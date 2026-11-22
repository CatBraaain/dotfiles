import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { firstInputDirectory } from "../../../../.local/cli.exact/pi-mux/src/main.ts";
import { firstInputRoot, registerFirstInputHandoff } from "./first-input-handoff.ts";

describe("warm input selection", () => {
  it("leaves commands, images, steering and noninteractive inputs to Pi", async () => {
    const previous = process.env.PI_TMUX_STARTUP_MODE;
    let input: ((event: InputEvent, ctx: ExtensionContext) => unknown) | undefined;
    try {
      process.env.PI_TMUX_STARTUP_MODE = "warm";
      registerFirstInputHandoff(
        {
          on(event: string, handler: typeof input) {
            if (event === "input") input = handler;
          },
        } as ExtensionAPI,
        async () => assert.fail("Must not request pane ownership"),
      );
    } finally {
      if (previous === undefined) delete process.env.PI_TMUX_STARTUP_MODE;
      else process.env.PI_TMUX_STARTUP_MODE = previous;
    }
    assert.ok(input);
    const ctx = { mode: "tui", hasUI: true } as ExtensionContext;
    const text: InputEvent = { type: "input", source: "interactive", text: "hello" };
    const inputs: InputEvent[] = [
      { ...text, text: "/skill:review" },
      { ...text, text: "!pwd" },
      { ...text, images: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      { ...text, streamingBehavior: "steer" },
      { ...text, source: "rpc" },
      { ...text, source: "extension" },
    ];
    for (const event of inputs) assert.equal(await input(event, ctx), undefined);
    const nested = {
      ...ctx,
      sessionManager: { getSessionId: () => "different-conversation" },
    } as ExtensionContext;
    assert.equal(await input(text, nested), undefined);
  });
});

it("does not launch replacement when the editor already contains another draft", async () => {
  const oldMode = process.env.PI_TMUX_STARTUP_MODE;
  const oldId = process.env.PI_TMUX_SESSION_ID;
  const id = "01234567-0123-4567-8901-012345678901";
  let input: ((event: InputEvent, ctx: ExtensionContext) => unknown) | undefined;
  try {
    process.env.PI_TMUX_STARTUP_MODE = "warm";
    process.env.PI_TMUX_SESSION_ID = id;
    registerFirstInputHandoff(
      {
        on(event: string, handler: typeof input) {
          if (event === "input") input = handler;
        },
      } as ExtensionAPI,
      async () => assert.fail("Must not look up the pane for replacement"),
    );
  } finally {
    if (oldMode === undefined) delete process.env.PI_TMUX_STARTUP_MODE;
    else process.env.PI_TMUX_STARTUP_MODE = oldMode;
    if (oldId === undefined) delete process.env.PI_TMUX_SESSION_ID;
    else process.env.PI_TMUX_SESSION_ID = oldId;
  }
  assert.ok(input);
  let editor = "already present";
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => id, getEntries: () => [] },
    ui: {
      getEditorText: () => editor,
      setEditorText: (text: string) => {
        editor = text;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;
  const result = await input({ type: "input", source: "interactive", text: "submitted" }, ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(editor, "submitted\nalready present");
});

describe("first input storage", () => {
  const id = "01234567-0123-4567-8901-012345678901";

  it("uses the same dedicated directory in both processes on Linux", () => {
    const root = firstInputRoot({ platform: "linux", agentDir: "/home/test/.pi/agent" });
    assert.equal(root, "/home/test/.pi/agent/pi-tmux/first-input");
    assert.equal(firstInputDirectory("/home/test/.pi/agent/pi-tmux", id, "linux"), root + "/" + id);
  });

  it("uses Windows local user data and does not fall back to another directory", () => {
    const localAppData = "C:/Users/Test/AppData/Local";
    const agentDir = "D:/agent";
    const location = { platform: "win32" as const, agentDir };
    const root = firstInputRoot({ ...location, localAppData });
    assert.equal(root, "C:\\Users\\Test\\AppData\\Local\\pi-mux-first-input");
    assert.equal(firstInputDirectory(agentDir, id, "win32", localAppData), root + "\\" + id);
    for (const path of ["", "relative", "\\\\server\\share", "\\rooted"]) {
      assert.equal(firstInputRoot({ ...location, localAppData: path }), undefined);
      assert.equal(firstInputDirectory(agentDir, id, "win32", path), undefined);
    }
  });

  it("rejects non-conversation path components", () => {
    assert.equal(firstInputDirectory("/tmp/test", "../text", "linux"), undefined);
    assert.equal(
      firstInputDirectory("D:/agent", "CON", "win32", "C:/Users/Test/AppData/Local"),
      undefined,
    );
  });
});
