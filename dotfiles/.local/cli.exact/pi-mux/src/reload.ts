import { randomUUID } from "node:crypto";
import { type BigIntStats, existsSync, opendirSync, readlinkSync, statSync } from "node:fs";
import {
  type Config,
  GENERATED_ENV_KEYS,
  prepareDirectory,
  type TmuxConfig,
} from "./configuration";
import { lockAddress, tryAcquireLock, withLock } from "./locks";
import {
  findFirstInput,
  launchRecordToken,
  matchesLaunch,
  PANE_FORMAT,
  parseLivePaneRows,
  readTemporarySession,
  temporarySessionQuery,
} from "./pane-inventory";
import { parseSessionState } from "./pane-state";
import { platform } from "./platform";
import {
  announceReloaded,
  matchesReloadPublication,
  type ReloadProgress,
  type ReloadPublication,
  publishWaitingTargets,
  reportReloadFailure,
} from "./reload-publication";
import { ReloadWaiting, type ReloadWaitingTarget } from "./reload-waiting";
import {
  bootstrapServer,
  RELOAD_MANAGED_FLAG,
  RELOAD_MANAGED_OPTION,
  snapshotReloadTarget,
  startAndRestore,
} from "./restoration";
import { readSnapshot } from "./restore-state";
import { findSaved } from "./saved-sessions";
import {
  isRecord,
  type Pane,
  POLL_INTERVAL_MS,
  SESSION_ID_PATTERN,
  STARTUP_TIMEOUT_MS,
} from "./session-model";
import {
  serverLifetime,
  type ServerLifetime,
  tmux,
  tmuxArguments,
  tmuxQueries,
  verifyServerLifetime,
} from "./tmux";
import { reloadWindowsPanes } from "./windows-reload";

type ReloadTarget = { pane: Pane; temporary: boolean };

type ReloadState = ReloadProgress & { confirmed: Set<string> };

type ReloadInventory = {
  panes: Pane[];
  starting: Map<string, string[]>;
  replaced: Set<string>;
};

export async function reloadPanes(config: Config, onlyId?: string): Promise<number> {
  if (platform.windows) return await reloadWindowsPanes(config, onlyId);
  const original = await withLock(config, () => serverLifetime(config));
  if (!original) {
    if (onlyId !== undefined)
      throw new Error(`Cannot reload session ${onlyId}: the dedicated server is not running`);
    return await withLock(config, async () => {
      if (await serverLifetime(config)) throw new Error("Dedicated server changed during reload");
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true)).failures > 0 ? 2 : 0;
    });
  }
  if (!original.generation) throw new Error("Dedicated server has not been initialized by pi-mux");
  const initial = await withLock(config, async () => {
    await verifyServerLifetime(config, original, "reload");
    readSnapshot(config);
    const inventory = await readReloadInventory(config);
    if (onlyId !== undefined) await validateReloadTarget(config, inventory, onlyId);
    await bootstrapServer(config, "existing");
    await verifyServerLifetime(config, original, "reload");
    return inventory;
  });
  const progress: ReloadState = {
    reloaded: new Set(),
    failed: new Set(),
    inFlight: new Map(),
    waiting: new ReloadWaiting(config, original),
    confirmed: new Set([...initial.panes.map(({ id }) => id), ...initial.starting.keys()]),
  };
  let schedulingFailure: { cause: unknown } | undefined;
  try {
    while (true) {
      const step = schedulingFailure
        ? "done"
        : await withLock(config, () =>
            startNextReload(config, original, initial, progress, onlyId),
          ).catch((cause: unknown) => {
            schedulingFailure = { cause };
            publishWaitingTargets(progress);
            return "done" as const;
          });
      await confirmReloadPublications(config, original, progress);
      if (step === "done" && progress.inFlight.size === 0) {
        if (schedulingFailure) throw schedulingFailure.cause;
        return progress.failed.size > 0 ? 2 : 0;
      }
      if (step !== "started") await Bun.sleep(POLL_INTERVAL_MS);
    }
  } finally {
    progress.waiting.replace([]);
    await Promise.all([...progress.inFlight.values()].map(({ release }) => release()));
  }
}

async function startNextReload(
  config: Config,
  original: ServerLifetime,
  initial: ReloadInventory,
  progress: ReloadState,
  onlyId?: string,
): Promise<"started" | "wait" | "done"> {
  await verifyServerLifetime(config, original, "reload");
  const scan = await scanReloadTargets(config, initial, progress, onlyId);
  publishWaitingTargets(progress, scan?.queued);
  if (!scan) return "done";
  for (const target of scan.ready) {
    const { id } = target.pane;
    const scope = `\0reload\0${original.pid}\0${original.generation}\0${id}`;
    const release = await tryAcquireLock(lockAddress(config, scope));
    if (!release) continue;
    try {
      const publication = await respawnReloadTarget(config, original, target, progress);
      if (!publication) continue;
      progress.inFlight.set(id, { ...publication, release });
      return "started";
    } finally {
      if (!progress.inFlight.has(id)) await release();
    }
  }
  return "wait";
}

async function validateReloadTarget(
  config: Config,
  inventory: ReloadInventory,
  id: string,
): Promise<void> {
  if (inventory.panes.some((pane) => pane.id === id) || inventory.starting.has(id)) return;
  const known =
    readSnapshot(config)?.sessions.some((session) => session.id === id) ||
    (await findSaved(config, id)) !== undefined;
  if (known) throw new Error(`The conversation is not running: ${id}`);
  throw new Error(`Session not found (use the complete ID): ${id}`);
}

async function scanReloadTargets(
  config: TmuxConfig,
  initial: ReloadInventory,
  progress: ReloadState,
  onlyId?: string,
): Promise<{ ready: ReloadTarget[]; queued: ReloadWaitingTarget[] } | undefined> {
  const { reloaded, failed, inFlight, confirmed } = progress;
  const isPending = (id: string) =>
    (!onlyId || id === onlyId) && !reloaded.has(id) && !failed.has(id) && !inFlight.has(id);
  const { panes, starting, replaced } = await readReloadInventory(config);
  for (const { id } of panes) confirmed.add(id);
  for (const id of starting.keys()) confirmed.add(id);
  const remaining: Pane[] = [];
  for (const id of [...confirmed].filter(isPending)) {
    const observed = panes.filter((pane) => pane.id === id);
    const booting = starting.get(id)?.length ?? 0;
    const initialMatches = initial.panes.filter((pane) => pane.id === id);
    const conflicts =
      observed.length + booting > 1 ||
      (initial.starting.get(id)?.length ?? 0) + initialMatches.length > 1;
    if (conflicts) {
      const reason =
        new Set([...observed, ...initialMatches].map(({ cwd }) => cwd)).size > 1
          ? `Conflicting working directories for conversation ${id}`
          : "Multiple pi processes match the conversation ID";
      reportReloadFailure(progress, id, reason);
      continue;
    }
    const pane = observed[0];
    if (!pane) {
      if (booting === 0) reportReloadFailure(progress, id, "The pi is not running");
      continue;
    }
    const first = initialMatches[0];
    if (first && first.cwd !== pane.cwd) {
      reportReloadFailure(progress, id, `Conflicting working directories for conversation ${id}`);
      continue;
    }
    if (
      first &&
      first.session === pane.session &&
      first.pane === pane.pane &&
      first.panePid !== pane.panePid &&
      replaced.has(pane.pane)
    ) {
      announceReloaded(progress, id);
      continue;
    }
    if (pane.reloadReadiness === undefined) {
      const reason = platform.processIsAlive(pane.pid)
        ? "Missing or invalid proof that pi drained its startup input"
        : "The pi is not running";
      reportReloadFailure(progress, id, reason);
      continue;
    }
    if (pane.reloadReadiness === "pending") continue;
    if (pane.pid !== pane.panePid) {
      reportReloadFailure(
        progress,
        id,
        "Replacing the pane would also stop the process that started pi",
      );
      continue;
    }
    remaining.push(pane);
  }
  const queued: ReloadWaitingTarget[] = [
    ...panes.filter(({ id }) => isPending(id)),
    ...[...starting].flatMap(([id, sessions]) =>
      isPending(id) ? sessions.map((session) => ({ id, session })) : [],
    ),
  ];
  if (remaining.length === 0) return queued.length ? { ready: [], queued } : undefined;
  const states = await tmuxQueries(
    config,
    remaining.flatMap((pane) => [
      ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"],
      ["show-options", "-pqv", "-t", pane.pane, "@pi-mux-pending-restart-blocker"],
    ]),
  );
  const ready = remaining.filter((pane, index) => {
    const state = states[index * 2]!;
    const blocker = states[index * 2 + 1]!;
    if (blocker.exitCode !== 0) throw new Error(`Cannot inspect pending reload state: ${pane.id}`);
    if (state.exitCode !== 0) throw new Error(`Cannot inspect reload state: ${pane.id}`);
    return (
      !blocker.stdout.trim() &&
      parseSessionState(state.stdout, pane.id) === "waiting-user" &&
      !findFirstInput(config, pane.id)
    );
  });
  const temporaryQueries = await tmuxQueries(
    config,
    ready.map((pane) => temporarySessionQuery(pane.session)),
  );
  return {
    ready: ready.map((pane, index) => ({
      pane,
      temporary: readTemporarySession(
        config,
        pane.session,
        pane.id,
        temporaryQueries[index]!,
        "allow-missing",
      ),
    })),
    queued,
  };
}

async function readReloadInventory(config: TmuxConfig): Promise<ReloadInventory> {
  const format = `${PANE_FORMAT}\t#{@pi-mux-launch}\t#{${RELOAD_MANAGED_OPTION}}`;
  const result = await tmux(config, ["list-panes", "-a", "-F", format], true);
  const inventory: ReloadInventory = { panes: [], starting: new Map(), replaced: new Set() };
  if (result.exitCode !== 0) {
    if (/^(no sessions|no current target)$/.test(result.stderr.trim())) return inventory;
    throw new Error(`Cannot inspect reload panes: ${result.stderr.trim()}`);
  }
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const fields = line.split("\t");
    const [paneId, session = "", , metadata, pid, dead, , , launch, enrolled] = fields;
    if (
      fields.length !== 10 ||
      !/^%\d+$/.test(paneId ?? "") ||
      !/^\$\d+$/.test(session) ||
      !["0", "1"].includes(dead ?? "")
    )
      throw new Error("Invalid reload pane inventory");
    if (dead !== "0") continue;
    const [pane] = parseLivePaneRows(fields.slice(0, 8).join("\t"), "list");
    if (pane) {
      inventory.panes.push(pane);
      if (enrolled === pane.id && matchesReloadPane(pane, Number(pid), launch, metadata))
        inventory.replaced.add(pane.pane);
    } else if (!metadata && launch && /^[1-9]\d*$/.test(pid ?? "")) {
      const id = verifiedStartingId(Number(pid), launch);
      if (id) {
        const sessions = inventory.starting.get(id);
        if (sessions) sessions.push(session);
        else inventory.starting.set(id, [session]);
      }
    }
  }
  return inventory;
}

function verifiedStartingId(pid: number, launch: string): string | undefined {
  let record: unknown;
  try {
    record = JSON.parse(launch);
  } catch {
    return;
  }
  if (
    !isRecord(record) ||
    typeof record.id !== "string" ||
    !SESSION_ID_PATTERN.test(record.id) ||
    !matchesLaunch(launch, record.id, pid, record.token)
  )
    return;
  try {
    const environment = platform.processEnvironment(pid);
    if (
      environment?.includes(`PI_TMUX_SESSION_ID=${record.id}`) &&
      environment.includes(`PI_TMUX_LAUNCH_TOKEN=${record.token}`)
    )
      return record.id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && platform.processIsAlive(pid))
      throw error;
  }
}

function matchesReloadPane(pane: Pane, pid: number, launch?: string, encoded?: string): boolean {
  const token = launchRecordToken(launch);
  if (!token || !encoded || !launch || !matchesLaunch(launch, pane.id, pid, token)) return false;
  const metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return (
    metadata.id === pane.id &&
    metadata.pid === pid &&
    metadata.token === token &&
    metadata.startup === "ready" &&
    metadata.cwd === pane.cwd &&
    (metadata.processPid === undefined || metadata.processPid === pid)
  );
}

async function respawnReloadTarget(
  config: Config,
  original: ServerLifetime,
  { pane, temporary }: ReloadTarget,
  progress: ReloadProgress,
): Promise<ReloadPublication | undefined> {
  await tmux(config, ["set-option", "-g", "@pi-mux-restart-veto", ""]);
  const [state, blocker, context, environment] = await tmuxQueries(config, [
    ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"],
    ["show-options", "-pqv", "-t", pane.pane, "@pi-mux-pending-restart-blocker"],
    [
      "display-message",
      "-p",
      "-t",
      pane.pane,
      "#{pane_tty}\t#{PI_TMUX_SESSION_ID}\t#{PI_TMUX_TEMPORARY}",
    ],
    ["show-environment", "-s", "-t", pane.session],
  ]);
  if (
    !state ||
    !blocker ||
    !context ||
    !environment ||
    [state, blocker, context, environment].some(({ exitCode }) => exitCode !== 0)
  )
    throw new Error(`Cannot recheck reload target ${pane.id}`);
  const [tty, owner, temporaryId] = removeTmuxNewline(context.stdout).split("\t");
  const waitingState = removeTmuxNewline(state.stdout);
  if (
    removeTmuxNewline(blocker.stdout) ||
    (temporaryId === pane.id) !== temporary ||
    parseSessionState(waitingState, pane.id) !== "waiting-user" ||
    findFirstInput(config, pane.id)
  )
    return;
  const terminalFailure = terminalReplacementRisk(pane, tty);
  if (terminalFailure) {
    reportReloadFailure(progress, pane.id, terminalFailure);
    return;
  }
  const identified = targetIdentifyingEnvironment(pane);
  if (!identified || !statSync(pane.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    reportReloadFailure(
      progress,
      pane.id,
      "Cannot read the target process environment or working directory",
    );
    return;
  }
  if (!(await snapshotReloadTarget(config, original, { id: pane.id, cwd: pane.cwd, temporary }))) {
    reportReloadFailure(progress, pane.id, "Conflicting working directories or restore ownership");
    return;
  }
  const launchToken = randomUUID();
  const startupCommand = `pi-mux-startup-${randomUUID()}`;
  const hasSavedFile = existsSync(pane.file);
  const preserveWarm = pane.warm && !hasSavedFile;
  const desired: Record<string, string> = {
    ...config.env,
    ...identified,
    PI_TMUX_SESSION_ID: pane.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
    PI_TMUX_STARTUP_COMMAND: startupCommand,
    ...(temporary ? { PI_TMUX_TEMPORARY: pane.id } : {}),
    ...(preserveWarm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  const selection = hasSavedFile ? ["--session", pane.file] : ["--session-id", pane.id];
  const command = [
    ...config.piCommand(),
    ...selection,
    "-e",
    config.extension,
    "--",
    `/${startupCommand}`,
  ];
  const canRespawn = allFormats([
    formatEquals("@pi-mux-restart-veto", ""),
    formatEquals("session_id", pane.session),
    formatEquals("pane_id", pane.pane),
    formatEquals("pane_pid", String(pane.panePid)),
    formatEquals("pane_dead", "0"),
    formatEquals("pane_tty", tty ?? ""),
    formatEquals("window_linked_sessions", "1"),
    formatEquals("@pi-tmux-session", pane.metadata),
    formatEquals("@pi-mux-pending-restart-blocker", ""),
    formatEquals("@pi_session_state", waitingState),
    formatEquals("PI_TMUX_TEMPORARY", temporaryId ?? ""),
  ]);
  const changes = [
    ...(temporary ? [] : [["set-option", "-g", `@pi-mux-restoring-${pane.id}`, "1"]]),
    respawnCommand(pane, desired, command),
    ["set-option", "-pu", "-t", pane.pane, "@pi-tmux-session"],
    ["set-option", "-pu", "-t", pane.pane, "@pi_session_state"],
    ["set-option", "-pu", "-t", pane.pane, "@pi-mux-state-source"],
    [
      "set-option",
      "-pF",
      "-t",
      pane.pane,
      "@pi-mux-launch",
      `{"id":"${pane.id}","pid":#{pane_pid},"token":"${launchToken}"}`,
    ],
    ["set-option", "-p", "-t", pane.pane, RELOAD_MANAGED_OPTION, pane.id],
    ["set-option", "-g", RELOAD_MANAGED_FLAG, "1"],
    ...sessionEnvironmentUpdate(pane, owner ?? "", environment.stdout, desired),
  ];
  const reloadBranch = tmuxArguments([
    "if-shell",
    "-t",
    pane.pane,
    "-F",
    canRespawn,
    changes.map(tmuxArguments).join(" ; "),
    "display-message -p PI_MUX_RELOAD_WAIT",
  ]);
  const current = await readReloadInventory(config);
  const matches = current.panes.filter(({ id }) => id === pane.id);
  const [next] = matches;
  if (
    current.starting.has(pane.id) ||
    matches.length !== 1 ||
    next?.session !== pane.session ||
    next.pane !== pane.pane ||
    next.metadata !== pane.metadata ||
    findFirstInput(config, pane.id)
  )
    return;
  const finalTerminalFailure = terminalReplacementRisk(pane, tty);
  if (finalTerminalFailure) {
    if (platform.processIsAlive(pane.pid))
      reportReloadFailure(progress, pane.id, finalTerminalFailure);
    return;
  }
  const respawned = await tmux(
    config,
    [
      "if-shell",
      "-F",
      allFormats([
        formatEquals("pid", String(original.pid)),
        formatEquals("@pi-mux-generation", original.generation),
      ]),
      reloadBranch,
      "display-message -p PI_MUX_RELOAD_SERVER_CHANGED",
    ],
    true,
  );
  if (respawned.stdout.includes("PI_MUX_RELOAD_SERVER_CHANGED"))
    throw new Error("Dedicated server changed during reload");
  if (respawned.exitCode !== 0) {
    await verifyServerLifetime(config, original, "reload");
    reportReloadFailure(progress, pane.id, `tmux if-shell failed: ${respawned.stderr.trim()}`);
    return;
  }
  if (respawned.stdout.includes("PI_MUX_RELOAD_WAIT")) return;
  return { pane, launchToken, preserveWarm, deadlineMs: Date.now() + STARTUP_TIMEOUT_MS };
}

async function confirmReloadPublications(
  config: Config,
  original: ServerLifetime,
  progress: ReloadProgress,
): Promise<void> {
  if (progress.inFlight.size === 0) return;
  const list = await tmux(
    config,
    [
      "list-panes",
      "-a",
      "-F",
      "#{session_id}\t#{pane_id}\t#{pid}\t#{@pi-mux-generation}\t#{pane_pid}\t#{pane_dead}\t#{@pi-tmux-session}\t#{@pi-mux-launch}",
    ],
    true,
  );
  if (list.exitCode !== 0 || !list.stdout.trim()) {
    await verifyServerLifetime(config, original, "reload");
    const noPanes =
      list.stderr.includes("no sessions") || list.stderr.includes("no current target");
    if (list.exitCode !== 0 && !noPanes)
      throw new Error(`tmux list-panes failed: ${list.stderr.trim()}`);
  }
  const rows = new Map<string, string[]>();
  for (const line of list.stdout.trimEnd().split("\n").filter(Boolean)) {
    const [session, paneId, serverPid, generation, ...publication] = line.split("\t");
    if (Number(serverPid) !== original.pid || generation !== original.generation)
      throw new Error("Dedicated server changed during reload");
    rows.set(`${session}:${paneId}`, publication);
  }
  for (const [id, { pane, launchToken, preserveWarm, deadlineMs, release }] of progress.inFlight) {
    const [pid, dead, metadata, launch] = rows.get(`${pane.session}:${pane.pane}`) ?? [];
    if (!pid || dead === "1") {
      reportReloadFailure(progress, id, "pi exited before reload was recorded");
    } else if (
      matchesReloadPublication(pane, Number(pid), launchToken, preserveWarm, metadata, launch) &&
      matchesReloadPane(pane, Number(pid), launch, metadata)
    ) {
      announceReloaded(progress, id);
    } else if (Date.now() >= deadlineMs) {
      reportReloadFailure(progress, id, "pi startup timed out during reload");
    } else {
      continue;
    }
    progress.inFlight.delete(id);
    await release();
  }
}

function removeTmuxNewline(output: string): string {
  return output.replace(/\n$/, "");
}

function formatEquals(field: string, literal: string): string {
  return `#{==:#{${field}},${literal.replace(/[#,}]/g, "#$&")}}`;
}

function allFormats(conditions: string[]): string {
  return conditions.reduce((left, right) => `#{&&:${left},${right}}`);
}

const TERMINAL_CHECK_TIMEOUT_MS = 1_000;
const MAX_PROCESS_INVENTORY_BYTES = 4 * 1024 * 1024;
const LINUX_TTY_MULTIPLEXER_RDEV = 5n << 8n;

function terminalReplacementRisk(pane: Pane, tty?: string): string | undefined {
  const unknown = "Cannot verify that only Pi uses the pane terminal";
  const shared = "Replacing the pane would affect another process using its terminal";
  if (process.platform !== "linux" || !tty?.startsWith("/dev/")) return unknown;
  const deadlineMs = performance.now() + TERMINAL_CHECK_TIMEOUT_MS;
  try {
    const processes = Bun.spawnSync(["/usr/bin/ps", "-e", "-o", "pid=,sid=,tty=,stat="], {
      env: { LC_ALL: "C" },
      timeout: TERMINAL_CHECK_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_INVENTORY_BYTES,
    });
    if (processes.exitCode !== 0 || !processes.stdout) return unknown;
    const rows = processes.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
    if (
      rows.some((row) => {
        const [pid, sid] = row;
        return row.length !== 4 || !/^[1-9]\d*$/.test(pid ?? "") || !/^\d+$/.test(sid ?? "");
      })
    )
      return unknown;
    const live = rows.filter(([, , , state]) => !state!.startsWith("Z"));
    const target = live.find(([pid]) => Number(pid) === pane.pid);
    if (!target || Number(target[1]) !== pane.pid || `/dev/${target[2]}` !== tty) return unknown;
    const device = statSync(tty, { bigint: true });
    if (
      !device.isCharacterDevice() ||
      findTerminalDescriptor(pane.pid, tty, device, deadlineMs, "target") !== "pane"
    )
      return unknown;
    for (const [pid, sid, controllingTty] of live) {
      if (Number(pid) === pane.pid) continue;
      if (Number(sid) === pane.pid) return shared;
      if (`/dev/${controllingTty}` === tty) {
        const controllingDevice = readVisibleProc(() =>
          statSync(`/proc/${pid}/root${tty}`, { bigint: true }),
        );
        if (isSameTerminal(controllingDevice, device)) return shared;
      }
      const descriptor = findTerminalDescriptor(Number(pid), tty, device, deadlineMs, "other");
      if (descriptor === "pane") return shared;
      if (descriptor === "multiplexer")
        return "Cannot rule out another process using the pane terminal through /dev/tty";
    }
  } catch {
    return unknown;
  }
}

function findTerminalDescriptor(
  pid: number,
  tty: string,
  device: BigIntStats,
  deadlineMs: number,
  processRole: "target" | "other",
): "pane" | "multiplexer" | undefined {
  if (performance.now() >= deadlineMs) throw new Error("Pane terminal inspection timed out");
  const directory = readVisibleProc(() => opendirSync(`/proc/${pid}/fd`));
  if (!directory) return;
  try {
    while (performance.now() < deadlineMs) {
      const entry = readVisibleProc(() => directory.readSync());
      if (!entry) return;
      if (!/^\d+$/.test(entry.name)) continue;
      const path = `/proc/${pid}/fd/${entry.name}`;
      const destination = readVisibleProc(() => readlinkSync(path));
      const mayBeMultiplexer =
        processRole === "other" &&
        (destination === "/dev/tty" || destination === "/dev/tty (deleted)");
      if (destination !== tty && !mayBeMultiplexer) continue;
      const descriptor = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (isSameTerminal(descriptor, device)) return "pane";
      if (
        mayBeMultiplexer &&
        descriptor?.isCharacterDevice() &&
        descriptor.rdev === LINUX_TTY_MULTIPLEXER_RDEV
      )
        return "multiplexer";
    }
    throw new Error("Pane terminal inspection timed out");
  } finally {
    directory.closeSync();
  }
}

function isSameTerminal(observed: BigIntStats | undefined, expected: BigIntStats): boolean {
  return (
    !!observed?.isCharacterDevice() &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino
  );
}

function readVisibleProc<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") return;
    throw error;
  }
}

function targetIdentifyingEnvironment(pane: Pane): Record<string, string> | undefined {
  try {
    const environment = platform.processEnvironment(pane.pid);
    if (!environment) return;
    return Object.fromEntries(
      environment.flatMap((entry) => {
        const match = /^(TICKET_DISPATCH_(?:ROLE|PROJECT|ID))=([\s\S]*)$/.exec(entry);
        return match ? [[match[1]!, match[2]!]] : [];
      }),
    );
  } catch {
    return;
  }
}

function respawnCommand(pane: Pane, desired: Record<string, string>, command: string[]): string[] {
  const args = ["respawn-pane", "-k", "-t", pane.pane, "-c", pane.cwd.replaceAll("#", "##")];
  const assignments = [...GENERATED_ENV_KEYS].map((key) => `\${${key}+"${key}=$${key}"}`);
  for (const [index, [key, value]] of Object.entries(desired).entries()) {
    if (GENERATED_ENV_KEYS.has(key)) continue;
    const transport = `PI_MUX_RELOAD_ENV_${index}`;
    args.push("-e", `${transport}=${key}=${value}`);
    assignments.push(`"$${transport}"`);
  }
  args.push("-e", `PI_TMUX_SESSION_ID=${desired.PI_TMUX_SESSION_ID}`);
  args.push("-e", `PI_TMUX_LAUNCH_TOKEN=${desired.PI_TMUX_LAUNCH_TOKEN}`);
  const exec = `exec /usr/bin/env -i ${assignments.join(" ")} "$@"`;
  return [...args, "--", "/bin/sh", "-c", exec, "pi-mux-reload", ...command];
}

function sessionEnvironmentUpdate(
  pane: Pane,
  owner: string,
  environment: string,
  desired: Record<string, string>,
): string[][] {
  if (owner && owner !== pane.id) return [];
  const assignments = environment.replace(/"(?:\\.|[^"\\])*"/gs, "");
  const removed = [...assignments.matchAll(/; export ([^;\n]+);/g)]
    .map((match) => match[1]!)
    .filter((key) => !Object.hasOwn(desired, key));
  const changes = [
    ...Object.entries(desired).map(([key, value]) => [
      "set-environment",
      "-t",
      pane.session,
      "--",
      key,
      value,
    ]),
    ...removed.map((key) => ["set-environment", "-u", "-t", pane.session, "--", key]),
  ];
  const isExclusive = allFormats([
    formatEquals("session_id", pane.session),
    formatEquals("session_windows", "1"),
    formatEquals("window_panes", "1"),
    formatEquals("window_linked_sessions", "1"),
    formatEquals("PI_TMUX_SESSION_ID", owner),
    formatEquals("session_path", pane.cwd),
  ]);
  return [["if-shell", "-t", pane.pane, "-F", isExclusive, changes.map(tmuxArguments).join(" ; ")]];
}
