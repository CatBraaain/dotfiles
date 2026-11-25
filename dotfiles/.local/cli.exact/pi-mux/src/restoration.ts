import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { cliInvocation, type Config, type TmuxConfig } from "./configuration";
import { openResolvedSession, resolveSaved } from "./launch-session";
import { windowsClaimLock } from "./locks";
import { managedSessions } from "./pane-inventory";
import { platform } from "./platform";
import { readSnapshot, type RestoreState, uniqueCandidates, writeSnapshot } from "./restore-state";
import {
  type Candidate,
  errorMessage,
  POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
} from "./session-model";
import { serverOption, tmux, tmuxQueries, windowsManagement } from "./tmux";
import { launchBasisStillLive, type WindowsManagementBasis } from "./windows-launch-rights";
import { configureWindowsPeer, WINDOWS_BOOTSTRAP_PROOF } from "./windows-lifecycle";

export type WindowsBootstrap = "start" | "fresh" | WindowsManagementBasis;

export async function bootstrapServer(
  config: Config,
  mode: WindowsBootstrap | "existing" = "start",
): Promise<{ generation: string; basis?: WindowsManagementBasis }> {
  const invocation = cliInvocation();
  const hookCommand = platform.hookCommand(
    [...invocation, "snapshot"],
    platform.windows
      ? { PI_CODING_AGENT_DIR: config.agentDir }
      : {
          HOME: config.env.HOME || homedir(),
          PATH: config.env.PATH || "",
          XDG_RUNTIME_DIR: dirname(config.directory),
          PI_CODING_AGENT_DIR: config.agentDir,
        },
  );
  if (platform.windows) {
    const management = windowsManagement(config);
    const existing = typeof mode === "object" ? mode : await management.currentBasis();
    let proof: string | undefined;
    if (existing) {
      if (mode === "fresh")
        throw new Error("A different psmux generation appeared before fresh bootstrap");
    } else if (mode !== "existing") {
      proof = randomUUID();
      await tmux({ ...config, env: { ...config.env, [WINDOWS_BOOTSTRAP_PROOF]: proof } }, [
        "start-server",
      ]);
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (!(await management.currentBasis()) && Date.now() < deadline) {
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }
    const audit = await management.audit("#{pane_id}", { requireRestored: false });
    if (existing && !launchBasisStillLive(existing, audit.basis))
      throw new Error("The dedicated psmux management generation changed during startup");
    await configureWindowsPeer(management.scope, audit, {
      configFile: config.tmuxConfig,
      hookCommand,
      proof,
    });
    await management.assertLive(audit.basis);
    return { generation: audit.basis.instance, basis: audit.basis };
  }
  if (mode !== "existing") await tmux(config, ["start-server"]);
  await tmux(config, ["source-file", config.tmuxConfig]);
  const existing = await serverOption(config, "@pi-mux-generation");
  const generation = existing || randomUUID();
  if (!existing) await tmux(config, ["set-option", "-g", "@pi-mux-generation", generation]);
  await tmux(config, ["set-option", "-g", "@pi-mux-snapshot", hookCommand]);
  return { generation };
}

export async function startAndRestore(
  config: Config,
  restoreRequested: boolean,
  temporaryTarget?: string,
  bootstrap: WindowsBootstrap = "start",
): Promise<{ failures: number; basis?: WindowsManagementBasis }> {
  const { generation, basis } = await bootstrapServer(config, bootstrap);
  const management = basis ? windowsManagement(config) : undefined;
  if (management && basis) {
    await management.assertLive(basis);
    if (!restoreRequested && management.startupState(basis)?.restored)
      return { failures: 0, basis };
    const restoring = (readSnapshot(config)?.sessions ?? [])
      .filter(({ id }) => id !== temporaryTarget)
      .map(({ id }) => id);
    await management.prepareStartup(basis, restoring, windowsClaimLock(management));
  }
  const restored = platform.windows ? "" : await serverOption(config, "@pi-mux-restored");
  if (!restoreRequested && restored === generation) return { failures: 0 };
  let failures = 0;
  try {
    failures = await restoreSessions(config, generation, temporaryTarget, basis);
  } catch (error) {
    console.error(`pi-mux: restore failed: ${errorMessage(error)}`);
    failures++;
  }
  if (management && basis) {
    await management.markRestored(basis, windowsClaimLock(management));
    await management.assertLive(basis);
  } else await tmux(config, ["set-option", "-g", "@pi-mux-restored", generation]);
  return { failures, basis };
}

async function restoreSessions(
  config: Config,
  generation: string,
  temporaryTarget?: string,
  windowsBasis?: WindowsManagementBasis,
): Promise<number> {
  const management = windowsBasis ? windowsManagement(config) : undefined;
  const previous = readSnapshot(config);
  const temporaryIds = new Set(
    (await managedSessions(config)).filter((entry) => entry.temporary).map((entry) => entry.id),
  );
  if (management && windowsBasis) await management.assertLive(windowsBasis);
  if (temporaryTarget) temporaryIds.add(temporaryTarget);
  const candidates = uniqueCandidates(previous?.sessions ?? []).filter(
    (entry) => !temporaryIds.has(entry.id),
  );
  let state: RestoreState = {
    ...previous,
    version: 1,
    generation,
    cwds: previous?.cwds ?? [],
    sessions: candidates,
  };
  await setRestoringSessions(config, candidates);
  writeSnapshot(config, state);
  let failures = 0;
  for (const candidate of candidates) {
    try {
      const resolution = await resolveSaved(config, candidate.id, candidate.cwd, windowsBasis);
      if (resolution.saved) {
        const restored = await openResolvedSession(
          config,
          candidate.id,
          resolution,
          "normal",
          windowsBasis,
        );
        if (restored.startup !== "ready")
          throw new Error("Running pi has not confirmed initialization completion");
      } else {
        console.error(`pi-mux: restore ${candidate.id}: saved conversation not found; removed`);
        state = { ...state, sessions: state.sessions.filter((entry) => entry.id !== candidate.id) };
      }
      if (management && windowsBasis) await management.assertLive(windowsBasis);
      writeSnapshot(config, state);
      if (management && windowsBasis) {
        await management.clearRestoring(windowsBasis, candidate.id, windowsClaimLock(management));
      } else await tmux(config, ["set-option", "-gu", `@pi-mux-restoring-${candidate.id}`]);
    } catch (error) {
      failures++;
      console.error(`pi-mux: restore ${candidate.id}: ${errorMessage(error)}`);
    }
  }
  await snapshotSessions(config, generation);
  return failures;
}

export async function snapshotSessions(
  config: TmuxConfig,
  expectedGeneration?: string,
  mode: "existing" | "repair" = "existing",
): Promise<void> {
  const management = platform.windows ? windowsManagement(config) : undefined;
  const basis = await management?.currentBasis();
  const generation = management
    ? basis?.instance
    : await serverOption(config, "@pi-mux-generation");
  if (!generation) throw new Error("Dedicated server has not been initialized by pi-mux");
  if (expectedGeneration !== undefined && generation !== expectedGeneration) return;
  const previous = readSnapshot(config);
  if (previous && previous.generation !== "" && previous.generation !== generation) {
    if (mode === "repair") throw new Error("Snapshot belongs to another server generation");
    return;
  }
  if (!previous && mode === "existing") return;
  const managed = await managedSessions(config);
  const temporaryIds = new Set(managed.filter((entry) => entry.temporary).map((entry) => entry.id));
  const candidates = (previous?.sessions ?? []).filter(
    (candidate) => !temporaryIds.has(candidate.id),
  );
  const restoringIds =
    management && basis && candidates.length > 0
      ? new Set(management.startupState(basis)?.restoring)
      : undefined;
  const restoring = restoringIds
    ? candidates.filter(({ id }) => restoringIds.has(id.toLowerCase()))
    : await readTmuxRestoringCandidates(config, candidates);
  const sessions = uniqueCandidates([
    ...restoring,
    ...managed.filter((entry) => !entry.temporary).map(({ id, cwd }) => ({ id, cwd })),
  ]);
  if ((await serverOption(config, "@pi-mux-generation")) !== generation)
    throw new Error("Dedicated server changed during snapshot");
  writeSnapshot(config, {
    ...previous,
    version: 1,
    generation,
    cwds: previous?.cwds ?? [],
    sessions,
  });
}

async function readTmuxRestoringCandidates(
  config: TmuxConfig,
  candidates: Candidate[],
): Promise<Candidate[]> {
  const markers = await tmuxQueries(
    config,
    candidates.map(({ id }) => ["show-options", "-gqv", `@pi-mux-restoring-${id}`]),
  );
  return candidates.filter((_, index) => {
    const result = markers[index]!;
    if (result.exitCode !== 0) throw new Error(`tmux show-options failed: ${result.stderr.trim()}`);
    const marker = result.stdout.trim();
    if (marker && marker !== "1") throw new Error("Invalid in-memory restore state");
    return marker === "1";
  });
}

export async function setRestoringSessions(config: Config, candidates: Candidate[]): Promise<void> {
  if (platform.windows) return;
  for (const { id } of candidates)
    await tmux(config, ["set-option", "-g", `@pi-mux-restoring-${id}`, "1"]);
}
