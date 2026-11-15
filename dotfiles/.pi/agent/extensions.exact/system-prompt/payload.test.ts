import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { promptFromPayload } from "./payload.ts";

const nativePayloads = [
  {
    api: "openai-codex-responses",
    payload: {
      model: "codex",
      instructions: "Initial",
      input: [{ role: "developer", content: "Update" }],
      stream: true,
    },
    expected: "Initial\n\nUpdate",
  },
  {
    api: "openai-responses",
    payload: {
      model: "responses",
      input: [
        { role: "developer", content: "Initial" },
        { role: "user", content: "Private user input" },
        { role: "system", content: "Update" },
      ],
      stream: true,
    },
    expected: "Initial\n\nUpdate",
  },
  {
    api: "azure-openai-responses",
    payload: {
      model: "deployment",
      input: [{ role: "system", content: [{ type: "input_text", text: "Azure" }] }],
      stream: true,
    },
    expected: "Azure",
  },
  {
    api: "openai-completions",
    payload: {
      model: "chat",
      messages: [
        { role: "system", content: "Initial" },
        { role: "user", content: "User" },
        { role: "developer", content: "Update" },
        { role: "system", tools: [] },
      ],
      stream: true,
    },
    expected: "Initial\n\nUpdate",
  },
  {
    api: "mistral-conversations",
    payload: {
      model: "mistral",
      messages: [
        { role: "system", content: "Mistral" },
        { role: "assistant", content: "Not instructions" },
      ],
      stream: true,
    },
    expected: "Mistral",
  },
  {
    api: "anthropic-messages",
    payload: {
      model: "claude",
      max_tokens: 100,
      system: [
        { type: "text", text: "Provider identity" },
        { type: "text", text: "Initial", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        { role: "user", content: "User" },
        {
          role: "system",
          content: [
            { type: "text", text: "Update" },
            { type: "tool_addition", tool: { name: "read" } },
            { type: "tool_removal", tool: { name: "write" } },
          ],
        },
      ],
      stream: true,
    },
    expected: "Provider identity\n\nInitial\n\nUpdate",
  },
  {
    api: "bedrock-converse-stream",
    payload: {
      modelId: "bedrock",
      system: [{ text: "Bedrock" }, { cachePoint: { type: "default" } }],
      messages: [{ role: "user", content: [{ text: "User" }] }],
    },
    expected: "Bedrock",
  },
  {
    api: "google-generative-ai",
    payload: {
      model: "gemini",
      contents: [{ role: "user", parts: [{ text: "User" }] }],
      config: { systemInstruction: "Google" },
    },
    expected: "Google",
  },
  {
    api: "google-vertex",
    payload: { model: "gemini", contents: [], config: { systemInstruction: "Vertex" } },
    expected: "Vertex",
  },
  {
    api: "pi-messages",
    payload: {
      model: "remote",
      context: {
        messages: [
          {
            role: "system",
            content: "Initial",
            sections: { rules: "Old rules", removed: "Remove" },
          },
          { role: "user", content: "User" },
          { role: "system", content: "Update", sections: { rules: "New rules", removed: null } },
        ],
      },
      options: {},
    },
    expected: "Initial\n\nUpdate\n\nNew rules",
  },
];

describe("promptFromPayload native schemas", () => {
  for (const { api, payload, expected } of nativePayloads) {
    it(`reads ${api} without changing the payload`, () => {
      const original = structuredClone(payload);
      assert.equal(promptFromPayload(payload), expected);
      assert.deepEqual(payload, original);
    });
  }

  it("supports Google content parts", () => {
    const payload = {
      contents: [],
      config: { systemInstruction: { parts: [{ text: "First" }, { text: "Second" }] } },
    };
    assert.equal(promptFromPayload(payload), "First\n\nSecond");
  });

  it("reads only validated prompt fields from context messages", () => {
    const payload = {
      context: {
        messages: [
          {
            role: "system",
            content: "New prompt",
            sections: { rules: "Rules" },
            toolsAdded: 42,
            toolsRemoved: 42,
            timestamp: "not used for text",
          },
        ],
      },
    };
    assert.equal(promptFromPayload(payload), "New prompt\n\nRules");
  });

  it("preserves whitespace inside text blocks", () => {
    assert.equal(promptFromPayload({ instructions: "  exact\n\n", input: [] }), "  exact\n\n");
  });

  it("reads payload shape without relying on a provider or model identifier", () => {
    assert.equal(
      promptFromPayload({
        model: "custom-route",
        messages: [{ role: "developer", content: "Custom" }],
      }),
      "Custom",
    );
  });
});

describe("empty and unavailable payloads", () => {
  const emptyPayloads = [
    { instructions: "", input: [] },
    { input: [{ role: "user", content: "User" }] },
    { input: "User" },
    { messages: [{ role: "user", content: "User" }] },
    { system: [], messages: [] },
    { contents: [], config: {} },
    { contents: [] },
    { context: { messages: [] } },
    { context: { messages: [{ role: "system", content: "" }] } },
  ];
  for (const [index, payload] of emptyPayloads.entries()) {
    it(`returns an empty prompt when the native schema has no instructions: ${index}`, () => {
      assert.equal(promptFromPayload(payload), "");
    });
  }

  const invalidPayloads = [
    undefined,
    null,
    [],
    "prompt",
    {},
    { unknown: "prompt" },
    { instructions: 42, input: [] },
    { instructions: "Do not return partial text", input: null },
    { instructions: "Do not return partial text", input: [{ role: "system", content: false }] },
    { messages: "not messages" },
    { messages: [null] },
    { messages: [{ role: "system", content: [{ type: "text", text: 42 }] }] },
    {
      system: [
        { type: "text", text: "Do not return partial text" },
        { type: "text", text: null },
      ],
    },
    { system: [{ unsupported: "hidden instructions" }] },
    { contents: [], config: null },
    { contents: [], config: { systemInstruction: 42 } },
    { contents: [], config: { systemInstruction: { parts: [{ text: false }] } } },
    { context: null },
    { context: { messages: "not messages" } },
    { context: { messages: [{ role: "system", content: 42 }] } },
    { context: { messages: [{ role: "system", content: "Text", sections: { invalid: 42 } }] } },
  ];
  for (const [index, payload] of invalidPayloads.entries()) {
    it(`returns unavailable for unsupported or malformed payloads: ${index}`, () => {
      assert.equal(promptFromPayload(payload), undefined);
    });
  }
});
