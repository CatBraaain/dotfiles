import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import {
  launchBasisStillLive,
  readWindowsScopeRecord,
  WindowsLaunchRights,
  writeWindowsScopeRecord,
  type WindowsClaimLock,
  type WindowsManagementBasis,
} from "./windows-launch-rights";
import {
  inspectWindowsProcess,
  observeWindowsIdentity,
  type InspectWindowsProcess,
} from "./windows-process";
import {
  psmuxNamespace,
  readPsmuxObservation,
  readPsmuxPeers,
  type PsmuxObservation,
  type PsmuxPeer,
  type PsmuxQuery,
} from "./windows-psmux";

const OBSERVATION_ATTEMPTS = 3;
const OBSERVATION_RETRY_MS = 40;
const SESSION_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const INSTANCE = /^[0-9a-f]{16}$/;

export type WindowsManagementConfig = {
  socket: string;
  directory: string;
  env: NodeJS.ProcessEnv;
  query: PsmuxQuery;
};
export type WindowsManagementScope = {
  registryDirectory: string;
  namespace: string;
  lockResource: string;
  claimLockResource: string;
  storageDirectory: string;
};
export type StartupState = { version: 1; instance: string; restored: boolean; restoring: string[] };

export function windowsManagementScope(
  { socket, env }: Omit<WindowsManagementConfig, "query">,
  canonicalize = canonicalPath,
  profileDirectory = homedir(),
): WindowsManagementScope {
  const registryOverride = environmentValue(env, "PSMUX_DATA_DIR");
  const profile = environmentValue(env, "USERPROFILE") || profileDirectory;
  const psmuxRegistry = registryOverride ?? win32.join(profile, ".psmux");
  const namespace = psmuxNamespace(socket, psmuxRegistry);
  const registryDirectory = canonicalize(psmuxRegistry);
  const lockResource = JSON.stringify([
    "psmux",
    win32.normalize(registryDirectory).toLowerCase(),
    namespace.toLowerCase(),
  ]);
  const hash = createHash("sha256").update(lockResource).digest("hex");
  return {
    registryDirectory,
    namespace,
    lockResource,
    claimLockResource: JSON.stringify(["launch-rights", lockResource]),
    storageDirectory: join(registryDirectory, ".pi-mux", hash),
  };
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const matches = Object.entries(env).filter(
    ([key, value]) => key.toUpperCase() === name && value !== undefined,
  );
  if (matches.length > 1) throw new Error(`Ambiguous Windows environment variable ${name}`);
  return matches[0]?.[1];
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      parent === path ||
      lstatSync(path, { throwIfNoEntry: false })
    )
      throw error;
    return join(canonicalPath(parent), win32.basename(path));
  }
}

export class WindowsManagement {
  readonly scope: WindowsManagementScope;
  private readonly inspectProcess: InspectWindowsProcess;
  private readonly startupPath: string;

  constructor(
    private readonly config: WindowsManagementConfig,
    dependencies: { scope?: WindowsManagementScope; inspectProcess?: InspectWindowsProcess } = {},
  ) {
    this.scope = dependencies.scope ?? windowsManagementScope(config);
    this.inspectProcess = dependencies.inspectProcess ?? inspectWindowsProcess;
    this.startupPath = join(this.scope.storageDirectory, "startup.json");
  }

  get lockResource(): string {
    return this.scope.lockResource;
  }

  get claimLockResource(): string {
    return this.scope.claimLockResource;
  }

  createLaunchRights(withClaimLock: WindowsClaimLock): WindowsLaunchRights {
    return new WindowsLaunchRights({
      path: join(this.scope.storageDirectory, "launch-rights.json"),
      withClaimLock,
      inspectProcess: this.inspectProcess,
      observeManagement: async (requireRestored) => {
        const basis = await this.currentBasis();
        if (!basis) throw new Error("The dedicated psmux management generation is not running");
        if (requireRestored) this.requireRestored(basis);
        return basis;
      },
    });
  }

  async currentBasis(): Promise<WindowsManagementBasis | undefined> {
    return (await this.observe())?.basis;
  }

  async audit(
    paneFormat: string,
    { requireRestored = true }: { requireRestored?: boolean } = {},
  ): Promise<PsmuxObservation & { startup: StartupState | undefined }> {
    const observation = await this.observe(paneFormat);
    if (!observation) throw new Error("The dedicated psmux management generation is not running");
    const startup = requireRestored
      ? this.requireRestored(observation.basis)
      : this.startupState(observation.basis);
    return { ...observation, startup };
  }

  startupState(basis: WindowsManagementBasis): StartupState | undefined {
    const state = readStartupState(this.startupPath);
    return state?.instance === basis.instance ? state : undefined;
  }

  async prepareStartup(
    basis: WindowsManagementBasis,
    restoringIds: string[],
    withClaimLock: WindowsClaimLock,
  ): Promise<void> {
    const restoring = [...new Set(restoringIds.map(validateId))];
    await withClaimLock(async () => {
      await this.assertLive(basis);
      readStartupState(this.startupPath);
      mkdirSync(this.scope.storageDirectory, { recursive: true, mode: 0o700 });
      writeWindowsScopeRecord(this.startupPath, {
        version: 1,
        instance: basis.instance,
        restored: false,
        restoring,
      });
    });
  }

  async keepRestoring(
    basis: WindowsManagementBasis,
    id: string,
    withClaimLock: WindowsClaimLock,
  ): Promise<void> {
    const key = validateId(id);
    await this.updateStartup(basis, withClaimLock, (state) => ({
      ...state,
      restoring: [...new Set([...state.restoring, key])],
    }));
  }

  async clearRestoring(
    basis: WindowsManagementBasis,
    id: string,
    withClaimLock: WindowsClaimLock,
  ): Promise<void> {
    const key = validateId(id);
    await this.updateStartup(basis, withClaimLock, (state) => ({
      ...state,
      restoring: state.restoring.filter((entry) => entry !== key),
    }));
  }

  async markRestored(
    basis: WindowsManagementBasis,
    withClaimLock: WindowsClaimLock,
  ): Promise<void> {
    await this.updateStartup(basis, withClaimLock, (state) => ({ ...state, restored: true }));
  }

  private async updateStartup(
    basis: WindowsManagementBasis,
    withClaimLock: WindowsClaimLock,
    update: (state: StartupState) => StartupState,
  ): Promise<void> {
    await withClaimLock(async () => {
      await this.assertLive(basis);
      const state = this.startupState(basis);
      if (!state) throw new Error("No startup record for the live psmux management generation");
      writeWindowsScopeRecord(this.startupPath, update(state));
    });
  }

  private requireRestored(basis: WindowsManagementBasis): StartupState {
    const state = this.startupState(basis);
    if (!state?.restored)
      throw new Error(
        "The dedicated psmux management generation has not completed startup restore",
      );
    return state;
  }

  async assertLive(expected: WindowsManagementBasis): Promise<void> {
    const current = await this.currentBasis();
    if (!current || !launchBasisStillLive(expected, current))
      throw new Error("The dedicated psmux management generation changed");
  }

  private async observe(paneFormat?: string): Promise<PsmuxObservation | undefined> {
    let failure: unknown;
    for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt++) {
      if (attempt > 0) await Bun.sleep(OBSERVATION_RETRY_MS);
      try {
        return await readPsmuxObservation(
          () => this.readPeers(),
          this.config.query,
          (peer) => this.observePeerIdentity(peer),
          paneFormat,
        );
      } catch (error) {
        failure = error;
      }
    }
    throw new Error("Cannot confirm the dedicated psmux management inventory", { cause: failure });
  }

  private async readPeers(): Promise<PsmuxPeer[]> {
    try {
      return await readPsmuxPeers(this.scope.registryDirectory, this.scope.namespace);
    } catch (error) {
      const io = error as NodeJS.ErrnoException & { path?: string };
      if (io.code === "ENOENT" && io.path === this.scope.registryDirectory) return [];
      throw error;
    }
  }

  private observePeerIdentity({ identity }: PsmuxPeer): "present" | "ended" | "unknown" {
    const [pid, creationTime] = identity.split(":") as [string, string];
    return observeWindowsIdentity({ pid: Number(pid), creationTime }, this.inspectProcess);
  }
}

function validateId(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`Invalid restoring conversation ID: ${id}`);
  return id.toLowerCase();
}

function readStartupState(path: string): StartupState | undefined {
  const input = readWindowsScopeRecord(path);
  if (input === undefined) return;
  if (!input || typeof input !== "object") throw new Error("Invalid Windows pi-mux startup record");
  const state = input as Partial<StartupState>;
  if (
    state.version !== 1 ||
    typeof state.instance !== "string" ||
    !INSTANCE.test(state.instance) ||
    typeof state.restored !== "boolean" ||
    !Array.isArray(state.restoring) ||
    !state.restoring.every((id) => typeof id === "string" && id === validateId(id)) ||
    new Set(state.restoring).size !== state.restoring.length
  )
    throw new Error("Invalid Windows pi-mux startup record");
  return state as StartupState;
}
