import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import streamRepetitionGuard from "./index.ts";

function createHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const entries: Array<{ customType: string; data: any }> = [];
  let abortCount = 0;
  const calls: string[] = [];
  streamRepetitionGuard({
    registerEntryRenderer() {},
    on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: any) => {
      calls.push("record");
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    abort: () => {
      calls.push("abort");
      abortCount++;
    },
    sessionManager: { getSessionId: () => "test-session" },
  };
  const emit = (type: string, payload: object = {}) =>
    handlers.get(type)?.({ type, ...payload }, ctx);
  const message = (timestamp = 1, stopReason = "stop", errorMessage?: string) => ({
    role: "assistant",
    timestamp,
    content: [],
    stopReason,
    errorMessage,
  });
  const start = (timestamp = 1) => emit("message_start", { message: message(timestamp) });
  const update = (type: string, delta = "", contentIndex = 0, timestamp = 1) =>
    emit("message_update", {
      message: message(timestamp),
      assistantMessageEvent: { type, delta, contentIndex, content: delta },
    });
  emit("before_agent_start");
  start();
  return { emit, start, update, message, entries, calls, abortCount: () => abortCount };
}

describe("stream repetition SDK adapter", () => {
  for (const kind of ["text", "thinking", "toolcall"]) {
    it(`aborts ${kind} raw deltas synchronously and records only metadata once`, () => {
      const h = createHarness();
      assert.equal(h.update(`${kind}_delta`, "prefix!" + "x".repeat(1000) + "tail"), undefined);
      assert.equal(h.abortCount(), 1);
      assert.deepEqual(h.calls, ["abort", "record"]);
      const record = h.entries[0]!;
      assert.equal(record.customType, "stream-repetition-guard");
      assert.equal(record.data.kind, kind);
      assert.equal(record.data.contentIndex, 0);
      assert.equal(record.data.period, 1);
      assert.equal(record.data.repetitions, 1000);
      assert.equal(record.data.repeatedCharacters, 1000);
      assert.equal(record.data.endPosition, 1007);
      assert.equal(record.data.responseTimestamp, 1);
      assert.equal(record.data.sessionId, "test-session");
      assert.ok(!JSON.stringify(record).includes("prefix!"));
      h.update(`${kind}_delta`, "x".repeat(2000));
      assert.equal(h.entries.length, 1);
      assert.equal(h.abortCount(), 1);
    });
  }

  it("keeps kinds and individual interleaved tool blocks independent", () => {
    const h = createHarness();
    h.update("text_delta", "x".repeat(600), 0);
    h.update("thinking_delta", "x".repeat(600), 1);
    h.update("toolcall_delta", "x".repeat(600), 2);
    h.update("toolcall_delta", "x".repeat(600), 3);
    assert.equal(h.abortCount(), 0);
    h.update("toolcall_delta", "x".repeat(400), 2);
    assert.equal(h.entries[0]!.data.contentIndex, 2);
  });

  it("is invariant to UTF-16 chunk boundaries", () => {
    const whole = createHarness();
    whole.update("text_delta", "😀".repeat(1000));
    const split = createHarness();
    for (const unit of "😀".repeat(1000).split("")) split.update("text_delta", unit);
    assert.deepEqual(split.entries, whole.entries);
  });

  it("flushes an unpaired surrogate at block end exactly once", () => {
    const h = createHarness();
    h.update("thinking_delta", "\ud800".repeat(1000));
    assert.equal(h.abortCount(), 0);
    h.update("thinking_end", "\ud800".repeat(1000));
    h.update("thinking_end", "\ud800".repeat(1000));
    h.emit("message_end", { message: h.message() });
    assert.equal(h.abortCount(), 1);
    assert.equal(h.entries[0]!.data.endPosition, 1000);
    assert.equal(h.entries.length, 1);
  });

  it("flushes all blocks at terminal message end even without block end", () => {
    const h = createHarness();
    h.update("toolcall_delta", "\ud800".repeat(1000), 4);
    const result = h.emit("message_end", { message: h.message() });
    assert.equal(result.message.stopReason, "aborted");
    assert.equal(h.entries[0]!.data.contentIndex, 4);
  });

  it("does not count authoritative end content or terminal snapshots twice", () => {
    const h = createHarness();
    h.update("text_delta", "x".repeat(600));
    h.update("text_end", "x".repeat(600));
    h.update("done", "x".repeat(1200));
    assert.equal(
      h.emit("message_end", {
        message: { ...h.message(), content: [{ type: "text", text: "x".repeat(1200) }] },
      }),
      undefined,
    );
    assert.equal(h.abortCount(), 0);
  });

  it("ignores cumulative snapshots, signatures and nonassistant messages", () => {
    const h = createHarness();
    h.update("start", "x".repeat(1000));
    h.update("thinking_signature", "x".repeat(1000));
    h.emit("message_update", {
      message: { role: "user" },
      assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1000), contentIndex: 0 },
    });
    h.emit("message_end", { message: { role: "toolResult", content: "x".repeat(1000) } });
    assert.equal(h.abortCount(), 0);
  });

  it("preserves the abort latch across late request, start, end and agent notifications", () => {
    const h = createHarness();
    h.update("text_delta", "x".repeat(1000));
    h.emit("agent_end");
    h.emit("agent_start");
    h.emit("before_provider_request");
    h.start(2);
    h.update("text_delta", "x".repeat(1000), 0, 2);
    assert.equal(h.emit("message_end", { message: h.message(2) }), undefined);
    assert.equal(h.abortCount(), 1);
    assert.equal(h.entries.length, 1);
    assert.deepEqual(h.emit("tool_call"), { block: true, reason: h.entries[0]!.data.reason });
  });

  it("clears the latch only on a new explicit run", () => {
    const h = createHarness();
    h.update("text_delta", "x".repeat(1000));
    h.emit("before_agent_start");
    h.start(2);
    assert.equal(h.emit("tool_call"), undefined);
    h.update("text_delta", "x".repeat(1000), 0, 2);
    assert.equal(h.abortCount(), 2);
    assert.equal(h.entries[1]!.data.responseTimestamp, 2);
  });

  it("never joins separate assistant responses or accepts stale deltas", () => {
    const h = createHarness();
    h.update("text_delta", "x".repeat(600));
    h.emit("message_end", { message: h.message() });
    h.start(2);
    h.update("text_delta", "x".repeat(600), 0, 2);
    h.update("text_delta", "x".repeat(1000), 0, 1);
    assert.equal(h.abortCount(), 0);
  });

  it("discards state on session shutdown and replacement", () => {
    const h = createHarness();
    h.update("text_delta", "x".repeat(600));
    h.emit("session_shutdown");
    h.update("text_delta", "x".repeat(1000));
    h.emit("session_start");
    h.emit("before_agent_start");
    h.start(2);
    h.update("text_delta", "x".repeat(600), 0, 2);
    assert.equal(h.abortCount(), 0);
    h.update("text_delta", "x".repeat(400), 0, 2);
    assert.equal(h.abortCount(), 1);
  });

  for (const stopReason of ["stop", "toolUse", "error", "aborted", "length"]) {
    it(`replaces detected ${stopReason} with aborted and preserves original error and content for parent consumers`, () => {
      const h = createHarness();
      h.update("text_delta", "x".repeat(1000));
      const original = {
        ...h.message(1, stopReason, "Original explanation"),
        content: [{ type: "text", text: "retained" }],
      };
      const replacement = h.emit("message_end", { message: original }).message;
      assert.equal(replacement.stopReason, "aborted");
      assert.equal(replacement.errorMessage, "Original explanation\n" + h.entries[0]!.data.reason);
      assert.equal(replacement.content, original.content);
      assert.equal(original.stopReason, stopReason);
      assert.equal(h.entries.length, 1);
    });

    it(`leaves unrelated ${stopReason} termination untouched`, () => {
      const h = createHarness();
      h.update("text_delta", "normal text");
      assert.equal(
        h.emit("message_end", { message: h.message(1, stopReason, "Original explanation") }),
        undefined,
      );
      assert.equal(h.entries.length, 0);
      assert.equal(h.abortCount(), 0);
    });
  }
});
