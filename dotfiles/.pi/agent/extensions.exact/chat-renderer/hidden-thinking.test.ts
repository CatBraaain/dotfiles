import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";

describe("chat-renderer host rendering", () => {
  it("removes hidden thinking gaps while preserving visible content and expanded tools", () => {
    const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        String.raw`
import assert from "node:assert/strict";
import { homedir } from "node:os";
const modules = homedir() + "/.bun/install/global/node_modules";
const agentRoot = modules + "/@earendil-works/pi-coding-agent";
const { createJiti } = await import(modules + "/jiti/lib/jiti.mjs");
const alias = Object.fromEntries(["coding-agent", "tui", "ai", "agent-core"].map(name => [
  "@earendil-works/pi-" + name, modules + "/@earendil-works/pi-" + name + "/dist/index.js",
]));
const jiti = createJiti(import.meta.url, { alias, fsCache: false, moduleCache: true });
const host = await jiti.import(alias["@earendil-works/pi-coding-agent"]);
const tui = await jiti.import(alias["@earendil-works/pi-tui"]);
const themes = await jiti.import(agentRoot + "/dist/modes/interactive/theme/theme.js");
const { InteractiveMode } = await jiti.import(agentRoot + "/dist/modes/interactive/interactive-mode.js");
const extension = await jiti.import(process.argv[1]);
themes.initTheme("purple-dark", false);
const theme = themes.getThemeByName("purple-dark");
assert.ok(theme);
const chat = new tui.Container();
const mode = { chatContainer: chat, ui: { requestRender() {} }, defaultHiddenThinkingLabel: "Thinking..." };
const ui = { theme, setHiddenThinkingLabel(label) { InteractiveMode.prototype.setHiddenThinkingLabel.call(mode, label); } };
const handlers = new Map();
extension.default({ on(name, handler) { handlers.set(name, handler); } });
const thinking = { type: "thinking", thinking: "Visible reasoning" };
const call = { type: "toolCall", id: "call", name: "read", arguments: {} };
function assistant(content, hidden = true) {
  return new host.AssistantMessageComponent({ role: "assistant", content, stopReason: "stop" }, hidden, undefined, mode.hiddenThinkingLabel);
}
function lines(component) {
  return component.render(80).map(tui.stripTerminalSequences).map(line => line.trimEnd());
}
const speech = assistant([{ type: "text", text: "Assistant body" }]);
const visible = assistant([thinking], false);
const speechBefore = lines(speech);
const visibleBefore = lines(visible);
chat.addChild(speech);
chat.addChild(visible);
const originalRender = host.ToolExecutionComponent.prototype.render;
handlers.get("session_start")({}, { mode: "tui", ui });
try {
  assert.notEqual(host.ToolExecutionComponent.prototype.render, originalRender);
  assert.equal(mode.hiddenThinkingLabel, "");
  const speechBox = [...speechBefore, ""];
  const visibleBox = [...visibleBefore, ""];
  assert.deepEqual(lines(speech), speechBox);
  assert.deepEqual(lines(visible), visibleBox);
  const first = new host.ToolExecutionComponent("read", "first", { path: "/project/file" }, {}, extension.renderersOf("read"), mode.ui, "/project");
  const second = new host.ToolExecutionComponent("read", "second", { path: "/project/file" }, {}, extension.renderersOf("read"), mode.ui, "/project");
  first.updateResult({ content: [{ type: "text", text: "details" }], isError: false });
  const expected = [...lines(first), ...lines(second)];
  for (const content of [[], [call], [thinking], [thinking, call]]) {
    const middle = assistant(content);
    chat.children = [first, middle, second];
    assert.deepEqual(lines(middle), [], JSON.stringify(content));
    assert.deepEqual(lines(chat), expected, JSON.stringify(content));
    chat.invalidate();
    assert.deepEqual(lines(chat), expected);
    if (content.includes(thinking)) {
      middle.setHideThinkingBlock(false);
      assert.ok(lines(middle).some(line => line.includes("Visible reasoning")));
      middle.setHideThinkingBlock(true);
      assert.deepEqual(lines(middle), []);
    }
  }
  const mixed = assistant([thinking, { type: "text", text: "Assistant body" }, call]);
  assert.deepEqual(lines(mixed), speechBefore);
  second.setExpanded(true);
  const expanded = lines(second);
  assert.equal(expanded[0], "");
  assert.equal(expanded.at(-1), "");
  assert.ok(expanded.length > 1);
  let codemode;
  host.createCodemodeExtension()({ registerTool(tool) { codemode = tool; } });
  for (const name of ["read", "codemode", "recontext"]) {
    const row = new host.ToolExecutionComponent(name, name, { code: "text(1)", path: "/project/file" }, {}, extension.renderersOf(name, () => name === "codemode" ? codemode : undefined), mode.ui, "/project");
    row.updateResult({ content: [{ type: "text", text: "details" }], details: { reason: "reason", handoff: "handoff" }, isError: false });
    row.setExpanded(true);
    const raw = row.render(80);
    assert.equal(raw[0], "");
    assert.equal(raw.at(-1), "");
    for (const line of [raw[1], raw.at(-2)]) {
      assert.equal(tui.stripTerminalSequences(line).trim(), "");
      assert.ok(line.includes("\x1b[48;"));
    }
    assert.deepEqual(row.render(80), raw);
  }
  chat.children = [first, speech, second];
  assert.deepEqual(lines(chat), [...lines(first), ...speechBox, ...expanded]);
} finally {
  handlers.get("session_shutdown")({}, { mode: "tui", ui });
}
assert.equal(mode.hiddenThinkingLabel, "Thinking...");
assert.equal(host.ToolExecutionComponent.prototype.render, originalRender);
`,
        extensionPath,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }, 30_000);
});
