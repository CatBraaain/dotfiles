import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { VIEW_RECEIPT_MAX_ENCODED_LENGTH } from "./cli-arguments";
import type { TmuxConfig } from "./configuration";
import { livePanes, paneExists, PANE_FORMAT, parseLivePaneRows } from "./pane-inventory";
import { platform } from "./platform";
import { metadataFileIdentity, type ViewReceipt } from "./session-metadata";
import { errorMessage, type Pane } from "./session-model";
import { guardedTmuxLine, paneEntityGuard, serverLifetime, tmux, windowsManagement } from "./mux";
import { mutateWindowsPeerPane, readWindowsPeerPaneFields } from "./windows/windows-lifecycle";
import type { WindowsManagement } from "./windows/windows-management";
import type { PsmuxObservation, PsmuxPeer } from "./windows/windows-psmux";

const SEND_WAIT_POLL_INTERVAL_MS = 100;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const VIEW_RECEIPT_TIMEOUT_SECONDS = 5;

const BASE64_OPTION_VALUE = /^[A-Za-z0-9+/]+={0,2}$/;

const MESSAGE_TARGET_LOST = "PI_MUX_MESSAGE_TARGET_LOST";

type WindowsDeliveryPeer = {
  scope: WindowsManagement["scope"];
  observation: PsmuxObservation;
  peer: PsmuxPeer;
};

type DeliveryTarget = { pane: Pane; windows?: WindowsDeliveryPeer };

export async function sendSessionMessage(
  config: TmuxConfig,
  id: string,
  text: string,
  waitSeconds: number | undefined,
): Promise<number> {
  try {
    const targets = await findDeliveryTargets(config, id);
    if (targets.length === 0) throw new Error(`Session not found (use the complete ID): ${id}`);
    if (targets.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
    const target = targets[0]!;
    const messageId = randomUUID();
    const optionName = `@pi-mux-msg-${messageId}`;
    const from = process.env.PI_SESSION_ID?.trim() || "external";
    const envelope = Buffer.from(
      JSON.stringify({ v: 1, id: messageId, from, at: new Date().toISOString(), text }),
      "utf8",
    ).toString("base64");
    await queuePaneOption(config, target, optionName, envelope, "message");
    if (waitSeconds === undefined) return 0;
    const outcome = await waitForMessageConsumption(config, target, optionName, waitSeconds);
    if (outcome === "consumed") {
      console.log("delivered");
      return 0;
    }
    if (outcome === "lost")
      throw new Error(`Target pane disappeared before consuming ${optionName}`);
    throw new Error(`Message option ${optionName} was not consumed within ${waitSeconds} seconds`);
  } catch (error) {
    throw new Error(`Cannot send message to session ${id}: ${errorMessage(error)}`);
  }
}

export async function sendViewReceipt(
  config: TmuxConfig,
  id: string,
  receipt: ViewReceipt,
): Promise<void> {
  const targets = await findDeliveryTargets(config, id);
  const target = targets[0];
  if (!target || targets.length !== 1)
    throw new Error(`Cannot identify a single live session: ${id}`);
  const { pane } = target;
  if (
    realpathSync(pane.file) !== receipt.file ||
    metadataFileIdentity(receipt.file) !== receipt.fileIdentity
  )
    throw new Error(`Session ${id} no longer points at the viewed history`);
  const option = `@pi-mux-view-${randomUUID()}`;
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      sessionId: id,
      processPid: pane.pid,
      file: receipt.file,
      fileIdentity: receipt.fileIdentity,
      responseId: receipt.responseId,
      viewedAt: receipt.viewedAt,
    }),
  ).toString("base64");
  if (payload.length > VIEW_RECEIPT_MAX_ENCODED_LENGTH)
    throw new Error(`View receipt is too large for session ${id}`);
  const paneGuard = await queuePaneOption(config, target, option, payload, "view");
  const outcome = await waitForMessageConsumption(
    config,
    target,
    option,
    VIEW_RECEIPT_TIMEOUT_SECONDS,
  );
  if (outcome === "consumed") return;
  const failure = `View receipt not consumed for session ${id}: ${outcome}`;
  if (outcome === "timeout") {
    if (target.windows) {
      try {
        await writeWindowsDeliveryOption(target.windows, pane, option);
      } catch (error) {
        throw new Error(`${failure}; ${errorMessage(error)}`);
      }
    } else if (paneGuard) {
      const clear = guardedTmuxLine(pane.pane, paneGuard, [
        ["set-option", "-pu", "-t", pane.pane, option],
      ]);
      await tmux(config, ["source-file", "-"], true, `${clear}\n`);
    }
  }
  throw new Error(failure);
}

async function findDeliveryTargets(config: TmuxConfig, id: string): Promise<DeliveryTarget[]> {
  if (!platform.windows)
    return (await livePanes(config, "list"))
      .filter((pane) => pane.id === id)
      .map((pane) => ({ pane }));

  const management = windowsManagement(config);
  const observation = await management.audit(PANE_FORMAT, { requireRestored: false });
  return observation.panes.flatMap(({ peer, rows }) =>
    parseLivePaneRows(rows.join("\n"), "list")
      .filter((pane) => pane.id === id)
      .map((pane) => ({ pane, windows: { scope: management.scope, observation, peer } })),
  );
}

async function queuePaneOption(
  config: TmuxConfig,
  { pane, windows }: DeliveryTarget,
  option: string,
  payload: string,
  kind: "message" | "view",
): Promise<string | undefined> {
  if (
    (windows || kind === "view") &&
    (!/^%\d+$/.test(pane.pane) || !BASE64_OPTION_VALUE.test(pane.metadata))
  )
    throw new Error(`Invalid pane identity for session ${pane.id}`);
  const failure =
    kind === "view"
      ? `Cannot queue view for session ${pane.id}`
      : "Cannot confirm the message option write";
  if (windows) {
    try {
      await writeWindowsDeliveryOption(windows, pane, option, payload);
    } catch (error) {
      throw new Error(`${failure}: ${errorMessage(error)}`);
    }
    return;
  }

  const server = await serverLifetime(config);
  if (!server) throw new Error("Dedicated server is not running");
  const paneGuard = paneEntityGuard(server.pid, pane.pane, pane.panePid);
  const condition =
    kind === "view" ? `#{&&:${paneGuard},#{==:#{@pi-tmux-session},${pane.metadata}}}` : paneGuard;
  const writeAndReadBack = guardedTmuxLine(
    pane.pane,
    condition,
    [
      ["set-option", "-p", "-t", pane.pane, option, payload],
      ["show-options", "-pqv", "-t", pane.pane, option],
    ],
    kind === "message" ? MESSAGE_TARGET_LOST : undefined,
  );
  const result = await tmux(config, ["source-file", "-"], false, `${writeAndReadBack}\n`);
  if (kind === "message" && result.stdout.includes(MESSAGE_TARGET_LOST))
    throw new Error("Target pane no longer matches the conversation");
  if (result.stdout.trim() !== payload) throw new Error(failure);
  return paneGuard;
}

async function writeWindowsDeliveryOption(
  { scope, observation, peer }: WindowsDeliveryPeer,
  pane: Pane,
  option: string,
  value?: string,
): Promise<void> {
  await mutateWindowsPeerPane(scope, observation, peer, pane.pane, {
    expected: [
      ["pane_pid", String(pane.panePid)],
      ["@pi-tmux-session", pane.metadata],
    ],
    mutations: [{ option, value }],
    processes: [],
  });
}

async function waitForMessageConsumption(
  config: TmuxConfig,
  { pane, windows }: DeliveryTarget,
  optionName: string,
  waitSeconds: number,
): Promise<"consumed" | "lost" | "timeout"> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return "timeout";
    if (windows) {
      const { scope, observation, peer } = windows;
      const signal = AbortSignal.timeout(Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      const fields = await readWindowsPeerPaneFields(
        scope,
        observation,
        peer,
        pane.pane,
        ["pane_pid", "pane_dead", "@pi-tmux-session", optionName],
        undefined,
        signal,
      ).catch((error) => {
        if (signal.aborted || Date.now() >= deadline) return;
        throw new Error(`Cannot inspect ${optionName} in the target pane: ${errorMessage(error)}`);
      });
      if (!fields || Date.now() >= deadline) return "timeout";
      const [pid, dead, metadata, value] = fields;
      if (pid !== String(pane.panePid) || dead !== "0" || metadata !== pane.metadata) return "lost";
      if (!value) return "consumed";
    } else {
      const result = await tmux(
        config,
        ["show-options", "-pqv", "-t", pane.pane, optionName],
        true,
      );
      if (result.exitCode !== 0)
        throw new Error(`Cannot inspect message option: ${result.stderr.trim()}`);
      if (!result.stdout.trim()) return (await paneExists(config, pane.pane)) ? "consumed" : "lost";
    }
    const delayMs = windows
      ? Math.min(SEND_WAIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))
      : SEND_WAIT_POLL_INTERVAL_MS;
    await Bun.sleep(delayMs);
  }
}
