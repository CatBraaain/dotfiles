import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { extractOpuiLangBlocks, stripOpuiLangBlocks } from "./fence";
import {
  createQueue,
  renderPreview,
  shotHtml,
  OPENUI_CUSTOM_TYPE,
  type ExecFileFn,
  type PreviewDetails,
} from "./index";

let workDir: string;

const ONE_BY_ONE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SUPPORTED_DSL = 'root = Stack([TextContent("hello")])';

let promptFixtureDir: string;

const ref = (name: string) => ({ $ref: "#/$defs/" + name });

const PROMPT_FIXTURE_SPEC = {
  root: "Stack",
  components: {
    Stack: {
      signature:
        "Stack(children: any[], direction?: \"row\" | \"column\") — Flex container",
    },
    TextContent: { signature: "TextContent(text: string) — Text block" },
    Tabs: { signature: "Tabs(items: TabItem[]) — Tabbed container" },
    TabItem: {
      signature:
        "TabItem(value: string, trigger: string, content: any[]) — Tab",
    },
  },
  schema: {
    type: "object",
    properties: {
      Stack: ref("Stack"),
      TextContent: ref("TextContent"),
      Tabs: ref("Tabs"),
      TabItem: ref("TabItem"),
    },
    required: ["Stack", "TextContent", "Tabs", "TabItem"],
    additionalProperties: false,
    $defs: {
      Stack: {
        type: "object",
        properties: { children: { type: "array", items: {} } },
        required: ["children"],
        additionalProperties: false,
      },
      TextContent: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      Tabs: {
        type: "object",
        properties: { items: { type: "array", items: {} } },
        required: ["items"],
        additionalProperties: false,
      },
      TabItem: {
        type: "object",
        properties: {
          value: { type: "string" },
          trigger: { type: "string" },
          content: { type: "array", items: {} },
        },
        required: ["value", "trigger", "content"],
        additionalProperties: false,
      },
    },
  },
};

const PROMPT_FIXTURE_OPTIONS = {
  examples: ["Example 1 — Table:\n\nroot = Stack([tbl])"],
  additionalRules: ["When asked about data, generate realistic/plausible data"],
};

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "openui-preview-test-"));
  promptFixtureDir = mkdtempSync(join(tmpdir(), "openui-prompt-fixture-"));
  writeFileSync(join(promptFixtureDir, "spec.json"), JSON.stringify(PROMPT_FIXTURE_SPEC));
  writeFileSync(
    join(promptFixtureDir, "prompt-options.json"),
    JSON.stringify(PROMPT_FIXTURE_OPTIONS),
  );
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("extractOpuiLangBlocks", () => {
  it("extracts a single closed block", () => {
    const text = ["before", "```openui-lang", 'root = Stack([])', "```", "after"].join("\n");
    const blocks = extractOpuiLangBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.source, "root = Stack([])");
    assert.equal(blocks[0]?.startLine, 2);
    assert.equal(blocks[0]?.unclosed, false);
  });

  it("extracts multiple blocks in document order", () => {
    const text = [
      "```openui-lang",
      "root = Stack([one])",
      "```",
      "text",
      "```openui-lang",
      "root = Stack([two])",
      "```",
    ].join("\n");
    const blocks = extractOpuiLangBlocks(text);
    assert.deepEqual(
      blocks.map((block) => block.source),
      ["root = Stack([one])", "root = Stack([two])"],
    );
  });

  it("ignores other language tags", () => {
    const text = ["```html", "<p>x</p>", "```"].join("\n");
    assert.deepEqual(extractOpuiLangBlocks(text), []);
  });

  it("does not match tags that merely start with openui-lang", () => {
    const text = ["```openui-language", "root = Stack([])", "```"].join("\n");
    assert.deepEqual(extractOpuiLangBlocks(text), []);
  });

  it("reports an unclosed block", () => {
    const text = ["```openui-lang", "root = Stack([never-closed])"].join("\n");
    const blocks = extractOpuiLangBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.unclosed, true);
    assert.equal(blocks[0]?.source, "root = Stack([never-closed])");
  });

  it("ignores extra tokens after the openui-lang tag", () => {
    const text = ["```openui-lang card", "root = Stack([])", "```"].join("\n");
    const blocks = extractOpuiLangBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.source, "root = Stack([])");
  });

  it("returns empty for text without fences", () => {
    assert.deepEqual(extractOpuiLangBlocks("plain text\nno code"), []);
  });
});

describe("stripOpuiLangBlocks", () => {
  it("removes closed blocks and keeps surrounding text", () => {
    const text = [
      "before",
      "```openui-lang",
      "root = Stack([])",
      "```",
      "after",
    ].join("\n");
    assert.equal(stripOpuiLangBlocks(text), "before\nafter");
  });

  it("removes an unclosed streaming block up to the end", () => {
    const text = ["intro", "```openui-lang", "root = Stack(["].join("\n");
    assert.equal(stripOpuiLangBlocks(text), "intro");
  });

  it("keeps other fenced languages", () => {
    const text = ["```html", "<p>x</p>", "```"].join("\n");
    assert.equal(stripOpuiLangBlocks(text), text);
  });
});

describe("createQueue", () => {
  it("runs tasks sequentially in order", async () => {
    const enqueue = createQueue();
    const order: number[] = [];
    const first = enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
    });
    const second = enqueue(async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, [1, 2]);
  });

  it("lets a later task run after a failed one", async () => {
    const enqueue = createQueue();
    const first = enqueue(async () => {
      throw new Error("boom");
    }).catch(() => {});
    let ran = false;
    const second = enqueue(async () => {
      ran = true;
    });
    await Promise.all([first, second]);
    assert.equal(ran, true);
  });
});

describe("shotHtml", () => {
  it("writes html, shots once on success, and removes the html file", async () => {
    const calls: string[][] = [];
    const execFile: ExecFileFn = (_file, args, callback) => {
      calls.push([...args]);
      callback(null, "ok", "");
    };

    const result = await shotHtml("<p>x</p>", "success-case", {
      outDir: workDir,
      htmlshotPath: "/bin/htmlshot",
      execFile,
      width: 960,
      height: 640,
    });

    assert.equal(result.ok, true);
    assert.equal(result.pngPath, join(workDir, "success-case.html.png"));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.includes("--width"));
    assert.equal(existsSync(join(workDir, "success-case.html")), false);
  });

  it("does not retry with --unsafe when the shot fails", async () => {
    const calls: string[][] = [];
    const execFile: ExecFileFn = (_file, args, callback) => {
      calls.push([...args]);
      callback({ code: 1, message: "rejected" }, "", "htmlshot: fatal: bad input");
    };

    const result = await shotHtml("<p>x</p>", "failure-case", {
      outDir: workDir,
      htmlshotPath: "/bin/htmlshot",
      execFile,
      width: 960,
      height: 640,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "htmlshot: fatal: bad input");
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]?.includes("--unsafe"));
    assert.equal(existsSync(join(workDir, "failure-case.html")), false);
  });
});

describe("renderPreview", () => {
  const theme = {
    bg: (color: string, text: string) => `bg(${color}){${text}}`,
    fg: (color: string, text: string) => `fg(${color}){${text}}`,
  };
  const options = { outputPad: 0 };

  it("renders an error card for error details", () => {
    const details: PreviewDetails = { kind: "error", message: "shot failed" };
    const lines = renderPreview(details, options, theme).render(40).join("\n");
    assert.ok(lines.includes("[openui] shot failed"));
  });

  it("renders a fallback card when the png file is missing", () => {
    const details: PreviewDetails = { kind: "image", pngPath: "/nonexistent/a.png" };
    const lines = renderPreview(details, options, theme).render(60).join("\n");
    assert.ok(lines.includes("preview file missing"));
  });

  it("renders an image when the png file exists", () => {
    const pngPath = join(workDir, "real.png");
    writeFileSync(pngPath, Buffer.from(ONE_BY_ONE_PNG, "base64"));
    const details: PreviewDetails = { kind: "image", pngPath };
    const lines = renderPreview(details, options, theme).render(60).join("\n");
    assert.ok(!lines.includes("preview file missing"));
  });
});

interface MockPi {
  registerMessageRenderer: (type: string) => void;
  on: (event: string, handler: (event: unknown, ctx: unknown) => void) => () => void;
  registerMarkdownTransformer: (transformer: (markdown: string, context: unknown) => string) => void;
  sendMessage: (message: unknown) => Promise<void>;
}

interface Captured {
  registeredTypes: string[];
  registeredEvents: string[];
  transformers: Array<(markdown: string, context: unknown) => string>;
  sent: Array<{ customType?: string; display?: boolean; details?: PreviewDetails }>;
  handlers: Map<string, (event: unknown, ctx: unknown) => void>;
}

function mockPi(captured: Captured): MockPi {
  return {
    registerMessageRenderer: (type: string) => {
      captured.registeredTypes.push(type);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      captured.registeredEvents.push(event);
      captured.handlers.set(event, handler);
      return () => {};
    },
    registerMarkdownTransformer: (transformer) => {
      captured.transformers.push(transformer);
    },
    sendMessage: async (message) => {
      captured.sent.push(message as Captured["sent"][number]);
    },
  };
}

function captureFrom(
  extension: (pi: MockPi, overrides?: unknown) => void,
  extraOverrides?: Record<string, unknown>,
): Captured {
  const captured: Captured = {
    registeredTypes: [],
    registeredEvents: [],
    transformers: [],
    sent: [],
    handlers: new Map(),
  };
  extension(mockPi(captured), { outDir: workDir, htmlshotPath: "/bin/htmlshot", ...extraOverrides });
  return captured;
}

const shootingExecFile: ExecFileFn = (_file, args, callback) => {
  const pngPath = args[args.indexOf("-o") + 1];
  writeFileSync(pngPath ?? "", Buffer.from(ONE_BY_ONE_PNG, "base64"));
  callback(null, "ok", "");
};

describe("extension wiring", () => {
  it("registers renderer, markdown transformer, and both handlers", async () => {
    const { default: openuiPreviewExtension } = await import("./index");
    const captured = captureFrom(openuiPreviewExtension as unknown as (pi: MockPi, overrides?: unknown) => void);
    assert.deepEqual(captured.registeredTypes, [OPENUI_CUSTOM_TYPE]);
    assert.deepEqual(captured.registeredEvents, ["before_agent_start", "message_end"]);
    assert.equal(captured.transformers.length, 1);
  });

  it("injects the openui-lang prompt section on agent start", async () => {
    const { default: openuiPreviewExtension } = await import("./index");
    const captured = captureFrom(
      openuiPreviewExtension as unknown as (pi: MockPi, overrides?: unknown) => void,
      { generatedDir: promptFixtureDir },
    );
    const handler = captured.handlers.get("before_agent_start");
    assert.ok(handler, "before_agent_start handler should be registered");
    const sections: Record<string, string> = {};
    handler({ systemPromptOptions: { sections } }, {});
    assert.ok(sections["openui-lang"]);
    assert.ok(sections["openui-lang"].includes("```openui-lang"));
  });

  it("strips openui-lang blocks only for assistant messages", async () => {
    const { default: openuiPreviewExtension } = await import("./index");
    const captured = captureFrom(
      openuiPreviewExtension as unknown as (pi: MockPi, overrides?: unknown) => void,
      { generatedDir: promptFixtureDir, execFile: shootingExecFile },
    );
    const transform = captured.transformers[0];
    assert.ok(transform);
    const markdown = "intro\n```openui-lang\nroot = Stack([])\n```\noutro";
    assert.equal(
      transform(markdown, { messageType: "assistant", isStreaming: false, availableWidth: 80 }),
      "intro\noutro",
    );
    assert.equal(
      transform(markdown, { messageType: "user", isStreaming: false, availableWidth: 80 }),
      markdown,
    );
    assert.equal(
      transform(markdown, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 }),
      markdown,
    );
  });

  it("sends a preview message for an openui-lang block in an assistant message", async () => {
    const { default: openuiPreviewExtension } = await import("./index");
    const captured: Captured = {
      registeredTypes: [],
      registeredEvents: [],
      transformers: [],
      sent: [],
      handlers: new Map(),
    };
    const errors: unknown[] = [];
    openuiPreviewExtension(
      mockPi(captured) as never,
      {
        outDir: workDir,
        htmlshotPath: "/bin/htmlshot",
        execFile: shootingExecFile,
        generatedDir: promptFixtureDir,
        enqueue: <T,>(task: () => Promise<T>): Promise<T> =>
          task().catch((error: unknown) => {
            errors.push(error);
            throw error;
          }),
      },
    );

    captured.handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: `\`\`\`openui-lang\n${SUPPORTED_DSL}\n\`\`\`` }],
        },
      },
      { mode: "tui" },
    );
    for (let i = 0; i < 50 && captured.sent.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(captured.sent.length, 1);
    assert.equal(captured.sent[0]?.customType, OPENUI_CUSTOM_TYPE);
    assert.equal(captured.sent[0]?.display, true);
    assert.equal(captured.sent[0]?.details?.kind, "image");
    assert.ok(existsSync(captured.sent[0]?.details?.pngPath ?? ""));
    assert.ok(readFileSync(captured.sent[0]?.details?.pngPath ?? "", "utf8").length > 0);
  });

  it("does nothing outside tui mode", async () => {
    const { default: openuiPreviewExtension } = await import("./index");
    const captured: Captured = {
      registeredTypes: [],
      registeredEvents: [],
      transformers: [],
      sent: [],
      handlers: new Map(),
    };
    openuiPreviewExtension(mockPi(captured) as never, { outDir: workDir, htmlshotPath: "/bin/true" });

    captured.handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: `\`\`\`openui-lang\n${SUPPORTED_DSL}\n\`\`\`` }],
        },
      },
      { mode: "print" },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(captured.sent, []);
  });

  it("sends an error message for an unclosed block", async () => {
    const { default: openuiPreviewExtension } = await import("./index");
    const captured: Captured = {
      registeredTypes: [],
      registeredEvents: [],
      transformers: [],
      sent: [],
      handlers: new Map(),
    };
    openuiPreviewExtension(mockPi(captured) as never, { outDir: workDir, htmlshotPath: "/bin/true" });

    captured.handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "```openui-lang\nroot = Stack([" }],
        },
      },
      { mode: "tui" },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(captured.sent.length, 1);
    assert.equal(captured.sent[0]?.details?.kind, "error");
    assert.ok(captured.sent[0]?.details?.message?.includes("closing fence"));
  });

  it("sends a guidance card for unsupported components", async () => {
    const { default: openuiPreviewExtension } = await import("./index");
    const captured: Captured = {
      registeredTypes: [],
      registeredEvents: [],
      transformers: [],
      sent: [],
      handlers: new Map(),
    };
    openuiPreviewExtension(mockPi(captured) as never, { outDir: workDir, htmlshotPath: "/bin/htmlshot", generatedDir: promptFixtureDir });

    const dsl = 'root = Stack([Tabs([TabItem("a", "A", [TextContent("x")])])])';
    captured.handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: `\`\`\`openui-lang\n${dsl}\n\`\`\`` }],
        },
      },
      { mode: "tui" },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(captured.sent.length, 1);
    assert.equal(captured.sent[0]?.details?.kind, "error");
    assert.ok(captured.sent[0]?.details?.message?.includes("preview does not support"));
  });
});
