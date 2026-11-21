import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { decodeAgentMessage, messageOptions, partitionMessageOptions } from "./messages.ts";

const MESSAGE_ID = "01234567-89ab-cdef-0123-456789abcdef";

function envelopeValue(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      id: MESSAGE_ID,
      from: "sender-session-id",
      at: "2026-11-21T00:00:00.000Z",
      text: "duplicate work detected",
      ...overrides,
    }),
  ).toString("base64");
}

describe("messageOptions", () => {
  it("keeps only the @pi-mux-msg- options from a pane option listing", () => {
    const output = [
      '@pi-mux-launch {"id":"x","pid":1,"token":"t"}',
      `@pi-mux-msg-${MESSAGE_ID} eyJ2IjoxfQ==`,
      "@pi-tmux-session eyJpZCI6IngifQ==",
      '@probe-with-spaces "quoted value with spaces"',
      "",
    ].join("\n");
    assert.deepEqual(messageOptions(output), [
      { name: `@pi-mux-msg-${MESSAGE_ID}`, value: "eyJ2IjoxfQ==" },
    ]);
  });

  it("returns an empty list for blank output", () => {
    assert.deepEqual(messageOptions(""), []);
    assert.deepEqual(messageOptions("\n"), []);
  });
});

describe("decodeAgentMessage", () => {
  it("decodes a valid envelope", () => {
    assert.deepEqual(decodeAgentMessage(envelopeValue()), {
      v: 1,
      id: MESSAGE_ID,
      from: "sender-session-id",
      at: "2026-11-21T00:00:00.000Z",
      text: "duplicate work detected",
    });
  });

  it("accepts an external sender and multibyte text at the size limit", () => {
    assert.equal(decodeAgentMessage(envelopeValue({ from: "external" }))?.from, "external");
    assert.notEqual(decodeAgentMessage(envelopeValue({ text: "あ".repeat(2800) })), undefined);
    assert.equal(decodeAgentMessage(envelopeValue({ text: "あ".repeat(2801) })), undefined);
  });

  for (const [label, value] of [
    ["non-base64 characters", "not base64!!"],
    ["empty value", ""],
    ["invalid JSON", Buffer.from("{").toString("base64")],
    ["a JSON array", Buffer.from("[]").toString("base64")],
    ["a JSON string", Buffer.from('"x"').toString("base64")],
  ] as const)
    it(`rejects ${label}`, () => {
      assert.equal(decodeAgentMessage(value), undefined);
    });

  for (const [label, overrides] of [
    ["an unknown version", { v: 2 }],
    ["a non-uuid id", { id: "not-a-uuid" }],
    ["a missing id", { id: undefined }],
    ["an empty sender", { from: "  " }],
    ["a non-string sender", { from: 42 }],
    ["a missing timestamp", { at: undefined }],
    ["an empty timestamp", { at: "" }],
    ["blank text", { text: "   " }],
    ["a non-string text", { text: { nested: true } }],
  ] as const)
    it(`rejects ${label}`, () => {
      assert.equal(decodeAgentMessage(envelopeValue(overrides)), undefined);
    });
});

describe("partitionMessageOptions", () => {
  it("separates valid messages from invalid options and orders them by timestamp", () => {
    const early = envelopeValue({
      id: "00000000-0000-4000-8000-000000000001",
      at: "2026-11-21T00:00:01.000Z",
    });
    const late = envelopeValue({
      id: "00000000-0000-4000-8000-000000000002",
      at: "2026-11-21T00:00:02.000Z",
    });
    const earliest = envelopeValue({
      id: "00000000-0000-4000-8000-000000000003",
      at: "2026-11-21T00:00:00.000Z",
    });
    const { valid, invalid } = partitionMessageOptions([
      { name: `@pi-mux-msg-late`, value: late },
      { name: "@pi-mux-msg-broken", value: "!!not-base64!!" },
      { name: `@pi-mux-msg-early`, value: early },
      { name: `@pi-mux-msg-earliest`, value: earliest },
    ]);
    assert.deepEqual(
      valid.map((entry) => entry.message.id),
      [
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
    );
    assert.deepEqual(invalid, ["@pi-mux-msg-broken"]);
  });
});
