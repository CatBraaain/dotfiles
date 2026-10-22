import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  entryTypeLabel,
  extractEntryText,
  messageText,
  messageThinking,
  parseEntryLine,
  type SessionEntry,
} from "./entry";

function userLine(text: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: "2026-10-21T02:38:45.892Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

describe("parseEntryLine", () => {
  it("returns the entry for a valid message line", () => {
    const entry = parseEntryLine(userLine("hello"));
    assert.equal(entry?.type, "message");
    assert.equal(entry?.message?.role, "user");
  });

  it("returns null for a broken JSON line", () => {
    assert.equal(parseEntryLine("{not json"), null);
  });

  it("returns null for a non-object JSON line", () => {
    assert.equal(parseEntryLine("42"), null);
  });

  it("returns null when the type field is missing", () => {
    assert.equal(parseEntryLine('{"timestamp":"2026-10-21T02:38:45.892Z"}'), null);
  });
});

describe("messageText", () => {
  it("joins text blocks with newlines", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "toolCall", name: "bash" },
      { type: "text", text: "second" },
    ];
    assert.equal(messageText(content), "first\nsecond");
  });

  it("returns string content as-is", () => {
    assert.equal(messageText("plain text"), "plain text");
  });

  it("returns an empty string when content is missing", () => {
    assert.equal(messageText(undefined), "");
  });
});

describe("messageThinking", () => {
  it("joins thinking blocks only", () => {
    const content = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
    ];
    assert.equal(messageThinking(content), "plan");
  });
});

describe("entryTypeLabel", () => {
  it("labels custom entries with their customType", () => {
    const entry: SessionEntry = { type: "custom", customType: "agents.subagent-log" };
    assert.equal(entryTypeLabel(entry), "custom:agents.subagent-log");
  });

  it("returns the plain type for non-custom entries", () => {
    assert.equal(entryTypeLabel({ type: "message" }), "message");
  });
});

describe("extractEntryText", () => {
  it("extracts user message text", () => {
    const entry = parseEntryLine(userLine("find the worktree"));
    assert.equal(extractEntryText(entry as SessionEntry), "find the worktree");
  });

  it("extracts text blocks from an assistant message", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal plan" },
          { type: "text", text: "the answer" },
        ],
      },
    });
    assert.equal(extractEntryText(parseEntryLine(line) as SessionEntry), "the answer");
  });

  it("falls back to thinking blocks when assistant text blocks are empty", () => {
    const line = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "internal plan" }] },
    });
    assert.equal(extractEntryText(parseEntryLine(line) as SessionEntry), "internal plan");
  });

  it("extracts toolResult output text", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "command output" }],
      },
    });
    assert.equal(extractEntryText(parseEntryLine(line) as SessionEntry), "command output");
  });

  it("extracts the agent and task from a subagent log", () => {
    const line = JSON.stringify({
      type: "custom",
      customType: "agents.subagent-log",
      data: { agent: "vision", task: "read the image" },
    });
    assert.equal(
      extractEntryText(parseEntryLine(line) as SessionEntry),
      "subagent vision: read the image",
    );
  });

  it("labels unknown custom entries with the customType and data", () => {
    const line = JSON.stringify({
      type: "custom",
      customType: "skill-status",
      data: { skill: "review" },
    });
    assert.equal(
      extractEntryText(parseEntryLine(line) as SessionEntry),
      'skill-status {"skill":"review"}',
    );
  });

  it("falls back to sections text for system messages with empty content", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "system",
        content: "",
        sections: { preamble: "You are pi.", tools: "<tools>bash</tools>" },
      },
    });
    assert.equal(
      extractEntryText(parseEntryLine(line) as SessionEntry),
      "You are pi.\n<tools>bash</tools>",
    );
  });

  it("returns an empty string for model_change entries", () => {
    assert.equal(extractEntryText({ type: "model_change" }), "");
  });
});
