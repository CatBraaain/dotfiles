import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import {
  DISPATCH_TICKET_ID_MAX_LENGTH,
  DISPATCH_TICKET_ID_PATTERN,
  type WindowsCreateDispatchWorker,
} from "./cli-arguments";
import {
  cliInvocation,
  GENERATED_ENV_KEYS,
  PARENT_ENV_KEYS,
  PI_HARDWARE_CURSOR_ENV,
  PSMUX_ROUTING,
  type TmuxConfig,
  tmuxConfiguration,
} from "./configuration";
import { InitialRequestFiles } from "./initial-request-files";
import { windowsClaimLock } from "./locks";
import {
  launchRecordToken,
  matchesLaunch,
  PANE_FORMAT,
  parseLivePaneRows,
  sessionName,
} from "./pane-inventory";
import { platform } from "./platform";
import {
  errorMessage,
  type ManagedSession,
  POLL_INTERVAL_MS,
  SESSION_ID_PATTERN,
  STARTUP_TIMEOUT_MS,
  UUID,
} from "./session-model";
import { excludedGlobalEnvironment, tmux, windowsManagement } from "./tmux";
import {
  conversationLaunchKey,
  launchBasisStillLive,
  SpawnDidNotStartError,
  ticketLaunchKey,
  type WindowsLaunchRights,
  type WindowsLaunchStatus,
  type WindowsManagementBasis,
} from "./windows-launch-rights";

export const WINDOWS_RIGHT_ENV = "PI_MUX_WINDOWS_START_RIGHT";

export const WINDOWS_RIGHT_OPTION = "@pi-mux-windows-start-right";

export async function claimWindowsLaunch(
  token: string,
  command: string[],
  cwd: string,
): Promise<number> {
  return await claimWindowsPaneLaunch(token, { command, cwd });
}

export async function claimWindowsInitialRequest(token: string): Promise<number> {
  return await claimWindowsPaneLaunch(token);
}

type WindowsPiCommand = { command: string[]; cwd: string };

async function claimWindowsPaneLaunch(token: string, inline?: WindowsPiCommand): Promise<number> {
  const config = tmuxConfiguration();
  const management = windowsManagement(config);
  const route = process.env.PSMUX_TARGET_SESSION;
  const pane = process.env.TMUX_PANE;
  const [socket, port, index] = (process.env.TMUX ?? "").split(",");
  const localAlias = /^\/tmp\/psmux-\d+\/([A-Za-z0-9_.-]+)$/.exec(socket ?? "")?.[1];
  const intoNamespace =
    socket === config.socket ||
    (localAlias !== undefined &&
      localAlias === management.scope.namespace &&
      win32.basename(config.socket) === localAlias);
  if (
    !intoNamespace ||
    !/^[1-9]\d{0,4}$/.test(port ?? "") ||
    Number(port) > 65535 ||
    !/^\d+$/.test(index ?? "") ||
    !/^%\d+$/.test(pane ?? "") ||
    process.env[WINDOWS_RIGHT_ENV] !== token ||
    !route
  )
    throw new Error("Cannot identify a Windows pi launch pane");
  const prefix = `${management.scope.namespace}__`;
  if (!route.startsWith(prefix)) throw new Error("Invalid Windows pi launch pane scope");
  const name = route.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid Windows pi launch pane name");
  const routed = {
    ...config,
    env: { ...config.env, TMUX: process.env.TMUX!, PSMUX_TARGET_SESSION: route },
  };
  const launchToken = process.env.PI_TMUX_LAUNCH_TOKEN;
  const id = process.env.PI_TMUX_SESSION_ID;
  const isInitialRequest = inline === undefined;
  if (
    isInitialRequest &&
    (!id ||
      !UUID.test(id) ||
      !launchToken ||
      !UUID.test(launchToken) ||
      process.env.PI_TMUX_STARTUP_MODE !== "create" ||
      name !== `${sessionName(id)}-${launchToken.slice(0, 12)}`)
  )
    throw new Error("Cannot identify the Windows initial-request session");

  async function readPanePid() {
    const identity = await tmux(routed, [
      "display-message",
      "-p",
      "-t",
      pane!,
      `#{session_name}\t#{pane_id}\t#{pane_pid}\t#{${WINDOWS_RIGHT_ENV}}`,
    ]);
    const [actualName, paneId, panePid, paneToken] = identity.stdout.trimEnd().split("\t");
    if (
      actualName !== name ||
      paneId !== pane ||
      paneToken !== token ||
      !/^[1-9]\d*$/.test(panePid ?? "")
    )
      throw new Error("Windows pi launch pane identity changed");
    return Number(panePid);
  }

  const panePid = await readPanePid();
  let files: InitialRequestFiles | undefined;
  const prepare = async () => {
    if (isInitialRequest) {
      files = InitialRequestFiles.open(config);
      if ((await readPanePid()) !== panePid)
        throw new Error("Windows pi launch pane identity changed");
    }
    if (id && launchToken)
      await tmux(routed, [
        "set-option",
        "-p",
        "-t",
        pane!,
        "@pi-mux-launch",
        JSON.stringify({ id, pid: panePid, token: launchToken }),
      ]);
    await tmux(routed, ["set-option", "-p", "-t", pane!, WINDOWS_RIGHT_OPTION, token]);
  };
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const started = await rights.claimAndStart(
    token,
    randomUUID(),
    (basis) => {
      let launch: WindowsPiCommand;
      try {
        launch =
          inline ??
          files!.take(token, {
            socket: config.socket,
            session: name,
            generation: basis.instance,
            id: id!,
            launchToken: launchToken!,
          });
      } catch {
        throw new SpawnDidNotStartError(
          "Cannot start Pi: the initial-request arguments were not claimed",
        );
      }
      const { command, cwd } = launch;
      const env = { ...process.env };
      configureWindowsPiEnvironment(env, `${config.socket},${port},${index}`);
      try {
        return Bun.spawn(command, {
          cwd,
          env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
      } catch (error) {
        if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          if (isInitialRequest)
            throw new SpawnDidNotStartError("Cannot start Pi with the initial-request arguments");
          throw new SpawnDidNotStartError(errorMessage(error), { cause: error });
        }
        if (isInitialRequest)
          throw new Error("Cannot confirm whether Pi started with the initial-request arguments");
        throw error;
      }
    },
    prepare,
    isInitialRequest ? name : undefined,
  );
  return started ? await started.started.exited : 1;
}

export function configureWindowsPiEnvironment(env: NodeJS.ProcessEnv, tmux: string): void {
  for (const key of Object.keys(env))
    if (key.toUpperCase() === PI_HARDWARE_CURSOR_ENV) delete env[key];
  env[PI_HARDWARE_CURSOR_ENV] = "1";
  delete env[WINDOWS_RIGHT_ENV];
  env.TMUX = tmux;
}

type WindowsLaunch = {
  keys: string[];
  basis: WindowsManagementBasis;
  name: string;
  cwd: string;
  ownerId?: string;
  environment: Record<string, string>;
  command: string[];
  requireRestored?: boolean;
  initialRequest?: { id: string; launchToken: string };
};

export async function startWindowsLaunch(
  config: TmuxConfig,
  action: WindowsLaunch,
): Promise<string> {
  const {
    basis,
    keys,
    cwd,
    name,
    environment,
    command,
    ownerId,
    requireRestored = true,
    initialRequest,
  } = action;
  const files = initialRequest ? InitialRequestFiles.open(config, true) : undefined;
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const right = await rights.reserveAfterLifecycleAudit(keys, basis, {
    requireRestored,
    initialRequestSession: initialRequest ? name : undefined,
  });
  if (right.state !== "reserved") throw new Error("A competing Windows pi launch is still running");
  const { token } = right;
  try {
    const env: Record<string, string> = { ...environment, [WINDOWS_RIGHT_ENV]: token };
    const unset = [
      ...new Set([
        ...(await excludedGlobalEnvironment(config, env)).filter((key) => !PSMUX_ROUTING.has(key)),
        ...[...PARENT_ENV_KEYS].filter(
          (key) => !GENERATED_ENV_KEYS.has(key) && !Object.hasOwn(env, key),
        ),
        ...(env.PI_CODING_AGENT_SESSION_DIR === undefined ? ["PI_CODING_AGENT_SESSION_DIR"] : []),
      ]),
    ];
    let launchArgs: string[];
    if (initialRequest) {
      files!.publish(token, {
        ...initialRequest,
        socket: config.socket,
        session: name,
        generation: basis.instance,
        cwd,
        command,
      });
      launchArgs = ["claim-initial-request", token];
    } else {
      const payload = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
      const destination = Buffer.from(JSON.stringify(cwd), "utf8").toString("base64");
      launchArgs = ["windows-claim-launch", token, payload, destination];
    }
    const launch = platform.newSessionLaunch([...cliInvocation(), ...launchArgs], env, unset);
    await tmux(config, [
      "new-session",
      "-d",
      "-s",
      name,
      "-n",
      "pi",
      "-c",
      cwd.replaceAll("#", "##"),
      "-x",
      String(process.stdout.columns || 80),
      "-y",
      String(process.stdout.rows || 24),
      ...launch.environmentArgs,
      "--",
      ...platform.tmuxPaneCommand(launch.paneCommand),
    ]);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await rights.status(token);
      if (status.state === "live" && "receipt" in status) {
        const audit = await management.audit(
          `#{session_id}\t#{@pi-mux-windows-start-right}\t#{pane_dead}`,
          { requireRestored },
        );
        const launched = audit.panes.find(({ peer }) => peer.name === name);
        const target = launched?.rows
          .map((row) => row.split("\t"))
          .filter(([, recorded, dead]) => recorded === token && dead === "0");
        if (!target || target.length !== 1 || !/^\$\d+$/.test(target[0]?.[0] ?? ""))
          throw new Error("Cannot confirm the Windows pi launch pane");
        await management.assertLive(basis);
        await rights.complete(token, status.receipt, ownerId);
        if (launch.transportKey)
          await tmux(config, ["set-environment", "-u", "-t", `=${name}`, launch.transportKey]);
        return target[0]![0]!;
      }
      if (status.state === "missing" || status.state === "ended" || status.state === "unknown")
        throw new Error("The Windows pi launch did not remain active");
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    throw new Error("Timed out confirming the Windows pi launch");
  } finally {
    try {
      await rights.cancelUnclaimed(token);
    } finally {
      files?.cancel(token);
    }
  }
}

export async function createWindowsDispatchWorker(
  config: TmuxConfig,
  worker: WindowsCreateDispatchWorker,
): Promise<void> {
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (win32.normalize(worker.powershell).toLowerCase() !== powershell.toLowerCase())
    throw new Error("Unexpected Windows dispatcher worker shell");
  const cwd = realpathSync(worker.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error("Invalid Windows dispatcher workspace");
  const management = windowsManagement(config);
  const audit = await management.audit("#{session_id}");
  if (audit.basis.instance !== worker.generation)
    throw new Error("Windows pi-mux management changed before dispatcher creation");
  if (audit.panes.some(({ peer }) => peer.name === worker.name))
    throw new Error(`Dispatcher session already exists: ${worker.name}`);
  await tmux(config, [
    "new-session",
    "-d",
    "-s",
    worker.name,
    "-c",
    cwd.replaceAll("#", "##"),
    "-e",
    `TICKET_DISPATCH_WORKER_TOKEN=${worker.token}`,
    "-e",
    "TICKET_DISPATCH_ROLE=dispatcher",
    "-e",
    `TICKET_DISPATCH_PROJECT=${worker.project}`,
    "--",
    powershell,
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    worker.command,
  ]);
  await management.assertLive(audit.basis);
}

async function selectWindowsLaunchPanes<
  T extends {
    token: string | undefined;
    paneToken: string | undefined;
    hasPiMetadata?: boolean;
  },
>(name: string, rows: T[], rights: WindowsLaunchRights) {
  const groups = new Map<string, T[]>();
  const selected: { row: T; status?: Extract<WindowsLaunchStatus, { receipt: unknown }> }[] = [];
  for (const row of rows) {
    const { token, paneToken } = row;
    if (paneToken && paneToken !== token)
      throw new Error(`Conflicting Windows pi launch markers in ${name}`);
    if (!token) {
      selected.push({ row });
      continue;
    }
    if (!UUID.test(token)) throw new Error(`Invalid Windows pi launch token in ${name}`);
    const group = groups.get(token) ?? [];
    group.push(row);
    groups.set(token, group);
  }
  for (const [token, group] of groups) {
    const status = await rights.status(token);
    if (status.state === "missing" || status.state === "ended" || status.state === "reserved") {
      if (
        group.some(({ hasPiMetadata }) => hasPiMetadata) ||
        (status.state === "missing" && group.some(({ paneToken }) => paneToken))
      )
        throw new Error(`Windows pi pane has no verifiable live launch in ${name}`);
      continue;
    }
    const marked = group.filter(({ paneToken }) => paneToken === token);
    if (
      status.state !== "live" ||
      !("receipt" in status) ||
      marked.length !== 1 ||
      group.some(({ paneToken, hasPiMetadata }) => !paneToken && hasPiMetadata)
    )
      throw new Error(`Cannot confirm the Windows pi launch outcome in ${name}`);
    selected.push({ row: marked[0]!, status });
  }
  return selected;
}

export async function auditWindowsDispatchInventory(config: TmuxConfig) {
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const unaccounted = new Set(await rights.fenceForDispatchInventory());
  const audit = await management.audit(
    `#{TICKET_DISPATCH_ROLE}\t#{TICKET_DISPATCH_PROJECT}\t#{TICKET_DISPATCH_ID}\t#{session_created}\t#{pane_dead}\t#{${WINDOWS_RIGHT_ENV}}\t#{${WINDOWS_RIGHT_OPTION}}`,
  );
  const sessions: { name: string; project: string; ticketId: string; created: number }[] = [];
  for (const { peer, rows } of audit.panes) {
    const parsed = rows.flatMap((row) => {
      const parts = row.split("\t");
      if (parts.length !== 7 || !["0", "1"].includes(parts[4]!))
        throw new Error(`Invalid Windows ticket dispatch pane in ${peer.name}`);
      const [role, project, ticketId, time, dead, token, paneToken] = parts;
      return role === "pi" && dead === "0" ? [{ project, ticketId, time, token, paneToken }] : [];
    });
    let entry: (typeof sessions)[number] | undefined;
    for (const {
      row: { project, ticketId, time, token },
      status,
    } of await selectWindowsLaunchPanes(peer.name, parsed, rights)) {
      const created = Number(time);
      if (
        !project ||
        [".", ".."].includes(project) ||
        /[\\/\0\r\n]/.test(project) ||
        !ticketId ||
        ticketId.length > DISPATCH_TICKET_ID_MAX_LENGTH ||
        !DISPATCH_TICKET_ID_PATTERN.test(ticketId) ||
        !/^[1-9]\d*$/.test(time ?? "") ||
        !Number.isSafeInteger(created)
      )
        throw new Error(`Invalid Windows ticket dispatch metadata in ${peer.name}`);
      if (token && status) {
        if (!unaccounted.delete(token))
          throw new Error(`Unexpected or duplicate Windows dispatch launch in ${peer.name}`);
        await rights.completeDispatched(
          token,
          status.receipt,
          audit.basis,
          ticketLaunchKey(project, ticketId),
        );
      }
      const candidate = { name: peer.name, project, ticketId, created };
      if (entry && JSON.stringify(entry) !== JSON.stringify(candidate))
        throw new Error(`Ambiguous Windows ticket dispatch metadata in ${peer.name}`);
      entry = candidate;
    }
    if (entry) sessions.push(entry);
  }
  for (const token of unaccounted) {
    if ((await rights.status(token)).state !== "ended")
      throw new Error("Cannot locate a live Windows ticket launch in the pane inventory");
  }
  await management.assertLive(audit.basis);
  return { sessions, basis: audit.basis, names: audit.panes.map(({ peer }) => peer.name) };
}

export async function inspectWindowsBeforeOpen(
  config: TmuxConfig,
  id: string,
  expected?: WindowsManagementBasis,
) {
  const basis = expected ?? (await windowsManagement(config).currentBasis());
  if (!basis) return { running: undefined, managed: undefined, basis: undefined };
  return await inspectWindowsRunningSession(config, id, false, basis);
}

export async function inspectWindowsRunningSession(
  config: TmuxConfig,
  id: string,
  requireRestored = true,
  expected?: WindowsManagementBasis,
) {
  const management = windowsManagement(config);
  const audit = await management.audit(
    `${PANE_FORMAT}\t#{PI_TMUX_SESSION_ID}\t#{TICKET_DISPATCH_ROLE}\t#{${WINDOWS_RIGHT_ENV}}\t#{@pi-mux-launch}\t#{session_path}\t#{${WINDOWS_RIGHT_OPTION}}\t#{TICKET_DISPATCH_PROJECT}\t#{TICKET_DISPATCH_ID}`,
    { requireRestored },
  );
  if (expected && !launchBasisStillLive(expected, audit.basis))
    throw new Error("The dedicated psmux management generation changed during inspection");
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const allPanes: string[] = [];
  const candidates = new Map<string, ManagedSession>();
  const seenTokens = new Set<string>();
  for (const { peer, rows } of audit.panes) {
    const live = rows.flatMap((row) => {
      const fields = row.split("\t");
      if (fields.length !== 16) throw new Error("Invalid Windows pi pane inventory");
      const [pane, session, name, metadata, pid, dead, , , , , token, launch, , paneToken] = fields;
      if (!pane || !session || !name || !pid || !["0", "1"].includes(dead!))
        throw new Error("Invalid Windows pi pane identity");
      return dead === "0"
        ? [
            {
              fields,
              pane,
              session,
              name,
              pid,
              token,
              paneToken,
              hasPiMetadata: !!(metadata || launch),
            },
          ]
        : [];
    });
    for (const {
      row: { fields, session, name, pid, token },
      status,
    } of await selectWindowsLaunchPanes(peer.name, live, rights)) {
      const [, , , metadata, , , , , managedId, role, , launch, cwd, , project, ticketId] = fields;
      if (metadata) allPanes.push(fields.slice(0, 8).join("\t"));
      if (managedId && (!SESSION_ID_PATTERN.test(managedId) || !isAbsolute(cwd ?? "")))
        throw new Error("Invalid Windows managed conversation or workspace");
      if (token && status) {
        if (seenTokens.has(token)) throw new Error(`Duplicate Windows pi launch token in ${name}`);
        seenTokens.add(token);
        if (role === "pi") {
          if (!project || !ticketId)
            throw new Error(`Cannot identify a Windows ticket dispatch in ${name}`);
          if (!status.completed)
            await rights.completeDispatched(
              token,
              status.receipt,
              audit.basis,
              ticketLaunchKey(project, ticketId),
            );
          if (!metadata) continue;
        }
        if (metadata) {
          const published = parseLivePaneRows(fields.slice(0, 8).join("\t"), "list");
          if (
            published.length !== 1 ||
            published[0]!.pid !== status.receipt.child.pid ||
            (managedId !== undefined && managedId !== "" && published[0]!.id !== managedId)
          )
            throw new Error(
              `Published metadata does not correspond to the Windows launch in ${name}`,
            );
        }
      }
      if (
        !metadata &&
        (role === "pi" ||
          (launch &&
            (!managedId ||
              !matchesLaunch(launch, managedId, Number(pid), launchRecordToken(launch)))))
      )
        throw new Error(`Cannot identify the starting pi in ${name}`);
      if (!metadata && managedId && !launch)
        throw new Error(`Cannot identify the starting managed conversation in ${name}`);
      if (managedId?.toLowerCase() === id.toLowerCase())
        candidates.set(session, { session, id: managedId, cwd: cwd!, temporary: false });
    }
  }
  const running = parseLivePaneRows(allPanes.join("\n"), "list").filter(
    (pane) => pane.id.toLowerCase() === id.toLowerCase(),
  );
  if (
    running.length > 1 ||
    candidates.size > 1 ||
    (running[0] && candidates.size > 0 && !candidates.has(running[0].session))
  )
    throw new Error(`Multiple pi processes are running for session ${id}`);
  const starting = (await rights.inspect([conversationLaunchKey(id)])) === "present";
  await management.assertLive(audit.basis);
  return {
    running: running[0],
    managed: [...candidates.values()][0],
    starting,
    restoring: audit.startup?.restoring.includes(id.toLowerCase()),
    basis: audit.basis,
  };
}
