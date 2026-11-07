import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  archiveSession,
  parseStore,
  serializeStore,
  unarchiveSession,
  type SessionStateStore,
} from "./index.ts";

describe("parseStore", () => {
  it("version 2 と workspaces を持つ文書を有効な store として読む", () => {
    const raw = JSON.stringify({
      version: 2,
      workspaces: {
        "/tmp": { active: true, "active-sessions": ["s1"], "locked-sessions": ["s2"] },
      },
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      version: 2,
      workspaces: {
        "/tmp": { active: true, "active-sessions": ["s1"], "locked-sessions": ["s2"] },
      },
    });
  });

  it("未知の root キーと workspace エントリの未知フィールドを保ったまま読む", () => {
    const raw = JSON.stringify({
      version: 2,
      workspaces: { "/tmp": { "active-sessions": ["s1"], pinned: true } },
      tags: ["a"],
    });
    const parsed = parseStore(raw);
    assert.ok(parsed.valid);
    assert.deepEqual(parsed.store, {
      version: 2,
      workspaces: { "/tmp": { "active-sessions": ["s1"], pinned: true } },
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
    assert.equal(parseStore('{"version":2,"workspaces":[]}').valid, false);
    assert.equal(parseStore('{"version":2,"workspaces":"x"}').valid, false);
    assert.equal(parseStore('{"version":2,"workspaces":3}').valid, false);
  });

  it("workspaces が無い内容は無効", () => {
    assert.equal(parseStore('{"version":2}').valid, false);
  });

  it("version が 2 以外の内容は無効", () => {
    assert.equal(
      parseStore('{"version":1,"workspaces":{}}').valid,
      false,
    );
    assert.equal(
      parseStore('{"version":3,"workspaces":{}}').valid,
      false,
    );
    assert.equal(parseStore('{"version":"2","workspaces":{}}').valid, false);
  });

  it("version が無い内容は無効", () => {
    assert.equal(parseStore('{"workspaces":{}}').valid, false);
  });
});

describe("unarchiveSession", () => {
  it("store が無いとき version 2 の新規 store に自ワークスペースのエントリを作る", () => {
    assert.deepEqual(unarchiveSession(undefined, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: { "/w": { "active-sessions": ["s1"] } },
      },
    });
  });

  it("自ワークスペースのエントリが無いときは作成し、他のワークスペースを保つ", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/other": { "active-sessions": ["s2"] } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: {
          "/other": { "active-sessions": ["s2"] },
          "/w": { "active-sessions": ["s1"] },
        },
      },
    });
  });

  it("active-sessions に既に載っているときは書き込まない", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/w": { "active-sessions": ["s1"] } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions へ追加し、active・locked-sessions・未知フィールドを保つ", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: {
        "/w": { active: false, "active-sessions": ["s2"], "locked-sessions": ["s3"], pinned: true },
      },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: {
          "/w": {
            active: false,
            "active-sessions": ["s2", "s1"],
            "locked-sessions": ["s3"],
            pinned: true,
          },
        },
      },
    });
  });

  it("locked-sessions に載っていても active-sessions へ追加する", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/w": { "locked-sessions": ["s1"] } },
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: { "/w": { "locked-sessions": ["s1"], "active-sessions": ["s1"] } },
      },
    });
  });

  it("自ワークスペースのエントリがオブジェクトでないときは置き換える", () => {
    const parsed = parseStore('{"version":2,"workspaces":{"/w":"garbage"}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: { "/w": { "active-sessions": ["s1"] } },
      },
    });
  });

  it("active-sessions が配列でないときは新しい配列で書く", () => {
    const parsed = parseStore('{"version":2,"workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(unarchiveSession(parsed.store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: { "/w": { "active-sessions": ["s1"] } },
      },
    });
  });

  it("未知の root キーを保つ", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: {},
      tags: ["a"],
    };
    assert.deepEqual(unarchiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: { "/w": { "active-sessions": ["s1"] } },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/w": { "active-sessions": ["s2"], "locked-sessions": ["s3"] } },
    };
    const snapshot = structuredClone(store);
    unarchiveSession(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("archiveSession", () => {
  it("locked-sessions に載っているセッションは locked を返す", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/w": { "active-sessions": ["s1"], "locked-sessions": ["s1"] } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "locked" });
  });

  it("active-sessions に載っていなくても locked-sessions に載っていれば locked を返す", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/w": { "locked-sessions": ["s1"] } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "locked" });
  });

  it("active-sessions から自セッションを削除し、他の属性を保つ", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: {
        "/w": { active: true, "active-sessions": ["s1", "s2"], "locked-sessions": ["s3"], pinned: true },
      },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: {
          "/w": {
            active: true,
            "active-sessions": ["s2"],
            "locked-sessions": ["s3"],
            pinned: true,
          },
        },
      },
    });
  });

  it("active-sessions に載っていなければ書き込まない", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/w": { "active-sessions": ["s2"] } },
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("自ワークスペースのエントリが無いときは書き込まない", () => {
    const store: SessionStateStore = { version: 2, workspaces: {} };
    assert.deepEqual(archiveSession(store, "/w", "s1"), { status: "skipped" });
  });

  it("store が無いときも書き込まない", () => {
    assert.deepEqual(archiveSession(undefined, "/w", "s1"), { status: "skipped" });
  });

  it("active-sessions が配列でないときは書き込まない", () => {
    const parsed = parseStore('{"version":2,"workspaces":{"/w":{"active-sessions":"garbage"}}}');
    assert.ok(parsed.valid);
    assert.deepEqual(archiveSession(parsed.store, "/w", "s1"), { status: "skipped" });
  });

  it("他のワークスペースと未知の root キーを保つ", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/other": { "active-sessions": ["s2"] }, "/w": { "active-sessions": ["s1"] } },
      tags: ["a"],
    };
    assert.deepEqual(archiveSession(store, "/w", "s1"), {
      status: "written",
      store: {
        version: 2,
        workspaces: {
          "/other": { "active-sessions": ["s2"] },
          "/w": { "active-sessions": [] },
        },
        tags: ["a"],
      },
    });
  });

  it("入力の store を変更しない", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: { "/w": { "active-sessions": ["s1", "s2"], "locked-sessions": ["s3"] } },
    };
    const snapshot = structuredClone(store);
    archiveSession(store, "/w", "s1");
    assert.deepEqual(store, snapshot);
  });
});

describe("serializeStore", () => {
  it("2 スペースの pretty JSON と末尾改行で書き出す", () => {
    const store: SessionStateStore = {
      version: 2,
      workspaces: {
        "/w": { active: true, "active-sessions": ["s1"], "locked-sessions": [] },
      },
    };
    assert.equal(
      serializeStore(store),
      '{\n  "version": 2,\n  "workspaces": {\n    "/w": {\n      "active": true,\n      "active-sessions": [\n        "s1"\n      ],\n      "locked-sessions": []\n    }\n  }\n}\n',
    );
  });
});
