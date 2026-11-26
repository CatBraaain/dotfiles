import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseOperation } from "./cli-arguments";
import type { TmuxConfig } from "./configuration";
import * as locks from "./locks";
import { platform } from "./platform";
import * as restoration from "./restoration";
import { notifyStartupInputDrained, notifyState } from "./state-notification";
import * as tmuxModule from "./tmux";
import * as windowsLifecycle from "./windows-lifecycle";
import { WindowsManagement } from "./windows-management";
import * as windowsProcess from "./windows-process";

const id = "startup-input-test";
const token = randomUUID();
const flag = "--startup-input-drained";
const metadataOption = "@pi-tmux-session";
const launchOption = "@pi-mux-launch";
const generationOption = "@pi-mux-generation";
const keepFields = { startup: "ready", warm: true, extension: { text: "notes あ $ # }" } };
const tmuxBinary = process.platform === "linux" ? Bun.which("tmux") : null;

function encode(metadata: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(metadata)).toString("base64");
}

function testConfig(root: string, tmux: string): TmuxConfig {
  const directory = join(root, "pi-tmux");
  const agentDir = join(root, "agent");
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const env = Object.assign(Object.fromEntries(inherited), {
    XDG_RUNTIME_DIR: root,
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
  });
  delete env.TMUX;
  delete env.TMUX_PANE;
  return {
    agentDir,
    stateDirectory: join(agentDir, "pi-tmux"),
    directory,
    extension: join(root, "bridge.ts"),
    tmuxConfig: "/dev/null",
    env,
    socket: join(directory, "server.sock"),
    tmux,
    noStart: true,
    timeout: 3_000,
  };
}

function realTmux() {
  assert.ok(tmuxBinary);
  const scratch = "/tmp/work/dotfiles";
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "pi-mux-startup-"));
  const config = testConfig(root, tmuxBinary);
  mkdirSync(dirname(config.socket), { mode: 0o700 });
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  function query(args: string[]): string {
    const { stdout, stderr, exitCode } = Bun.spawnSync(
      [config.tmux, "-S", config.socket, "-f", config.tmuxConfig, ...args],
      { env: config.env, timeout: config.timeout },
    );
    assert.equal(exitCode, 0, stderr.toString());
    return stdout.toString().replace(/\n$/, "");
  }
  const pane = query(["new-session", "-d", "-P", "-F", "#{pane_id}", "--", "/usr/bin/sleep", "60"]);
  const [serverPid, pid] = query(["display-message", "-p", "-t", pane, "#{pid}:#{pane_pid}"])
    .split(":")
    .map(Number);
  assert.ok(serverPid && pid);
  const source = { socket: config.socket, serverPid, pid, pane, token };
  const metadata = { id, pid, token, cwd: root, file: join(root, "pi.jsonl"), ...keepFields };
  const pending = encode({ ...metadata, reloadReadiness: "pending" });
  const launch = JSON.stringify({ id, pid, token, annotation: 'tag|name #, } "$PATH"' });
  function setOption(option: string, value: string) {
    if (option === generationOption) query(["set-option", "-g", option, value]);
    else query(["set-option", "-p", "-t", pane, option, value]);
  }
  function option(option: string) {
    return query(["show-options", "-pqv", "-t", pane, option]);
  }
  setOption(generationOption, randomUUID());
  setOption(launchOption, launch);
  setOption(metadataOption, pending);
  setOption("@pi_session_state", "old-state");
  setOption("@pi-mux-pending-restart-blocker", "1");
  return {
    config,
    source,
    metadata,
    pending,
    launch,
    setOption,
    option,
    close() {
      try {
        query(["kill-server"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

describe("startup input notification arguments", () => {
  const source = {
    socket: join(process.cwd(), "server.sock"),
    serverPid: 100,
    pane: "%1",
    pid: 101,
    token,
  };
  const encoded = JSON.stringify(source);

  it("accepts only the source for startup input and keeps ordinary state routing", () => {
    assert.deepEqual(parseOperation(["state", id, flag, "--source", encoded]), {
      kind: "startup-input-drained",
      id,
      source,
    });
    assert.deepEqual(parseOperation(["state", id, "--clear", "--source", encoded]), {
      kind: "state",
      id,
      source,
      notification: { clear: true },
    });
    assert.deepEqual(
      parseOperation(["state", id, "waiting-user", "--source", encoded, "--title", "null"]),
      {
        kind: "state",
        id,
        source,
        notification: { clear: false, state: "waiting-user", title: null },
      },
    );
  });

  it("rejects missing, malformed, or combined arguments", () => {
    for (const argv of [
      [flag],
      [flag, "--source"],
      [flag, "--source", "null"],
      [flag, "--source", encoded, "--source", encoded],
      [flag, "--source", encoded, "--title", "null"],
      [flag, "--clear", "--source", encoded],
      ["waiting-user", "--source", encoded, "--title", "null", flag],
      ["--clear", "--source", encoded, flag],
    ]) {
      assert.throws(() => parseOperation(["state", id, ...argv]), /state startup-input-test:/);
    }
  });
});

describe.skipIf(!tmuxBinary)("startup input publication to tmux", () => {
  it("publishes through the CLI with the lifecycle lock held and preserves state and launch", async () => {
    const fixture = realTmux();
    try {
      await locks.withLock(fixture.config, async () => {
        const result = Bun.spawnSync(
          [
            process.execPath,
            join(import.meta.dir, "main.ts"),
            "state",
            id,
            flag,
            "--source",
            JSON.stringify(fixture.source),
          ],
          { env: fixture.config.env, timeout: 3_000 },
        );
        assert.equal(result.exitCode, 0, result.stderr.toString());
      });
      const drained = encode({ ...fixture.metadata, reloadReadiness: "drained" });
      assert.equal(fixture.option(metadataOption), drained);
      assert.equal(fixture.option(launchOption), fixture.launch);
      assert.equal(fixture.option("@pi_session_state"), "old-state");
      assert.equal(fixture.option("@pi-mux-pending-restart-blocker"), "1");
      await notifyStartupInputDrained(fixture.config, id, fixture.source);
      assert.equal(fixture.option(metadataOption), drained);
    } finally {
      fixture.close();
    }
  });

  it("does not treat ordinary waiting-user state as proof or add missing readiness", async () => {
    const fixture = realTmux();
    try {
      const child = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "main.ts"),
          "state",
          id,
          "waiting-user",
          "--source",
          JSON.stringify(fixture.source),
          "--title",
          "null",
        ],
        { env: fixture.config.env, timeout: 3_000 },
      );
      assert.equal(child.exitCode, 0, child.stderr.toString());
      assert.equal(JSON.parse(fixture.option("@pi_session_state")).state, "waiting-user");
      assert.equal(fixture.option(metadataOption), fixture.pending);
      for (const raw of [
        encode(fixture.metadata),
        encode({ ...fixture.metadata, reloadReadiness: "unknown" }),
      ]) {
        fixture.setOption(metadataOption, raw);
        await assert.rejects(
          notifyStartupInputDrained(fixture.config, id, fixture.source),
          /not published pending/,
        );
        assert.equal(fixture.option(metadataOption), raw);
      }
    } finally {
      fixture.close();
    }
  });

  it("rejects a wrong source, mismatched launch, or live PID outside the pane", async () => {
    const fixture = realTmux();
    try {
      for (const changes of [
        { socket: "/other/socket" },
        { serverPid: fixture.source.serverPid + 1 },
        { pane: "%999999" },
        { pid: fixture.source.pid + 1 },
        { token: randomUUID() },
      ]) {
        await assert.rejects(
          notifyStartupInputDrained(fixture.config, id, { ...fixture.source, ...changes }),
          /Source/,
        );
        assert.equal(fixture.option(metadataOption), fixture.pending);
      }
      fixture.setOption(
        launchOption,
        JSON.stringify({ id: "other-id", pid: fixture.source.pid, token }),
      );
      await assert.rejects(
        notifyStartupInputDrained(fixture.config, id, fixture.source),
        /startup metadata and launch/,
      );
      assert.equal(fixture.option(metadataOption), fixture.pending);

      fixture.setOption(launchOption, fixture.launch);
      const unrelated = encode({
        ...fixture.metadata,
        processPid: process.pid,
        reloadReadiness: "pending",
      });
      fixture.setOption(metadataOption, unrelated);
      await assert.rejects(
        notifyStartupInputDrained(fixture.config, id, { ...fixture.source, pid: process.pid }),
        /not live in the pane/,
      );
      assert.equal(fixture.option(metadataOption), unrelated);
    } finally {
      fixture.close();
    }
  });

  for (const option of [metadataOption, launchOption, generationOption]) {
    it(`does not mutate the pane if ${option} changed after observation`, async () => {
      const fixture = realTmux();
      const invoke = tmuxModule.tmux;
      const replacement =
        option === metadataOption
          ? encode({
              ...fixture.metadata,
              reloadReadiness: "pending",
              extension: { text: "replacement" },
            })
          : option === launchOption
            ? fixture.launch.replace("tag|name", "new|name")
            : randomUUID();
      const run = spyOn(tmuxModule, "tmux").mockImplementation((...args) => {
        if (args[1][0] === "source-file") fixture.setOption(option, replacement);
        return invoke(...args);
      });
      try {
        await assert.rejects(
          notifyStartupInputDrained(fixture.config, id, fixture.source),
          /Cannot confirm guarded startup input/,
        );
        assert.equal(
          fixture.option(metadataOption),
          option === metadataOption ? replacement : fixture.pending,
        );
      } finally {
        run.mockRestore();
        fixture.close();
      }
    });
  }
});

function mockWindowsState() {
  const config = testConfig(process.cwd(), "not-used");
  const peer = { identity: "100:1234", name: "active", port: 10000 };
  const source = { socket: config.socket, serverPid: 100, pane: "%1", pid: 103, token };
  const metadata = { id, pid: 102, processPid: source.pid, token, ...keepFields };
  const launch = JSON.stringify({ id, pid: 102, token });
  const pending = encode({ ...metadata, reloadReadiness: "pending" });
  const drained = encode({ ...metadata, reloadReadiness: "drained" });
  const scope = {
    lockResource: "not-used",
    claimLockResource: "not-used",
    registryDirectory: "not-used",
    namespace: "test",
    storageDirectory: "not-used",
  };
  const management = new WindowsManagement(
    {
      ...config,
      query: async () => {
        throw new Error("Unexpected backend query");
      },
    },
    { scope },
  );
  const auditSpy = spyOn(management, "audit");
  const useManagement = spyOn(tmuxModule, "windowsManagement").mockReturnValue(management);
  const inspect = spyOn(windowsProcess, "inspectWindowsProcess").mockImplementation((pid) => ({
    state: "live",
    identity: { pid, creationTime: String(pid * 100) },
  }));
  const mutate = spyOn(windowsLifecycle, "mutateWindowsPeerPane").mockResolvedValue("applied");
  const assertLive = spyOn(management, "assertLive").mockResolvedValue(undefined);
  const snapshot = spyOn(restoration, "snapshotSessions").mockResolvedValue(undefined);
  const lock = spyOn(locks, "withLock").mockImplementation(
    async (_config, action) => await action(),
  );
  const originalPlatform = platform.windows;
  platform.windows = true;
  const audit = observePane(pending);
  return {
    config,
    source,
    audit,
    auditSpy,
    peer,
    scope,
    inspect,
    launch,
    metadata,
    pending,
    drained,
    mutate,
    lock,
    snapshot,
    observePane,
    close() {
      platform.windows = originalPlatform;
      lock.mockRestore();
      snapshot.mockRestore();
      assertLive.mockRestore();
      mutate.mockRestore();
      inspect.mockRestore();
      useManagement.mockRestore();
      auditSpy.mockRestore();
    },
  };

  function observePane(encoded: string, temporary = "", launchRaw = launch) {
    const observation = {
      basis: { instance: "abcdef1234567890", witnesses: [peer.identity] },
      panes: [{ peer: { ...peer }, rows: [`%1\t102\t0\t${encoded}\t${launchRaw}\t${temporary}`] }],
      startup: undefined,
    };
    auditSpy.mockResolvedValue(observation);
    return observation;
  }
}

describe("startup input publication to a Windows peer", () => {
  it("passes the audited peer, raw options and both process generations to the guarded mutator", async () => {
    const fixture = mockWindowsState();
    const { config, source, audit, auditSpy, peer, scope, launch, pending, drained, mutate } =
      fixture;
    try {
      await notifyStartupInputDrained(config, id, source);
      assert.deepEqual(auditSpy.mock.calls[0]?.[1], { requireRestored: false });
      assert.deepEqual(mutate.mock.calls[0], [
        scope,
        audit,
        peer,
        source.pane,
        {
          expected: [
            ["pane_pid", "102"],
            [metadataOption, pending],
            [launchOption, launch],
          ],
          mutations: [{ option: metadataOption, value: drained }],
          processes: [
            { pid: 102, creationTime: "10200" },
            { pid: 103, creationTime: "10300" },
          ],
        },
      ]);
      mutate.mockClear();
      await assert.rejects(
        notifyStartupInputDrained(config, id, { ...source, serverPid: 999 }),
        /does not match/,
      );
      assert.equal(mutate.mock.calls.length, 0);

      fixture.observePane(drained);
      await notifyStartupInputDrained(config, id, source);
      assert.deepEqual(mutate.mock.calls[0]?.[4].mutations, []);
      assert.deepEqual(mutate.mock.calls[0]?.[4].expected[1], [metadataOption, drained]);
    } finally {
      fixture.close();
    }
  });
});

describe("Windows running promotion during startup acknowledgement", () => {
  const running = { clear: false, state: "running", title: null } as const;
  const pendingState = "@pi_session_state_pending";

  it("retries the first running write if the ACK commits immediately before it", async () => {
    const fixture = mockWindowsState();
    const { config, source, pending, drained, observePane, mutate, lock, snapshot } = fixture;
    try {
      observePane(pending, id);
      mutate.mockImplementationOnce(async () => {
        observePane(drained, id);
        throw new Error("Raw metadata compare failed");
      });
      mutate.mockImplementationOnce(async () => {
        assert.equal(lock.mock.calls.length, 0);
        return "applied";
      });
      assert.equal(await notifyState(config, id, source, running), 0);
      assert.equal(mutate.mock.calls.length, 4);
      const [first, retry, promote, clearPending] = mutate.mock.calls.map((call) => call[4]);
      assert.ok(first && retry && promote && clearPending);
      assert.equal(first.owner, undefined);
      assert.deepEqual(first.expected[1], [metadataOption, pending]);
      assert.deepEqual(retry, {
        ...first,
        expected: [first.expected[0]!, [metadataOption, drained], first.expected[2]!],
      });
      const ownerPublication = first.mutations[0];
      assert.ok(ownerPublication && "option" in ownerPublication);
      const owner = [ownerPublication.option, ownerPublication.value];
      assert.deepEqual(promote.owner, owner);
      assert.deepEqual(promote.expected, [...retry.expected, ["PI_TMUX_TEMPORARY", id]]);
      assert.deepEqual(promote.mutations, [{ unsetTemporary: true }]);
      assert.deepEqual(clearPending.owner, owner);
      assert.deepEqual(clearPending.expected, retry.expected);
      assert.deepEqual(clearPending.mutations, [{ option: pendingState }]);
      assert.deepEqual(snapshot.mock.calls, [[config, fixture.audit.basis.instance, "repair"]]);
    } finally {
      fixture.close();
    }
  });

  it("does not retry the first running write if other metadata changed with the ACK", async () => {
    const fixture = mockWindowsState();
    const { config, source, pending, observePane, mutate, lock, snapshot } = fixture;
    try {
      observePane(pending, id);
      mutate.mockImplementationOnce(async () => {
        observePane(encode({ ...fixture.metadata, reloadReadiness: "drained", warm: false }), id);
        throw new Error("Raw metadata compare failed");
      });
      await assert.rejects(notifyState(config, id, source, running), /Source pane changed/);
      assert.equal(mutate.mock.calls.length, 1);
      assert.equal(lock.mock.calls.length, 0);
      assert.equal(snapshot.mock.calls.length, 0);
    } finally {
      fixture.close();
    }
  });

  for (const phase of ["promotion", "cleanup"] as const) {
    it(`retries ${phase} once with only the acknowledged metadata and the original owner`, async () => {
      const fixture = mockWindowsState();
      const { config, source, pending, drained, observePane, mutate, snapshot } = fixture;
      try {
        observePane(pending, id);
        mutate.mockResolvedValueOnce("applied");
        const hasPromoted = phase === "cleanup";
        if (hasPromoted) mutate.mockResolvedValueOnce("applied");
        mutate.mockImplementationOnce(async () => {
          observePane(drained, hasPromoted ? "" : id);
          throw new Error("Raw metadata compare failed");
        });
        assert.equal(await notifyState(config, id, source, running), 0);
        assert.equal(mutate.mock.calls.length, 4);
        const options = mutate.mock.calls.map((call) => call[4]);
        const [publish, ...owned] = options;
        const ownerPublication = publish?.mutations[0];
        assert.ok(ownerPublication && "option" in ownerPublication);
        const originalOwner = [ownerPublication.option, ownerPublication.value];
        for (const attempt of owned) assert.deepEqual(attempt.owner, originalOwner);
        const rawOptions = owned.map(({ expected }) => expected[1]);
        assert.deepEqual(rawOptions, [
          [metadataOption, pending],
          [metadataOption, hasPromoted ? pending : drained],
          [metadataOption, drained],
        ]);
        for (const attempt of owned.filter(({ mutations }) => "unsetTemporary" in mutations[0]!))
          assert.deepEqual(attempt.expected.at(-1), ["PI_TMUX_TEMPORARY", id]);
        assert.deepEqual(owned.at(-1)?.mutations, [{ option: pendingState }]);
        assert.equal(snapshot.mock.calls.length, 1);
      } finally {
        fixture.close();
      }
    });
  }

  it("accepts a refreshed ACK before promotion but never falls back to the pending metadata", async () => {
    const fixture = mockWindowsState();
    const { config, source, pending, drained, observePane, mutate, snapshot } = fixture;
    try {
      observePane(pending, id);
      mutate.mockImplementationOnce(async () => {
        observePane(drained, id);
        return "applied";
      });
      snapshot.mockImplementationOnce(async () => {
        observePane(pending);
      });
      mutate
        .mockResolvedValueOnce("applied")
        .mockRejectedValueOnce(new Error("Raw metadata compare failed"));
      await assert.rejects(notifyState(config, id, source, running), /Raw metadata compare failed/);
      assert.deepEqual(
        mutate.mock.calls.map((call) => call[4].expected[1]),
        [
          [metadataOption, pending],
          [metadataOption, drained],
          [metadataOption, drained],
        ],
      );
      assert.equal(snapshot.mock.calls.length, 1);
    } finally {
      fixture.close();
    }
  });

  it("keeps deferred blocker semantics when the ACK lands while the lock is busy", async () => {
    const fixture = mockWindowsState();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { config, source, pending, drained, observePane, mutate, lock, snapshot } = fixture;
      observePane(pending, id);
      lock.mockRejectedValueOnce(new locks.LockBusyError("busy"));
      mutate.mockResolvedValueOnce("applied").mockImplementationOnce(async () => {
        observePane(drained, id);
        throw new Error("Raw metadata compare failed");
      });
      assert.equal(await notifyState(config, id, source, running), 75);
      assert.equal(mutate.mock.calls.length, 3);
      const attempt = mutate.mock.calls[1]![4];
      const retry = mutate.mock.calls[2]![4];
      assert.deepEqual(retry.owner, attempt.owner);
      assert.deepEqual(retry.expected[1], [metadataOption, drained]);
      assert.deepEqual(retry.mutations, attempt.mutations);
      assert.deepEqual(retry.mutations[0], {
        option: "@pi-mux-pending-restart-blocker",
        value: "1",
      });
      const veto = retry.mutations[1];
      assert.ok(veto && "option" in veto);
      assert.equal(veto.option, "@pi-mux-restart-veto");
      assert.equal(veto.global, true);
      assert.match(veto.value ?? "", /^[a-f0-9-]{36}$/);
      assert.equal(snapshot.mock.calls.length, 0);
    } finally {
      log.mockRestore();
      fixture.close();
    }
  });

  for (const change of [
    "metadata",
    "launch",
    "peer",
    "generation",
    "process",
    "temporary",
    "no-ack",
    "owner",
  ] as const) {
    it(`does not retry when continuity is broken: ${change}`, async () => {
      const fixture = mockWindowsState();
      const { config, source, pending, drained, observePane, mutate, snapshot } = fixture;
      try {
        observePane(pending, id);
        mutate.mockResolvedValueOnce("applied").mockImplementationOnce(async () => {
          const raw =
            change === "metadata"
              ? encode({ ...fixture.metadata, reloadReadiness: "drained", warm: false })
              : change === "no-ack"
                ? pending
                : drained;
          const launch = change === "launch" ? `${fixture.launch} ` : fixture.launch;
          const next = observePane(raw, change === "temporary" ? "" : id, launch);
          if (change === "peer") next.panes[0]!.peer.port++;
          if (change === "generation") next.basis.instance = "fedcba0987654321";
          if (change === "process")
            fixture.inspect.mockImplementation((pid) => ({
              state: "live",
              identity: { pid, creationTime: String(pid * 101) },
            }));
          if (change === "owner") return "owner-changed";
          throw new Error("Raw metadata compare failed");
        });
        const expected =
          change === "owner" ? /no longer owns/ : /Source pane changed|Raw metadata compare failed/;
        await assert.rejects(notifyState(config, id, source, running), expected);
        assert.equal(mutate.mock.calls.length, 2);
        assert.equal(snapshot.mock.calls.length, 0);
      } finally {
        fixture.close();
      }
    });
  }
});
