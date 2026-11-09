import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { quote } from "shell-quote";
import { describe, it } from "bun:test";

const TEST_TIMEOUT_MS = 30_000;
const SDK_URL = import.meta.resolve("@earendil-works/pi-coding-agent");
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

const SCENARIO = String.raw`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const directory = process.env.PI_TEST_DIRECTORY;
const moduleDir = process.env.PI_TEST_MODULE_DIR;
const { createEventBus } = await import(process.env.PI_TEST_SDK_URL);
const { default: toolsExtension } = await import(pathToFileURL(join(moduleDir, "../tools/index.ts")));
const { default: sessionStateExtension } = await import(pathToFileURL(join(moduleDir, "index.ts")));
const { SandboxRunner } = await import(pathToFileURL(join(moduleDir, "../guardrails/sandbox-runner.ts")));
const { detectManagedPane, phaseOptionValue, PANE_OPTION_NAME } = await import(pathToFileURL(join(moduleDir, "tmux.ts")));
const { requestBackgroundBash } = await import(pathToFileURL(join(moduleDir, "../tools/background-bash.ts")));

const socket = join(process.env.XDG_RUNTIME_DIR, "pi-tmux", "server.sock");
const pane = process.env.TMUX_PANE;
const race = process.env.PI_TEST_RACE === "1";
let sessionId = race ? "race-old" : "session-'quoted-#{pane_id}";
const notifications = [];
const trace = [];
const sandboxCommands = [];
const bus = createEventBus();
const handlers = new Map();
const tools = new Map();
const commandNames = [];
const originalRunTool = SandboxRunner.prototype.runTool;
SandboxRunner.prototype.runTool = async function(name, params, options) {
  assert.equal(name, "bash");
  assert.equal(options.mode, "bash");
  assert.equal(options.executor, undefined);
  assert.ok(this.buildArgs("bash").includes(directory));
  sandboxCommands.push(params.command);
  return originalRunTool.call(this, name, params, options);
};
const events = {
  on: bus.on.bind(bus),
  emit(name, data) {
    trace.push(name);
    bus.emit(name, data);
  },
};
const pi = {
  events,
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name) { commandNames.push(name); },
};
let currentContext;
function context() {
  const state = { live: true };
  function current(value) {
    if (!state.live) throw new Error("stale context was read");
    return value;
  }
  const manager = {
    getCwd() { return current(directory); },
    getSessionId() { return current(sessionId); },
    getSessionFile() { return current(undefined); },
    getSessionDir() { return current(join(directory, "sessions")); },
  };
  const ui = {
    notify(message) { notifications.push(message); },
    confirm() { throw new Error("unexpected approval UI"); },
    select() { throw new Error("unexpected approval UI"); },
    input() { throw new Error("unexpected approval UI"); },
  };
  const ctx = {
    get hasUI() { return current(true); },
    get model() { return current(undefined); },
    get thinkingLevel() { return current("off"); },
    get ui() { return current(ui); },
    get sessionManager() { return current(manager); },
    get signal() { throw new Error("run signal was read"); },
  };
  return { ctx, state };
}
async function dispatch(type, fields = {}) {
  currentContext = context();
  try {
    for (const handler of handlers.get(type) ?? []) {
      await handler({ type, ...fields }, currentContext.ctx);
    }
  } finally {
    currentContext.state.live = false;
  }
}
function cli(...args) {
  return execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trimEnd();
}
function readOption() {
  return cli("show-options", "-p", "-q", "-v", "-t", pane, PANE_OPTION_NAME);
}
async function waitFor(label, predicate) {
  const end = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("timeout: " + label + "; notifications=" + notifications.join(" | "));
    await delay(10);
  }
}
const config = join(directory, "guardrails.yaml");
const denied = process.env.PI_TEST_DENIED === "1";
writeFileSync(config, "read:\n  - allow: \"*\"\nwrite:\n  - allow: " + directory + "\ncommands:\n  - .*:\n      - allow: []\n" + (denied ? "  - tmux:\n      - ask: []\n" : ""));
const sessionFirst = process.env.PI_TEST_ORDER === "session-first";
if (sessionFirst) sessionStateExtension(pi);
toolsExtension(pi, config);
if (!sessionFirst) sessionStateExtension(pi);
assert.deepEqual(commandNames, []);

try {
  await dispatch("session_start", { reason: "startup" });
  if (race) {
    await waitFor("startup", () => readOption() === phaseOptionValue(sessionId, "waiting-user"));
    await dispatch("agent_start");
    await waitFor("old CLI started", () => existsSync(join(directory, "race-started")));
    const count = sandboxCommands.length;
    sessionId = "replacement";
    await dispatch("session_start", { reason: "resume" });
    assert.equal(sandboxCommands.length, count, "new publication waits for the old CLI");
    assert.equal(readOption(), phaseOptionValue("race-old", "waiting-user"));
    writeFileSync(join(directory, "race-release"), "release");
    await waitFor("replacement after delayed set", () => readOption() === phaseOptionValue(sessionId, "waiting-user"));
    assert.equal(existsSync(join(directory, "race-finished")), true);
    assert.equal(readOption(), phaseOptionValue(sessionId, "waiting-user"));
    assert.equal(notifications.length, 0);
    await dispatch("session_shutdown", { reason: "quit" });
    assert.equal(readOption(), "");
  } else if (denied) {
    await waitFor("denied notification", () => notifications.some((text) => text.includes("requires confirmation")));
    assert.equal(sandboxCommands.length, 0);
    assert.equal(readOption(), "");
    await dispatch("input");
    await waitFor("membership", () => existsSync(join(directory, "session-state.json")));
    await dispatch("session_shutdown", { reason: "quit" });
  } else {
    await waitFor("startup", () => readOption() === phaseOptionValue(sessionId, "waiting-user"));
    assert.equal(existsSync(join(directory, "session-state.json")), false);
    await dispatch("input");
    await waitFor("membership", () => existsSync(join(directory, "session-state.json")));
    const storePath = join(directory, "session-state.json");
    const before = statSync(storePath, { bigint: true });
    const bytes = readFileSync(storePath, "utf8");
    for (const [type, phase] of [
      ["agent_start", "running"],
      ["ui_prompt_start", "waiting-approval"],
      ["ui_prompt_end", "running"],
      ["agent_settled", "waiting-user"],
    ]) {
      await dispatch(type);
      await waitFor(type, () => readOption() === phaseOptionValue(sessionId, phase));
    }
    await dispatch("agent_start");
    await waitFor("running", () => readOption() === phaseOptionValue(sessionId, "running"));
    const commandsBefore = sandboxCommands.length;
    await dispatch("provider_stream_event");
    await dispatch("tool_execution_update");
    await dispatch("agent_start");
    await delay(20);
    assert.equal(sandboxCommands.length, commandsBefore);
    assert.equal(sandboxCommands.some(command => command.includes("show-options")), false);
    const after = statSync(storePath, { bigint: true });
    assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs]);
    assert.equal(readFileSync(storePath, "utf8"), bytes);

    const live = context();
    const captured = {
      hasUI: true,
      ui: live.ctx.ui,
      model: undefined,
      thinkingLevel: "off",
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    };
    async function run(command) {
      return requestBackgroundBash(events, { id: "test-detect", params: { command }, context: captured });
    }
    const [actualSocket, actualServer] = process.env.TMUX.split(",");
    const forged = await detectManagedPane(run, { ...process.env, TMUX: actualSocket + ",99999999" });
    assert.equal(forged.status, "unmanaged");
    const child = await detectManagedPane(run, process.env, process.pid + 1);
    assert.equal(child.status, "unmanaged");
    const callsBefore = sandboxCommands.length;
    const ordinary = await detectManagedPane(run, { ...process.env, TMUX: "/tmp/unrelated.sock,1" });
    assert.equal(ordinary.status, "unmanaged");
    assert.equal(sandboxCommands.length, callsBefore);

    assert.equal(notifications.length, 0);
    await dispatch("session_shutdown", { reason: "quit" });
    if (sessionFirst) {
      assert.equal(readOption(), "");
      assert.equal(notifications.length, 0);
    } else {
      assert.ok(notifications.some((text) => text.includes("publication stopped")));
    }
    assert.equal(readFileSync(storePath, "utf8"), bytes);
  }
  assert.ok(trace.length > 0);
  assert.ok(trace.every(name => name === "tools:execute-bash"));
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: true, trace, sandboxCommands, notifications, pane }));
} catch (error) {
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: false, error: String(error.stack ?? error), notifications, trace, sandboxCommands }));
  process.exitCode = 1;
} finally {
  SandboxRunner.prototype.runTool = originalRunTool;
  bus.clear();
}
`;

describe("session-state with a dedicated headless tmux and real registered Bash", () => {
  it(
    "serializes a delayed real tmux set before replacement publication through the sandbox",
    async () => {
      const result = await runScenario("session-first", false, true);
      assert.equal(result.ok, true, result.error ?? "scenario failed");
    },
    TEST_TIMEOUT_MS,
  );
  for (const order of ["session-first", "tools-first"] as const) {
    it(
      `uses the Bash-only entrance and real sandbox with ${order} shutdown`,
      async () => {
        const result = await runScenario(order, false);
        assert.equal(result.ok, true, result.error ?? "scenario failed");
        assert.ok(result.sandboxCommands.length >= 8);
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "fails closed at shared authorization without opening UI",
    async () => {
      const result = await runScenario("tools-first", true);
      assert.equal(result.ok, true, result.error ?? "scenario failed");
      assert.equal(result.sandboxCommands.length, 0);
    },
    TEST_TIMEOUT_MS,
  );
});

type ScenarioResult = {
  ok: boolean;
  error?: string;
  pane?: string;
  sandboxCommands: string[];
};

async function runScenario(order: string, denied: boolean, race = false): Promise<ScenarioResult> {
  mkdirSync("/tmp/work/dotfiles", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/mvp-tmux-");
  const runtimeDir = join(directory, "runtime");
  const socketPath = join(runtimeDir, "pi-tmux", "server.sock");
  mkdirSync(join(runtimeDir, "pi-tmux"), { recursive: true });
  const scriptPath = join(directory, "scenario.mjs");
  const reportPath = join(directory, "result.json");
  writeFileSync(scriptPath, SCENARIO);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    PI_CODING_AGENT_DIR: directory,
    PI_TEST_DIRECTORY: directory,
    PI_TEST_MODULE_DIR: MODULE_DIR,
    PI_TEST_SDK_URL: SDK_URL,
    PI_TEST_ORDER: order,
    PI_TEST_DENIED: denied ? "1" : "0",
    PI_TEST_RACE: race ? "1" : "0",
  };
  if (race) {
    const actualTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    const bin = join(directory, "bin");
    mkdirSync(bin);
    env.PI_TEST_TMUX = actualTmux;
    env.PATH = `${bin}:${env.PATH}`;
    writeFileSync(
      join(bin, "tmux"),
      [
        "#!/bin/sh",
        `case "$*" in`,
        `  *'"sessionId":"race-old","phase":"running"'*)`,
        `    printf started > "$PI_TEST_DIRECTORY/race-started"`,
        `    while [ ! -e "$PI_TEST_DIRECTORY/race-release" ]; do sleep 0.01; done`,
        `    "$PI_TEST_TMUX" "$@"`,
        `    status=$?`,
        `    printf finished > "$PI_TEST_DIRECTORY/race-finished"`,
        `    exit "$status";;`,
        "esac",
        `exec "$PI_TEST_TMUX" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  delete env.TMUX;
  delete env.TMUX_PANE;
  function cli(...args: string[]): string {
    return execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8", env }).trimEnd();
  }
  try {
    cli("-f", "/dev/null", "new-session", "-d", "-s", "fixture", "sleep 60");
    cli("set-option", "-g", "@pi_session_state", "global-inherited-value");
    cli("set-option", "-t", "fixture", "@pi_session_state", "session-inherited-value");
    cli("set-option", "-w", "-t", "fixture", "@pi_session_state", "window-inherited-value");
    const target = cli(
      "new-window",
      "-d",
      "-P",
      "-t",
      "fixture",
      `exec ${quote([process.execPath, scriptPath])}`,
    );
    const pane = cli("display-message", "-p", "-t", target, "#{pane_id}");
    const deadline = Date.now() + TEST_TIMEOUT_MS - 1_000;
    while (!existsSync(reportPath)) {
      if (Date.now() >= deadline) {
        const screen = cli("capture-pane", "-p", "-t", pane);
        assert.fail(`scenario timed out: ${screen}`);
      }
      await delay(20);
    }
    const result = JSON.parse(readFileSync(reportPath, "utf8")) as ScenarioResult;
    assert.equal(result.ok, true, result.error ?? "scenario failed");
    while (cli("list-panes", "-a").split("\n").length > 1) {
      if (Date.now() >= deadline) assert.fail("pane did not disappear after normal process exit");
      await delay(10);
    }
    assert.equal(cli("show-options", "-g", "-v", "@pi_session_state"), "global-inherited-value");
    return result;
  } finally {
    try {
      cli("kill-server");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
