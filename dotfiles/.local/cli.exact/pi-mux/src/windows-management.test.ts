import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationLaunchKey } from "./windows-launch-rights";
import {
  WindowsManagement,
  windowsManagementScope,
  type WindowsManagementScope,
} from "./windows-management";
import {
  inspectWindowsProcess,
  observeWindowsIdentity,
  type WindowsProcessIdentity,
} from "./windows-process";
import type { PsmuxQuery } from "./windows-psmux";

const directories: string[] = [];
const marker = "pi-mux-audit-end";
const firstInstance = "aaaaaaaaaaaaaaaa";
const laterInstance = "bbbbbbbbbbbbbbbb";
const firstPeer = { pid: 11, creationTime: "133970000000000000" };
const laterPeer = { pid: 12, creationTime: "133971000000000000" };
const piChild = { pid: 200, creationTime: "133973000000000000" };
const paneFormat = "#{pane_pid}\t#{@pi-tmux-session}";
const psmux =
  process.platform === "win32"
    ? (Bun.which("psmux.exe") ??
      join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "psmux.exe"))
    : undefined;

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pi-mux-windows-management-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = tempDirectory();
  const registryDirectory = join(directory, "registry");
  const scope: WindowsManagementScope = {
    registryDirectory,
    namespace: "mux",
    lockResource: "test-management",
    claimLockResource: "test-claims",
    storageDirectory: join(registryDirectory, "scope"),
  };
  const current = {
    instance: firstInstance,
    failTarget: "",
    omitPane: "",
    commands: [] as string[][],
    convertOnNextHeldQuery: false,
  };
  const peers = new Map<string, WindowsProcessIdentity>();
  const directChildren = new Map<number, WindowsProcessIdentity>();
  const inaccessible = new Set<number>();
  const remove = (name: string) => {
    peers.delete(name);
    for (const kind of ["pid", "port", "held"])
      rmSync(join(registryDirectory, `mux__${name}.${kind}`), { force: true });
  };
  const add = (name: string, identity: WindowsProcessIdentity) => {
    peers.set(name, identity);
    writeFileSync(
      join(registryDirectory, `mux__${name}.pid`),
      `${identity.pid}:${identity.creationTime}`,
    );
    writeFileSync(join(registryDirectory, `mux__${name}.port`), String(30000 + identity.pid));
    if (name === "__warm__")
      writeFileSync(join(registryDirectory, `mux__${name}.held`), String(identity.pid));
  };
  const query: PsmuxQuery = async (argv) => {
    current.commands.push(argv);
    const name = argv[3]?.replace(/^=/, "") ?? "__warm__";
    const peer = peers.get(name);
    if (name === current.failTarget || !peer) return { stdout: "", stderr: "", exitCode: 0 };
    if (argv[0] === "display-message") {
      const stdout = `${peer.pid}\t${current.instance}\t${name === "__warm__" ? "" : name}\t${marker}\r\n`;
      if (name === "__warm__" && current.convertOnNextHeldQuery) {
        current.convertOnNextHeldQuery = false;
        remove(name);
        add("alpha", peer);
      }
      return { stdout, stderr: "", exitCode: 0 };
    }
    assert.deepEqual(argv.slice(0, 3), ["list-panes", "-s", "-t"]);
    const response =
      current.omitPane === name
        ? ""
        : `${current.instance}\t${peer.pid}\t${name}\t$1\t1\t@0\t1\t%0\t57\t\t${marker}\r\n`;
    return { stdout: response, stderr: "", exitCode: 0 };
  };
  const create = (agentDir = "agent-a") =>
    new WindowsManagement(
      {
        socket: "C:/runtime/server.sock",
        directory,
        env: { PI_CODING_AGENT_DIR: agentDir },
        query,
      },
      {
        scope,
        inspectProcess(pid) {
          if (inaccessible.has(pid)) return { state: "unknown" };
          const identity =
            [...peers.values()].find((entry) => entry.pid === pid) ?? directChildren.get(pid);
          return identity ? { state: "live", identity } : { state: "ended" };
        },
      },
    );
  return {
    add,
    remove,
    create,
    current,
    directChildren,
    scope,
    inaccessible,
    retireProcess: (name: string) => peers.delete(name),
  };
}

let claimTail = Promise.resolve();

async function withClaimLock<T>(action: () => Promise<T>): Promise<T> {
  const previous = claimTail;
  const { promise, resolve } = Promise.withResolvers<void>();
  claimTail = promise;
  await previous;
  try {
    return await action();
  } finally {
    resolve();
  }
}

describe("Windows psmux management", () => {
  it("uses the same resource and storage across agent directories and registry aliases", () => {
    const socket = "C:/runtime/server.sock";
    const canonicalize = () => "C:\\User\\.psmux";
    const profile = { USERPROFILE: "C:/User" };
    const fromDefault = windowsManagementScope(
      { socket, directory: "C:/runtime", env: { ...profile, PI_CODING_AGENT_DIR: "first" } },
      canonicalize,
    );
    const fromAlias = windowsManagementScope(
      {
        socket,
        directory: "C:/runtime",
        env: { psmux_data_dir: "D:/alias", PI_CODING_AGENT_DIR: "second" },
      },
      canonicalize,
    );
    assert.deepEqual(fromAlias, fromDefault);
    assert.notEqual(fromAlias.lockResource, fromAlias.claimLockResource);
    const different = windowsManagementScope(
      { socket: "C:/runtime/other.sock", directory: "C:/runtime", env: profile },
      canonicalize,
    );
    assert.notEqual(different.lockResource, fromDefault.lockResource);
  });

  it("has no live basis in a missing registry and cannot audit an empty answer as absence", async () => {
    const { create } = fixture();
    assert.equal(await create().currentBasis(), undefined);
    await assert.rejects(create().audit(paneFormat), /not running/);
  });

  it("does not count stale registry records for processes known to have ended", async () => {
    const { create, add, retireProcess, current, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("alpha", firstPeer);
    retireProcess("alpha");
    assert.equal(await create().currentBasis(), undefined);
    assert.deepEqual(current.commands, []);
  });

  it("does not treat an inaccessible registered process as ended", async () => {
    const { create, add, inaccessible, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("alpha", firstPeer);
    inaccessible.add(firstPeer.pid);
    await assert.rejects(create().currentBasis(), /Cannot confirm.*inventory/);
  });

  it("does not change restored state while a claim operation owns the shared lock", async () => {
    const { create, add, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("alpha", firstPeer);
    const management = create();
    const basis = await management.currentBasis();
    assert.ok(basis);
    await management.prepareStartup(basis, [], withClaimLock);
    await management.markRestored(basis, withClaimLock);
    const { promise: held, resolve: acquired } = Promise.withResolvers<void>();
    const { promise: hold, resolve: release } = Promise.withResolvers<void>();
    const lockOperation = withClaimLock(async () => {
      acquired();
      await hold;
    });
    await held;
    const update = management.prepareStartup(basis, ["owner"], withClaimLock);
    try {
      await management.assertLive(basis);
      assert.equal(management.startupState(basis)?.restored, true);
    } finally {
      release();
      await lockOperation;
      await update;
    }
    assert.deepEqual(management.startupState(basis)?.restoring, ["owner"]);
  });

  it("authenticates an empty held peer and shares startup and restoring marks between agent directories", async () => {
    const { create, add, current, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("__warm__", firstPeer);
    const first = create();
    const other = create("agent-b");
    const basis = await first.currentBasis();
    assert.deepEqual(basis, { instance: firstInstance, witnesses: ["11:133970000000000000"] });
    assert.ok(basis);
    await first.prepareStartup(basis, ["Owner-Id", "other"], withClaimLock);
    await assert.rejects(other.audit(paneFormat), /not completed startup restore/);
    await other.clearRestoring(basis, "OTHER", withClaimLock);
    await first.markRestored(basis, withClaimLock);
    const result = await other.audit(paneFormat);
    assert.deepEqual(result.startup?.restoring, ["owner-id"]);
    assert.deepEqual(result.panes, [
      {
        peer: { name: "__warm__", identity: basis.witnesses[0], port: 30011, held: true },
        rows: [],
      },
    ]);
    assert.ok(
      current.commands.every(
        (args) => args[0] === "display-message" && args[2] === "-t" && args[3] === "=__warm__",
      ),
    );
  });

  it("retries held-to-session conversion and accepts the same authenticated witness by its new exact name", async () => {
    const { create, add, current, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("__warm__", firstPeer);
    const management = create();
    const basis = await management.currentBasis();
    assert.ok(basis);
    await management.prepareStartup(basis, [], withClaimLock);
    await management.markRestored(basis, withClaimLock);
    current.convertOnNextHeldQuery = true;
    const observed = await management.audit(paneFormat);
    assert.deepEqual(observed.basis, basis);
    assert.equal(observed.panes[0]?.peer.name, "alpha");
    assert.deepEqual(observed.panes[0]?.rows, ["57\t"]);
    assert.ok(
      current.commands.some((args) => args[0] === "display-message" && args.includes("=alpha")),
    );
  });

  it("cannot use an old restored record after authenticating a replacement generation", async () => {
    const { create, add, remove, current, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("alpha", firstPeer);
    const management = create();
    const basis = await management.currentBasis();
    assert.ok(basis);
    await management.prepareStartup(basis, ["old"], withClaimLock);
    await management.markRestored(basis, withClaimLock);
    remove("alpha");
    add("beta", laterPeer);
    current.instance = laterInstance;
    await assert.rejects(management.assertLive(basis), /generation changed/);
    await assert.rejects(management.audit(paneFormat), /not completed startup restore/);
    const replacement = await management.currentBasis();
    assert.ok(replacement);
    assert.equal(management.startupState(replacement), undefined);
  });

  it("rejects an incomplete exact peer or pane response even if the rest of the generation responds", async () => {
    const { create, add, current, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("alpha", firstPeer);
    add("beta", laterPeer);
    const management = create();
    const basis = await management.currentBasis();
    assert.deepEqual(basis?.witnesses, ["11:133970000000000000", "12:133971000000000000"]);
    current.failTarget = "beta";
    await assert.rejects(management.currentBasis(), /Cannot confirm.*inventory/);
    current.failTarget = "";
    current.omitPane = "beta";
    await assert.rejects(
      management.audit(paneFormat, { requireRestored: false }),
      /Cannot confirm.*inventory/,
    );
  });

  it("creates a shared ledger whose child receipt survives a new management object", async () => {
    const { create, add, directChildren, scope } = fixture();
    mkdirSync(scope.registryDirectory);
    add("alpha", firstPeer);
    const management = create();
    const basis = await management.currentBasis();
    assert.ok(basis);
    await management.prepareStartup(basis, [], withClaimLock);
    await management.markRestored(basis, withClaimLock);
    const rights = management.createLaunchRights(withClaimLock);
    const reserved = await rights.reserveAfterLifecycleAudit([conversationLaunchKey("id")], basis);
    assert.equal(reserved.state, "reserved");
    const claim = randomUUID();
    const launcher = create("other-agent").createLaunchRights(withClaimLock);
    await launcher.claimAndStart(reserved.token, claim, () => {
      directChildren.set(piChild.pid, piChild);
      return { pid: piChild.pid };
    });
    assert.deepEqual(await rights.status(reserved.token), {
      state: "live",
      receipt: { claim, child: piChild },
      completed: false,
    });
  });
});

it.skipIf(process.platform !== "win32")(
  "tracks a direct native Windows child through exit",
  async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let identity: WindowsProcessIdentity;
    try {
      const observed = inspectWindowsProcess(child.pid);
      assert.equal(observed.state, "live");
      identity = observed.identity;
      assert.equal(observeWindowsIdentity(identity, inspectWindowsProcess), "present");
    } finally {
      child.kill();
      await child.exited;
    }
    assert.equal(observeWindowsIdentity(identity, inspectWindowsProcess), "ended");
  },
);

it.skipIf(!psmux || !existsSync(psmux))(
  "authenticates an isolated native psmux generation across held conversion and restart",
  async () => {
    assert.ok(psmux);
    const directory = tempDirectory();
    const socket = join(directory, "isolated.sock");
    const registry = join(directory, "registry");
    const psmuxConfig = join(directory, "psmux.conf");
    mkdirSync(registry);
    writeFileSync(psmuxConfig, "set -g exit-empty off\n");
    const inheritedRouting = [
      "TMUX",
      "TMUX_PANE",
      "PSMUX_TARGET_SESSION",
      "PSMUX_TARGET_FULL",
      "PSMUX_ROUTE_WARM",
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, PSMUX_DATA_DIR: registry, PSMUX_NO_WARM: "1" };
    for (const key of inheritedRouting) delete env[key];
    const query: PsmuxQuery = async (args) => {
      const response = Bun.spawnSync([psmux, "-S", socket, "-f", psmuxConfig, ...args], {
        cwd: directory,
        env,
        timeout: 10_000,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        stdout: response.stdout.toString(),
        stderr: response.stderr.toString(),
        exitCode: response.exitCode,
      };
    };
    async function run(...args: string[]) {
      const response = await query(args);
      assert.equal(response.exitCode, 0, response.stderr);
    }
    const management = new WindowsManagement({ directory, socket, env, query });
    try {
      await run("start-server", ";", "set-option", "-g", "exit-empty", "off");
      const held = await management.audit(paneFormat, { requireRestored: false });
      assert.equal(held.panes[0]?.peer.held, true);
      assert.deepEqual(held.panes[0]?.rows, []);
      await management.prepareStartup(held.basis, [], withClaimLock);
      await management.markRestored(held.basis, withClaimLock);
      for (const name of ["alpha", "beta"]) {
        await run(
          "new-session",
          "-d",
          "-s",
          name,
          "--",
          process.execPath,
          "-e",
          "await Bun.sleep(60_000)",
        );
      }
      const active = await management.audit(paneFormat);
      assert.deepEqual(
        active.panes.map(({ peer }) => peer.name),
        ["alpha", "beta"],
      );
      assert.equal(active.basis.instance, held.basis.instance);
      assert.equal(active.panes[0]?.peer.identity, held.basis.witnesses[0]);
      assert.notEqual(active.panes[0]?.peer.identity, active.panes[1]?.peer.identity);
      await run("kill-server");
      await run("start-server", ";", "set-option", "-g", "exit-empty", "off");
      const replacement = await management.currentBasis();
      assert.ok(replacement);
      assert.notEqual(replacement.instance, active.basis.instance);
      await assert.rejects(management.audit(paneFormat), /not completed startup restore/);
    } finally {
      await query(["kill-server"]);
    }
  },
  30_000,
);
