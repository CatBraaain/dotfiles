import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import type { DispatchTicketOperation } from "./cli-arguments";
import {
  type Config,
  executable,
  GENERATED_ENV_KEYS,
  PARENT_ENV_KEYS,
  prepareDirectory,
  type TmuxConfig,
} from "./configuration";
import { LockBusyError, windowsClaimLock, withLock } from "./locks";
import {
  findFirstInput,
  hasSession,
  initializingPanes,
  livePanes,
  managedSessions,
  matchesLaunch,
  PANE_FORMAT,
  sessionName,
  waitForSession,
} from "./pane-inventory";
import { platform } from "./platform";
import { registerWorkspaces } from "./restore-state";
import { findExactSaved, findSaved } from "./saved-sessions";
import {
  type Candidate,
  errorMessage,
  type ManagedSession,
  type Pane,
  type Session,
} from "./session-model";
import {
  excludedGlobalEnvironment,
  serverLifetime,
  type ServerLifetime,
  serverOption,
  tmux,
  verifyServerLifetime,
  windowsManagement,
} from "./tmux";
import {
  auditWindowsDispatchInventory,
  inspectWindowsBeforeOpen,
  inspectWindowsRunningSession,
  startWindowsLaunch,
} from "./windows-launch";
import { windowsNpmPiCommand } from "./windows-pi-command";
import {
  conversationLaunchKey,
  ticketLaunchKey,
  type WindowsManagementBasis,
} from "./windows-launch-rights";

export async function createNew(
  config: Config,
  request?: string,
  windowsBasis?: WindowsManagementBasis,
): Promise<Pane> {
  const cwd = process.cwd();
  if (request === undefined) {
    const candidates = (await livePanes(config, "list")).filter(
      (pane) => pane.warm && pane.cwd === cwd && pane.startup === "ready" && !existsSync(pane.file),
    );
    const managed = candidates.length > 0 ? await managedSessions(config) : [];
    for (const pane of candidates) {
      if (
        !managed.some(
          (session) =>
            session.session === pane.session && session.id === pane.id && session.cwd === cwd,
        )
      )
        continue;
      const launch = await tmux(config, [
        "show-options",
        "-pqv",
        "-t",
        pane.pane,
        "@pi-mux-launch",
      ]);
      const metadata = JSON.parse(Buffer.from(pane.metadata, "base64").toString("utf8"));
      if (matchesLaunch(launch.stdout, pane.id, pane.panePid, metadata.token)) return pane;
    }
  }
  const id = randomUUID();
  const name = sessionName(id);
  const created = await createSession(
    config,
    {
      id,
      cwd,
      ...(request === undefined ? { warm: true } : { request }),
    },
    name,
    windowsBasis,
  );
  return await waitForSession(
    config,
    created ?? name,
    id,
    request === undefined ? "ready" : "accepted",
    cwd,
  );
}

type SavedSessionResolution = {
  windowsBasis?: WindowsManagementBasis;
  running?: Pane;
  managed?: ManagedSession;
  saved?: Session;
  recovery?: Candidate;
};

export async function resolveSaved(
  config: Config,
  id: string,
  restoreCwd?: string,
  expected?: WindowsManagementBasis,
): Promise<SavedSessionResolution> {
  const inspection = await (
    platform.windows
      ? inspectWindowsBeforeOpen(config, id, expected)
      : inspectRunningSession(config, id).then((result) => ({ ...result, basis: undefined }))
  ).catch((error: unknown) => {
    if (restoreCwd === undefined) throw error;
    return { error };
  });
  const saved = await findSaved(config, id, restoreCwd === undefined ? "open" : "restore");
  if (restoreCwd !== undefined) {
    if (!saved) return {};
    if (saved.cwd !== restoreCwd)
      throw new Error(`Saved working directory differs from snapshot: ${saved.cwd}`);
  }
  if ("error" in inspection) throw inspection.error;

  const { running, managed } = inspection;
  const recovery = !saved && !running && !managed ? findFirstInput(config, id) : undefined;
  if (!running && !managed) {
    const candidate = saved ?? recovery;
    if (!candidate) throw new Error(`Session not found (use the complete ID): ${id}`);
    if (!existsSync(candidate.cwd) || !statSync(candidate.cwd).isDirectory())
      throw new Error(`Session working directory does not exist: ${candidate.cwd}`);
  }
  return {
    running,
    managed,
    saved,
    recovery,
    windowsBasis: inspection.basis,
  };
}

type SessionInspection = { state: "present" } | { state: "absent"; file: string | null };

type DispatchTicketLaunch = { state: "present" } | { state: "launched"; session: string };

async function withSessionAudit<T>(
  config: TmuxConfig,
  inspect: (lifetime: ServerLifetime) => Promise<T>,
): Promise<T> {
  const stateDirectory = lstatSync(config.stateDirectory);
  platform.assertDirectorySafety(stateDirectory, config.stateDirectory);
  return await withLock(
    config,
    async () => {
      const lifetime = await serverLifetime(config);
      if (!lifetime) throw new Error("The dedicated tmux server is not running");
      if (!lifetime.generation)
        throw new Error("Dedicated server has not been initialized by pi-mux");
      return await inspect(lifetime);
    },
    "try",
  );
}

export async function inspectSession(config: TmuxConfig, id: string): Promise<SessionInspection> {
  try {
    if (platform.windows)
      return await withLock(
        config,
        async () => {
          const { running, managed, starting, restoring, basis } =
            await inspectWindowsRunningSession(config, id);
          const present = running || managed || starting || restoring;
          const saved = present ? undefined : await findSaved(config, id);
          await windowsManagement(config).assertLive(basis!);
          return present ? { state: "present" } : { state: "absent", file: saved?.file ?? null };
        },
        "try",
      );
    return await withSessionAudit<SessionInspection>(config, async (lifetime) => {
      const wasPresent = await auditSessionPresence(config, id);
      const saved = wasPresent ? undefined : await findSaved(config, id);
      const isPresent = wasPresent || (await auditSessionPresence(config, id));
      await verifyServerLifetime(config, lifetime, "inspect");
      return isPresent ? { state: "present" } : { state: "absent", file: saved?.file ?? null };
    });
  } catch (error) {
    if (error instanceof LockBusyError) throw error;
    throw new Error(`Cannot inspect session ${id}: ${errorMessage(error)}`);
  }
}

export async function launchDispatchedTicket(
  config: TmuxConfig,
  operation: DispatchTicketOperation,
): Promise<DispatchTicketLaunch> {
  if (!platform.windows && process.platform !== "linux")
    throw new Error("Ticket dispatch launch requires Linux or Windows");
  const { ownerId } = operation;
  if (ownerId === undefined && !platform.windows)
    throw new Error("Open ticket dispatch launch requires Windows");
  if (operation.socket !== config.socket)
    throw new Error("Ticket dispatch socket does not match pi-mux");
  const cwd = realpathSync(operation.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
  if (platform.windows)
    return await withLock(
      config,
      async () => {
        const ticketKey = ticketLaunchKey(operation.project, operation.ticketId);
        const keys =
          ownerId === undefined ? [ticketKey] : [conversationLaunchKey(ownerId), ticketKey];
        const management = windowsManagement(config);
        const rights = management.createLaunchRights(windowsClaimLock(management));
        await rights.discardUnclaimed(keys);

        let basis: WindowsManagementBasis;
        let names: string[];
        if (ownerId === undefined) {
          const inventory = await auditWindowsDispatchInventory(config);
          if (
            inventory.sessions.some(
              ({ project, ticketId }) => ticketLaunchKey(project, ticketId) === ticketKey,
            )
          )
            return { state: "present" };
          ({ basis, names } = inventory);
        } else {
          const owner = await inspectWindowsRunningSession(config, ownerId);
          if (owner.running || owner.managed || owner.starting || owner.restoring)
            return { state: "present" };
          basis = owner.basis!;
          const audit = await management.audit(PANE_FORMAT);
          names = audit.panes.map(({ peer }) => peer.name);
        }
        if (names.includes(operation.sessionName))
          throw new Error(`Ticket tmux session already exists: ${operation.sessionName}`);
        const piCommand = windowsNpmPiCommand();
        prepareDirectory(config.stateDirectory);
        registerWorkspaces(config, [cwd]);
        const session = await startWindowsLaunch(config, {
          keys,
          basis,
          name: operation.sessionName,
          cwd,
          ownerId,
          environment: { ...config.env, ...dispatchTicketEnvironment(config, operation) },
          command: [...piCommand, "--", operation.prompt],
        });
        return { state: "launched", session };
      },
      "try",
    );
  return await withSessionAudit<DispatchTicketLaunch>(config, async (lifetime) => {
    const isPresent = await auditSessionPresence(config, ownerId!);
    await verifyServerLifetime(config, lifetime, "ticket dispatch launch");
    if (isPresent) return { state: "present" };

    const args = dispatchTicketSessionArgs(config, operation, cwd);
    registerWorkspaces(config, [cwd]);
    const result = await tmux(config, args);
    const session = result.stdout.trimEnd();
    if (!/^\$[0-9]+$/.test(session))
      throw new Error("Cannot identify the created ticket tmux session");
    return { state: "launched", session };
  });
}

function dispatchTicketEnvironment(
  config: TmuxConfig,
  { project, ticketId }: DispatchTicketOperation,
): Record<string, string> {
  const desired: Record<string, string> = {
    PI_CODING_AGENT_DIR: config.agentDir,
    TICKET_DISPATCH_ROLE: "pi",
    TICKET_DISPATCH_PROJECT: project,
    TICKET_DISPATCH_ID: ticketId,
  };
  const keys = ["HOME", "PATH", "PI_CODING_AGENT_SESSION_DIR"];
  if (platform.windows) keys.push("USERPROFILE", "PSMUX_DATA_DIR", "PSMUX_NO_WARM");
  for (const key of keys) {
    const value = config.env[key];
    if (value !== undefined) desired[key] = value;
  }
  return desired;
}

function dispatchTicketSessionArgs(
  config: TmuxConfig,
  operation: DispatchTicketOperation,
  cwd: string,
): string[] {
  const { sessionName, prompt } = operation;
  const desired = dispatchTicketEnvironment(config, operation);
  const unset = [...PARENT_ENV_KEYS].filter(
    (key) => !GENERATED_ENV_KEYS.has(key) && !Object.hasOwn(desired, key),
  );
  if (config.env.PI_CODING_AGENT_SESSION_DIR === undefined)
    unset.push("PI_CODING_AGENT_SESSION_DIR");
  const environment = Object.entries(desired).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const command = platform.paneCommand([executable("pi"), "--", prompt], unset);
  return [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}",
    "-s",
    sessionName,
    "-c",
    cwd.replaceAll("#", "##"),
    ...environment,
    "--",
    `exec ${command}`,
  ].map((arg) => (arg.endsWith(";") ? arg.slice(0, -1) + "\\;" : arg));
}

async function auditSessionPresence(config: TmuxConfig, id: string): Promise<boolean> {
  const marker = await serverOption(config, `@pi-mux-restoring-${id}`);
  if (marker !== "" && marker !== "1") throw new Error("Invalid in-memory restore state");
  const { running, managed } = await inspectRunningSession(config, id, "audit");
  return running !== undefined || managed !== undefined || marker === "1";
}

async function inspectRunningSession(
  config: TmuxConfig,
  id: string,
  mode: "open" | "audit" = "open",
) {
  const isAudit = mode === "audit";
  const allManaged = await managedSessions(config, isAudit);
  const managed = allManaged.filter((session) => session.id === id);
  if (managed.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const running = (await livePanes(config, "list", isAudit ? allManaged : undefined)).filter(
    (pane) => pane.id === id,
  );
  const [active] = running;
  const [target] = managed;
  if (running.length > 1 || (isAudit && active && target && active.session !== target.session))
    throw new Error(`Multiple pi processes are running for session ${id}`);
  if (isAudit && target && !active) {
    const initializing = await initializingPanes(config, [target], []);
    if (initializing.length !== 1)
      throw new Error(`Cannot identify a single starting pi for managed session ${id}`);
  }
  return { running: active, managed: target };
}

export async function openExactSession(config: Config, id: string, file: string): Promise<Pane> {
  if (platform.windows)
    return await withLock(
      config,
      async () => {
        const key = conversationLaunchKey(id);
        const management = windowsManagement(config);
        await management.createLaunchRights(windowsClaimLock(management)).discardUnclaimed([key]);
        const { running, managed, starting, restoring, basis } = await inspectWindowsRunningSession(
          config,
          id,
        );
        if (restoring)
          throw new Error(`Cannot confirm the exact file of a restoring session: ${id}`);
        const saved = await findExactSaved(config, id, file);
        if ((managed || starting) && !running)
          throw new Error(`Cannot confirm the exact file of a starting session: ${id}`);
        const pane = running ?? (await startExactSession(config, saved, basis));
        if (pane.file !== saved.file || pane.cwd !== saved.cwd || pane.startup !== "ready")
          throw new Error(`Running session does not match the expected file and cwd: ${id}`);
        await management.assertLive(basis!);
        return pane;
      },
      "try",
    );
  return await withSessionAudit(config, async (lifetime) => {
    if ((await serverOption(config, "@pi-mux-restored")) !== lifetime.generation)
      throw new Error("Dedicated server has not completed startup restore");
    if (await serverOption(config, `@pi-mux-restoring-${id}`))
      throw new Error(`Cannot confirm the exact file of a restoring session: ${id}`);
    const { running, managed } = await inspectRunningSession(config, id, "audit");
    const saved = await findExactSaved(config, id, file);
    if (managed && !running)
      throw new Error(`Cannot confirm the exact file of a starting session: ${id}`);
    await verifyServerLifetime(config, lifetime, "exact session reopen");
    const pane = running ?? (await startExactSession(config, saved));
    if (pane.file !== saved.file || pane.cwd !== saved.cwd || pane.startup !== "ready")
      throw new Error(`Running session does not match the expected file and cwd: ${id}`);
    await verifyServerLifetime(config, lifetime, "exact session reopen");
    return pane;
  });
}

async function startExactSession(
  config: Config,
  saved: Session,
  basis?: WindowsManagementBasis,
): Promise<Pane> {
  const target = await createSession(config, saved, sessionName(saved.id), basis);
  if (!target) throw new Error(`Cannot confirm the exact file of a competing session: ${saved.id}`);
  const pane = await waitForSession(config, target, saved.id, "ready", saved.cwd);
  if (pane.session !== target)
    throw new Error(`Cannot confirm the session created for the expected file: ${saved.id}`);
  return pane;
}

export async function openSaved(
  config: Config,
  id: string,
  mode: "normal" | "temporary" = "normal",
  expected?: WindowsManagementBasis,
): Promise<Pane> {
  if (platform.windows) {
    const management = windowsManagement(config);
    await management
      .createLaunchRights(windowsClaimLock(management))
      .discardUnclaimed([conversationLaunchKey(id)]);
  }
  const resolution = await resolveSaved(config, id, undefined, expected);
  return await openResolvedSession(config, id, resolution, mode);
}

export async function openResolvedSession(
  config: Config,
  id: string,
  { running, managed, saved, recovery, windowsBasis: resolutionBasis }: SavedSessionResolution,
  mode: "normal" | "temporary" = "normal",
  restoringBasis?: WindowsManagementBasis,
): Promise<Pane> {
  const basis = restoringBasis ?? resolutionBasis;
  if (basis) await windowsManagement(config).assertLive(basis);
  if (running) return running;
  if (managed) return await waitForSession(config, managed.session, id);
  const candidate = saved ?? recovery;
  if (!candidate) throw new Error(`Session not found (use the complete ID): ${id}`);
  const name = sessionName(id);
  const created = await createSession(
    config,
    { id, cwd: candidate.cwd, file: saved?.file, temporary: mode === "temporary" },
    name,
    basis,
    restoringBasis === undefined,
  );
  return await waitForSession(config, created ?? name, id, "ready", candidate.cwd);
}

async function createSession(
  config: Config,
  session: {
    id: string;
    cwd: string;
    file?: string;
    request?: string;
    temporary?: boolean;
    warm?: boolean;
  },
  name: string,
  windowsBasis?: WindowsManagementBasis,
  requireRestored = true,
): Promise<string | undefined> {
  const startupCommand =
    session.request === undefined ? `pi-mux-startup-${randomUUID()}` : undefined;
  const launchToken = randomUUID();
  const desired = {
    ...config.env,
    PI_TMUX_SESSION_ID: session.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
    ...(session.temporary ? { PI_TMUX_TEMPORARY: session.id } : {}),
    ...(startupCommand === undefined
      ? { PI_TMUX_STARTUP_MODE: "create" }
      : { PI_TMUX_STARTUP_COMMAND: startupCommand }),
    ...(session.warm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  const selection = session.file ? ["--session", session.file] : ["--session-id", session.id];
  const command = [
    ...config.piCommand(),
    ...selection,
    "-e",
    config.extension,
    ...(session.request === undefined
      ? ["--", `/${startupCommand}`]
      : ["--agent", "main", "--", session.request]),
  ];
  if (platform.windows) {
    const management = windowsManagement(config);
    const basis = windowsBasis ?? (await management.audit(PANE_FORMAT, { requireRestored })).basis;
    return await startWindowsLaunch(config, {
      keys: [conversationLaunchKey(session.id)],
      basis,
      name: `${name}-${launchToken.slice(0, 12)}`,
      cwd: session.cwd,
      environment: desired,
      command,
      requireRestored,
    });
  }
  const removed = await excludedGlobalEnvironment(config, desired);
  const launch = platform.newSessionLaunch(command, desired, removed);
  const result = await tmux(
    config,
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}\t#{pane_id}\t#{pane_pid}",
      "-s",
      name,
      "-n",
      "pi",
      "-c",
      session.cwd,
      "-x",
      String(process.stdout.columns || 80),
      "-y",
      String(process.stdout.rows || 24),
      ...launch.environmentArgs,
      "--",
      ...(session.request === undefined
        ? platform.tmuxPaneCommand(launch.paneCommand)
        : [launch.paneCommand]),
    ],
    true,
  );
  if (result.exitCode === 0) {
    const [target, pane, pid] = result.stdout.trim().split("\t");
    if (
      !target ||
      !/^\$[0-9]+$/.test(target) ||
      !pane ||
      !/^%[0-9]+$/.test(pane) ||
      !pid ||
      !/^[1-9]\d*$/.test(pid)
    )
      throw new Error("Cannot identify the created tmux session and pane");
    if (launch.transportKey)
      await tmux(config, ["set-environment", "-u", "-t", target, launch.transportKey]);
    if (!platform.processIsAlive(Number(pid)))
      throw new Error(`pi exited before launch was recorded: ${session.id}`);
    await tmux(config, [
      "set-option",
      "-p",
      "-t",
      pane,
      "@pi-mux-launch",
      JSON.stringify({ id: session.id, pid: Number(pid), token: launchToken }),
    ]);
    return target;
  }
  if (await hasSession(config, name)) return undefined;
  throw new Error(`Cannot start pi session: ${result.stderr.trim()}`);
}
