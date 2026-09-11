import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractMessageText, findUndoTarget } from "./core.ts";

type UserContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

function entry(id: string, parentId: string | null, role: "user" | "assistant", content: UserContent | Array<{ type: "text"; text: string }>): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role, content, timestamp: 0 },
  } as SessionEntry;
}

/** Branch entries in getBranch() order: leaf first, root last. */
function branch(...leafToRoot: SessionEntry[]): SessionEntry[] {
  return leafToRoot;
}

describe("extractMessageText", () => {
  it("文字列の content はそのまま返す", () => {
    assert.equal(extractMessageText("修正して"), "修正して");
  });

  it("配列の content は text パートだけを区切りなしで連結する(内蔵 /tree の復元テキストと同じ)", () => {
    const text = extractMessageText([
      { type: "text", text: "1行目" },
      { type: "image", data: "base64", mimeType: "image/png" },
      { type: "text", text: "2行目" },
    ]);
    assert.equal(text, "1行目2行目");
  });

  it("text パートがない配列は空文字を返す", () => {
    assert.equal(extractMessageText([{ type: "image", data: "base64", mimeType: "image/png" }]), "");
  });
});

describe("findUndoTarget", () => {
  it("ブランチの末尾から見て最後の user 発言を選ぶ(末尾に assistant があっても)", () => {
    const entries = branch(
      entry("a2", "u2", "assistant", [{ type: "text", text: "ok" }]),
      entry("u2", "a1", "user", "やり直したい"),
      entry("a1", "u1", "assistant", [{ type: "text", text: "hello" }]),
      entry("u1", null, "user", "はじめ"),
    );
    const target = findUndoTarget(entries);
    assert.equal(target?.entryId, "u2");
    assert.equal(target?.text, "やり直したい");
  });

  it("連打を想定して、直前の user 発言まで戻った状態のブランチではその前の user 発言を選ぶ", () => {
    const entries = branch(
      entry("a1", "u1", "assistant", [{ type: "text", text: "hello" }]),
      entry("u1", null, "user", "はじめ"),
    );
    const target = findUndoTarget(entries);
    assert.equal(target?.entryId, "u1");
    assert.equal(target?.text, "はじめ");
  });

  it("user 発言が会話の最初の1件のみのとき、その発言を選ぶ", () => {
    const entries = branch(entry("u1", null, "user", "はじめ"));
    const target = findUndoTarget(entries);
    assert.equal(target?.entryId, "u1");
  });

  it("user 発言がないブランチでは undefined を返す", () => {
    const entries = branch(entry("a1", null, "assistant", [{ type: "text", text: "hello" }]));
    assert.equal(findUndoTarget(entries), undefined);
  });

  it("空のブランチでは undefined を返す", () => {
    assert.equal(findUndoTarget(branch()), undefined);
  });
});
