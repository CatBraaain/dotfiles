import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  inspectWindowsProcess,
  isWindowsProcessIdentity,
  observeWindowsIdentity,
  type InspectWindowsProcess,
  type WindowsProcessIdentity,
} from "./windows-process";

const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const INSTANCE = /^[0-9a-f]{16}$/;
const WITNESS = /^[1-9]\d*:[1-9]\d*$/;

export type WindowsManagementBasis = { instance: string; witnesses: string[] };

type Reservation = {
  token: string;
  keys: string[];
  basis: WindowsManagementBasis;
  requireRestored: boolean;
};
export type SpawnReceipt = { claim: string; child: WindowsProcessIdentity };
type SpawnedRight = Reservation & SpawnReceipt & { state: "spawned"; completed: boolean };
export type LaunchRight =
  | (Reservation & { state: "reserved"; initialRequestSession?: string })
  | (Reservation & { state: "pending"; claim: string })
  | SpawnedRight;

export type WindowsLaunchStatus =
  | { state: "missing" | "reserved" | "pending" }
  | { state: "live" | "ended" | "unknown"; receipt: SpawnReceipt; completed: boolean };
export type WindowsClaimLock = <T>(action: () => Promise<T>) => Promise<T>;
type LedgerAccess = {
  path: string;
  withClaimLock: WindowsClaimLock;
  observeManagement(requireRestored: boolean): Promise<WindowsManagementBasis>;
  inspectProcess?: InspectWindowsProcess;
};

export class SpawnDidNotStartError extends Error {}

export function conversationLaunchKey(id: string): string {
  return JSON.stringify(["conversation", id.toLowerCase()]);
}

export function ticketLaunchKey(project: string, id: string): string {
  return JSON.stringify(["ticket", project.toLowerCase(), id.toLowerCase()]);
}

export function launchBasisStillLive(
  basis: WindowsManagementBasis,
  current: WindowsManagementBasis,
): boolean {
  return (
    basis.instance === current.instance &&
    basis.witnesses.some((witness) => current.witnesses.includes(witness))
  );
}

export class WindowsLaunchRights {
  private readonly inspectProcess: InspectWindowsProcess;

  constructor(private readonly access: LedgerAccess) {
    this.inspectProcess = access.inspectProcess ?? inspectWindowsProcess;
  }

  async reserveAfterLifecycleAudit(
    keys: string[],
    basis: WindowsManagementBasis,
    {
      requireRestored = true,
      token = randomUUID(),
      initialRequestSession,
    }: { requireRestored?: boolean; token?: string; initialRequestSession?: string } = {},
  ): Promise<{ state: "conflict"; right: SpawnedRight } | { state: "reserved"; token: string }> {
    return await this.access.withClaimLock(async () => {
      if (
        !TOKEN.test(token) ||
        !isWindowsManagementBasis(basis) ||
        !launchBasisStillLive(basis, await this.access.observeManagement(requireRestored))
      )
        throw new Error("The audited Windows pi-mux management generation is no longer live");
      const retained: LaunchRight[] = [];
      for (const right of readRights(this.access.path)) {
        if (right.token === token) throw new Error("Windows pi-mux launch token already exists");
        if (!right.keys.some((key) => keys.includes(key))) {
          retained.push(right);
          continue;
        }
        if (right.state === "reserved") continue;
        if (right.state === "spawned") {
          const observation = this.observeChild(right);
          if (observation === "ended") continue;
          if (observation === "present") return { state: "conflict", right };
        }
        throw new Error("Cannot determine the outcome of a prior Windows pi-mux launch");
      }
      writeRights(this.access.path, [
        ...retained,
        { state: "reserved", keys, basis, token, requireRestored, initialRequestSession },
      ]);
      return { state: "reserved", token };
    });
  }

  async claimAndStart<T extends { pid: number; exited?: Promise<number> }>(
    token: string,
    claim: string,
    spawn: (basis: WindowsManagementBasis) => T,
    prepare?: () => Promise<void>,
    initialRequestSession?: string,
  ): Promise<{ started: T; receipt: SpawnReceipt } | undefined> {
    return await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const right = rights.find((entry) => entry.token === token);
      if (right?.state !== "reserved") return;
      const { initialRequestSession: reservedSession, ...reservation } = right;
      if (reservedSession !== initialRequestSession)
        throw new Error("Windows launch right does not match its assigned initial-request session");
      const otherRights = rights.filter((entry) => entry !== right);
      let current: WindowsManagementBasis;
      try {
        await prepare?.();
        current = await this.access.observeManagement(right.requireRestored);
      } catch (error) {
        writeRights(this.access.path, otherRights);
        throw error;
      }
      if (!launchBasisStillLive(right.basis, current)) {
        writeRights(this.access.path, otherRights);
        return;
      }
      const pending: LaunchRight = { ...reservation, state: "pending", claim };
      writeRights(this.access.path, [...otherRights, pending]);
      let started: T;
      try {
        started = spawn(right.basis);
      } catch (error) {
        if (error instanceof SpawnDidNotStartError) writeRights(this.access.path, otherRights);
        throw error;
      }
      const observation = this.inspectProcess(started.pid);
      if (observation.state === "ended") {
        if (
          started.exited &&
          (await Promise.race([
            started.exited.then(
              (code) => Number.isInteger(code),
              () => false,
            ),
            Bun.sleep(100).then(() => false),
          ]))
        )
          writeRights(this.access.path, otherRights);
        throw new Error("The Windows pi-mux child vanished before its identity could be recorded");
      }
      if (
        observation.state !== "live" ||
        !isWindowsProcessIdentity(observation.identity) ||
        observation.identity.pid !== started.pid
      )
        throw new Error("Cannot record the Windows pi-mux child's process identity");
      const receipt: SpawnReceipt = { claim, child: observation.identity };
      writeRights(this.access.path, [
        ...otherRights,
        { ...reservation, ...receipt, state: "spawned", completed: false },
      ]);
      return { started, receipt };
    });
  }

  async inspect(keys: string[]): Promise<"present" | "clear"> {
    return await this.access.withClaimLock(async () => {
      let present = false;
      for (const right of readRights(this.access.path)) {
        if (!right.keys.some((key) => keys.includes(key))) continue;
        if (right.state === "reserved") {
          present = true;
          continue;
        }
        const observation = right.state === "spawned" ? this.observeChild(right) : "unknown";
        if (observation === "unknown")
          throw new Error("Cannot determine the outcome of a prior Windows pi-mux launch");
        if (observation === "present") present = true;
      }
      return present ? "present" : "clear";
    });
  }

  async inspectReloadKeys({
    token,
    basis,
    child,
    conversationKey,
  }: {
    token: string | undefined;
    basis: WindowsManagementBasis;
    child: WindowsProcessIdentity;
    conversationKey: string;
  }): Promise<string[]> {
    return await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const matchingChildren = rights.filter(
        (right) =>
          right.state === "spawned" &&
          right.child.pid === child.pid &&
          right.child.creationTime === child.creationTime,
      );
      const [owned] = matchingChildren;
      if (
        (owned || token) &&
        (matchingChildren.length !== 1 ||
          owned?.state !== "spawned" ||
          owned.token !== token ||
          !owned.completed ||
          owned.basis.instance !== basis.instance ||
          this.observeChild(owned) !== "present")
      )
        throw new Error("Cannot verify the current Windows pi launch receipt and ownership");
      if (
        rights.some(
          (right) =>
            right !== owned &&
            right.keys.includes(conversationKey) &&
            (right.state !== "spawned" || this.observeChild(right) !== "ended"),
        )
      )
        throw new Error("A Windows launch right already owns this conversation");
      return owned?.keys ?? [conversationKey];
    });
  }

  async status(token: string): Promise<WindowsLaunchStatus> {
    return await this.access.withClaimLock(async () => {
      const right = readRights(this.access.path).find((entry) => entry.token === token);
      if (!right) return { state: "missing" };
      if (right.state !== "spawned") return { state: right.state };
      const observed = this.observeChild(right);
      return {
        state: observed === "present" ? "live" : observed,
        receipt: { claim: right.claim, child: right.child },
        completed: right.completed,
      };
    });
  }

  async complete(token: string, receipt: SpawnReceipt, releaseOwnerId?: string): Promise<void> {
    await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const right = rights.find((entry) => entry.token === token);
      if (
        right?.state !== "spawned" ||
        right.claim !== receipt.claim ||
        right.child.pid !== receipt.child.pid ||
        right.child.creationTime !== receipt.child.creationTime ||
        this.observeChild(right) !== "present"
      )
        throw new Error("Cannot confirm the Windows pi-mux launch receipt");
      const ownerKey =
        releaseOwnerId === undefined ? undefined : conversationLaunchKey(releaseOwnerId);
      if (right.completed) {
        if (ownerKey === undefined || !right.keys.includes(ownerKey)) return;
        throw new Error("Cannot release an owner key after confirming the Windows pi-mux launch");
      }
      if (
        ownerKey !== undefined &&
        (!right.keys.some((key) => key.startsWith('["ticket",')) || !right.keys.includes(ownerKey))
      )
        throw new Error("Cannot release the owner key of this Windows pi-mux launch");
      const completed: SpawnedRight = {
        ...right,
        completed: true,
        keys: right.keys.filter((key) => key !== ownerKey),
      };
      writeRights(
        this.access.path,
        rights.map((entry) => (entry === right ? completed : entry)),
      );
    });
  }

  async completeDispatched(
    token: string,
    receipt: SpawnReceipt,
    basis: WindowsManagementBasis,
    key: string,
  ): Promise<void> {
    await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const right = rights.find((entry) => entry.token === token);
      if (
        right?.state !== "spawned" ||
        !right.keys.includes(key) ||
        right.basis.instance !== basis.instance ||
        right.claim !== receipt.claim ||
        right.child.pid !== receipt.child.pid ||
        right.child.creationTime !== receipt.child.creationTime ||
        this.observeChild(right) !== "present"
      )
        throw new Error("Cannot verify a dispatched Windows pi launch receipt");
      if (right.completed) return;
      const completed: SpawnedRight = {
        ...right,
        completed: true,
        keys: right.keys.filter((entry) => !entry.startsWith('["conversation",')),
      };
      writeRights(
        this.access.path,
        rights.map((entry) => (entry === right ? completed : entry)),
      );
    });
  }

  async fenceForRestart(allowLive: boolean): Promise<SpawnedRight[]> {
    return await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const liveLaunches: SpawnedRight[] = [];
      for (const right of rights) {
        if (right.state === "reserved") continue;
        const state = right.state === "spawned" ? this.observeChild(right) : "unknown";
        if (state === "unknown")
          throw new Error("Cannot determine the outcome of a prior Windows pi-mux launch");
        if (right.state === "spawned" && state === "present") liveLaunches.push(right);
      }
      if (!allowLive && liveLaunches.length > 0)
        throw new Error("A prior Windows pi-mux launch is still active; cannot restart safely");
      const claimed = rights.filter((right) => right.state !== "reserved");
      if (claimed.length !== rights.length) writeRights(this.access.path, claimed);
      return liveLaunches;
    });
  }

  async fenceForDispatchInventory(): Promise<string[]> {
    return await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const retained: LaunchRight[] = [];
      const live: string[] = [];
      for (const right of rights) {
        if (right.keys.some((key) => key.startsWith('["ticket",'))) {
          if (right.state === "reserved") continue;
          const state = right.state === "spawned" ? this.observeChild(right) : "unknown";
          if (state === "unknown")
            throw new Error("Cannot determine the outcome of a prior Windows ticket launch");
          if (state === "present") live.push(right.token);
        }
        retained.push(right);
      }
      if (retained.length !== rights.length) writeRights(this.access.path, retained);
      return live;
    });
  }

  async discardUnclaimed(keys: string[]): Promise<void> {
    await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const retained = rights.filter(
        (right) => right.state !== "reserved" || !right.keys.some((key) => keys.includes(key)),
      );
      if (retained.length !== rights.length) writeRights(this.access.path, retained);
    });
  }

  async cancelUnclaimed(token: string): Promise<boolean> {
    return await this.access.withClaimLock(async () => {
      const rights = readRights(this.access.path);
      const right = rights.find((entry) => entry.token === token);
      if (right?.state !== "reserved") return false;
      writeRights(
        this.access.path,
        rights.filter((entry) => entry !== right),
      );
      return true;
    });
  }

  private observeChild(right: SpawnedRight): "present" | "ended" | "unknown" {
    return observeWindowsIdentity(right.child, this.inspectProcess);
  }
}

function readRights(path: string): LaunchRight[] {
  let input: unknown;
  try {
    input = readWindowsScopeRecord(path);
  } catch (error) {
    throw new Error("Cannot read Windows pi-mux launch rights", { cause: error });
  }
  if (input === undefined) return [];
  if (!isRecord(input) || input.version !== 2 || !Array.isArray(input.rights))
    throw new Error("Invalid Windows pi-mux launch ledger");
  validateRights(input.rights);
  return input.rights;
}

function writeRights(path: string, rights: LaunchRight[]): void {
  validateRights(rights);
  writeWindowsScopeRecord(path, { version: 2, rights });
}

export function readWindowsScopeRecord(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeWindowsScopeRecord(path: string, record: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(record));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function validateRights(rights: unknown[]): asserts rights is LaunchRight[] {
  const tokens = new Set<string>();
  const keys = new Set<string>();
  for (const right of rights) {
    if (
      !isRecord(right) ||
      typeof right.token !== "string" ||
      !TOKEN.test(right.token) ||
      tokens.has(right.token) ||
      !isWindowsManagementBasis(right.basis) ||
      typeof right.requireRestored !== "boolean" ||
      !Array.isArray(right.keys) ||
      right.keys.length === 0 ||
      !validRightState(right)
    )
      throw new Error("Invalid Windows pi-mux launch right");
    tokens.add(right.token);
    for (const key of right.keys) {
      if (typeof key !== "string" || key.length === 0 || keys.has(key))
        throw new Error("Invalid or overlapping Windows pi-mux launch keys");
      keys.add(key);
    }
  }
}

function validRightState(right: Record<string, unknown>): boolean {
  if (right.state === "reserved")
    return (
      right.initialRequestSession === undefined ||
      (typeof right.initialRequestSession === "string" &&
        /^[A-Za-z0-9_-]+$/.test(right.initialRequestSession))
    );
  if (right.initialRequestSession !== undefined) return false;
  if (typeof right.claim !== "string" || !TOKEN.test(right.claim)) return false;
  if (right.state === "pending") return true;
  return (
    right.state === "spawned" &&
    isWindowsProcessIdentity(right.child) &&
    typeof right.completed === "boolean"
  );
}

export function isWindowsManagementBasis(value: unknown): value is WindowsManagementBasis {
  return (
    isRecord(value) &&
    typeof value.instance === "string" &&
    INSTANCE.test(value.instance) &&
    Array.isArray(value.witnesses) &&
    value.witnesses.length > 0 &&
    value.witnesses.every(
      (witness: unknown) => typeof witness === "string" && WITNESS.test(witness),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
