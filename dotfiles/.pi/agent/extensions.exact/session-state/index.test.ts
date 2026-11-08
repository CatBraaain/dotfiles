import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, it, spyOn } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { childInvocationArgs, subagentSessionDir } from "../agents/index.ts";
import sessionStateExtension, {
  archiveSession,
  clearSessionState,
  getSessionState,
  parseStore,
  serializeStore,
  setSessionState,
  unarchiveSession,
  type SessionStateStore,
} from "./index.ts";

const STORE_UPDATE_TIMEOUT_MS = 1_000;

type EventHandler = (event: { type: string; reason?: string }, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

interface SessionHarness {
  storePath: string;
  workspacePath: string;
  sessionId: string;
  commands: Map<string, Command>;
  storeReads: ReturnType<typeof spyOn<typeof fs, "readFile">>;
  emit(type: string): Promise<void>;
  command(name: string): Promise<void>;
}

async function withSessionHarness(
  options: { agent: string; mode?: "new" | "resume" | "fork" | "vision"; customDir?: boolean },
  test: (harness: SessionHarness) => Promise<void>,
): Promise<void> {
  const tempRoot = "/tmp/work/dotfiles/skip-subagent-session-state";
  mkdirSync(tempRoot, { recursive: true });
  const agentDir = mkdtempSync(join(tempRoot, "unit-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousAgentName = process.env.PI_AGENT_NAME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_NAME = options.agent;
  const workspacePath = join(agentDir, "workspace: child");
  const sessionId = "current-session";
  const childDir = subagentSessionDir(workspacePath);
  const childSession =
    options.mode === "resume" || options.mode === "fork"
      ? { path: join(childDir, "existing-session.jsonl"), fork: options.mode === "fork" }
      : undefined;
  const args = childInvocationArgs(options.agent, "test task", workspacePath, childSession);
  const sessionDir =
    options.mode === undefined
      ? options.customDir
        ? join(agentDir, "custom", "subagents")
        : dirname(childDir)
      : `${args[args.indexOf("--session-dir") + 1]}/../subagents/`;
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, Command>();
  const ctx = {
    hasUI: true,
    ui: { notify() {} },
    sessionManager: {
      getCwd: () => workspacePath,
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
      getHeader: () => ({ parentSession: "/ordinary/top-level-parent.jsonl" }),
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on(type: string, handler: EventHandler) {
      const registered = handlers.get(type) ?? [];
      registered.push(handler);
      handlers.set(type, registered);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    getFlag: () => options.agent,
  } as unknown as ExtensionAPI;
  const storeReads = spyOn(fs, "readFile");
  sessionStateExtension(pi);
  const harness: SessionHarness = {
    storePath: join(agentDir, "session-state.json"),
    workspacePath,
    sessionId,
    commands,
    storeReads,
    async emit(type) {
      for (const handler of handlers.get(type) ?? []) {
        await handler(
          { type, reason: options.mode === "vision" ? "startup" : (options.mode ?? "startup") },
          ctx,
        );
      }
    },
    async command(name) {
      const command = commands.get(name);
      assert.ok(command, `command: ${name}`);
      await command.handler("", ctx);
    },
  };
  try {
    await test(harness);
  } finally {
    if (commands.has("unarchive")) await harness.command("unarchive");
    storeReads.mockRestore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousAgentName === undefined) delete process.env.PI_AGENT_NAME;
    else process.env.PI_AGENT_NAME = previousAgentName;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

const lifecycleEvents = [
  "session_start",
  "input",
  "agent_start",
  "ui_prompt_start",
  "ui_prompt_end",
  "agent_settled",
  "ui_prompt_end",
  "session_shutdown",
];

describe("sessionStateExtension in child sessions", () => {
  for (const mode of ["new", "resume", "fork", "vision"] as const) {
    const agent = mode === "vision" ? "vision" : "main";

    it(`does not create a store during the ${mode} child lifecycle`, async () => {
      await withSessionHarness({ agent, mode }, async (harness) => {
        for (const event of lifecycleEvents) {
          await harness.emit(event);
          assert.equal(harness.storeReads.mock.calls.length, 0, `event: ${event}`);
          assert.equal(existsSync(harness.storePath), false, `event: ${event}`);
        }
      });
    });

    it(`preserves existing entries and store bytes during the ${mode} child lifecycle`, async () => {
      await withSessionHarness({ agent, mode }, async (harness) => {
        const original = JSON.stringify({
          "active-workspaces": {
            [harness.workspacePath]: {
              "active-sessions": {
                [harness.sessionId]: { lock: true, state: "running", custom: "keep" },
                other: { lock: false, state: "waiting-user" },
              },
              pinned: true,
            },
          },
          custom: ["keep"],
        });
        writeFileSync(harness.storePath, original);
        const before = statSync(harness.storePath, { bigint: true });
        for (const event of lifecycleEvents) {
          await harness.emit(event);
          assert.equal(harness.storeReads.mock.calls.length, 0, `event: ${event}`);
          assert.equal(readFileSync(harness.storePath, "utf8"), original, `event: ${event}`);
          const after = statSync(harness.storePath, { bigint: true });
          assert.deepEqual(
            [after.ino, after.mtimeNs],
            [before.ino, before.mtimeNs],
            `event: ${event}`,
          );
        }
      });
    });

    it(`does not provide archive commands in the ${mode} child`, async () => {
      await withSessionHarness({ agent, mode }, async (harness) => {
        await harness.emit("session_start");
        assert.deepEqual([...harness.commands.keys()], []);
      });
    });
  }
});

describe("sessionStateExtension in top-level sessions", () => {
  for (const agent of ["main", "senior", "junior", "vision", "chat"]) {
    it(`preserves phase updates for a top-level ${agent} session with a parent header`, async () => {
      await withSessionHarness({ agent, customDir: agent === "vision" }, async (harness) => {
        const phases = [
          ["session_start", "waiting-user"],
          ["agent_start", "running"],
          ["ui_prompt_start", "waiting-approval"],
          ["ui_prompt_end", "running"],
          ["agent_settled", "waiting-user"],
          ["ui_prompt_end", "waiting-user"],
          ["agent_end", "waiting-user"],
          ["session_shutdown", undefined],
        ] as const;
        for (const [event, expectedState] of phases) {
          await harness.emit(event);
          await harness.command("unarchive");
          const store = JSON.parse(readFileSync(harness.storePath, "utf8")) as SessionStateStore;
          assert.equal(
            getSessionState(store, harness.workspacePath, harness.sessionId),
            expectedState,
            `event: ${event}`,
          );
        }
      });
    });

    it(`preserves commands and automatic unarchive for a top-level ${agent} session`, async () => {
      await withSessionHarness({ agent }, async (harness) => {
        await harness.emit("session_start");
        assert.deepEqual([...harness.commands.keys()].sort(), ["archive", "unarchive"]);
        await harness.command("archive");
        const archived = JSON.parse(readFileSync(harness.storePath, "utf8")) as SessionStateStore;
        assert.equal(
          archived["active-workspaces"][harness.workspacePath]?.["active-sessions"]?.[
            harness.sessionId
          ],
          undefined,
        );
        await harness.emit("input");
        const deadline = Date.now() + STORE_UPDATE_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const current = JSON.parse(readFileSync(harness.storePath, "utf8")) as SessionStateStore;
          if (
            current["active-workspaces"][harness.workspacePath]?.["active-sessions"]?.[
              harness.sessionId
            ]
          )
            break;
          await setImmediate();
        }
        const active = JSON.parse(readFileSync(harness.storePath, "utf8")) as SessionStateStore;
        assert.deepEqual(
          active["active-workspaces"][harness.workspacePath]?.["active-sessions"]?.[
            harness.sessionId
          ],
          { lock: false },
        );
        await harness.command("archive");
        await harness.command("unarchive");
        const unarchived = JSON.parse(readFileSync(harness.storePath, "utf8")) as SessionStateStore;
        assert.deepEqual(unarchived, active);
      });
    });
  }
});

describe("parseStore", () => {
  it("reads a document with active-workspaces as a valid store", () => {
    const raw = JSON.stringify({
      "active-workspaces": {
        "/tmp": {
          "active-sessions": { s1: { lock: false, state: "running" } },
          pinned: true,
        },
      },
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      "active-workspaces": {
        "/tmp": {
          "active-sessions": { s1: { lock: false, state: "running" } },
          pinned: true,
        },
      },
    });
  });

  it("未知の root キーと workspace エントリの未知フィールドを保ったまま読む", () => {
    const raw = JSON.stringify({
      "active-workspaces": { "/tmp": { "active-sessions": { s1: { lock: false } }, pinned: true } },
      tags: ["a"],
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      "active-workspaces": { "/tmp": { "active-sessions": { s1: { lock: false } }, pinned: true } },
      tags: ["a"],
    });
  });

  it("preserves a registered workspace with no active sessions", () => {
    const store = {
      "active-workspaces": { "/w": { "active-sessions": {} } },
    };
    const parsed = parseStore(JSON.stringify(store));
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, store);
  });

  it("rejects the legacy workspaces root without active-workspaces", () => {
    const raw = JSON.stringify({
      workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
    });
    assert.deepEqual(parseStore(raw), { valid: false });
  });

  it("rejects an empty legacy workspaces root without active-workspaces", () => {
    assert.deepEqual(parseStore('{"workspaces":{}}'), { valid: false });
  });

  it("rejects legacy workspaces alongside active-workspaces", () => {
    const raw = JSON.stringify({
      "active-workspaces": { "/new": { "active-sessions": {} } },
      workspaces: { "/old": { "active-sessions": { s1: { lock: false } } } },
    });
    assert.deepEqual(parseStore(raw), { valid: false });
  });

  it("rejects an empty legacy workspaces root alongside active-workspaces", () => {
    const raw = JSON.stringify({
      "active-workspaces": { "/w": { "active-sessions": {} } },
      workspaces: {},
    });
    assert.deepEqual(parseStore(raw), { valid: false });
  });

  it("preserves non-object root values named workspaces as unknown attributes", () => {
    for (const workspaces of [null, false, 3, "metadata", []]) {
      const store = { "active-workspaces": {}, workspaces };
      assert.deepEqual(
        parseStore(JSON.stringify(store)),
        { valid: true, store },
        `workspaces: ${JSON.stringify(workspaces)}`,
      );
    }
  });

  it("JSON として壊れている内容は無効", () => {
    assert.equal(parseStore("{oops").valid, false);
    assert.equal(parseStore("").valid, false);
  });

  it("ルートがオブジェクトでない内容は無効", () => {
    assert.equal(parseStore("[]").valid, false);
    assert.equal(parseStore("42").valid, false);
    assert.equal(parseStore("null").valid, false);
    assert.equal(parseStore('"text"').valid, false);
  });

  it("rejects a non-object active-workspaces root", () => {
    assert.equal(parseStore('{"active-workspaces":[]}').valid, false);
    assert.equal(parseStore('{"active-workspaces":"x"}').valid, false);
    assert.equal(parseStore('{"active-workspaces":3}').valid, false);
  });

  it("rejects a missing active-workspaces root", () => {
    assert.equal(parseStore("{}").valid, false);
  });

  it("active-sessions が配列の workspace エントリを持つ旧形式は無効", () => {
    assert.equal(
      parseStore('{"active-workspaces":{"/w":{"active-sessions":["s1"]}}}').valid,
      false,
    );
    assert.equal(
      parseStore('{"active-workspaces":{"/w":{"active-sessions":[]},"/x":{}}}').valid,
      false,
    );
  });
});

describe("unarchiveSession", () => {
  it("store が無いとき新規 store に自ワークスペースの entry を作る", () => {
    assert.deepEqual(unarchiveSession(undefined, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("自ワークスペースのエントリが無いときは作成し、他のワークスペースを保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/other": { "active-sessions": { s2: { lock: false } } } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/other": { "active-sessions": { s2: { lock: false } } },
          "/w": { "active-sessions": { s1: { lock: false } } },
        },
      },
    });
  });

  it("recreates its workspace on unarchive after the workspace is unregistered", () => {
    const registeredStore: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: false } } },
        "/other": { "active-sessions": {} },
      },
    };
    const unregisteredStore = structuredClone(registeredStore);
    delete unregisteredStore["active-workspaces"]["/w"];

    assert.deepEqual(unarchiveSession(unregisteredStore, "/w", "s1"), {
      status: "written",
      store: registeredStore,
    });
  });

  it("active-sessions に既に載っているときは書き込まない", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: true, state: "running" } } },
      },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("entry を追加し、active-sessions の他セッションと workspace エントリの未知フィールドを保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s2: { lock: true } }, pinned: true },
      },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/w": {
            "active-sessions": { s2: { lock: true }, s1: { lock: false } },
            pinned: true,
          },
        },
      },
    });
  });

  it("active-sessions が無い workspace エントリに active-sessions を作る", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { pinned: true } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { pinned: true, "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("active-sessions がオブジェクトでないときは新しい map で書く", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("自ワークスペースのエントリがオブジェクトでないときは置き換える", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":"garbage"}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("未知の root キーを保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": {},
      tags: ["a"],
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s2: { lock: false }, s3: { lock: true } } },
      },
    };
    const snapshot = structuredClone(store);
    unarchiveSession(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("archiveSession", () => {
  it("lock が true のセッションは locked を返す", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { lock: true } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "locked" });
  });

  it("active-sessions に載っていなければ書き込まない", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s2: { lock: false } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("自ワークスペースのエントリが無いときは書き込まない", () => {
    const store: SessionStateStore = { "active-workspaces": {} };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("store が無いときも書き込まない", () => {
    assert.deepEqual(archiveSession(undefined, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions がオブジェクトでないときは書き込まない", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(archiveSession(parsed.store, "/w", "s1"), { status: "skipped" });
  });

  it("自セッションの entry を削除し、他のセッションと属性を保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": {
          "active-sessions": {
            s1: { lock: false, state: "running" },
            s2: { lock: true },
          },
          pinned: true,
        },
      },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/w": { "active-sessions": { s2: { lock: true } }, pinned: true },
        },
      },
    });
  });

  it("削除後も空の active-sessions map を残す", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": {} } },
      },
    });
  });

  it("他のワークスペースと未知の root キーを保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/other": { "active-sessions": { s2: { lock: false } } },
        "/w": { "active-sessions": { s1: { lock: false } } },
      },
      tags: ["a"],
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/other": { "active-sessions": { s2: { lock: false } } },
          "/w": { "active-sessions": {} },
        },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: false }, s2: { lock: true } } },
      },
    };
    const snapshot = structuredClone(store);
    archiveSession(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("setSessionState", () => {
  it("store が無いとき新規 store に自セッションの entry を作る", () => {
    assert.deepEqual(setSessionState(undefined, "/w", "s1", "waiting-user"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { state: "waiting-user" } } } },
      },
    });
  });

  it("同じ state が既に設定されているときは書き込まない", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { state: "running" } } } },
    };
    assert.deepEqual(setSessionState(store, "/w", "s1", "running"), { status: "skipped" });
  });

  it("state を更新し、entry の lock と他セッションの entry を保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": {
          "active-sessions": {
            s1: { lock: true, state: "waiting-user" },
            s2: { state: "running" },
          },
        },
      },
    };
    assert.deepEqual(setSessionState(store, "/w", "s1", "running"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/w": {
            "active-sessions": {
              s1: { lock: true, state: "running" },
              s2: { state: "running" },
            },
          },
        },
      },
    });
  });

  it("workspace エントリの未知フィールドを保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { pinned: true } },
    };
    assert.deepEqual(setSessionState(store, "/w", "s1", "waiting-approval"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/w": {
            pinned: true,
            "active-sessions": { s1: { state: "waiting-approval" } },
          },
        },
      },
    });
  });

  it("active-sessions がオブジェクトでないときは置き換える", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(setSessionState(parsed.store, "/w", "s1", "running"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { state: "running" } } } },
      },
    });
  });

  it("entry がオブジェクトでないときは新しい entry で書く", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":{"s1":"garbage"}}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(setSessionState(parsed.store, "/w", "s1", "running"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { state: "running" } } } },
      },
    });
  });

  it("未知の root キーを保つ", () => {
    const store: SessionStateStore = { "active-workspaces": {}, tags: ["a"] };
    assert.deepEqual(setSessionState(store, "/w", "s1", "waiting-user"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: { state: "waiting-user" } } } },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: true, state: "waiting-user" } } },
      },
    };
    const snapshot = structuredClone(store);
    setSessionState(store, "/w", "s1", "running");
    assert.deepEqual(store, snapshot);
  });
});

describe("getSessionState", () => {
  it("自セッションの state を返す", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { state: "running" } } } },
    };
    assert.equal(getSessionState(store, "/w", "s1"), "running");
  });

  it("store が無いときは undefined を返す", () => {
    assert.equal(getSessionState(undefined, "/w", "s1"), undefined);
  });

  it("workspace のエントリが無いときは undefined を返す", () => {
    const store: SessionStateStore = { "active-workspaces": {} };
    assert.equal(getSessionState(store, "/w", "s1"), undefined);
  });

  it("active-sessions が無いときは undefined を返す", () => {
    const store: SessionStateStore = { "active-workspaces": { "/w": { pinned: true } } };
    assert.equal(getSessionState(store, "/w", "s1"), undefined);
  });

  it("他セッションの entry は返さない", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s2: { state: "running" } } } },
    };
    assert.equal(getSessionState(store, "/w", "s1"), undefined);
  });

  it("state が3値でない entry は undefined を返す", () => {
    const parsed = parseStore(
      '{"active-workspaces":{"/w":{"active-sessions":{"s1":{"state":"idle"}}}}}',
    );
    assert.ok(parsed.valid);
    assert.equal(getSessionState(parsed.store, "/w", "s1"), undefined);
  });

  it("entry がオブジェクトでないときは undefined を返す", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":{"s1":"garbage"}}}}');
    assert.ok(parsed.valid);
    assert.equal(getSessionState(parsed.store, "/w", "s1"), undefined);
  });
});

describe("clearSessionState", () => {
  it("自セッションの entry から state を除き、lock と他セッションを保つ", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": {
          "active-sessions": {
            s1: { lock: true, state: "running" },
            s2: { state: "running" },
          },
        },
      },
    };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": {
          "/w": { "active-sessions": { s1: { lock: true }, s2: { state: "running" } } },
        },
      },
    });
  });

  it("state が無いときは書き込まない", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
    };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions に載っていないときは書き込まない", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s2: { state: "running" } } } },
    };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), { status: "skipped" });
  });

  it("store が無いときも書き込まない", () => {
    assert.deepEqual(clearSessionState(undefined, "/w", "s1"), { status: "skipped" });
  });

  it("workspace のエントリが無いときは書き込まない", () => {
    const store: SessionStateStore = { "active-workspaces": {} };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions がオブジェクトでないときは書き込まない", () => {
    const parsed = parseStore('{"active-workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(clearSessionState(parsed.store, "/w", "s1"), { status: "skipped" });
  });

  it("preserves active-workspaces and unknown root keys", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { state: "waiting-approval" } } } },
      tags: ["a"],
    };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), {
      status: "written",
      store: {
        "active-workspaces": { "/w": { "active-sessions": { s1: {} } } },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      "active-workspaces": { "/w": { "active-sessions": { s1: { state: "running" } } } },
    };
    const snapshot = structuredClone(store);
    clearSessionState(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("serializeStore", () => {
  it("2 スペースの pretty JSON と末尾改行で書き出す", () => {
    const store: SessionStateStore = {
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { lock: false } } },
      },
    };
    assert.equal(
      serializeStore(store),
      '{\n  "active-workspaces": {\n    "/w": {\n      "active-sessions": {\n        "s1": {\n          "lock": false\n        }\n      }\n    }\n  }\n}\n',
    );
  });
});
