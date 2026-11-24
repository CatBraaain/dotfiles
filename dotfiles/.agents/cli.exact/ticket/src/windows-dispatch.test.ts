import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dispatcherName } from "./dispatch";
import { WindowsWorkerRights, workerResponseVerifier } from "./windows-dispatch";

type Runtime = NonNullable<ConstructorParameters<typeof WindowsWorkerRights>[1]>;
type Right = Parameters<Runtime["create"]>[1];
const socket = "test-socket";
const generation = "0123456789abcdef";
const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture({ disconnectAfterActiveCommit = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ticket-worker-rights-"));
  directories.push(directory);
  const sessions = new Map<string, { right: Right; finish(): void }>();
  const workers: Promise<void>[] = [];
  const attempted: Right[] = [];
  const workStarted: string[] = [];
  const stopped: string[] = [];
  let claimEnabled = true;
  let currentGeneration = generation;
  let disconnectBeforeStop = false;
  let observationUnknown = false;
  let stopDisconnectsOnly = false;
  const runtime: Runtime = {
    activationTimeout: 400,
    stopTimeout: 100,
    async management() {
      return currentGeneration;
    },
    async create(_socket, right) {
      attempted.push(right);
      const work = Promise.withResolvers<void>();
      sessions.set(right.name, { right, finish: () => work.resolve() });
      if (claimEnabled) {
        workers.push(
          rights.runWorker(socket, right.project, right.token, async () => {
            workStarted.push(right.token);
            await work.promise;
          }),
        );
      }
    },
    async observe(_socket, right) {
      if (observationUnknown) return { state: "unknown" };
      const session = sessions.get(right.name);
      if (session?.right.token !== right.token) return { state: "gone" };
      let alive = true;
      let checks = 0;
      return {
        state: "bound",
        connection: {
          isAlive: () =>
            (!disconnectAfterActiveCommit || ++checks === 1) &&
            alive &&
            sessions.get(right.name) === session,
          stop() {
            if (stopDisconnectsOnly) {
              alive = false;
              observationUnknown = true;
              session.finish();
              return;
            }
            if (disconnectBeforeStop) {
              const replacement = { ...right, token: "unrelated" };
              sessions.set(right.name, { right: replacement, finish() {} });
            }
            if (sessions.get(right.name) !== session) {
              session.finish();
              return;
            }
            stopped.push(right.token);
            sessions.delete(right.name);
            session.finish();
          },
          async close() {},
        },
      };
    },
  };
  const rights = new WindowsWorkerRights(directory, runtime);

  return {
    directory,
    rights,
    sessions,
    attempted,
    stopped,
    workStarted,
    disableClaim() {
      claimEnabled = false;
    },
    enableClaim() {
      claimEnabled = true;
    },
    changeGeneration() {
      currentGeneration = "123456789abcdef0";
    },
    replaceBeforeStop() {
      disconnectBeforeStop = true;
    },
    makeObservationUnknown() {
      observationUnknown = true;
    },
    resumeObservation() {
      observationUnknown = false;
      stopDisconnectsOnly = false;
    },
    disconnectWithoutSessionExit() {
      stopDisconnectsOnly = true;
    },
    start(project: string | null) {
      return rights.start(socket, { project, name: dispatcherName(project), generation }, []);
    },
    async finish() {
      for (const session of sessions.values()) session.finish();
      await Promise.all(workers);
    },
  };
}

describe("Windows dispatcher worker launch rights", () => {
  it("activates only the worker whose claim and bound connection both match", async () => {
    const f = fixture();
    try {
      assert.equal(await f.start("a"), false);
      const entries = await f.rights.list(socket);
      assert.deepEqual(
        entries.map(({ project, name }) => [project, name]),
        [["a", dispatcherName("a")]],
      );
      assert.equal(await f.rights.stop(socket, "a"), true);
      assert.deepEqual(f.stopped, [f.attempted[0]!.token]);
      assert.deepEqual(await f.rights.list(socket), []);
    } finally {
      await f.finish();
    }
  });

  it("waits for a concurrent ledger reader before committing a launcher reservation", async () => {
    const f = fixture();
    const path = join(f.directory, "rights.sqlite");
    const reader = new Database(path);
    reader.exec("CREATE TABLE rights (scope TEXT PRIMARY KEY, record TEXT NOT NULL)");
    reader.exec("BEGIN");
    assert.deepEqual(reader.query("SELECT scope FROM rights").all(), []);
    const start = f.start("a").then(
      (restarted) => ({ restarted }),
      (error: unknown) => ({ error }),
    );
    try {
      await Bun.sleep(50);
      assert.deepEqual(f.attempted, []);
    } finally {
      reader.close();
    }
    try {
      assert.deepEqual(await start, { restarted: false });
      assert.equal(f.attempted.length, 1);
      assert.equal(await f.rights.stop(socket, "a"), true);
    } finally {
      await f.finish();
    }
  });

  it("does not report a worker that lost its bound peer as active after committing", async () => {
    const f = fixture({ disconnectAfterActiveCommit: true });
    try {
      await assert.rejects(f.start("a"), /Cannot confirm the activated Windows dispatcher worker/);
    } finally {
      await f.finish();
    }
  });

  it("preserves other projects and rejects a global start that overlaps live workers", async () => {
    const f = fixture();
    try {
      await f.start("a");
      await f.start("b");
      await assert.rejects(f.start(null), /overlapping dispatcher/);
      assert.equal(await f.rights.stop(socket, null), false);
      assert.equal(await f.rights.stop(socket, "a"), true);
      assert.deepEqual(
        (await f.rights.list(socket)).map(({ project }) => project),
        ["b"],
      );
    } finally {
      await f.finish();
    }
  });

  it("rejects a project start while global is active and keeps global on project stop", async () => {
    const f = fixture();
    try {
      await f.start(null);
      await assert.rejects(f.start("a"), /overlapping dispatcher/);
      assert.equal(await f.rights.stop(socket, "a"), false);
      assert.deepEqual(
        (await f.rights.list(socket)).map(({ project }) => project),
        [null],
      );
    } finally {
      await f.finish();
    }
  });

  it("restarts a same-scope worker using only its bound connection", async () => {
    const f = fixture();
    try {
      await f.start("a");
      assert.equal(await f.start("A"), true);
      assert.deepEqual(f.stopped, [f.attempted[0]!.token]);
      assert.notEqual(f.attempted[1]!.token, f.attempted[0]!.token);
      assert.deepEqual(
        (await f.rights.list(socket)).map(({ project }) => project),
        ["A"],
      );
    } finally {
      await f.finish();
    }
  });

  it("invalidates a never-claimed worker and prevents its delayed claim", async () => {
    const f = fixture();
    try {
      f.disableClaim();
      await assert.rejects(f.start("a"), /did not claim/);
      const stale = f.attempted[0]!;
      f.enableClaim();
      assert.equal(await f.start("a"), false);
      let staleRan = false;
      await f.rights.runWorker(socket, stale.project, stale.token, async () => {
        staleRan = true;
      });
      assert.equal(staleRan, false);
      assert.deepEqual(f.stopped, [stale.token]);
    } finally {
      await f.finish();
    }
  });

  it("revokes an unused reservation left by a dead caller even when the worker arrives later", async () => {
    const f = fixture();
    try {
      const token = "3ac4aba3-923b-4984-a9d3-4d26276042b0";
      const ledger = new Database(join(f.directory, "rights.sqlite"));
      ledger.exec("CREATE TABLE rights (scope TEXT PRIMARY KEY, record TEXT NOT NULL)");
      ledger.run("INSERT INTO rights VALUES (?, ?)", [
        "project:a",
        JSON.stringify({
          token,
          project: "a",
          name: dispatcherName("a"),
          generation,
          created: 1,
          state: "reserved",
        }),
      ]);
      ledger.close();
      await f.start(null);
      await f.rights.runWorker(socket, "a", token, async () => {
        assert.fail("revoked worker ran");
      });
      assert.deepEqual(
        (await f.rights.list(socket)).map(({ project }) => project),
        [null],
      );
    } finally {
      await f.finish();
    }
  });

  it("does not kill a same-name replacement after the previous connection breaks", async () => {
    const f = fixture();
    try {
      await f.start("a");
      f.replaceBeforeStop();
      assert.equal(await f.rights.stop(socket, "a"), true);
      assert.deepEqual(f.stopped, []);
      assert.equal(f.sessions.get(dispatcherName("a"))?.right.token, "unrelated");
    } finally {
      await f.finish();
    }
  });

  it("stops an owned session that outlives its worker lease", async () => {
    const f = fixture();
    try {
      await f.start("a");
      await f.finish();
      assert.equal(await f.rights.stop(socket, "a"), true);
      assert.deepEqual(f.stopped, [f.attempted[0]!.token]);
    } finally {
      await f.finish();
    }
  });

  it("retains the record until a disconnect is followed by verified session exit", async () => {
    const f = fixture();
    try {
      await f.start("a");
      f.disconnectWithoutSessionExit();
      await assert.rejects(
        f.rights.stop(socket, "a"),
        /cannot confirm dispatcher worker session is gone/,
      );
      await assert.rejects(f.start("a"), /cannot verify dispatcher worker to stop/);
      await assert.rejects(f.start(null), /cannot verify overlapping dispatcher has stopped/);
      assert.equal(f.attempted.length, 1);
      f.resumeObservation();
      assert.equal(await f.rights.stop(socket, "a"), true);
      assert.deepEqual(f.stopped, [f.attempted[0]!.token]);
    } finally {
      await f.finish();
    }
  });

  it("does not misreport a live claim with no verifiable session as absent", async () => {
    const f = fixture();
    try {
      await f.start("a");
      const name = dispatcherName("a");
      const session = f.sessions.get(name)!;
      f.sessions.set(name, { ...session, right: { ...session.right, token: "other" } });
      assert.deepEqual(await f.rights.list(socket), []);
      await assert.rejects(f.rights.stop(socket, "a"), /cannot verify dispatcher worker/);
      await assert.rejects(f.start("a"), /cannot verify dispatcher worker/);
      assert.deepEqual(f.stopped, []);
    } finally {
      await f.finish();
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when a claimed worker's liveness record cannot be opened",
    async () => {
      const f = fixture();
      try {
        await f.start("a");
        const lease = join(f.directory, `${f.attempted[0]!.token}.sqlite`);
        rmSync(lease);
        assert.equal(existsSync(lease), false);
        await assert.rejects(f.start("a"), /ENOENT/);
        await assert.rejects(f.rights.stop(socket, "a"), /ENOENT/);
        assert.deepEqual(f.stopped, []);
      } finally {
        await f.finish();
      }
    },
  );

  it("recovers the scope after the process holding the claim is killed", async () => {
    const f = fixture();
    f.disableClaim();
    const script = join(f.directory, "claim.ts");
    writeFileSync(
      script,
      `
import { WindowsWorkerRights } from ${JSON.stringify(join(import.meta.dir, "windows-dispatch.ts"))};
const rights = new WindowsWorkerRights(process.argv[2], {
  management: async () => ${JSON.stringify(generation)},
  observe: async () => ({
    state: "bound",
    connection: { isAlive: () => true, async close() {} },
  }),
  activationTimeout: 3000,
});
await rights.runWorker(${JSON.stringify(socket)}, "a", process.argv[3], async () => {
  console.log("worker active");
  await Bun.sleep(30000);
});
`,
    );
    const started = f.start("a");
    const expire = Date.now() + 300;
    while (f.attempted.length === 0 && Date.now() < expire) await Bun.sleep(5);
    assert.ok(f.attempted[0]);
    const child = Bun.spawn([process.execPath, script, f.directory, f.attempted[0].token], {
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      assert.equal(await started, false);
      const output = child.stdout.getReader();
      try {
        const first = await output.read();
        assert.match(new TextDecoder().decode(first.value), /worker active/);
      } finally {
        output.releaseLock();
      }
      child.kill();
      await child.exited;
      f.sessions.delete(dispatcherName("a"));
      assert.deepEqual(await f.rights.list(socket), []);
      f.enableClaim();
      assert.equal(await f.start("a"), false);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await f.finish();
    }
  });

  it("does not create a session after the verified generation changes", async () => {
    const f = fixture();
    f.changeGeneration();
    await assert.rejects(f.start("a"), /management changed/);
    assert.deepEqual(f.attempted, []);
  });
});

describe("psmux worker control response", () => {
  it("requires a complete successful frame for the identity query", () => {
    const verify = workerResponseVerifier("show-environment PROOF", "PROOF=expected");
    assert.equal(verify("PROOF=expected"), undefined);
    assert.equal(verify("show-environment PROOF"), undefined);
    assert.equal(verify("%begin 1234 1 1"), undefined);
    assert.equal(verify("PROOF=expected"), undefined);
    assert.equal(verify("%end 1234 1 1"), "owned");
  });

  it("does not treat a timed-out identity query as a replacement", () => {
    const verify = workerResponseVerifier("show-environment PROOF", "PROOF=expected");
    for (const line of ["show-environment PROOF", "%begin 1234 1 1", "command timed out"])
      assert.equal(verify(line), undefined);
    assert.equal(verify("%error 1234 1 1"), "unknown");
  });

  it("rejects a successful identity query with a different token", () => {
    const verify = workerResponseVerifier("show-environment PROOF", "PROOF=expected");
    for (const line of ["show-environment PROOF", "%begin 1234 1 1", "PROOF=replacement"])
      assert.equal(verify(line), undefined);
    assert.equal(verify("%end 1234 1 1"), "other");
  });
});
