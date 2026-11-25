import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { VIEW_RECEIPT_MAX_ENCODED_LENGTH } from "./cli-arguments";
import type { TmuxConfig } from "./configuration";
import { livePanes, paneExists } from "./pane-inventory";
import { metadataFileIdentity, type ViewReceipt } from "./session-metadata";
import { errorMessage } from "./session-model";
import { guardedTmuxLine, paneEntityGuard, serverLifetime, tmux } from "./tmux";

const SEND_WAIT_POLL_INTERVAL_MS = 100;

const VIEW_RECEIPT_TIMEOUT_SECONDS = 5;

const BASE64_OPTION_VALUE = /^[A-Za-z0-9+/]+={0,2}$/;

export async function sendSessionMessage(
  config: TmuxConfig,
  id: string,
  text: string,
  waitSeconds: number | undefined,
): Promise<number> {
  try {
    const targets = (await livePanes(config, "list")).filter((pane) => pane.id === id);
    if (targets.length === 0) throw new Error(`Session not found (use the complete ID): ${id}`);
    if (targets.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
    const target = targets[0]!;
    const server = await serverLifetime(config);
    if (!server) throw new Error("Dedicated server is not running");
    const messageId = randomUUID();
    const optionName = `@pi-mux-msg-${messageId}`;
    const from = process.env.PI_SESSION_ID?.trim() || "external";
    const envelope = Buffer.from(
      JSON.stringify({ v: 1, id: messageId, from, at: new Date().toISOString(), text }),
      "utf8",
    ).toString("base64");
    const writeAndReadBack = guardedTmuxLine(
      target.pane,
      paneEntityGuard(server.pid, target.pane, target.panePid),
      [
        ["set-option", "-p", "-t", target.pane, optionName, envelope],
        ["show-options", "-pqv", "-t", target.pane, optionName],
      ],
      "PI_MUX_MESSAGE_TARGET_LOST",
    );
    const result = await tmux(config, ["source-file", "-"], false, `${writeAndReadBack}\n`);
    if (result.stdout.includes("PI_MUX_MESSAGE_TARGET_LOST"))
      throw new Error("Target pane no longer matches the conversation");
    if (result.stdout.trim() !== envelope)
      throw new Error("Cannot confirm the message option write");
    if (waitSeconds === undefined) return 0;
    const outcome = await waitForMessageConsumption(config, target.pane, optionName, waitSeconds);
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
  const targets = (await livePanes(config, "list")).filter((pane) => pane.id === id);
  const target = targets[0];
  if (!target || targets.length !== 1)
    throw new Error(`Cannot identify a single live session: ${id}`);
  if (
    realpathSync(target.file) !== receipt.file ||
    metadataFileIdentity(receipt.file) !== receipt.fileIdentity
  )
    throw new Error(`Session ${id} no longer points at the viewed history`);
  const server = await serverLifetime(config);
  if (!server) throw new Error("Dedicated server is not running");
  const option = `@pi-mux-view-${randomUUID()}`;
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      sessionId: id,
      processPid: target.pid,
      file: receipt.file,
      fileIdentity: receipt.fileIdentity,
      responseId: receipt.responseId,
      viewedAt: receipt.viewedAt,
    }),
  ).toString("base64");
  if (payload.length > VIEW_RECEIPT_MAX_ENCODED_LENGTH)
    throw new Error(`View receipt is too large for session ${id}`);
  if (!/^%\d+$/.test(target.pane) || !BASE64_OPTION_VALUE.test(target.metadata))
    throw new Error(`Invalid pane identity for session ${id}`);
  const paneGuard = paneEntityGuard(server.pid, target.pane, target.panePid);
  const writeAndReadBack = guardedTmuxLine(
    target.pane,
    `#{&&:${paneGuard},#{==:#{@pi-tmux-session},${target.metadata}}}`,
    [
      ["set-option", "-p", "-t", target.pane, option, payload],
      ["show-options", "-pqv", "-t", target.pane, option],
    ],
  );
  const result = await tmux(config, ["source-file", "-"], false, `${writeAndReadBack}\n`);
  if (result.stdout.trim() !== payload) throw new Error(`Cannot queue view for session ${id}`);
  const outcome = await waitForMessageConsumption(
    config,
    target.pane,
    option,
    VIEW_RECEIPT_TIMEOUT_SECONDS,
  );
  if (outcome === "timeout") {
    const clear = guardedTmuxLine(target.pane, paneGuard, [
      ["set-option", "-pu", "-t", target.pane, option],
    ]);
    await tmux(config, ["source-file", "-"], true, `${clear}\n`);
  }
  if (outcome !== "consumed")
    throw new Error(`View receipt not consumed for session ${id}: ${outcome}`);
}

async function waitForMessageConsumption(
  config: TmuxConfig,
  pane: string,
  optionName: string,
  waitSeconds: number,
): Promise<"consumed" | "lost" | "timeout"> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await tmux(config, ["show-options", "-pqv", "-t", pane, optionName], true);
    if (result.exitCode !== 0)
      throw new Error(`Cannot inspect message option: ${result.stderr.trim()}`);
    if (!result.stdout.trim()) return (await paneExists(config, pane)) ? "consumed" : "lost";
    await Bun.sleep(SEND_WAIT_POLL_INTERVAL_MS);
  }
  return "timeout";
}
