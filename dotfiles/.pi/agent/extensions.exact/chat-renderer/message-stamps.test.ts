import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
  initTheme,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import extensionDefault from "./index.ts";
import { installMessageStamps } from "./message-stamps.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
} as Theme;

const noon = new Date(2025, 0, 1, 21, 30, 3);
const noonMs = noon.getTime();
const noonIso = noon.toISOString();

let dispose: () => void;
beforeEach(() => {
  initTheme("dark", false);
  dispose = installMessageStamps(plainTheme);
});
afterEach(() => {
  dispose();
});

type AssistantMessageInput = NonNullable<
  ConstructorParameters<typeof AssistantMessageComponent>[0]
>;

function assistantMessage(content: AssistantMessageInput["content"]): AssistantMessageInput {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {},
    stopReason: "stop",
    timestamp: noonMs,
  } as AssistantMessageInput;
}

function lastPlainLine(lines: string[]): string {
  return stripTerminalSequences(lines.at(-1) ?? "");
}

describe("assistant message stamps", () => {
  it("appends a right-aligned stamp under a text response", () => {
    const component = new AssistantMessageComponent(
      assistantMessage([{ type: "text", text: "reply body" }]),
    );
    const lines = component.render(80);
    assert.ok(lines.length > 1);
    assert.equal(visibleWidth(lines.at(-1)!), 80);
    assert.match(lastPlainLine(lines), /21:30:03$/);
  });

  it("stamps the message creation time even without an entry timestamp", () => {
    const component = new AssistantMessageComponent(
      assistantMessage([{ type: "text", text: "reply body" }]),
    );
    delete (component as unknown as { timestamp?: string }).timestamp;
    const lines = component.render(80);
    assert.match(lastPlainLine(lines), /21:30:03$/);
  });

  it("leaves stamping of tool-carrying responses to the tool rows", () => {
    const component = new AssistantMessageComponent(
      assistantMessage([
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ] as AssistantMessageInput["content"]),
    );
    const lines = component.render(80);
    assert.ok(!lastPlainLine(lines).includes("21:30:03"));
  });

  it("keeps empty renders empty", () => {
    const component = new AssistantMessageComponent(assistantMessage([{ type: "text", text: "" }]));
    assert.deepEqual(component.render(80), []);
  });
});

describe("user message stamps", () => {
  it("appends a right-aligned stamp from the entry timestamp", () => {
    const component = new UserMessageComponent("hello");
    (component as unknown as { timestamp?: string }).timestamp = noonIso;
    const lines = component.render(80);
    assert.ok(lines.length > 1);
    assert.equal(visibleWidth(lines.at(-1)!), 80);
    assert.match(lastPlainLine(lines), /21:30:03$/);
  });

  it("renders live user messages once their start event is observed", () => {
    const { pi, handlers } = captureExtension();
    extensionDefault(pi);
    handlers.get("message_start")!(
      { message: { role: "user", content: "hi", timestamp: noonMs } },
      {},
    );
    const component = new UserMessageComponent("hello");
    const lines = component.render(80);
    assert.match(lastPlainLine(lines), /21:30:03$/);
    const again = component.render(80);
    assert.equal(lastPlainLine(again), lastPlainLine(lines));
  });

  it("omits the stamp when no time is known", () => {
    const component = new UserMessageComponent("hello");
    const lines = component.render(80);
    assert.ok(!lastPlainLine(lines).includes("21:30:03"));
  });
});

describe("legacy pi-stamp entries", () => {
  it("renders recorded pi-stamp entries as nothing", () => {
    let renderer: ((entry: unknown) => unknown) | undefined;
    const pi = {
      registerEntryRenderer: (_type: string, value: (entry: unknown) => unknown) => {
        renderer = value;
      },
    } as unknown as ExtensionAPI;
    extensionDefault(pi);
    const rendered = renderer!({ customType: "pi-stamp" }) as { render: () => string[] };
    assert.deepEqual(rendered.render(), []);
  });
});

function captureExtension() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => void) => {
      handlers.set(event, handler);
    },
    registerEntryRenderer: () => {},
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}
