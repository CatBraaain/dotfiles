import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationLaunchKey,
  SpawnDidNotStartError,
  ticketLaunchKey,
  WindowsLaunchRights,
} from "./windows-launch-rights";
import type { WindowsProcessObservation } from "./windows-process";

const basis = { instance: "aaaaaaaaaaaaaaaa", witnesses: ["12:133970000000000000"] };
const conversation = conversationLaunchKey("owner-id");
const ticket = ticketLaunchKey("Project", "20261124-120000");
const child = { pid: 205, creationTime: "133971000000000000" };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-mux-launch-rights-"));
  directories.push(directory);
  const path = join(directory, "rights.json");
  const observations = {
    management: basis,
    restored: true,
    child: { state: "live", identity: child } as WindowsProcessObservation,
  };
  let lock = Promise.resolve();
  const args = {
    path,
    async withClaimLock<T>(action: () => Promise<T>): Promise<T> {
      const previous = lock;
      const { promise, resolve } = Promise.withResolvers<void>();
      lock = promise;
      await previous;
      try {
        return await action();
      } finally {
        resolve();
      }
    },
    async observeManagement(requireRestored: boolean) {
      if (requireRestored && !observations.restored) throw new Error("not restored");
      return observations.management;
    },
    inspectProcess(pid: number) {
      assert.equal(pid, child.pid);
      return observations.child;
    },
  };
  return { path, observations, create: () => new WindowsLaunchRights(args) };
}

function spawn() {
  return { pid: child.pid };
}

async function reserve(ledger: WindowsLaunchRights, keys = [conversation], expected = basis) {
  const right = await ledger.reserveAfterLifecycleAudit(keys, expected);
  assert.equal(right.state, "reserved");
  return right.token;
}

describe("Windows launch rights", () => {
  it("does not grant a waiting reload wrapper's token while the old identity lives", async () => {
    const { create, observations } = fixture();
    const ledger = create();
    const old = await reserve(ledger);
    await ledger.claimAndStart(old, randomUUID(), spawn);
    const replacement = randomUUID();
    assert.equal(
      (await ledger.reserveAfterLifecycleAudit([conversation], basis, { token: replacement }))
        .state,
      "conflict",
    );
    assert.equal(
      await ledger.claimAndStart(replacement, randomUUID(), () => assert.fail()),
      undefined,
    );

    observations.child = { state: "ended" };
    assert.deepEqual(
      await ledger.reserveAfterLifecycleAudit([conversation], basis, { token: replacement }),
      { state: "reserved", token: replacement },
    );
    assert.deepEqual(await ledger.status(replacement), { state: "reserved" });
  });

  it("reserves the verified launch keys after exit and preserves them in later dispatch audits", async () => {
    const { create, observations } = fixture();
    const ledger = create();
    const originalKeys = [conversation, ticket];
    const token = await reserve(ledger, originalKeys);
    const old = await ledger.claimAndStart(token, randomUUID(), spawn);
    assert.ok(old);
    await ledger.complete(token, old.receipt);

    const keys = await ledger.inspectReloadKeys({
      token,
      basis,
      child,
      conversationKey: conversation,
    });
    assert.deepEqual(keys, originalKeys);
    assert.equal((await ledger.reserveAfterLifecycleAudit(keys, basis)).state, "conflict");

    observations.child = { state: "ended" };
    const replacement = await reserve(ledger, keys);
    observations.child = {
      state: "live",
      identity: { ...child, creationTime: "133972000000000000" },
    };
    const started = await ledger.claimAndStart(replacement, randomUUID(), spawn);
    assert.ok(started);
    await ledger.complete(replacement, started.receipt);
    await ledger.completeDispatched(replacement, started.receipt, basis, ticket);

    assert.deepEqual(await ledger.fenceForDispatchInventory(), [replacement]);
    assert.equal(await ledger.inspect([conversation]), "present");
    assert.equal(await ledger.inspect([ticket]), "present");
  });

  it("rejects missing, mismatched or stale evidence without mutating the ledger", async () => {
    const { create, path } = fixture();
    const ledger = create();
    const token = await reserve(ledger, [ticket]);
    const old = await ledger.claimAndStart(token, randomUUID(), spawn);
    assert.ok(old);
    await ledger.complete(token, old.receipt);
    const before = readFileSync(path, "utf8");
    const expected = { token, basis, child, conversationKey: conversation };
    for (const evidence of [
      { ...expected, token: undefined },
      { ...expected, token: randomUUID() },
      { ...expected, basis: { ...basis, instance: "bbbbbbbbbbbbbbbb" } },
      { ...expected, child: { ...child, creationTime: "133972000000000000" } },
    ]) {
      await assert.rejects(
        ledger.inspectReloadKeys(evidence),
        /Cannot verify.*receipt and ownership/,
      );
    }
    assert.equal(readFileSync(path, "utf8"), before);
  });

  it("refuses a competing conversation key even when the target owns a verified ticket key", async () => {
    const { create } = fixture();
    const ledger = create();
    const token = await reserve(ledger, [ticket]);
    const old = await ledger.claimAndStart(token, randomUUID(), spawn);
    assert.ok(old);
    await ledger.complete(token, old.receipt);
    await reserve(ledger, [conversation]);

    await assert.rejects(
      ledger.inspectReloadKeys({ token, basis, child, conversationKey: conversation }),
      /already owns this conversation/,
    );
  });

  it("rejects a late claim after its unclaimed reservation is replaced", async () => {
    const { create } = fixture();
    const old = await reserve(create(), [conversation, ticket]);
    const current = await reserve(create());
    assert.equal(await create().claimAndStart(old, randomUUID(), spawn), undefined);
    const claim = randomUUID();
    assert.deepEqual(await create().claimAndStart(current, claim, spawn), {
      started: { pid: child.pid },
      receipt: { claim, child },
    });
  });

  it("revokes a delayed ticket claim even with no pane and retains other reservations", async () => {
    const { create } = fixture();
    const delayed = await reserve(create(), [ticket]);
    const unrelated = await reserve(create());
    assert.deepEqual(await create().fenceForDispatchInventory(), []);
    assert.equal(
      await create().claimAndStart(
        delayed,
        randomUUID(),
        () => assert.fail(),
        async () => assert.fail("writes a pane marker"),
      ),
      undefined,
    );
    assert.equal((await create().status(unrelated)).state, "reserved");
  });

  it("accounts for a claimed ticket even before any caller has confirmed its pane", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create(), [ticket]);
    const started = create().claimAndStart(token, randomUUID(), spawn);
    const audit = create().fenceForDispatchInventory();
    await started;
    assert.deepEqual(await audit, [token]);
    observations.child = { state: "unknown" };
    await assert.rejects(create().fenceForDispatchInventory(), /prior Windows ticket launch/);
  });

  it("serializes probing a competing ticket with the atomic pending-to-spawned transition", async () => {
    const { create, path } = fixture();
    const token = await reserve(create(), [conversation, ticket]);
    const claim = randomUUID();
    const started = create().claimAndStart(token, claim, () => {
      const ledger = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(ledger.rights[0].state, "pending");
      return spawn();
    });
    const competing = create().reserveAfterLifecycleAudit([ticket], basis);
    assert.equal((await competing).state, "conflict");
    assert.deepEqual(await started, { started: { pid: child.pid }, receipt: { claim, child } });
  });

  it("keeps a pending receipt when a wrapper stops after starting an unrecorded child", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create());
    observations.child = { state: "unknown" };
    await assert.rejects(create().claimAndStart(token, randomUUID(), spawn), /record.*identity/);
    assert.deepEqual(await create().status(token), { state: "pending" });
    assert.equal(await create().cancelUnclaimed(token), false);
    await assert.rejects(
      create().reserveAfterLifecycleAudit([conversation], basis),
      /prior Windows pi-mux launch/,
    );
  });

  it("retains the pending claim when the new child's PID vanished before it was identified", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create());
    observations.child = { state: "ended" };
    await assert.rejects(
      create().claimAndStart(token, randomUUID(), spawn),
      /vanished before its identity/,
    );
    assert.deepEqual(await create().status(token), { state: "pending" });
  });

  it("retries an early child exit confirmed by the directly spawned process handle", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create());
    observations.child = { state: "ended" };
    await assert.rejects(
      create().claimAndStart(token, randomUUID(), () => ({
        pid: child.pid,
        exited: Promise.resolve(1),
      })),
      /vanished before its identity/,
    );
    assert.deepEqual(await create().status(token), { state: "missing" });
    await reserve(create());
  });

  it("keeps a pending claim when a spawn callback throws without proving no child was created", async () => {
    const { create } = fixture();
    const token = await reserve(create());
    await assert.rejects(
      create().claimAndStart(token, randomUUID(), () => {
        throw new Error("Lost spawn response");
      }),
      /Lost spawn response/,
    );
    assert.deepEqual(await create().status(token), { state: "pending" });
  });

  it("can retry a synchronous spawn failure that proved no child was created", async () => {
    const { create } = fixture();
    const token = await reserve(create());
    await assert.rejects(
      create().claimAndStart(token, randomUUID(), () => {
        throw new SpawnDidNotStartError("Spawn failed before process creation");
      }),
      /before process creation/,
    );
    assert.deepEqual(await create().status(token), { state: "missing" });
    await reserve(create());
  });

  it("does not reserve again merely because the parent wrapper has returned", async () => {
    const { create } = fixture();
    const token = await reserve(create());
    const claim = randomUUID();
    await create().claimAndStart(token, claim, spawn);
    assert.deepEqual(await create().status(token), {
      state: "live",
      receipt: { claim, child },
      completed: false,
    });
    assert.equal(
      (await create().reserveAfterLifecycleAudit([conversation], basis)).state,
      "conflict",
    );
  });

  it("can retry after the recorded child's identity has ended even if its PID was reused", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create());
    const claim = randomUUID();
    await create().claimAndStart(token, claim, spawn);
    observations.child = {
      state: "live",
      identity: { ...child, creationTime: "133972000000000000" },
    };
    assert.deepEqual(await create().status(token), {
      state: "ended",
      receipt: { claim, child },
      completed: false,
    });
    await reserve(create());
  });

  it("releases only the owner key after confirming the live dispatch receipt", async () => {
    const { create } = fixture();
    const token = await reserve(create(), [conversation, ticket]);
    const result = await create().claimAndStart(token, randomUUID(), spawn);
    assert.ok(result);
    await create().complete(token, result.receipt, "owner-id");
    assert.equal(await create().inspect([conversation]), "clear");
    assert.equal(await create().inspect([ticket]), "present");
    assert.deepEqual(await create().status(token), {
      state: "live",
      receipt: result.receipt,
      completed: true,
    });
    await reserve(create());
  });

  it("does not release the owner key on a mismatched receipt", async () => {
    const { create } = fixture();
    const token = await reserve(create(), [conversation, ticket]);
    await create().claimAndStart(token, randomUUID(), spawn);
    await assert.rejects(
      create().complete(token, { claim: randomUUID(), child }, "owner-id"),
      /Cannot confirm/,
    );
    assert.equal(await create().inspect([conversation]), "present");
  });

  it("does not forget an unresolved launch when the namespace generation changes", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create());
    await create().claimAndStart(token, randomUUID(), spawn);
    observations.child = { state: "unknown" };
    observations.management = {
      instance: "bbbbbbbbbbbbbbbb",
      witnesses: ["19:133970000000000002"],
    };
    await assert.rejects(
      create().reserveAfterLifecycleAudit([conversation], observations.management),
      /prior Windows pi-mux launch/,
    );
  });

  for (const management of [
    { ...basis, witnesses: ["12:133970000000000001"] },
    { ...basis, instance: "bbbbbbbbbbbbbbbb" },
  ]) {
    it(`does not spawn if the audited witness or generation changed: ${JSON.stringify(management)}`, async () => {
      const { create, observations } = fixture();
      const token = await reserve(create());
      observations.management = management;
      assert.equal(
        await create().claimAndStart(token, randomUUID(), () => assert.fail("spawned")),
        undefined,
      );
      assert.equal(await create().inspect([conversation]), "clear");
    });
  }

  it("keeps the right when an additional peer joins the same generation", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create());
    observations.management = {
      ...basis,
      witnesses: [...basis.witnesses, "13:133970000000000001"],
    };
    assert.ok(await create().claimAndStart(token, randomUUID(), spawn));
  });

  it("rechecks restore readiness immediately before an audited launch", async () => {
    const { create, observations } = fixture();
    const token = await reserve(create());
    observations.restored = false;
    await assert.rejects(
      create().claimAndStart(token, randomUUID(), () => assert.fail("spawned")),
      /not restored/,
    );
    assert.equal(await create().inspect([conversation]), "clear");
  });

  it("permits a startup restore to start under the live generation before marking it restored", async () => {
    const { create, observations } = fixture();
    observations.restored = false;
    const right = await create().reserveAfterLifecycleAudit([conversation], basis, {
      requireRestored: false,
    });
    assert.equal(right.state, "reserved");
    assert.ok(await create().claimAndStart(right.token, randomUUID(), spawn));
  });

  it("never grants the same launch token to two panes", async () => {
    const { create } = fixture();
    const token = await reserve(create());
    const claim = randomUUID();
    const claims = await Promise.all([
      create().claimAndStart(token, claim, spawn),
      create().claimAndStart(token, randomUUID(), spawn),
    ]);
    assert.deepEqual(claims, [
      { started: { pid: child.pid }, receipt: { claim, child } },
      undefined,
    ]);
  });

  it("inspects a reserved launch without modifying its on-disk evidence", async () => {
    const { create, path } = fixture();
    await reserve(create());
    const before = readFileSync(path, "utf8");
    assert.equal(await create().inspect([conversation]), "present");
    assert.equal(readFileSync(path, "utf8"), before);
  });

  it("refuses a corrupt ledger rather than overwriting it", async () => {
    const { create, path } = fixture();
    writeFileSync(path, "{truncated");
    await assert.rejects(
      create().reserveAfterLifecycleAudit([conversation], basis),
      /Cannot read Windows pi-mux launch rights/,
    );
    assert.equal(readFileSync(path, "utf8"), "{truncated");
  });
});
