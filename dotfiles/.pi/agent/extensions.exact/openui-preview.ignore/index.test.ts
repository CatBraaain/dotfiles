import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractOpenuiLangBlocks, stripOpenuiLangBlocks } from "./fence";
import openuiPreviewExtension, {
  createQueue,
  renderPreview,
  OPENUI_CUSTOM_TYPE,
  type PreviewDetails,
} from "./index";
import { displayLibrary, displayPromptOptions } from "./library.data";
import type { SnapshotInput } from "./snapshot";

const ONE_BY_ONE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SUPPORTED_DSL = 'root = Stack([TextContent("hello")])';
let workDir: string;
beforeAll(() => {
  mkdirSync("/tmp/work/dotfiles/openui-preview-tests", { recursive: true });
  workDir = mkdtempSync("/tmp/work/dotfiles/openui-preview-tests/index-");
  writeFileSync(join(workDir, "spec.json"), JSON.stringify(displayLibrary.toSpec()));
  writeFileSync(join(workDir, "prompt-options.json"), JSON.stringify(displayPromptOptions));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("extractOpenuiLangBlocks", () => {
  it("extracts a single closed block", () => {
    const text = ["before", "```openui-lang", "root = Stack([])", "```", "after"].join("\n");
    const blocks = extractOpenuiLangBlocks(text);
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
    const blocks = extractOpenuiLangBlocks(text);
    assert.deepEqual(
      blocks.map((block) => block.source),
      ["root = Stack([one])", "root = Stack([two])"],
    );
  });

  it("ignores other language tags", () => {
    const text = ["```html", "<p>x</p>", "```"].join("\n");
    assert.deepEqual(extractOpenuiLangBlocks(text), []);
  });

  it("does not match tags that merely start with openui-lang", () => {
    const text = ["```openui-language", "root = Stack([])", "```"].join("\n");
    assert.deepEqual(extractOpenuiLangBlocks(text), []);
  });

  it("reports an unclosed block", () => {
    const text = ["```openui-lang", "root = Stack([never-closed])"].join("\n");
    const blocks = extractOpenuiLangBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.unclosed, true);
    assert.equal(blocks[0]?.source, "root = Stack([never-closed])");
  });

  it("ignores extra tokens after the openui-lang tag", () => {
    const text = ["```openui-lang card", "root = Stack([])", "```"].join("\n");
    const blocks = extractOpenuiLangBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.source, "root = Stack([])");
  });

  it("returns empty for text without fences", () => {
    assert.deepEqual(extractOpenuiLangBlocks("plain text\nno code"), []);
  });
});

describe("stripOpenuiLangBlocks", () => {
  it("removes closed blocks and keeps surrounding text", () => {
    const text = ["before", "```openui-lang", "root = Stack([])", "```", "after"].join("\n");
    assert.equal(stripOpenuiLangBlocks(text), "before\nafter");
  });

  it("removes an unclosed streaming block up to the end", () => {
    const text = ["intro", "```openui-lang", "root = Stack(["].join("\n");
    assert.equal(stripOpenuiLangBlocks(text), "intro");
  });

  it("keeps other fenced languages", () => {
    const text = ["```html", "<p>x</p>", "```"].join("\n");
    assert.equal(stripOpenuiLangBlocks(text), text);
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

type Handler = (event: unknown, context?: unknown) => unknown;
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type SnapshotExec = ExtensionAPI["exec"];

function capture(exec: SnapshotExec = successfulShot) {
  const entries: Array<{ customType: string; data: PreviewDetails }> = [];
  const entryRenderers: string[] = [];
  const legacyRenderers: string[] = [];
  const messages: unknown[] = [];
  const handlers = new Map<string, Handler>();
  const transformers: Array<(markdown: string, context: { messageType: string }) => string> = [];
  const pending: Promise<unknown>[] = [];
  const queue = createQueue();
  openuiPreviewExtension(
    {
      exec,
      appendEntry(customType: string, data: PreviewDetails) {
        entries.push({ customType, data });
      },
      registerEntryRenderer(type: string) {
        entryRenderers.push(type);
      },
      registerMessageRenderer(type: string) {
        legacyRenderers.push(type);
      },
      registerMarkdownTransformer(transformer: (typeof transformers)[number]) {
        transformers.push(transformer);
      },
      sendMessage(message: unknown) {
        messages.push(message);
      },
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
    {
      outDir: workDir,
      generatedDir: workDir,
      exec,
      enqueue<T>(task: () => Promise<T>): Promise<T> {
        const result = queue(task);
        pending.push(result);
        return result;
      },
    },
  );
  function message(source: string, mode = "tui", role = "assistant", signal?: AbortSignal) {
    const original = { role, content: [{ type: "text", text: source }] };
    const result = handlers.get("message_end")?.(
      { message: original },
      { mode, modelRegistry: {}, signal },
    );
    return { original, result };
  }
  async function drain() {
    await Promise.allSettled(pending);
  }
  return {
    entries,
    entryRenderers,
    legacyRenderers,
    messages,
    handlers,
    transformers,
    message,
    drain,
  };
}

async function successfulShot(_command: string, args: string[]): Promise<ExecResult> {
  const inputPath = args.at(-1)!;
  const input: SnapshotInput = JSON.parse(readFileSync(inputPath, "utf8"));
  writeFileSync(input.pngPath, Buffer.from(ONE_BY_ONE_PNG, "base64"));
  const directory = dirname(inputPath);
  renameSync(join(directory, "pending"), join(directory, "running"));
  writeFileSync(join(directory, "finished.json"), JSON.stringify({ ok: true }));
  return { stdout: "", stderr: "", code: 0, killed: false };
}

function fenced(source = SUPPORTED_DSL): string {
  return `\`\`\`openui-lang\n${source}\n\`\`\``;
}

describe("extension wiring", () => {
  it("uses the allowed cache directory as the default output", async () => {
    const handlers = new Map<string, Handler>();
    let pending: Promise<unknown> = Promise.resolve();
    let pngPath = "";
    const previousHome = process.env.HOME;
    const fixtureHome = join(workDir, "home");
    process.env.HOME = fixtureHome;
    try {
      openuiPreviewExtension(
        {
          exec: successfulShot,
          on(name: string, handler: Handler) {
            handlers.set(name, handler);
          },
          appendEntry(_type: string, data: PreviewDetails) {
            pngPath = data.pngPath ?? "";
          },
          registerEntryRenderer() {},
          registerMessageRenderer() {},
          registerMarkdownTransformer() {},
        } as unknown as ExtensionAPI,
        {
          generatedDir: workDir,
          exec: successfulShot,
          enqueue<T>(task: () => Promise<T>): Promise<T> {
            const result = task();
            pending = result;
            return result;
          },
        },
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    handlers.get("message_end")?.(
      { message: { role: "assistant", content: [{ type: "text", text: fenced() }] } },
      { mode: "tui", modelRegistry: {} },
    );
    await pending;
    assert.equal(
      pngPath.startsWith(join(fixtureHome, ".cache", "pi", "openui-preview") + "/"),
      true,
    );
  });

  it("registers entry rendering and preserves rendering of existing message records", () => {
    const captured = capture();
    assert.deepEqual(captured.entryRenderers, [OPENUI_CUSTOM_TYPE]);
    assert.deepEqual(captured.legacyRenderers, [OPENUI_CUSTOM_TYPE]);
    assert.deepEqual(
      [...captured.handlers.keys()],
      ["resources_discover", "session_shutdown", "message_end"],
    );
  });
  it("registers the generated skill path without injecting a prompt section", () => {
    const captured = capture();
    assert.equal(captured.handlers.has("before_agent_start"), false);
    const resources = captured.handlers.get("resources_discover")?.({ reason: "startup" });
    const skillPath = join(import.meta.dir, "skills", "openui-preview", "SKILL.md");
    assert.deepEqual(resources, { skillPaths: [skillPath] });
    const reloaded = captured.handlers.get("resources_discover")?.({ reason: "reload" });
    assert.deepEqual(reloaded, resources);
  });
  it("removes fences only from the displayed assistant body", () => {
    const captured = capture();
    const transform = captured.transformers[0]!;
    const markdown = `before\n${fenced()}\nafter`;
    assert.equal(transform(markdown, { messageType: "assistant" }), "before\nafter");
    for (const messageType of ["user", "assistant-thinking"]) {
      assert.equal(transform(markdown, { messageType }), markdown);
    }
  });
  it("stores only an entry and leaves the assistant message unchanged", async () => {
    const captured = capture();
    const text = fenced();
    const { original, result } = captured.message(text);
    assert.equal(result, undefined);
    await captured.drain();
    assert.deepEqual(original.content, [{ type: "text", text }]);
    assert.deepEqual(captured.messages, []);
    assert.equal(captured.entries.length, 1);
    const entry = captured.entries[0]!;
    assert.equal(entry.customType, OPENUI_CUSTOM_TYPE);
    assert.deepEqual(Object.keys(entry.data).sort(), ["kind", "pngPath"]);
    assert.equal(entry.data.kind, "image");
    assert.ok(existsSync(entry.data.pngPath!));
  });
  it("does not wait for the shooting process in the message handler", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured = capture(async (command, args) => {
      await gate;
      return successfulShot(command, args);
    });
    assert.equal(captured.message(fenced()).result, undefined);
    assert.equal(captured.entries.length, 0);
    release();
    await captured.drain();
    assert.equal(captured.entries[0]?.data.kind, "image");
  });
  it("ignores non-TUI modes and non-assistant messages", async () => {
    const captured = capture();
    for (const mode of ["print", "json", "rpc"]) captured.message(fenced(), mode);
    captured.message(fenced(), "tui", "user");
    await captured.drain();
    assert.deepEqual(captured.entries, []);
  });
  it("reports an unclosed fence without invoking Bash", async () => {
    let calls = 0;
    const captured = capture(async () => {
      calls += 1;
      return successfulShot("env", []);
    });
    captured.message("```openui-lang\nroot = Stack([");
    await captured.drain();
    assert.match(captured.entries[0]?.data.message ?? "", /closing fence/);
    assert.equal(calls, 0);
  });
  it("reports parser and missing-spec failures as entries", async () => {
    const captured = capture();
    captured.message(fenced('root = Stack([Mystery("x")])'));
    await captured.drain();
    assert.match(captured.entries[0]?.data.message ?? "", /display-only library/);
  });
  it("reports a process launch failure from pi.exec", async () => {
    const captured = capture(async () => {
      throw new Error("process launch failed");
    });
    captured.message(fenced());
    await captured.drain();
    assert.equal(captured.entries[0]?.data.kind, "error");
    assert.match(captured.entries[0]?.data.message ?? "", /process launch failed/);
  });
  it("runs one block at a time and continues after an execution failure", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const captured = capture(async (command, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      try {
        if (calls === 1) return { stdout: "", stderr: "denied", code: 1, killed: false };
        return await successfulShot(command, args);
      } finally {
        active -= 1;
      }
    });
    captured.message(`${fenced()}\n${fenced()}`);
    await captured.drain();
    assert.equal(maxActive, 1);
    assert.equal(calls, 2);
    assert.deepEqual(
      captured.entries.map((entry) => entry.data.kind),
      ["error", "image"],
    );
  });
  it("honors the agent context interruption before publishing", async () => {
    const controller = new AbortController();
    const captured = capture(async (command, args) => {
      const result = await successfulShot(command, args);
      controller.abort(new Error("agent interrupted"));
      return result;
    });
    captured.message(fenced(), "tui", "assistant", controller.signal);
    await captured.drain();
    assert.equal(captured.entries[0]?.data.kind, "error");
    assert.match(captured.entries[0]?.data.message ?? "", /agent interrupted/);
  });

  it("waits for the active shot on shutdown and skips queued shots", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let directory = "";
    let calls = 0;
    const captured = capture(async (command, args) => {
      calls += 1;
      directory = dirname(args.at(-1)!);
      entered();
      await gate;
      return successfulShot(command, args);
    });
    captured.message(`${fenced()}\n${fenced()}`);
    await started;
    let stopped = false;
    const shutdown = Promise.resolve(captured.handlers.get("session_shutdown")?.({})).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    assert.equal(existsSync(join(directory, "cancel")), true);
    release();
    await shutdown;
    assert.equal(calls, 1);
    assert.equal(existsSync(directory), false);
    assert.equal(
      captured.entries.some((entry) => entry.data.kind === "image"),
      false,
    );
  });

  it("does not start a queued shot after immediate shutdown", async () => {
    let calls = 0;
    const captured = capture(async (command, args) => {
      calls += 1;
      return successfulShot(command, args);
    });
    captured.message(fenced());
    await captured.handlers.get("session_shutdown")?.({});
    await captured.drain();
    assert.equal(calls, 0);
    assert.deepEqual(captured.entries, []);
  });
});
