import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstInputDirectory } from "./pane-inventory";
import { platformFor } from "./platform";
import {
  auditWindowsLifecycle,
  windowsPaneIsWaiting,
  type WindowsLifecycleAudit,
} from "./server-lifecycle";
import {
  planWindowsReload,
  replaceVerifiedWindowsReloadPane,
  startingConversationId,
  verifyWindowsReloadGroup,
  windowsReloadDispatchEnvironment,
  windowsReloadIsWaiting,
  windowsReloadSnapshotCandidates,
} from "./windows-reload";
import { conversationLaunchKey, ticketLaunchKey } from "./windows-launch-rights";
import { WindowsManagement, type WindowsManagementScope } from "./windows-management";
import type { PsmuxQuery } from "./windows-psmux";

const marker = "pi-mux-audit-end";
const instance = "aaaaaaaaaaaaaaaa";
const socket = "/runtime/pi-tmux/server.sock";
const cwd = "/tmp/workspace";
const directories: string[] = [];

type PaneSpec = {
  panePid?: number;
  managedId?: string;
  temporary?: string;
  cwd?: string;
  metadata?: { id: string; startup?: "accepted" | "ready"; reloadReadiness?: string };
  launch?: { id: string; pid: number; token?: string } | "not-json";
  role?: string;
  right?: string;
  state?: "running" | "waiting-user" | null;
  source?: "matching" | "other-token" | "none";
  blocker?: string;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function paneRow(name: string, spec: PaneSpec, index: number, peerPid: number): string {
  const panePid = spec.panePid ?? 57;
  const token = randomUUID();
  const id = spec.metadata?.id ?? spec.managedId ?? "";
  const directory = spec.cwd ?? cwd;
  const metadata = spec.metadata
    ? Buffer.from(
        JSON.stringify({
          id: spec.metadata.id,
          cwd: directory,
          file: `/tmp/sessions/${spec.metadata.id}.jsonl`,
          pid: panePid,
          startup: spec.metadata.startup,
          reloadReadiness: spec.metadata.reloadReadiness,
          token,
        }),
      ).toString("base64")
    : "";
  const state = spec.state
    ? JSON.stringify({ version: 1, sessionId: id, state: spec.state, title: null })
    : "";
  const source = JSON.stringify({
    id,
    socket,
    serverPid: peerPid,
    pane: `%${index}`,
    pid: panePid,
    token: spec.source === "other-token" ? randomUUID() : token,
  });
  const launch =
    spec.launch === undefined || spec.launch === "not-json"
      ? (spec.launch ?? "")
      : JSON.stringify({ ...spec.launch, token: spec.launch.token ?? token });
  return [
    `%${index}`,
    "$1",
    name,
    metadata,
    String(panePid),
    "0",
    "1",
    "1",
    spec.managedId ?? "",
    spec.temporary ?? "",
    directory,
    launch,
    spec.role ?? "",
    spec.right ?? "",
    state,
    source,
    spec.blocker ?? "",
    spec.right ?? "",
  ].join("\t");
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-mux-windows-reload-"));
  directories.push(directory);
  const registryDirectory = join(directory, "registry");
  const storageDirectory = join(registryDirectory, "scope");
  mkdirSync(storageDirectory, { recursive: true });
  writeFileSync(
    join(storageDirectory, "startup.json"),
    JSON.stringify({ version: 1, instance, restored: true, restoring: [] }),
  );
  const scope: WindowsManagementScope = {
    registryDirectory,
    namespace: "mux",
    lockResource: "reload-test",
    claimLockResource: "reload-test-claims",
    storageDirectory,
  };
  const peers = new Map<string, { pid: number; panes: PaneSpec[] }>();
  const add = (name: string, pid: number, panes: PaneSpec[]) => {
    peers.set(name, { pid, panes });
    writeFileSync(join(registryDirectory, `mux__${name}.pid`), `${pid}:${pid * 100}`);
    writeFileSync(join(registryDirectory, `mux__${name}.port`), String(30000 + pid));
  };
  const query: PsmuxQuery = async (argv) => {
    const name = argv[3]?.replace(/^=/, "") ?? "";
    const peer = peers.get(name);
    if (!peer) return { stdout: "", stderr: "can't find session", exitCode: 1 };
    if (argv[0] === "display-message")
      return {
        stdout: `${peer.pid}\t${instance}\t${name}\t${marker}\r\n`,
        stderr: "",
        exitCode: 0,
      };
    const rows = peer.panes
      .map(
        (spec, index) =>
          `${instance}\t${peer.pid}\t${name}\t$1\t1\t@0\t${peer.panes.length}\t%${index}\t${paneRow(name, spec, index, peer.pid)}\t${marker}\r\n`,
      )
      .join("");
    return { stdout: rows, stderr: "", exitCode: 0 };
  };
  const management = new WindowsManagement(
    { socket, directory, env: {}, query },
    {
      scope,
      inspectProcess(pid) {
        const peer = [...peers.values()].find((candidate) => candidate.pid === pid);
        return peer
          ? { state: "live", identity: { pid, creationTime: String(pid * 100) } }
          : { state: "ended" };
      },
    },
  );
  return {
    add,
    audit: async (): Promise<WindowsLifecycleAudit> =>
      await auditWindowsLifecycle(management, "reload"),
    config: {
      socket,
      stateDirectory: directory,
      directory,
      agentDir: directory,
      extension: join(directory, "extension"),
      tmuxConfig: join(directory, "pi.conf"),
      tmux: "tmux",
      env: {},
    },
  };
}

function entryOf(audit: WindowsLifecycleAudit, name: string) {
  const entry = audit.entries.find(({ peer }) => peer.name === name);
  assert.ok(entry, `${name} should have a pane entry`);
  return entry;
}

function progress(confirmed: string[] = [], initialPanes: ReturnType<typeof initialPane>[] = []) {
  return {
    initialPanes,
    reloaded: new Set<string>(),
    failed: new Set<string>(),
    inFlight: new Map<string, never>(),
    confirmed: new Set(confirmed),
  };
}

const initialPane = (panePid: number, session = "$1", peerIdentity = "11:1100") => ({
  session,
  peerIdentity,
  cwd,
  pane: "%0",
  id: managed.managedId!,
  panePid,
});

const dispatched: PaneSpec = {
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    startup: "ready",
    reloadReadiness: "drained",
  },
  role: "pi",
  right: randomUUID(),
  state: "waiting-user",
};
const managed: PaneSpec = {
  managedId: "22222222-2222-4222-8222-222222222222",
  metadata: {
    id: "22222222-2222-4222-8222-222222222222",
    startup: "ready",
    reloadReadiness: "drained",
  },
  launch: { id: "22222222-2222-4222-8222-222222222222", pid: 57 },
  right: randomUUID(),
  state: "waiting-user",
};
const temporary: PaneSpec = {
  managedId: "33333333-3333-4333-8333-333333333333",
  temporary: "33333333-3333-4333-8333-333333333333",
  metadata: {
    id: "33333333-3333-4333-8333-333333333333",
    startup: "ready",
    reloadReadiness: "drained",
  },
  launch: { id: "33333333-3333-4333-8333-333333333333", pid: 57 },
  right: randomUUID(),
  state: "waiting-user",
};

describe("Windows reload readiness", () => {
  it("does not treat an accepted startup as waiting even with a published waiting-user phase", async () => {
    const test = fixture();
    test.add("alpha", 11, [
      { ...managed, metadata: { id: managed.managedId!, startup: "accepted" } },
    ]);
    assert.equal(windowsPaneIsWaiting(test.config, entryOf(await test.audit(), "alpha")), false);
  });

  it("waits for pending reload proof even if legacy startup is ready and the phase is waiting-user", async () => {
    const test = fixture();
    const id = managed.managedId!;
    test.add("alpha", 11, [
      { ...managed, metadata: { id, startup: "ready", reloadReadiness: "pending" } },
    ]);
    const audit = await test.audit();
    const entry = entryOf(audit, "alpha");
    const plan = planWindowsReload(audit, progress(), id);
    assert.deepEqual(plan.candidates, [entry]);
    assert.deepEqual(plan.rejected, []);
    assert.equal(windowsReloadIsWaiting(test.config, entry), false);
    assert.equal(windowsPaneIsWaiting(test.config, entry), true);
  });

  it.each([undefined, "unknown"])(
    "excludes only the ID with %s reload proof",
    async (reloadReadiness) => {
      const test = fixture();
      const id = managed.managedId!;
      test.add("alpha", 11, [{ ...managed, metadata: { id, startup: "ready", reloadReadiness } }]);
      test.add("beta", 12, [dispatched]);
      const audit = await test.audit();
      const entry = entryOf(audit, "alpha");
      const plan = planWindowsReload(audit, progress());
      assert.equal(entry.pi?.reloadReadiness, undefined);
      assert.equal(windowsReloadIsWaiting(test.config, entry), false);
      assert.equal(windowsPaneIsWaiting(test.config, entry), true);
      assert.deepEqual(plan.candidates, [entryOf(audit, "beta")]);
      assert.deepEqual(plan.rejected, [
        { id, reason: "Missing or invalid proof that pi drained its startup input" },
      ]);
      assert.deepEqual(planWindowsReload(audit, progress(), id).rejected, plan.rejected);
    },
  );

  it("requires waiting-user and no blocker even with drained reload proof", async () => {
    const test = fixture();
    test.add("alpha", 11, [managed]);
    const entry = entryOf(await test.audit(), "alpha");
    assert.equal(windowsReloadIsWaiting(test.config, entry), true);
    assert.equal(windowsReloadIsWaiting(test.config, { ...entry, state: "" }), false);
    assert.equal(windowsReloadIsWaiting(test.config, { ...entry, owner: "" }), false);
    assert.equal(windowsReloadIsWaiting(test.config, { ...entry, blocker: "1" }), false);
    assert.equal(
      windowsReloadIsWaiting(test.config, {
        ...entry,
        state: JSON.stringify({
          version: 1,
          sessionId: managed.managedId,
          state: "running",
          title: null,
        }),
      }),
      false,
    );
  });

  it("rejects drained reload proof if the waiting-user state source names another launch token", async () => {
    const test = fixture();
    test.add("alpha", 11, [{ ...managed, source: "other-token" }]);
    assert.equal(windowsReloadIsWaiting(test.config, entryOf(await test.audit(), "alpha")), false);
  });
});

describe("Windows reload identification", () => {
  it("identifies dispatched, managed, and temporary pi by their published metadata alone", async () => {
    const test = fixture();
    test.add("alpha", 11, [dispatched]);
    test.add("beta", 12, [managed]);
    test.add("gamma", 13, [temporary]);
    const audit = await test.audit();

    assert.deepEqual(
      audit.ownership.map(({ session: { id } }) => id),
      [managed.managedId, temporary.managedId],
    );
    assert.deepEqual(
      audit.entries.map(({ temporary: isTemporary }) => isTemporary),
      [false, false, true],
    );
    const plan = planWindowsReload(audit, progress());
    assert.deepEqual(
      plan.candidates.map(({ pi }) => pi?.id).sort(),
      [dispatched.metadata!.id, managed.managedId, temporary.managedId].sort(),
    );
    assert.deepEqual(plan.rejected, []);
    assert.deepEqual(plan.starting, []);
  });

  it("narrows a targeted reload to the requested conversation", async () => {
    const test = fixture();
    test.add("alpha", 11, [dispatched]);
    test.add("beta", 12, [managed]);
    const plan = planWindowsReload(await test.audit(), progress(), dispatched.metadata!.id);
    assert.deepEqual(
      plan.candidates.map(({ peer }) => peer.name),
      ["alpha"],
    );
    assert.deepEqual(
      plan.running.map(({ peer }) => peer.name),
      ["alpha"],
    );
    assert.deepEqual(plan.confirmed, [dispatched.metadata!.id]);
  });

  it("waits for a starting pi that its launch record identifies by ID, pane PID, and token", async () => {
    const test = fixture();
    const starting: PaneSpec = {
      managedId: managed.managedId,
      launch: { id: managed.managedId!, pid: 57, token: randomUUID() },
      right: randomUUID(),
    };
    test.add("alpha", 11, [starting]);
    test.add("beta", 12, [{ launch: { id: managed.managedId!, pid: 999, token: randomUUID() } }]);
    test.add("gamma", 13, [{ launch: "not-json" }]);
    const audit = await test.audit();

    assert.ok(audit.entries.every(({ pi }) => pi === undefined));
    assert.equal(startingConversationId(entryOf(audit, "alpha")), managed.managedId);
    assert.equal(startingConversationId(entryOf(audit, "beta")), undefined);
    assert.equal(startingConversationId(entryOf(audit, "gamma")), undefined);
    const plan = planWindowsReload(audit, progress());
    assert.deepEqual(
      plan.starting.map(({ peer }) => peer.name),
      ["alpha"],
    );
    assert.deepEqual(plan.candidates, []);
    assert.deepEqual(plan.confirmed, [managed.managedId]);
  });

  it("does not exclude a published pi merely because it has no launch record or right", async () => {
    const test = fixture();
    const manual: PaneSpec = {
      metadata: dispatched.metadata,
      state: "waiting-user",
    };
    test.add("alpha", 11, [manual]);
    const audit = await test.audit();
    const entry = entryOf(audit, "alpha");
    assert.equal(entry.launch, "");
    assert.equal(entry.right, "");

    const plan = planWindowsReload(audit, progress());
    assert.deepEqual(plan.candidates, [entry]);
    assert.deepEqual(plan.rejected, []);
  });

  it("rejects a pane that shares its session with another pane", async () => {
    const test = fixture();
    test.add("alpha", 11, [
      dispatched,
      { panePid: 58, launch: { id: "other", pid: 58, token: randomUUID() } },
    ]);
    const plan = planWindowsReload(await test.audit(), progress());
    assert.deepEqual(plan.candidates, []);
    assert.deepEqual(
      plan.rejected.map(({ id, reason }) => ({ id, reason })),
      [
        {
          id: dispatched.metadata!.id,
          reason: "Cannot replace only the target pane in a session with several panes",
        },
      ],
    );
  });

  it("rejects several live pi that claim the same conversation, naming a cwd conflict when present", async () => {
    const test = fixture();
    test.add("alpha", 11, [dispatched]);
    test.add("beta", 12, [dispatched]);
    const plan = planWindowsReload(await test.audit(), progress());
    assert.deepEqual(plan.candidates, []);
    assert.deepEqual(plan.rejected, [
      {
        id: dispatched.metadata!.id,
        reason: "Multiple pi processes or owners match the conversation ID",
      },
    ]);

    const conflict = fixture();
    conflict.add("alpha", 11, [dispatched]);
    conflict.add("beta", 12, [{ ...dispatched, cwd: "/tmp/other" }]);
    const conflicting = planWindowsReload(await conflict.audit(), progress());
    assert.deepEqual(conflicting.rejected, [
      {
        id: dispatched.metadata!.id,
        reason: `Conflicting working directories for conversation ${dispatched.metadata!.id}`,
      },
    ]);
  });

  it("reports a confirmed target that can no longer be seen as running or starting", async () => {
    const test = fixture();
    test.add("alpha", 11, [managed]);
    const plan = planWindowsReload(await test.audit(), progress([dispatched.metadata!.id]));
    assert.deepEqual(plan.vanished, [dispatched.metadata!.id]);
    assert.deepEqual(plan.confirmed, [managed.managedId]);
  });

  it("treats a confirmed target whose pane process was replaced by a peer as reloaded, not vanished", async () => {
    const test = fixture();
    test.add("alpha", 11, [
      {
        ...managed,
        panePid: 58,
        metadata: { id: managed.managedId!, startup: "ready" },
        launch: { id: managed.managedId!, pid: 58 },
      },
    ]);
    const plan = planWindowsReload(
      await test.audit(),
      progress([managed.managedId!], [initialPane(57)]),
    );
    assert.deepEqual(plan.replaced, [managed.managedId]);
    assert.deepEqual(plan.vanished, []);
    assert.deepEqual(plan.candidates, []);
  });

  it("keeps a pi that started after the reload began in another session as a new candidate", async () => {
    const test = fixture();
    test.add("alpha", 11, [managed]);
    const plan = planWindowsReload(await test.audit(), progress([], [initialPane(57, "$9")]));
    assert.deepEqual(plan.replaced, []);
    assert.deepEqual(
      plan.running.map(({ pi }) => pi?.panePid),
      [57],
    );
    assert.deepEqual(
      plan.candidates.map(({ pi }) => pi?.id),
      [managed.managedId],
    );
  });
});

const paths = {
  node: "C:\\Node\\node.exe",
  cli: "C:\\Pi CLI\\cli.js",
  wrapper: "C:\\Tools\\pi-mux.exe",
};
const piProcess = {
  pid: 57,
  parent: 11,
  executable: paths.node,
  command: `"${paths.node}" "${paths.cli}"`,
};
const peerProcess = { pid: 11, parent: 1, executable: "C:\\Tools\\tmux.exe", command: null };
const directGroup = { peerPid: 11, panePid: 57, piPid: 57 };

function replacementPaneFields(
  entry: WindowsLifecycleAudit["entries"][number],
  { metadata = entry.pi!.metadata, blocker = "", dispatchRouting = ["", "", ""] } = {},
): string[] {
  const pane = entry.pi!;
  return [
    pane.session,
    String(pane.panePid),
    "0",
    "1",
    "1",
    entry.observedId,
    entry.observedTemporary,
    entry.observedCwd,
    metadata,
    entry.launch!,
    entry.right!,
    entry.inheritedRight,
    entry.state!,
    entry.owner!,
    blocker,
    ...dispatchRouting,
  ];
}

it("reaches the final replacement callback with exact drained proof despite legacy startup accepted", async () => {
  const test = fixture();
  test.add("alpha", 11, [
    {
      metadata: { ...dispatched.metadata!, startup: "accepted" },
      state: "waiting-user",
    },
  ]);
  const entry = entryOf(await test.audit(), "alpha");
  const pane = entry.pi!;
  assert.equal(windowsPaneIsWaiting(test.config, entry), false);
  const calls: string[] = [];
  const identities = [{ pid: 57, creationTime: "5700" }];
  const replaced = await replaceVerifiedWindowsReloadPane(
    test.config,
    { entry, pane, temporary: false },
    {
      dispatchRouting: ["", "", ""],
      async verifyProcesses() {
        calls.push("group");
        assert.deepEqual(
          verifyWindowsReloadGroup([peerProcess, piProcess], directGroup, paths),
          [57],
        );
        return identities;
      },
      async readPane(fields) {
        calls.push("pane");
        assert.equal(fields[8], "@pi-tmux-session");
        assert.ok(fields.includes("PI_TMUX_SESSION_ID"));
        return replacementPaneFields(entry);
      },
      isPresent(identity) {
        calls.push("identity");
        return identity === identities[0];
      },
      async replace() {
        calls.push("respawn");
      },
    },
  );
  assert.equal(replaced, true);
  assert.deepEqual(calls, ["group", "pane", "identity", "respawn"]);
});

it.each([
  {
    name: "proof is pending in both reads",
    selected: "pending",
    final: { reloadReadiness: "pending" },
  },
  { name: "proof becomes absent", selected: "drained", final: { reloadReadiness: undefined } },
  { name: "proof becomes pending", selected: "drained", final: { reloadReadiness: "pending" } },
  {
    name: "raw metadata changes without losing the proof",
    selected: "drained",
    final: { warm: true },
  },
])("does not call replacement when $name", async ({ selected, final }) => {
  const test = fixture();
  test.add("alpha", 11, [
    {
      metadata: { ...dispatched.metadata!, reloadReadiness: selected },
      state: "waiting-user",
    },
  ]);
  const entry = entryOf(await test.audit(), "alpha");
  const pane = entry.pi!;
  const raw = JSON.parse(Buffer.from(pane.metadata, "base64").toString("utf8"));
  const metadata = Buffer.from(JSON.stringify({ ...raw, ...final })).toString("base64");
  const replaced = await replaceVerifiedWindowsReloadPane(
    test.config,
    { entry, pane, temporary: false },
    {
      dispatchRouting: ["", "", ""],
      async verifyProcesses() {
        return [{ pid: pane.pid, creationTime: "5700" }];
      },
      async readPane() {
        return replacementPaneFields(entry, { metadata });
      },
      isPresent: () => true,
      async replace() {
        assert.fail("Must not replace a pane without the exact selected drained proof");
      },
    },
  );
  assert.equal(replaced, false);
});

it("waits if persistent first input appears during the last pane read", async () => {
  const test = fixture();
  test.add("alpha", 11, [managed]);
  const entry = entryOf(await test.audit(), "alpha");
  const pane = entry.pi!;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = test.config.stateDirectory;
  try {
    const directory = firstInputDirectory(test.config.stateDirectory, pane.id);
    assert.ok(directory);
    assert.equal(windowsReloadIsWaiting(test.config, entry), true);
    const replaced = await replaceVerifiedWindowsReloadPane(
      test.config,
      { entry, pane, temporary: false },
      {
        dispatchRouting: ["", "", ""],
        async verifyProcesses() {
          return [{ pid: pane.pid, creationTime: "5700" }];
        },
        async readPane() {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(
            join(directory, "context.json"),
            JSON.stringify({
              id: pane.id,
              cwd: pane.cwd,
              request: randomUUID(),
            }),
            { mode: 0o600 },
          );
          writeFileSync(join(directory, "text"), "unconsumed input", { mode: 0o600 });
          return replacementPaneFields(entry);
        },
        isPresent: () => true,
        async replace() {
          assert.fail("Must not replace a pane with unresolved first input");
        },
      },
    );
    assert.equal(replaced, false);
    assert.equal(windowsReloadIsWaiting(test.config, entry), false);
    rmSync(join(directory, "text"));
    assert.equal(windowsReloadIsWaiting(test.config, entry), true);
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});

it("does not call the replacement when a blocker arrives in the last pane read", async () => {
  const test = fixture();
  test.add("alpha", 11, [{ metadata: dispatched.metadata, state: "waiting-user" }]);
  const entry = entryOf(await test.audit(), "alpha");
  const pane = entry.pi!;
  const replaced = await replaceVerifiedWindowsReloadPane(
    test.config,
    { entry, pane, temporary: false },
    {
      dispatchRouting: ["", "", ""],
      async verifyProcesses() {
        return [{ pid: pane.pid, creationTime: "5700" }];
      },
      async readPane() {
        return replacementPaneFields(entry, { blocker: "1" });
      },
      isPresent: () => true,
      async replace() {
        assert.fail("Must not respawn a blocked pane");
      },
    },
  );
  assert.equal(replaced, false);
});

it("preserves verified Windows ticket routing without manufacturing ticket ownership", () => {
  const id = dispatched.metadata!.id;
  const project = "Project";
  const ticketId = "20261124-120000";
  const routing = ["pi", project, ticketId];
  const keys = [ticketLaunchKey(project, ticketId)];

  assert.deepEqual(windowsReloadDispatchEnvironment(id, "pi", routing, keys), {
    TICKET_DISPATCH_ROLE: "pi",
    TICKET_DISPATCH_PROJECT: project,
    TICKET_DISPATCH_ID: ticketId,
  });
  assert.throws(
    () => windowsReloadDispatchEnvironment(id, "pi", routing, [conversationLaunchKey(id)]),
    /does not match the verified launch keys/,
  );
  assert.throws(
    () => windowsReloadDispatchEnvironment(id, "", ["", "", ""], keys),
    /Cannot verify the Windows ticket dispatch routing/,
  );
});

it("refuses replacement if the ticket routing changes before mutation", async () => {
  const test = fixture();
  test.add("alpha", 11, [dispatched]);
  const entry = entryOf(await test.audit(), "alpha");
  const pane = entry.pi!;
  const dispatchRouting = ["pi", "Project", "20261124-120000"];
  await assert.rejects(
    replaceVerifiedWindowsReloadPane(
      test.config,
      { entry, pane, temporary: false },
      {
        dispatchRouting,
        async verifyProcesses() {
          return [{ pid: pane.pid, creationTime: "5700" }];
        },
        async readPane(fields) {
          assert.deepEqual(fields.slice(-3), [
            "TICKET_DISPATCH_ROLE",
            "TICKET_DISPATCH_PROJECT",
            "TICKET_DISPATCH_ID",
          ]);
          return replacementPaneFields(entry, {
            dispatchRouting: ["pi", "Project", "20261124-120001"],
          });
        },
        isPresent: () => true,
        async replace() {
          assert.fail("Must not replace a pane after its ticket ownership changed");
        },
      },
    ),
    /ticket dispatch routing changed/,
  );
});

it("requires a receipt and a known wrapper with only the attributed child", () => {
  const right = randomUUID();
  const wrapper = {
    pid: 40,
    parent: 11,
    executable: paths.wrapper,
    command: `"${paths.wrapper}" windows-claim-launch ${right} payload`,
  };
  const child = { ...piProcess, parent: wrapper.pid };
  const target = { ...directGroup, panePid: wrapper.pid, verifiedRight: right };
  assert.deepEqual(
    verifyWindowsReloadGroup([peerProcess, wrapper, child], target, paths),
    [40, 57],
  );
  assert.throws(
    () =>
      verifyWindowsReloadGroup(
        [peerProcess, wrapper, child],
        { ...target, verifiedRight: undefined },
        paths,
      ),
    /unverified Windows pane parent/,
  );
  assert.throws(
    () =>
      verifyWindowsReloadGroup([peerProcess, wrapper, child, { ...child, pid: 58 }], target, paths),
    /other Windows processes/,
  );
  assert.throws(
    () =>
      verifyWindowsReloadGroup(
        [peerProcess, wrapper, child],
        { ...target, verifiedRight: randomUUID() },
        paths,
      ),
    /assigned launch right/,
  );
  const shell = {
    pid: 39,
    parent: 11,
    executable: "C:\\Tools\\powershell.exe",
    command: "powershell.exe -NoLogo",
  };
  const nested = { ...wrapper, parent: shell.pid };
  const shellTarget = { ...target, panePid: shell.pid };
  assert.throws(
    () => verifyWindowsReloadGroup([peerProcess, shell, nested, child], shellTarget, paths),
    /wrapper and its only child/,
  );
  const script = `& '${paths.wrapper}' 'windows-claim-launch' '${right}' 'payload'; exit $LASTEXITCODE`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const ownedShell = {
    ...shell,
    command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`,
  };
  assert.deepEqual(
    verifyWindowsReloadGroup([peerProcess, ownedShell, nested, child], shellTarget, paths),
    [39, 40, 57],
  );
});

it.each(["compiled", "source"])(
  "verifies an initial-request launch only with matching PowerShell and wrapper ownership (%s)",
  (launchMode) => {
    const right = randomUUID();
    const invocation =
      launchMode === "compiled" ? [paths.wrapper] : [paths.wrapper, "C:\\Pi Mux\\main.ts"];
    const windows = platformFor("win32");
    function shellFor(operation: string, token: string) {
      const launch = windows.newSessionLaunch([...invocation, operation, token], {}, ["TEST_ENV"]);
      const [executable, ...flags] = windows.tmuxPaneCommand(launch.paneCommand);
      return {
        pid: 39,
        parent: 11,
        executable: executable!,
        command: `"${executable}" ${flags.join(" ")}`,
      };
    }
    const shell = shellFor("claim-initial-request", right);
    const wrapper = {
      pid: 40,
      parent: shell.pid,
      executable: paths.wrapper,
      command: [...invocation, "claim-initial-request", right].map((arg) => `"${arg}"`).join(" "),
    };
    const child = { ...piProcess, parent: wrapper.pid };
    const target = { ...directGroup, panePid: shell.pid, verifiedRight: right };
    assert.deepEqual(
      verifyWindowsReloadGroup([peerProcess, shell, wrapper, child], target, paths),
      [shell.pid, wrapper.pid, child.pid],
    );
    for (const [reason, invalidShell, invalidWrapper] of [
      ["wrong shell operation", shellFor("windows-claim-launch", right), wrapper],
      ["wrong shell right", shellFor("claim-initial-request", randomUUID()), wrapper],
      [
        "wrong wrapper right",
        shell,
        { ...wrapper, command: wrapper.command.replace(right, randomUUID()) },
      ],
      ["wrong wrapper executable", shell, { ...wrapper, executable: paths.node }],
    ] as const) {
      assert.throws(
        () =>
          verifyWindowsReloadGroup(
            [peerProcess, invalidShell, invalidWrapper, child],
            target,
            paths,
          ),
        /wrapper and its only child/,
        reason,
      );
    }
    assert.throws(
      () =>
        verifyWindowsReloadGroup(
          [peerProcess, shell, wrapper, child, { ...child, pid: 58 }],
          target,
          paths,
        ),
      /wrapper and its only child/,
    );
    assert.throws(
      () =>
        verifyWindowsReloadGroup(
          [peerProcess, { ...wrapper, parent: peerProcess.pid }, child],
          { ...target, panePid: wrapper.pid },
          paths,
        ),
      /assigned launch right/,
    );
  },
);

it("rejects a conflicting cwd before recognizing any replaced target", async () => {
  const test = fixture();
  const id = managed.managedId!;
  test.add("alpha", 11, [{ ...managed, panePid: 58, launch: { id, pid: 58 } }]);
  test.add("beta", 12, [{ ...managed, cwd: "/tmp/elsewhere" }]);
  test.add("gamma", 13, [temporary]);
  const plan = planWindowsReload(await test.audit(), progress([id], [initialPane(57)]));
  assert.deepEqual(plan.replaced, []);
  assert.deepEqual(plan.rejected, [
    { id, reason: `Conflicting working directories for conversation ${id}` },
  ]);
  assert.deepEqual(
    plan.candidates.map(({ pi }) => pi?.id),
    [temporary.managedId],
  );
});

it("does not mistake the same numeric pane in another peer for a completed replacement", async () => {
  const test = fixture();
  test.add("alpha", 11, [managed]);
  const plan = planWindowsReload(
    await test.audit(),
    progress([], [initialPane(58, "$1", "12:1200")]),
  );
  assert.deepEqual(plan.replaced, []);
  assert.equal(plan.candidates.length, 1);
});

it("preserves a saved candidate when an unrelated ID has both temporary and normal owners", async () => {
  const test = fixture();
  const id = temporary.managedId!;
  test.add("alpha", 11, [temporary]);
  test.add("beta", 12, [{ ...temporary, temporary: "" }]);
  const saved = { id, cwd: "/tmp/saved" };
  const target = { id: managed.managedId!, cwd };
  const candidates = windowsReloadSnapshotCandidates(await test.audit(), [saved], {
    pane: target,
    temporary: false,
  });
  assert.deepEqual(candidates, [saved, target]);
});

it.each([false, true])(
  "refuses a saved cwd conflict and preserves it during another reload (temporary=%s)",
  async (isTemporary) => {
    const test = fixture();
    const spec = isTemporary ? temporary : managed;
    const saved = { id: spec.managedId!, cwd: "/tmp/saved" };
    const conflicting = { id: saved.id, cwd };
    const other = { id: dispatched.metadata!.id, cwd };
    test.add("alpha", 11, [spec]);
    test.add("beta", 12, [dispatched]);
    const audit = await test.audit();

    assert.equal(
      windowsReloadSnapshotCandidates(audit, [saved], {
        pane: conflicting,
        temporary: isTemporary,
      }),
      undefined,
    );
    assert.deepEqual(
      windowsReloadSnapshotCandidates(audit, [saved], {
        pane: other,
        temporary: false,
      }),
      [saved, other],
    );
  },
);

it("retains a refused snapshot candidate if its conflicting live pane vanishes", async () => {
  const test = fixture();
  const saved = { id: managed.managedId!, cwd: "/tmp/saved" };
  const other = { id: dispatched.metadata!.id, cwd };
  test.add("beta", 12, [dispatched]);
  assert.deepEqual(
    windowsReloadSnapshotCandidates(
      await test.audit(),
      [saved],
      { pane: other, temporary: false },
      new Set([saved.id]),
    ),
    [saved, other],
  );
});

it("rejects permanent session ownership contradictions without dropping other IDs", async () => {
  const test = fixture();
  const id = dispatched.metadata!.id;
  test.add("alpha", 11, [{ ...dispatched, managedId: "bad id" }]);
  test.add("beta", 12, [managed]);
  const plan = planWindowsReload(await test.audit(), progress());
  assert.deepEqual(plan.rejected, [
    { id, reason: "Published pi contradicts Windows session ownership" },
  ]);
  assert.deepEqual(
    plan.candidates.map(({ pi }) => pi?.id),
    [managed.managedId],
  );
});

it("does not call replacement if the pane process identity is reused after group verification", async () => {
  const test = fixture();
  test.add("alpha", 11, [{ metadata: dispatched.metadata, state: "waiting-user" }]);
  const entry = entryOf(await test.audit(), "alpha");
  const pane = entry.pi!;
  await assert.rejects(
    replaceVerifiedWindowsReloadPane(
      test.config,
      { entry, pane, temporary: false },
      {
        dispatchRouting: ["", "", ""],
        async verifyProcesses() {
          return [{ pid: pane.pid, creationTime: "5700" }];
        },
        async readPane() {
          return replacementPaneFields(entry);
        },
        isPresent: () => false,
        async replace() {
          assert.fail("Must not replace a reused process identity");
        },
      },
    ),
    /process group changed before replacement/,
  );
});
