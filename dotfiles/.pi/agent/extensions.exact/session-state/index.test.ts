import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  archiveSession,
  clearSessionState,
  getSessionState,
  parseStore,
  serializeStore,
  setSessionState,
  unarchiveSession,
  type SessionStateStore,
} from "./index.ts";

describe("parseStore", () => {
  it("workspaces を持つ文書を有効な store として読む", () => {
    const raw = JSON.stringify({
      workspaces: {
        "/tmp": {
          "active-sessions": { s1: { lock: false, state: "running" } },
          pinned: true,
        },
      },
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      workspaces: {
        "/tmp": {
          "active-sessions": { s1: { lock: false, state: "running" } },
          pinned: true,
        },
      },
    });
  });

  it("未知の root キーと workspace エントリの未知フィールドを保ったまま読む", () => {
    const raw = JSON.stringify({
      workspaces: { "/tmp": { "active-sessions": { s1: { lock: false } }, pinned: true } },
      tags: ["a"],
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      workspaces: { "/tmp": { "active-sessions": { s1: { lock: false } }, pinned: true } },
      tags: ["a"],
    });
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

  it("workspaces がオブジェクトでない内容は無効", () => {
    assert.equal(parseStore('{"workspaces":[]}').valid, false);
    assert.equal(parseStore('{"workspaces":"x"}').valid, false);
    assert.equal(parseStore('{"workspaces":3}').valid, false);
  });

  it("workspaces が無い内容は無効", () => {
    assert.equal(parseStore("{}").valid, false);
  });

  it("active-sessions が配列の workspace エントリを持つ旧形式は無効", () => {
    assert.equal(parseStore('{"workspaces":{"/w":{"active-sessions":["s1"]}}}').valid, false);
    assert.equal(parseStore('{"workspaces":{"/w":{"active-sessions":[]},"/x":{}}}').valid, false);
  });
});

describe("unarchiveSession", () => {
  it("store が無いとき新規 store に自ワークスペースの entry を作る", () => {
    assert.deepEqual(unarchiveSession(undefined, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("自ワークスペースのエントリが無いときは作成し、他のワークスペースを保つ", () => {
    const store: SessionStateStore = {
      workspaces: { "/other": { "active-sessions": { s2: { lock: false } } } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: {
          "/other": { "active-sessions": { s2: { lock: false } } },
          "/w": { "active-sessions": { s1: { lock: false } } },
        },
      },
    });
  });

  it("active-sessions に既に載っているときは書き込まない", () => {
    const store: SessionStateStore = {
      workspaces: {
        "/w": { "active-sessions": { s1: { lock: true, state: "running" } } },
      },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("entry を追加し、active-sessions の他セッションと workspace エントリの未知フィールドを保つ", () => {
    const store: SessionStateStore = {
      workspaces: {
        "/w": { "active-sessions": { s2: { lock: true } }, pinned: true },
      },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: {
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
      workspaces: { "/w": { pinned: true } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: { "/w": { pinned: true, "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("active-sessions がオブジェクトでないときは新しい map で書く", () => {
    const parsed = parseStore('{"workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("自ワークスペースのエントリがオブジェクトでないときは置き換える", () => {
    const parsed = parseStore('{"workspaces":{"/w":"garbage"}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
      },
    });
  });

  it("未知の root キーを保つ", () => {
    const store: SessionStateStore = {
      workspaces: {},
      tags: ["a"],
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s2: { lock: false }, s3: { lock: true } } } },
    };
    const snapshot = structuredClone(store);
    unarchiveSession(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("archiveSession", () => {
  it("lock が true のセッションは locked を返す", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s1: { lock: true } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "locked" });
  });

  it("active-sessions に載っていなければ書き込まない", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s2: { lock: false } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("自ワークスペースのエントリが無いときは書き込まない", () => {
    const store: SessionStateStore = { workspaces: {} };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("store が無いときも書き込まない", () => {
    assert.deepEqual(archiveSession(undefined, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions がオブジェクトでないときは書き込まない", () => {
    const parsed = parseStore('{"workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(archiveSession(parsed.store, "/w", "s1"), { status: "skipped" });
  });

  it("自セッションの entry を削除し、他のセッションと属性を保つ", () => {
    const store: SessionStateStore = {
      workspaces: {
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
        workspaces: {
          "/w": { "active-sessions": { s2: { lock: true } }, pinned: true },
        },
      },
    });
  });

  it("削除後も空の active-sessions map を残す", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": {} } },
      },
    });
  });

  it("他のワークスペースと未知の root キーを保つ", () => {
    const store: SessionStateStore = {
      workspaces: {
        "/other": { "active-sessions": { s2: { lock: false } } },
        "/w": { "active-sessions": { s1: { lock: false } } },
      },
      tags: ["a"],
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: {
          "/other": { "active-sessions": { s2: { lock: false } } },
          "/w": { "active-sessions": {} },
        },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      workspaces: {
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
        workspaces: { "/w": { "active-sessions": { s1: { state: "waiting-user" } } } },
      },
    });
  });

  it("同じ state が既に設定されているときは書き込まない", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s1: { state: "running" } } } },
    };
    assert.deepEqual(setSessionState(store, "/w", "s1", "running"), { status: "skipped" });
  });

  it("state を更新し、entry の lock と他セッションの entry を保つ", () => {
    const store: SessionStateStore = {
      workspaces: {
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
        workspaces: {
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
      workspaces: { "/w": { pinned: true } },
    };
    assert.deepEqual(setSessionState(store, "/w", "s1", "waiting-approval"), {
      status: "written",
      store: {
        workspaces: {
          "/w": {
            pinned: true,
            "active-sessions": { s1: { state: "waiting-approval" } },
          },
        },
      },
    });
  });

  it("active-sessions がオブジェクトでないときは置き換える", () => {
    const parsed = parseStore('{"workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(setSessionState(parsed.store, "/w", "s1", "running"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: { state: "running" } } } },
      },
    });
  });

  it("entry がオブジェクトでないときは新しい entry で書く", () => {
    const parsed = parseStore('{"workspaces":{"/w":{"active-sessions":{"s1":"garbage"}}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(setSessionState(parsed.store, "/w", "s1", "running"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: { state: "running" } } } },
      },
    });
  });

  it("未知の root キーを保つ", () => {
    const store: SessionStateStore = { workspaces: {}, tags: ["a"] };
    assert.deepEqual(setSessionState(store, "/w", "s1", "waiting-user"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: { state: "waiting-user" } } } },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      workspaces: {
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
      workspaces: { "/w": { "active-sessions": { s1: { state: "running" } } } },
    };
    assert.equal(getSessionState(store, "/w", "s1"), "running");
  });

  it("store が無いときは undefined を返す", () => {
    assert.equal(getSessionState(undefined, "/w", "s1"), undefined);
  });

  it("workspace のエントリが無いときは undefined を返す", () => {
    const store: SessionStateStore = { workspaces: {} };
    assert.equal(getSessionState(store, "/w", "s1"), undefined);
  });

  it("active-sessions が無いときは undefined を返す", () => {
    const store: SessionStateStore = { workspaces: { "/w": { pinned: true } } };
    assert.equal(getSessionState(store, "/w", "s1"), undefined);
  });

  it("他セッションの entry は返さない", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s2: { state: "running" } } } },
    };
    assert.equal(getSessionState(store, "/w", "s1"), undefined);
  });

  it("state が3値でない entry は undefined を返す", () => {
    const parsed = parseStore('{"workspaces":{"/w":{"active-sessions":{"s1":{"state":"idle"}}}}}');
    assert.ok(parsed.valid);
    assert.equal(getSessionState(parsed.store, "/w", "s1"), undefined);
  });

  it("entry がオブジェクトでないときは undefined を返す", () => {
    const parsed = parseStore('{"workspaces":{"/w":{"active-sessions":{"s1":"garbage"}}}}');
    assert.ok(parsed.valid);
    assert.equal(getSessionState(parsed.store, "/w", "s1"), undefined);
  });
});

describe("clearSessionState", () => {
  it("自セッションの entry から state を除き、lock と他セッションを保つ", () => {
    const store: SessionStateStore = {
      workspaces: {
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
        workspaces: {
          "/w": { "active-sessions": { s1: { lock: true }, s2: { state: "running" } } },
        },
      },
    });
  });

  it("state が無いときは書き込まない", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s1: { lock: false } } } },
    };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions に載っていないときは書き込まない", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s2: { state: "running" } } } },
    };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), { status: "skipped" });
  });

  it("store が無いときも書き込まない", () => {
    assert.deepEqual(clearSessionState(undefined, "/w", "s1"), { status: "skipped" });
  });

  it("workspace のエントリが無いときは書き込まない", () => {
    const store: SessionStateStore = { workspaces: {} };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions がオブジェクトでないときは書き込まない", () => {
    const parsed = parseStore('{"workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(clearSessionState(parsed.store, "/w", "s1"), { status: "skipped" });
  });

  it("workspaces と未知の root キーを保つ", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s1: { state: "waiting-approval" } } } },
      tags: ["a"],
    };
    assert.deepEqual(clearSessionState(store, "/w", "s1"), {
      status: "written",
      store: {
        workspaces: { "/w": { "active-sessions": { s1: {} } } },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      workspaces: { "/w": { "active-sessions": { s1: { state: "running" } } } },
    };
    const snapshot = structuredClone(store);
    clearSessionState(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("serializeStore", () => {
  it("2 スペースの pretty JSON と末尾改行で書き出す", () => {
    const store: SessionStateStore = {
      workspaces: {
        "/w": { "active-sessions": { s1: { lock: false } } },
      },
    };
    assert.equal(
      serializeStore(store),
      '{\n  "workspaces": {\n    "/w": {\n      "active-sessions": {\n        "s1": {\n          "lock": false\n        }\n      }\n    }\n  }\n}\n',
    );
  });
});
