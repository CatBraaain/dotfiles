import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, win32 } from "node:path";
import type { Config, TmuxConfig } from "./configuration";
import { windowsClaimLock } from "./locks";
import { platform } from "./platform";
import {
  type Candidate,
  isRecord,
  type ManagedSession,
  type Pane,
  POLL_INTERVAL_MS,
  SESSION_ID_PATTERN,
  STARTUP_TIMEOUT_MS,
  type StopTarget,
  UUID,
} from "./session-model";
import { serverIsAbsent, tmux, tmuxQueries, windowsManagement } from "./mux";
import { assertWindowsPiWorkingDirectory } from "./windows/windows-pi-command";

export const PANE_FORMAT =
  "#{pane_id}\t#{session_id}\t#{session_name}\t#{@pi-tmux-session}\t#{pane_pid}\t#{pane_dead}\t#{window_active}\t#{pane_active}";

export function temporarySessionQuery(session: string): string[] {
  return ["show-environment", "-t", session, "PI_TMUX_TEMPORARY"];
}

export async function isTemporarySession(
  config: TmuxConfig,
  session: string,
  id: string,
): Promise<boolean> {
  const result = await tmux(config, temporarySessionQuery(session), true);
  return readTemporarySession(config, session, id, result, "strict");
}

export function readTemporarySession(
  config: TmuxConfig,
  session: string,
  id: string,
  result: Awaited<ReturnType<typeof tmux>>,
  mode: "strict" | "allow-missing",
): boolean {
  if (result.exitCode !== 0) {
    if (result.stderr.includes("unknown variable: PI_TMUX_TEMPORARY")) return false;
    if (
      mode === "allow-missing" &&
      (serverIsAbsent(config, result.stderr) ||
        result.stderr.includes("no such session:") ||
        result.stderr.includes("can't find session:"))
    )
      return false;
    throw new Error(`Cannot inspect temporary session ${session}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim() === `PI_TMUX_TEMPORARY=${id}`;
}

export async function promoteSession(
  config: TmuxConfig,
  session: string,
  id: string,
): Promise<void> {
  if (await isTemporarySession(config, session, id))
    await tmux(config, ["set-environment", "-u", "-t", session, "PI_TMUX_TEMPORARY"]);
}

export function launchRecordToken(launch: string | undefined): string | undefined {
  if (!launch) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(launch);
  } catch {
    return undefined;
  }
  return isRecord(record) && typeof record.token === "string" ? record.token : undefined;
}

export async function managedSessions(
  config: TmuxConfig,
  strict = false,
): Promise<ManagedSession[]> {
  if (platform.windows) {
    const management = windowsManagement(config);
    const basis = await management.currentBasis();
    if (!basis && !strict) return [];
    const audit = await management.audit(
      "#{session_id}\t#{PI_TMUX_SESSION_ID}\t#{PI_TMUX_TEMPORARY}\t#{session_path}\t#{pane_dead}\t#{PI_MUX_WINDOWS_START_RIGHT}",
      { requireRestored: false },
    );
    const rights = management.createLaunchRights(windowsClaimLock(management));
    const managed: ManagedSession[] = [];
    for (const { peer, rows } of audit.panes) {
      let candidate: ManagedSession | undefined;
      for (const row of rows) {
        const parts = row.split("\t");
        const [session, id, temporary, cwd, dead, token] = parts;
        if (parts.length !== 6 || !/^\$\d+$/.test(session ?? "") || !["0", "1"].includes(dead!))
          throw new Error(`Invalid Windows managed session in ${peer.name}`);
        if (!id || dead === "1") continue;
        if (
          !SESSION_ID_PATTERN.test(id) ||
          !isAbsolute(cwd ?? "") ||
          (temporary && temporary !== id)
        )
          throw new Error(`Invalid Windows conversation metadata in ${peer.name}`);
        if (token) {
          if (!UUID.test(token)) throw new Error(`Invalid Windows launch token in ${peer.name}`);
          const status = await rights.status(token);
          if (["missing", "ended", "reserved"].includes(status.state)) continue;
          if (status.state !== "live")
            throw new Error(`Cannot verify Windows launch in ${peer.name}`);
        }
        const current = { session: session!, id, cwd: cwd!, temporary: temporary === id };
        if (candidate && JSON.stringify(candidate) !== JSON.stringify(current))
          throw new Error(`Ambiguous Windows conversation metadata in ${peer.name}`);
        candidate = current;
      }
      if (candidate) managed.push(candidate);
    }
    await management.assertLive(audit.basis);
    return managed;
  }
  const listed = await tmux(config, ["list-sessions", "-F", "#{session_id}"], true);
  if (listed.exitCode !== 0) {
    if (!strict && (serverIsAbsent(config, listed.stderr) || listed.stderr.includes("no sessions")))
      return [];
    throw new Error(`Cannot inspect managed sessions: ${listed.stderr.trim()}`);
  }
  const targets = listed.stdout.trimEnd().split("\n").filter(Boolean);
  if (strict && targets.some((session) => !/^\$\d+$/.test(session)))
    throw new Error("Invalid tmux session inventory");
  const attributes = await tmuxQueries(
    config,
    targets.flatMap((session) => [
      ["show-environment", "-t", session, "PI_TMUX_SESSION_ID"],
      ["display-message", "-p", "-t", session, "#{session_path}"],
      ["show-environment", "-t", session, "PI_TMUX_TEMPORARY"],
    ]),
  );
  const sessions: ManagedSession[] = [];
  for (const [index, session] of targets.entries()) {
    const environment = attributes[index * 3]!;
    if (environment.exitCode !== 0) {
      if (environment.stderr.includes("unknown variable: PI_TMUX_SESSION_ID")) continue;
      throw new Error(`Cannot inspect tmux session ${session}: ${environment.stderr.trim()}`);
    }
    const id = environment.stdout.replace(/\n$/, "").slice("PI_TMUX_SESSION_ID=".length);
    if (!environment.stdout.startsWith("PI_TMUX_SESSION_ID=") || !SESSION_ID_PATTERN.test(id))
      throw new Error(`Invalid conversation ID in tmux session ${session}`);
    const path = attributes[index * 3 + 1]!;
    if (path.exitCode !== 0) throw new Error(`tmux display-message failed: ${path.stdout.trim()}`);
    const cwd = path.stdout.replace(/\n$/, "");
    if (!isAbsolute(cwd)) throw new Error(`Invalid working directory in tmux session ${session}`);
    const temporary = attributes[index * 3 + 2]!;
    if (
      temporary.exitCode !== 0 &&
      !temporary.stderr.includes("unknown variable: PI_TMUX_TEMPORARY")
    )
      throw new Error(`Cannot inspect temporary session ${session}: ${temporary.stderr.trim()}`);
    sessions.push({
      id,
      cwd,
      session,
      temporary: temporary.exitCode === 0 && temporary.stdout.trim() === `PI_TMUX_TEMPORARY=${id}`,
    });
  }
  return sessions;
}

export function firstInputDirectory(
  stateDirectory: string,
  id: string,
  platformName: NodeJS.Platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
): string | undefined {
  if (!UUID.test(id)) return;
  if (platformName === "win32") {
    if (!localAppData || !/^[a-z]:[\\/]/i.test(localAppData)) return;
    return win32.join(localAppData, "pi-mux-first-input", id);
  }
  return join(stateDirectory, "first-input", id);
}

export function findFirstInput(config: TmuxConfig, id: string): Candidate | undefined {
  const directory = firstInputDirectory(config.stateDirectory, id);
  if (!directory) return;
  const payload = lstatSync(join(directory, "text"), { throwIfNoEntry: false });
  if (!payload) return;
  if (!payload.isFile() || !platform.ownedFileEntry(payload))
    throw new Error("Unsafe first input file");
  for (const path of [dirname(directory), directory])
    platform.assertDirectorySafety(lstatSync(path), path);
  if (!platform.windows)
    platform.assertDirectorySafety(lstatSync(config.stateDirectory), config.stateDirectory);
  const context = join(directory, "context.json");
  const stat = lstatSync(context);
  if (!stat.isFile() || !platform.ownedFileEntry(stat))
    throw new Error("Unsafe first input context");
  const record = JSON.parse(readFileSync(context, "utf8"));
  if (
    record?.id !== id ||
    typeof record?.cwd !== "string" ||
    !isAbsolute(record.cwd) ||
    typeof record?.request !== "string" ||
    !UUID.test(record.request)
  )
    throw new Error("Invalid first input context");
  return { id, cwd: record.cwd };
}

export function matchesLaunch(
  encoded: string,
  id: string,
  panePid: number,
  token: unknown,
): boolean {
  if (typeof token !== "string" || !UUID.test(token)) return false;
  try {
    const launch = JSON.parse(encoded);
    return launch?.id === id && launch.pid === panePid && launch.token === token;
  } catch {
    return false;
  }
}

export async function waitForSession(
  config: Config,
  target: string,
  expectedId: string,
  startup: "accepted" | "ready" = "ready",
  expectedCwd?: string,
): Promise<Pane> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  function matches(candidate: Pane): boolean {
    if (candidate.id !== expectedId || (startup === "ready" && candidate.startup !== "ready"))
      return false;
    if (platform.windows && expectedCwd !== undefined)
      assertWindowsPiWorkingDirectory(expectedCwd, candidate.cwd);
    return true;
  }
  while (Date.now() < deadline) {
    const pane = (await livePanes(config)).find(matches);
    if (pane) return pane;
    if (!(await hasSession(config, target))) {
      const moved = (await livePanes(config)).find(matches);
      if (moved) return moved;
      throw new Error(`pi exited before startup: ${expectedId}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`pi startup timed out: ${expectedId}`);
}

export async function paneExists(config: TmuxConfig, pane: string): Promise<boolean> {
  const result = await tmux(config, ["list-panes", "-a", "-F", "#{pane_id}"], true);
  if (result.exitCode !== 0) {
    if (serverIsAbsent(config, result.stderr) || result.stderr.includes("no sessions"))
      return false;
    throw new Error(`Cannot inspect panes: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd().split("\n").includes(pane);
}

export async function initializingPanes(
  config: TmuxConfig,
  managed: ManagedSession[],
  published: Pane[],
): Promise<StopTarget[]> {
  const targets: StopTarget[] = [];
  for (const session of managed) {
    const result = await tmux(config, [
      "list-panes",
      "-s",
      "-t",
      session.session,
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{pane_dead}",
    ]);
    const unpublished = result.stdout
      .trimEnd()
      .split("\n")
      .flatMap((line) => {
        const [pane, pid, dead] = line.split("\t");
        if (dead !== "0" || published.some((entry) => entry.pane === pane)) return [];
        if (!pane || !pid || !/^[1-9]\d*$/.test(pid))
          throw new Error(`Cannot identify initializing pi in ${session.session}`);
        return [{ pane, pid: Number(pid), panePid: Number(pid) }];
      });
    const matching: StopTarget[] = [];
    for (const target of unpublished) {
      const environment = platform.processEnvironment(target.pid);
      const workingDirectory =
        environment === undefined ? undefined : platform.processWorkingDirectory(target.pid);
      const option = await tmux(config, [
        "show-options",
        "-pqv",
        "-t",
        target.pane,
        "@pi-mux-launch",
      ]);
      let launch: unknown;
      try {
        launch = JSON.parse(option.stdout);
      } catch {
        throw new Error(`Cannot safely identify initializing pi ${session.id} in ${target.pane}`);
      }
      if (
        !isRecord(launch) ||
        launch.id !== session.id ||
        launch.pid !== target.pid ||
        typeof launch.token !== "string"
      )
        throw new Error(`Cannot safely identify initializing pi ${session.id} in ${target.pane}`);
      if (
        (environment !== undefined &&
          (!environment.includes(`PI_TMUX_SESSION_ID=${session.id}`) ||
            !environment.includes(`PI_TMUX_LAUNCH_TOKEN=${launch.token}`))) ||
        (workingDirectory !== undefined && workingDirectory !== realpathSync(session.cwd))
      )
        continue;
      matching.push(target);
    }
    if (
      unpublished.length > 0 &&
      matching.length === 0 &&
      !published.some((pane) => pane.session === session.session && pane.id === session.id)
    )
      throw new Error(`Cannot safely identify initializing pi ${session.id} in ${session.session}`);
    targets.push(...matching);
  }
  return targets;
}

export async function livePanes(
  config: TmuxConfig,
  purpose: "startup" | "list" | { displayedIn: ReadonlySet<string> } = "startup",
  auditedSessions?: ManagedSession[],
): Promise<Pane[]> {
  const format = auditedSessions
    ? `${PANE_FORMAT}\t#{==:#{TICKET_DISPATCH_ROLE},pi}\t#{!=:#{PI_TMUX_SESSION_ID},}\t#{@pi-mux-launch}`
    : PANE_FORMAT;
  const result = await tmux(config, ["list-panes", "-a", "-F", format], true);
  const rows = result.stdout.replace(/\n$/, "");
  if (auditedSessions) {
    const reportsEmpty =
      result.exitCode === 0
        ? !rows
        : /^(no sessions|no current target)$/.test(result.stderr.trim());
    if (reportsEmpty) {
      if (!(await tmux(config, ["list-sessions", "-F", "#{session_id}"])).stdout.trim()) return [];
      throw new Error("Cannot confirm an empty tmux pane inventory");
    }
  } else if (result.exitCode !== 0) {
    if (result.stderr.includes("no sessions") || result.stderr.includes("no current target"))
      return [];
    if (purpose !== "startup" && serverIsAbsent(config, result.stderr)) return [];
  }
  if (result.exitCode !== 0) throw new Error(`Cannot inspect pi sessions: ${result.stderr.trim()}`);
  return parseLivePaneRows(rows, purpose, auditedSessions);
}

export function parseLivePaneRows(
  rows: string,
  purpose: "startup" | "list" | { displayedIn: ReadonlySet<string> },
  auditedSessions?: ManagedSession[],
): Pane[] {
  if (!rows) return [];
  return rows.split("\n").flatMap((line) => {
    const columns = line.split("\t");
    const [pane, session, name, encoded, pid, dead, windowActive, paneActive, ...audit] = columns;
    if (auditedSessions) {
      const hasValidPane = /^%\d+$/.test(pane ?? "") && /^\$\d+$/.test(session ?? "") && name;
      const [dispatcherPi, managedId, launch] = audit;
      const hasAuditFlags =
        audit.length === 3 &&
        [dead, dispatcherPi, managedId].every((flag) => flag === "0" || flag === "1");
      if (!hasValidPane || !hasAuditFlags) throw new Error("Invalid tmux pane inventory");
      if (dead === "0" && !encoded) {
        const managed = auditedSessions.find((entry) => entry.session === session);
        const hasUnidentifiedPi = (dispatcherPi === "1" || managedId === "1") && !managed;
        if (hasUnidentifiedPi || (launch && !launchMatchesManagedSession(launch, managed, pid)))
          throw new Error(`Cannot identify the starting pi in pane ${pane}`);
      }
    }
    if (!pane || !session || !name || !encoded || dead !== "0") return [];
    const active = windowActive === "1" && paneActive === "1";
    if (typeof purpose === "object" && (!active || !purpose.displayedIn.has(name))) return [];
    const metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (
      typeof metadata?.id !== "string" ||
      !SESSION_ID_PATTERN.test(metadata.id) ||
      typeof metadata.cwd !== "string" ||
      typeof metadata.file !== "string" ||
      !isAbsolute(metadata.cwd) ||
      !isAbsolute(metadata.file) ||
      !pid ||
      !/^[1-9]\d*$/.test(pid) ||
      metadata.pid !== Number(pid) ||
      (metadata.startup !== "accepted" &&
        metadata.startup !== "ready" &&
        !(purpose !== "startup" && metadata.startup === undefined))
    )
      throw new Error(`Invalid pi session metadata in pane ${pane}`);
    if (metadata.processPid !== undefined) {
      if (!Number.isSafeInteger(metadata.processPid) || metadata.processPid <= 0)
        throw new Error(`Invalid pi session metadata in pane ${pane}`);
      if (
        platform.processAncestryAvailable &&
        !platform.processDescendsFrom(metadata.processPid, Number(pid))
      ) {
        if (auditedSessions) throw new Error(`Cannot confirm the pi process in pane ${pane}`);
        return [];
      }
    }
    const reloadReadiness = metadata.reloadReadiness;
    return [
      {
        pane,
        session,
        name,
        active,
        pid: metadata.processPid ?? Number(pid),
        panePid: Number(pid),
        id: metadata.id,
        cwd: metadata.cwd,
        file: metadata.file,
        startup: metadata.startup,
        reloadReadiness:
          reloadReadiness === "pending" || reloadReadiness === "drained"
            ? reloadReadiness
            : undefined,
        warm: metadata.warm === true,
        metadata: encoded,
      },
    ];
  });
}

export function launchMatchesManagedSession(
  encoded: string,
  managed: ManagedSession | undefined,
  pid: string | undefined,
): boolean {
  if (!managed || !pid) return false;
  return matchesLaunch(encoded, managed.id, Number(pid), launchRecordToken(encoded));
}

export async function hasSession(config: Config, name: string): Promise<boolean> {
  const target = name.startsWith("$") ? name : `=${name}`;
  return (await tmux(config, ["has-session", "-t", target], true)).exitCode === 0;
}

export function sessionName(id: string): string {
  return `pi-${createHash("sha256").update(id).digest("hex")}`;
}
