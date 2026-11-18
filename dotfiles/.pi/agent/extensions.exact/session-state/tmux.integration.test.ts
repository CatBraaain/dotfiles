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
const { default: sessionStateExtension } = await import(pathToFileURL(join(moduleDir, "index.ts")));
const { detectManagedPane, stateOptionValue, PANE_OPTION_NAME } = await import(pathToFileURL(join(moduleDir, "tmux.ts")));

const socket = join(process.env.XDG_RUNTIME_DIR, "pi-tmux", "server.sock");
const pane = process.env.TMUX_PANE;
const race = process.env.PI_TEST_RACE === "1";
const recovery = process.env.PI_TEST_RECOVERY === "1";
let sessionId = race ? "race-old" : "session-external";
const notifications = [];
const initializationErrors = [];
const trace = [];
const sandboxCommands = [];
const executions = [];
const bus = createEventBus();
const handlers = new Map();
const tools = new Map();
const commandNames = [];
const { execCommand } = await import(new URL("./core/exec.js", process.env.PI_TEST_SDK_URL));
async function execProcess(command, args, options = {}) {
  const shellCommand = args[1];
  sandboxCommands.push(shellCommand);
  const execution = { command: shellCommand, timeout: options.timeout, started: Date.now() };
  executions.push(execution);
  try {
    const result = await execCommand(command, args, directory, options);
    execution.status = result.killed ? "failed" : "completed";
    execution.result = result;
    return result;
  } finally {
    execution.finished = Date.now();
  }
}
const events = {
  on: bus.on.bind(bus),
  emit(name, data) {
    trace.push(name);
    bus.emit(name, data);
  },
};
const modelRegistry = {};
const pi = {
  getThinkingLevel() { return "off"; },
  events,
  exec: execProcess,
  registerTool(tool) { tools.set(tool.name, tool); },
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
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
    getSessionName() { return current(undefined); },
    getSessionFile() { return current(undefined); },
    getSessionDir() { return current(join(directory, "sessions")); },
  };
  const ui = {
    notify(message) {
      if (message.includes("schema violation")) initializationErrors.push(message);
      else notifications.push(message);
    },
    confirm() { throw new Error("unexpected approval UI"); },
    select() { throw new Error("unexpected approval UI"); },
    input() { throw new Error("unexpected approval UI"); },
  };
  const ctx = {
    get modelRegistry() { return current(modelRegistry); },
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
  if (type === "session_start") {
    const metadata = { id: sessionId, cwd: directory, file: join(directory, "external.jsonl"), pid: process.pid };
    cli("set-option", "-p", "-t", pane, "@pi-tmux-session", Buffer.from(JSON.stringify(metadata)).toString("base64"));
  }
  currentContext = context();
  try {
    for (const handler of handlers.get(type) ?? []) {
      await handler({ type, ...fields }, currentContext.ctx);
    }
    if (type === "session_start") for (const handler of handlers.get("resources_discover") ?? []) await handler({ type: "resources_discover" }, currentContext.ctx);
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
const sessionFirst = process.env.PI_TEST_ORDER === "session-first";
if (!sessionFirst) {
  const { default: toolsExtension } = await import(pathToFileURL(join(moduleDir, "../tools/index.ts")));
  const invalidConfig = join(directory, "invalid-guardrails.yaml");
  writeFileSync(invalidConfig, "read: invalid\n");
  toolsExtension(pi, invalidConfig);
}
sessionStateExtension(pi);
assert.deepEqual(commandNames, []);
const restorePath = join(directory, "pi-tmux", "pi-mux-restore.json");
const before = existsSync(restorePath) ? statSync(restorePath, { bigint: true }) : undefined;
const bytes = before ? readFileSync(restorePath, "utf8") : undefined;

try {
  await dispatch("session_start", { reason: "startup" });
  assert.equal(initializationErrors.length, sessionFirst ? 0 : 1);
  if (!sessionFirst)
    await assert.rejects(tools.get("bash").execute("invalid", {command: "true"}, undefined, undefined, {}), /schema violation/);
  if (race) {
    await waitFor("startup", () => readOption() === stateOptionValue(sessionId, "waiting-user"));
    await dispatch("agent_start");
    await waitFor("old CLI started", () => existsSync(join(directory, "race-started")));
    const count = sandboxCommands.length;
    sessionId = "replacement";
    await dispatch("session_start", { reason: "resume" });
    assert.equal(sandboxCommands.length, count, "new publication waits for the old CLI");
    assert.equal(readOption(), stateOptionValue("race-old", "waiting-user"));
    writeFileSync(join(directory, "race-release"), "release");
    await waitFor("replacement after delayed set", () => readOption() === stateOptionValue(sessionId, "waiting-user"));
    assert.equal(existsSync(join(directory, "race-finished")), true);
    assert.equal(readOption(), stateOptionValue(sessionId, "waiting-user"));
    assert.equal(notifications.length, 0);
    await dispatch("session_shutdown", { reason: "quit" });
    assert.equal(readOption(), "");
  } else if (recovery) {
    process.env.PI_TEST_SOCKET = socket;
    process.env.PI_TEST_PANE = pane;
    await waitFor("startup", () => readOption() === stateOptionValue(sessionId, "waiting-user"));
    await dispatch("agent_start");
    await waitFor("old if-shell accepted by the server", () => existsSync(join(directory, "old-write-started")));
    assert.match(cli("show-messages", "-J"), /old-write-release/);
    await waitFor(
      "inner Bash timeout and recovery warning",
      () => notifications.some((text) => text.includes("publication interrupted")),
    );
    const failed = executions.find((execution) => execution.command.includes(" running "));
    assert.equal(failed.status, "failed");
    assert.equal(failed.timeout, 1_000);
    assert.equal(failed.result.killed, true);
    assert.ok(failed.finished - failed.started >= 1_000);
    await dispatch("agent_settled");
    assert.equal(executions.filter((execution) => execution.command.includes(" running ")).length, 1);
    await waitFor("successful retry followed by queued waiting-user", () => {
      const publications = executions.filter((execution) => execution.command.startsWith("pi-mux state "));
      return publications.length === 4 && publications[3].finished !== undefined;
    });
    const publications = executions.filter((execution) => execution.command.startsWith("pi-mux state "));
    assert.deepEqual(publications.map((execution) => execution.command.split(" ")[3]), [
      "waiting-user", "running", "running", "waiting-user",
    ]);
    const retried = publications[2];
    assert.ok(retried.started - failed.finished >= 1_000);
    assert.equal(retried.command, failed.command);
    for (const execution of [retried, publications[3]]) {
      assert.equal(execution.status, "completed", JSON.stringify(execution));
      assert.equal(execution.result.code, 0);
      assert.equal(execution.result.killed, false);
      assert.notEqual(execution.result.truncated, true);
    }
    assert.ok(publications[3].started >= retried.finished);
    assert.match(cli("show-messages", "-J"), /old-write-release/);
    assert.equal(existsSync(join(directory, "old-job-finished")), false);
    assert.equal(readOption(), stateOptionValue(sessionId, "waiting-user"));
    writeFileSync(join(directory, "old-write-release"), "release");
    await waitFor("old server job retired after waiting-user publication", () =>
      existsSync(join(directory, "old-job-finished")) && !cli("show-messages", "-J").includes("old-write-release"),
    );
    assert.equal(existsSync(join(directory, "old-write-finished")), false);
    assert.equal(readOption(), stateOptionValue(sessionId, "waiting-user"));
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /publication interrupted:.*Process interrupted or timed out.*retrying automatically/);
    await dispatch("session_shutdown", { reason: "quit" });
    assert.equal(readOption(), "");
    assert.equal(notifications.length, 1);
  } else {
    await waitFor("startup", () => readOption() === stateOptionValue(sessionId, "waiting-user"));
    await dispatch("input");
    for (const [type, state] of [
      ["agent_start", "running"],
      ["ui_prompt_start", "waiting-approval"],
      ["ui_prompt_end", "running"],
      ["agent_settled", "waiting-user"],
    ]) {
      await dispatch(type);
      await waitFor(type, () => readOption() === stateOptionValue(sessionId, state));
    }
    await dispatch("agent_start");
    await waitFor("running", () => readOption() === stateOptionValue(sessionId, "running"));
    await waitFor("running process terminal", () => executions.at(-1).finished !== undefined);
    await new Promise(setImmediate);
    const commandsBefore = sandboxCommands.length;
    await dispatch("provider_stream_event");
    await dispatch("tool_execution_update");
    await dispatch("agent_start");
    await delay(20);
    assert.equal(sandboxCommands.length, commandsBefore);
    assert.equal(sandboxCommands.some(command => command.includes("show-options")), false);

    const live = context();
    const captured = {
      modelRegistry: live.ctx.modelRegistry,
      hasUI: true,
      ui: live.ctx.ui,
      model: undefined,
      thinkingLevel: "off",
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    };
    async function run(command) {
      return execProcess("bash", ["-c", command], { timeout: 1000 });
    }
    const [actualSocket, actualServer] = process.env.TMUX.split(",");
    const forged = await detectManagedPane(run, { ...process.env, TMUX: actualSocket + ",99999999" });
    assert.equal(forged.status, "unmanaged", JSON.stringify(forged));
    const child = await detectManagedPane(run, process.env, process.pid + 1);
    assert.equal(child.status, "unmanaged", JSON.stringify(child));
    const callsBefore = sandboxCommands.length;
    const ordinary = await detectManagedPane(run, { ...process.env, TMUX: "/tmp/unrelated.sock,1" });
    assert.equal(ordinary.status, "unmanaged");
    assert.equal(sandboxCommands.length, callsBefore);

    assert.equal(notifications.length, 0);
    await dispatch("session_shutdown", { reason: "quit" });
    assert.equal(readOption(), "");
    assert.equal(notifications.length, 0);
  }
  assert.deepEqual(commandNames, []);
  if (before) {
    const after = statSync(restorePath, { bigint: true });
    assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs]);
    assert.equal(readFileSync(restorePath, "utf8"), bytes);
  } else {
    assert.equal(existsSync(restorePath), false);
  }
  assert.equal(trace.length, 0);
  assert.ok(sandboxCommands.length > 0);
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: true, trace, sandboxCommands, notifications, pane, executions }));
} catch (error) {
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: false, error: String(error.stack ?? error), notifications, trace, sandboxCommands }));
  process.exitCode = 1;
} finally {
  bus.clear();
}
`;

const SDK_TITLE_SCENARIO = String.raw`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const directory = process.env.PI_TEST_DIRECTORY;
const moduleDir = process.env.PI_TEST_MODULE_DIR;
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader } = await import(process.env.PI_TEST_SDK_URL);
const { fakeProvider, fakeModel, memoryRuntime } = await import(pathToFileURL(join(moduleDir, "../recontext/test-fixture.ts")));
const { registerSessionTitle } = await import(pathToFileURL(join(moduleDir, "../session-title/extension.ts")));
const { default: sessionStateExtension } = await import(pathToFileURL(join(moduleDir, "index.ts")));
const socket = join(process.env.XDG_RUNTIME_DIR, "pi-tmux/server.sock");
const pane = process.env.TMUX_PANE;
const title = "Delayed SDK title";
const errors = [];
const sandboxCommands = [];
const executions = [];
function cli(...args) {
  return execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trimEnd();
}
function readOption() {
  return JSON.parse(cli("show-options", "-pqv", "-t", pane, "@pi_session_state") || "null");
}
async function waitFor(label, predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timeout: " + label + "; errors=" + JSON.stringify(errors));
    await delay(10);
  }
}
const runtime = await memoryRuntime();
const fake = fakeProvider("title-share");
fake.state.models = ["parent", "title"].map(id => fakeModel({ provider: "title-share", id }));
const titleStarted = Promise.withResolvers();
const releaseTitle = Promise.withResolvers();
const settled = Promise.withResolvers();
fake.state.beforeReply = async (capture) => {
  if (capture.model.id === "title") {
    titleStarted.resolve();
    await releaseTitle.promise;
  }
  fake.state.normalContent = [{ type: "text", text: capture.model.id === "title" ? title : "Normal reply" }];
};
runtime.registerNativeProvider(fake.provider);
await runtime.refresh({ allowNetwork: false });
const manager = SessionManager.create(directory, join(directory, "sessions"));
const settings = SettingsManager.inMemory({
  compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  defaultTools: [], enableInstallTelemetry: false,
});
const loader = new DefaultResourceLoader({
  cwd: directory, agentDir: directory, settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [
    (pi) => {
      const originalExec = pi.exec.bind(pi);
      pi.exec = async (command, args, options) => {
        const shellCommand = args[1];
        sandboxCommands.push(shellCommand);
        const execution = { command: shellCommand, timeout: options?.timeout, started: Date.now() };
        executions.push(execution);
        try {
          const result = await originalExec(command, args, options);
          execution.status = "completed";
          execution.result = result;
          return result;
        } catch (error) {
          execution.status = "failed";
          execution.error = String(error);
          throw error;
        } finally {
          execution.finished = Date.now();
        }
      };
      sessionStateExtension(pi);
      registerSessionTitle(pi, async () => [runtime.getModel("title-share", "title")]);
      pi.on("agent_settled", () => { settled.resolve(); });
    },
  ],
});
await loader.reload();
const { session } = await createAgentSession({
  cwd: directory, agentDir: directory, modelRuntime: runtime,
  model: runtime.getModel("title-share", "parent"), thinkingLevel: "off",
  settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: [],
});
try {
  const identity = { id: manager.getSessionId(), cwd: directory, file: manager.getSessionFile(), pid: process.pid };
  cli("set-option", "-p", "-t", pane, "@pi-tmux-session", Buffer.from(JSON.stringify(identity)).toString("base64"));
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
  await waitFor("initial state", () => readOption()?.state === "waiting-user");
  assert.equal(readOption().title, null);
  const request = session.prompt("Discuss delayed session titles");
  await settled.promise;
  await titleStarted.promise;
  await waitFor("settled before title", () => readOption()?.state === "waiting-user");
  assert.equal(manager.getSessionName(), undefined);
  assert.equal(readOption().title, null);
  const beforeIdentity = cli("show-options", "-pqv", "-t", pane, "@pi-tmux-session");
  const commandsBeforeTitle = sandboxCommands.length;
  releaseTitle.resolve();
  await request;
  await waitFor("late title publication", () => readOption()?.title === title);
  assert.deepEqual(readOption(), { version: 1, sessionId: identity.id, state: "waiting-user", title });
  assert.ok(sandboxCommands.length > commandsBeforeTitle);
  assert.equal(manager.getSessionName(), title);
  assert.match(readFileSync(identity.file, "utf8"), /"type":"session_info".*"name":"Delayed SDK title"/);
  const cliPath = resolve(moduleDir, "../../../../.local/cli.exact/pi-mux/src/main.ts");
  const listed = JSON.parse(execFileSync(process.execPath, [cliPath, "list"], { encoding: "utf8" }));
  assert.deepEqual(listed, [{ cwd: identity.cwd, sessions: [{ id: identity.id, file: identity.file, state: "waiting-user", title }], empty: [] }]);
  assert.equal(cli("show-options", "-pqv", "-t", pane, "@pi-tmux-session"), beforeIdentity);
  await session.prompt("Continue the same conversation");
  await waitFor("later state retains title", () => readOption()?.state === "waiting-user" && readOption()?.title === title);
  assert.deepEqual(errors, []);
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: true, sandboxCommands, executions }));
} catch (error) {
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: false, error: String(error.stack ?? error), sandboxCommands, executions }));
  process.exitCode = 1;
} finally {
  releaseTitle.resolve();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
`;

describe("session-state with a dedicated headless tmux and pi.exec", () => {
  it(
    "shares a title generated after real SDK settlement without activation or identity changes",
    async () => {
      const result = await runScenario("session-first", false, SDK_TITLE_SCENARIO);
      assert.equal(result.ok, true, result.error ?? "scenario failed");
      assert.ok(result.sandboxCommands.length > 0);
      assert.ok(result.executions.every((execution) => execution.timeout === 1_000));
    },
    TEST_TIMEOUT_MS,
  );
  it(
    "serializes a delayed real tmux set before replacement publication through pi.exec",
    async () => {
      const result = await runScenario("session-first", true);
      assert.equal(result.ok, true, result.error ?? "scenario failed");
    },
    TEST_TIMEOUT_MS,
  );
  for (const order of ["session-first", "tools-first"] as const) {
    for (const initialRestoreRecord of ["absent", "valid", "invalid"] as const) {
      it(
        `uses pi.exec with ${order} shutdown and ${initialRestoreRecord} restore record`,
        async () => {
          const result = await runScenario(order, false, SCENARIO, initialRestoreRecord);
          assert.equal(result.ok, true, result.error ?? "scenario failed");
          assert.ok(result.sandboxCommands.length >= 8);
          assert.ok(result.executions.every((execution) => execution.timeout === 1_000));
        },
        TEST_TIMEOUT_MS,
      );
    }
  }

  it(
    "recovers automatically after a pi.exec timeout and keeps the latest state",
    async () => {
      const result = await runScenario("session-first", false, SCENARIO, "absent", true);
      assert.equal(result.ok, true, result.error ?? "scenario failed");
      assert.ok(result.sandboxCommands.some((command) => command.includes("pi-mux state")));
      console.info("recovery evidence: " + JSON.stringify(result));
    },
    TEST_TIMEOUT_MS,
  );
});

type ScenarioResult = {
  ok: boolean;
  error?: string;
  pane?: string;
  sandboxCommands: string[];
  executions: { command: string; timeout?: number; status?: string; finished?: number }[];
};

async function runScenario(
  order: string,
  race = false,
  scenario = SCENARIO,
  initialRestoreRecord: "absent" | "valid" | "invalid" = "absent",
  recovery = false,
): Promise<ScenarioResult> {
  mkdirSync("/tmp/work/dotfiles", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/mvp-tmux-");
  const runtimeDir = join(directory, "runtime");
  const socketPath = join(runtimeDir, "pi-tmux", "server.sock");
  mkdirSync(join(runtimeDir, "pi-tmux"), { recursive: true });
  const scriptPath = join(directory, "scenario.mjs");
  const reportPath = join(directory, "result.json");
  writeFileSync(scriptPath, scenario);
  if (initialRestoreRecord !== "absent") {
    const restoreDirectory = join(directory, "pi-tmux");
    mkdirSync(restoreDirectory, { recursive: true, mode: 0o700 });
    const bytes =
      initialRestoreRecord === "invalid"
        ? "{broken"
        : JSON.stringify({
            version: 1,
            generation: "saved-generation",
            workspaces: [{ cwd: directory, sessions: ["saved-id"] }],
          });
    writeFileSync(join(restoreDirectory, "pi-mux-restore.json"), bytes);
  }
  const homeDirectory = join(directory, "home");
  mkdirSync(homeDirectory, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDirectory,
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_RUNTIME_DIR: runtimeDir,
    PI_CODING_AGENT_DIR: directory,
    PI_TEST_DIRECTORY: directory,
    PI_TEST_MODULE_DIR: MODULE_DIR,
    PI_TEST_SDK_URL: SDK_URL,
    PI_TEST_ORDER: order,
    PI_TEST_RACE: race ? "1" : "0",
  };
  const bin = join(directory, "bin");
  mkdirSync(bin);
  env.PATH = `${bin}:${env.PATH}`;
  const cliSource = fileURLToPath(
    new URL("../../../../.local/cli.exact/pi-mux/src/main.ts", import.meta.url),
  );
  if (recovery) {
    const actualTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    env.PI_TEST_TMUX = actualTmux;
    env.PI_TEST_RECOVERY = "1";
    const oldValue = JSON.stringify({
      version: 1,
      sessionId: "session-external",
      state: "running",
      title: "Timed out write",
    });
    const delayedJob = [
      `printf started > ${quote([join(directory, "old-write-started")])}`,
      `while [ ! -e ${quote([join(directory, "old-write-release")])} ]; do sleep 0.01; done`,
      `printf finished > ${quote([join(directory, "old-job-finished")])}`,
    ].join("; ");
    const writeFinished = `printf written > ${quote([join(directory, "old-write-finished")])}`;
    const delayedWrite = `set-option -p -t $PI_TEST_PANE @pi_session_state '${oldValue}'; run-shell ${quote([writeFinished])}`;
    const ifShellLine =
      '  exec "$PI_TEST_TMUX" -S "$PI_TEST_SOCKET" if-shell ' +
      quote([delayedJob]) +
      ' "' +
      delayedWrite.replaceAll('"', '\\"') +
      '"';
    writeFileSync(
      join(bin, "pi-mux"),
      [
        "#!/bin/sh",
        'if [ "$1" = state ] && [ "$3" = running ] && [ ! -e "$PI_TEST_DIRECTORY/old-write-scheduled" ]; then',
        '  printf x > "$PI_TEST_DIRECTORY/old-write-scheduled"',
        ifShellLine,
        "fi",
        "exec " + quote([process.execPath, cliSource]) + ' "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  } else {
    writeFileSync(
      join(bin, "pi-mux"),
      "#!/bin/sh\nexec " + quote([process.execPath, cliSource]) + ' "$@"\n',
      { mode: 0o755 },
    );
  }
  if (race) {
    const actualTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    env.PI_TEST_TMUX = actualTmux;
    writeFileSync(
      join(bin, "tmux"),
      [
        "#!/bin/sh",
        `if [ "$5" = source-file ] && [ "$6" = - ]; then`,
        `  input=$(cat)`,
        `  case "$input" in`,
        `    *race-old*running*)`,
        `      printf started > "$PI_TEST_DIRECTORY/race-started"`,
        `      while [ ! -e "$PI_TEST_DIRECTORY/race-release" ]; do sleep 0.01; done`,
        `      printf '%s' "$input" | "$PI_TEST_TMUX" "$@"`,
        `      status=$?`,
        `      printf finished > "$PI_TEST_DIRECTORY/race-finished"`,
        `      exit "$status";;`,
        `  esac`,
        `  printf '%s' "$input" | "$PI_TEST_TMUX" "$@"`,
        `  exit $?`,
        "fi",
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
    assert.equal(result.ok, true, JSON.stringify(result));
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
