import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";
import { quote } from "shell-quote";
import { parseOperation } from "../../../../.local/cli.exact/pi-mux/src/main.ts";

type Outcome = { out: string; err: string; code: number };
type Pane = {
  id: string;
  file: string;
  cwd: string;
  pid: number;
  pane: string;
  session: string;
  startup: "accepted" | "ready";
};
type Input = { id: string; text: string; source: string; images?: unknown[] };
type Prompt = { id: string; prompt: string; images?: unknown[] };
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CLI =
  process.env.PI_MUX_TEST_CLI ??
  resolve(EXTENSION_DIR, "../../../../.local/cli.exact/pi-mux/src/main.ts");
const CLI_COMMAND = CLI.endsWith(".ts") ? [process.execPath, CLI] : [CLI];
const TIMEOUT_MS = 60_000;

async function fixture(test: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try {
    await test(f);
  } finally {
    writeFileSync(join(f.root, "has-released"), "");
    writeFileSync(join(f.root, "create-released"), "");
    writeFileSync(join(f.root, "startup-released"), "");
    writeFileSync(join(f.root, "command-released"), "");
    await f.tmux(["kill-server"]);
    await f.tmux(["kill-server"], f.outer);
  }
}

async function createFixture() {
  const parent = process.env.TMPDIR || "/tmp/work/dotfiles";
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "pi-mux-regression-"));
  const agent = join(root, "agent");
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  const bin = join(root, "bin");
  const cwdA = join(root, "cwd-a");
  const cwdB = join(root, "cwd-b");
  const outer = join(root, "outer.sock");
  const socket = join(runtime, "pi-tmux/server.sock");
  for (const path of [
    join(agent, "extensions"),
    runtime,
    bin,
    cwdA,
    cwdB,
    join(home, ".config/tmux"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  symlinkSync(EXTENSION_DIR, join(agent, "extensions/pi-mux-bridge"));
  copyFileSync(
    resolve(EXTENSION_DIR, "../../../../tmux/pi.conf"),
    join(home, ".config/tmux/pi.conf"),
  );
  symlinkSync(resolve(EXTENSION_DIR, "../../node_modules"), join(agent, "node_modules"));
  const guardrails = join(root, "guardrails.yaml");
  writeFileSync(
    guardrails,
    `read:\n  - allow: "*"\nwrite:\n  - allow: ${JSON.stringify(root)}\ncommands:\n  - ".*":\n      - allow: []\n`,
  );
  writeFileSync(
    join(agent, "extensions/fixture-tools.ts"),
    `import tools from ${JSON.stringify(resolve(EXTENSION_DIR, "../tools/index.ts"))};\nexport default function (pi) { tools(pi, ${JSON.stringify(guardrails)}); }\n`,
  );
  writeFileSync(
    join(agent, "extensions/observer.ts"),
    `
import { appendFileSync, existsSync } from "node:fs";
export default function (pi) {
  function record(kind, payload) {
    appendFileSync(${JSON.stringify(join(root, "events.jsonl"))}, JSON.stringify({ kind, payload }) + "\\n");
  }
  pi.registerFlag("agent", { type: "string", description: "Fixture agent" });
  pi.on("input", (event, ctx) => {
    record("input", event.text);
    appendFileSync(${JSON.stringify(join(root, "inputs.jsonl"))}, JSON.stringify({ id: ctx.sessionManager.getSessionId(), text: event.text, source: event.source, images: event.images }) + "\\n");
    if (!event.text.startsWith("/skill:") && event.text.includes("fixture-initial")) return { action: "handled" };
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event, ctx) => {
    appendFileSync(${JSON.stringify(join(root, "prompts.jsonl"))}, JSON.stringify({ id: ctx.sessionManager.getSessionId(), prompt: event.prompt, images: event.images }) + "\\n");
  });
  pi.registerCommand("fixture-initial-command", { async handler(args, ctx) {
    appendFileSync(${JSON.stringify(join(root, "commands.jsonl"))}, JSON.stringify({ id: ctx.sessionManager.getSessionId(), args }) + "\\n");
    if (args === "blocked") while (!existsSync(${JSON.stringify(join(root, "command-released"))})) await new Promise((resolve) => setTimeout(resolve, 25));
  }});
  pi.on("resources_discover", (_event, ctx) => {
    appendFileSync(${JSON.stringify(join(root, "discovered.jsonl"))}, JSON.stringify({ id: ctx.sessionManager.getSessionId() }) + "\\n");
  });
  pi.on("before_provider_request", () => { record("provider", null); });
  pi.on("tool_call", (event) => { record("tool", event.toolName); });
}
`,
  );
  const realPi = Bun.which("pi");
  assert.ok(realPi, "pi is required");
  writeFileSync(
    join(bin, "pi"),
    `#!/bin/sh
if test -f ${quote([join(root, "fail-startup")])}; then
  failed=$(cat ${quote([join(root, "fail-startup")])})
  case "$*" in *"$failed"*) exit 42 ;; esac
fi
printf '%s\\0' "$@" > ${quote([join(root, "argv-")])}"$$"
exec ${quote([realPi])} "$@" 2>>${quote([join(root, "pi-stderr.log")])}
`,
  );
  chmodSync(join(bin, "pi"), 0o700);
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture",
      defaultProjectTrust: "never",
      quietStartup: true,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 10000,
              maxTokens: 100,
            },
          ],
        },
      },
    }),
  );
  const realTmux = Bun.which("tmux");
  assert.ok(realTmux, "tmux is required");
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/sh
case "$*" in
  *"has-session -t =pi-empty"*)
    if test "$TEST_PAUSE_HAS" = 1; then
      ${quote([realTmux])} "$@"; code=$?
      if test "$code" = 0 && ! test -f ${quote([join(root, "has-released")])}; then
        touch ${quote([join(root, "has-ready")])}
        while ! test -f ${quote([join(root, "has-released")])}; do sleep 0.02; done
      fi
      exit "$code"
    fi ;;
  *"new-session"*)
    if test "$TEST_PAUSE_CREATE" = 1; then
      touch ${quote([join(root, "create-ready")])}
      while ! test -f ${quote([join(root, "create-released")])}; do sleep 0.02; done
    fi ;;
esac
exec ${quote([realTmux])} "$@"
`,
  );
  chmodSync(join(bin, "tmux"), 0o700);
  const env = {
    PATH: bin + ":" + process.env.PATH!,
    HOME: home,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: runtime,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  const outerConfig = join(root, "outer.conf");
  writeFileSync(outerConfig, "set -g exit-empty off\nset -g exit-unattached off\n");

  async function run(
    args: string[],
    cwd = cwdB,
    extra: Record<string, string> = {},
  ): Promise<Outcome> {
    const child = launch(args, cwd, extra);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  }

  function launch(args: string[], cwd = cwdB, extra: Record<string, string> = {}) {
    return Bun.spawn([...CLI_COMMAND, ...args], {
      cwd,
      env: { ...env, ...extra },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  function snapshot() {
    return JSON.parse(readFileSync(join(agent, "pi-tmux/pi-mux-restore.json"), "utf8")) as {
      version: number;
      generation: string;
      workspaces: { cwd: string; sessions: string[] }[];
    };
  }

  function snapshotCandidates() {
    return snapshot().workspaces.flatMap((workspace) =>
      workspace.sessions.map((id) => ({ id, cwd: workspace.cwd })),
    );
  }

  function seed(candidates: { id: string; cwd: string }[]) {
    const workspaces = new Map<string, { cwd: string; sessions: string[] }>();
    for (const { id, cwd } of candidates) {
      let workspace = workspaces.get(cwd);
      if (!workspace) {
        workspace = { cwd, sessions: [] };
        workspaces.set(cwd, workspace);
      }
      workspace.sessions.push(id);
    }
    mkdirSync(join(agent, "pi-tmux"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(agent, "pi-tmux/pi-mux-restore.json"),
      JSON.stringify({
        version: 1,
        generation: "previous-server",
        workspaces: [...workspaces.values()],
      }),
    );
  }

  function saved(id: string, cwd = cwdA) {
    const group = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
    const file = join(agent, "sessions", group, "fixture_" + id + ".jsonl");
    mkdirSync(dirname(file), { recursive: true });
    const timestamp = new Date().toISOString();
    const entries = [
      { type: "session", version: 3, id, timestamp, cwd },
      {
        type: "message",
        id: "11111111",
        parentId: null,
        timestamp,
        message: { role: "user", content: "fixture saved user message", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "22222222",
        parentId: "11111111",
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "old-call",
              name: "bash",
              arguments: { command: "touch should-not-run" },
            },
          ],
          api: "openai-completions",
          provider: "fixture",
          model: "fixture",
          stopReason: "toolUse",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        },
      },
    ];
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return file;
  }

  function events(): { kind: string; payload: unknown }[] {
    const file = join(root, "events.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }

  function records<T>(name: string): T[] {
    const path = join(root, name + ".jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }

  async function standard(request: string, cwd = cwdA): Promise<string> {
    const id = randomUUID();
    const result = await tmux([
      "new-session",
      "-d",
      "-s",
      "standard-" + id,
      "-c",
      cwd,
      "--",
      "/usr/bin/env",
      "-i",
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      join(bin, "pi"),
      "--session-id",
      id,
      "--agent",
      "main",
      "--",
      request,
    ]);
    assert.equal(result.code, 0, result.err);
    return id;
  }

  async function tmux(args: string[], target = socket): Promise<Outcome> {
    const child = Bun.spawn([realTmux!, "-S", target, ...args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  }

  async function panes(): Promise<Pane[]> {
    const result = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_id}\t#{@pi-tmux-session}",
    ]);
    if (result.code !== 0) return [];
    return result.out
      .trimEnd()
      .split("\n")
      .flatMap((line) => {
        const [pane, session, encoded] = line.split("\t");
        if (!encoded) return [];
        return [{ ...JSON.parse(Buffer.from(encoded, "base64").toString()), pane, session }];
      });
  }

  async function client(
    name: string,
    args: string[],
    cwd = cwdB,
    extra: Record<string, string> = {},
  ) {
    const command = quote([
      "env",
      "-i",
      ...Object.entries({ ...env, ...extra }).map(([key, value]) => `${key}=${value}`),
      ...CLI_COMMAND,
      ...args,
    ]);
    const script = `${command} 2>${quote([join(root, name + ".err")])}; code=$?; printf '%s' "$code" > ${quote([join(root, name + ".code")])}; sleep 30`;
    const result = await tmux(
      [
        "-f",
        outerConfig,
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        "-x",
        "110",
        "-y",
        "32",
        "--",
        "/bin/sh",
        "-c",
        script,
      ],
      outer,
    );
    assert.equal(result.code, 0, result.err);
  }

  async function persist(pane: Pane) {
    await tmux(["send-keys", "-t", pane.pane, "-l", "regression user message"]);
    await tmux(["send-keys", "-t", pane.pane, "Enter"]);
    await waitFor(() =>
      existsSync(pane.file) && readFileSync(pane.file, "utf8").includes("regression user message")
        ? true
        : undefined,
    );
  }

  async function detachAll(expectedClients = 1) {
    const names = await waitFor(async () => {
      const result = await tmux(["list-clients", "-F", "#{client_name}"]);
      const connected = result.out.trim().split("\n").filter(Boolean);
      return connected.length >= expectedClients ? connected : undefined;
    });
    for (const name of names) await tmux(["detach-client", "-t", name]);
  }

  async function exitCode(name: string) {
    return await waitFor(() => {
      const path = join(root, name + ".code");
      return existsSync(path) ? Number(readFileSync(path, "utf8")) : undefined;
    });
  }

  return {
    root,
    env,
    bin,
    launch,
    snapshot,
    snapshotCandidates,
    seed,
    saved,
    events,
    records,
    standard,
    agent,
    runtime,
    socket,
    outer,
    cwdA,
    cwdB,
    run,
    tmux,
    panes,
    client,
    persist,
    detachAll,
    exitCode,
  };
}

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for the isolated pi fixture");
}

type MuxFixture = Awaited<ReturnType<typeof createFixture>>;

function enableStatePublisher(f: MuxFixture): void {
  writeFileSync(
    join(f.agent, "extensions/session-state.ts"),
    `export { default } from ${JSON.stringify(resolve(EXTENSION_DIR, "../session-state/index.ts"))};\n`,
  );
  writeFileSync(join(f.bin, "pi-mux"), "#!/bin/sh\nexec " + quote(CLI_COMMAND) + ' "$@"\n', {
    mode: 0o700,
  });
}

async function notificationSource(f: MuxFixture, pane: Pick<Pane, "pane" | "pid">) {
  const server = await f.tmux(["display-message", "-p", "-t", pane.pane, "#{pid}"]);
  const serverPid = Number(server.out.trim());
  const launch = await f.tmux(["show-options", "-pqv", "-t", pane.pane, "@pi-mux-launch"]);
  const metadata = await f.tmux(["show-options", "-pqv", "-t", pane.pane, "@pi-tmux-session"]);
  const token =
    launch.out.trim() !== ""
      ? JSON.parse(launch.out.trim()).token
      : JSON.parse(Buffer.from(metadata.out.trim(), "base64").toString("utf8")).token;
  return {
    socket: f.socket,
    serverPid,
    pane: pane.pane,
    pid: pane.pid,
    token,
  };
}

async function listedSession(f: MuxFixture, id: string) {
  const result = await f.run(["list"]);
  assert.equal(result.code, 0, result.err);
  const workspaces = JSON.parse(result.out) as {
    cwd: string;
    sessions: { id: string; state: string | null; title: string | null; temporary?: true }[];
  }[];
  return workspaces.flatMap((workspace) => workspace.sessions).find((session) => session.id === id);
}

async function firstPane(f: Awaited<ReturnType<typeof createFixture>>): Promise<Pane> {
  return await waitFor(async () => (await f.panes())[0]);
}

function processEnvironment(pid: number): string[] {
  return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
}

async function publishedIdlePane(
  f: Awaited<ReturnType<typeof createFixture>>,
  startup: "legacy" | "accepted" | "ready" = "ready",
  id = "live-id",
) {
  mkdirSync(dirname(f.socket), { recursive: true, mode: 0o700 });
  const created = await f.tmux([
    "-f",
    join(f.root, "outer.conf"),
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}\t#{pane_pid}",
    "-s",
    "listed-" + id,
    "-c",
    f.cwdA,
    "--",
    "sleep",
    "120",
  ]);
  assert.equal(created.code, 0, created.err);
  const [pane, pid] = created.out.trim().split("\t");
  assert.ok(pane);
  const file = join(f.agent, "sessions", id + ".jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      cwd: f.cwdA,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  const metadata = {
    id,
    cwd: f.cwdA,
    file,
    pid: Number(pid),
    token: randomUUID(),
    ...(startup === "legacy" ? {} : { startup }),
  };
  const published = await f.tmux([
    "set-option",
    "-p",
    "-t",
    pane,
    "@pi-tmux-session",
    Buffer.from(JSON.stringify(metadata)).toString("base64"),
  ]);
  assert.equal(published.code, 0, published.err);
  return { pane, metadata };
}

describe("pi-mux dedicated tmux settings", () => {
  const expectedOptions = [
    ["-g", "status", "off"],
    ["-g", "prefix", "None"],
    ["-g", "set-titles", "on"],
    ["-g", "set-titles-string", "#{pane_title}"],
    ["-s", "extended-keys", "on"],
    ["-s", "extended-keys-format", "csi-u"],
    ["-g", "mouse", "on"],
  ] as const;
  const shiftEnterBinding = "bind-key -T root S-Enter send-keys -H 1b 5b 31 33 3b 32 75";

  it(
    "applies the dedicated settings on detached launch without changing another server",
    async () => {
      await fixture(async (f) => {
        writeFileSync(join(f.env.HOME, ".tmux.conf"), "set -g @normal-config loaded\n");
        const outer = await f.tmux(["-f", join(f.root, "outer.conf"), "start-server"], f.outer);
        assert.equal(outer.code, 0, outer.err);
        const before = await f.tmux(["show-options", "-g"], f.outer);
        const keysBefore = await f.tmux(["list-keys", "-T", "root"], f.outer);
        const result = await f.run(["new", "--detached"]);
        assert.equal(result.code, 0, result.err);
        for (const [scope, option, expected] of expectedOptions) {
          const actual = await f.tmux(["show-options", scope + "v", option]);
          assert.equal(actual.code, 0, actual.err);
          assert.equal(actual.out.trim(), expected, option);
        }
        const binding = await f.tmux(["list-keys", "-T", "root", "S-Enter"]);
        assert.equal(binding.code, 0, binding.err);
        assert.equal(binding.out.trim().replace(/\s+/g, " "), shiftEnterBinding);
        assert.equal((await f.tmux(["show-options", "-gqv", "@normal-config"])).out, "");
        assert.equal((await f.tmux(["show-options", "-g"], f.outer)).out, before.out);
        assert.equal((await f.tmux(["list-keys", "-T", "root"], f.outer)).out, keysBefore.out);
      });
    },
    TIMEOUT_MS,
  );

  for (const operation of ["new", "open", "restore"]) {
    it(
      "reapplies settings to the existing dedicated server on " + operation,
      async () => {
        await fixture(async (f) => {
          const started = await f.run(["new", "--detached"]);
          assert.equal(started.code, 0, started.err);
          const pane = await firstPane(f);
          const generation = (await f.tmux(["show-options", "-gqv", "@pi-mux-generation"])).out;
          for (const [scope, option, changed] of [
            ["-g", "status", "on"],
            ["-g", "prefix", "C-b"],
            ["-g", "set-titles", "off"],
            ["-g", "set-titles-string", "changed"],
            ["-s", "extended-keys", "off"],
            ["-s", "extended-keys-format", "xterm"],
          ]) {
            const changedOption = await f.tmux(["set-option", scope!, option!, changed!]);
            assert.equal(changedOption.code, 0, changedOption.err);
          }
          assert.equal((await f.tmux(["unbind-key", "-n", "S-Enter"])).code, 0);
          if (operation === "open") {
            await f.client("reapply-open", ["open", pane.id]);
            await waitFor(async () =>
              (await f.tmux(["list-clients", "-F", "#{client_name}"])).out.trim()
                ? true
                : undefined,
            );
          } else {
            const result = await f.run(operation === "new" ? ["new", "--detached"] : ["restore"]);
            assert.equal(result.code, 0, result.err);
          }
          for (const [scope, option, expected] of expectedOptions) {
            const actual = await f.tmux(["show-options", scope + "v", option]);
            assert.equal(actual.code, 0, actual.err);
            assert.equal(actual.out.trim(), expected, option);
          }
          const binding = await f.tmux(["list-keys", "-T", "root", "S-Enter"]);
          assert.equal(binding.out.trim().replace(/\s+/g, " "), shiftEnterBinding);
          assert.equal(
            (await f.tmux(["show-options", "-gqv", "@pi-mux-generation"])).out,
            generation,
          );
          if (operation === "open") {
            await f.detachAll();
            assert.equal(await f.exitCode("reapply-open"), 0);
          }
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const [before, after, error] of [
    [
      "set -sq extended-keys-format csi-u",
      "set -sq extended-keys-format invalid",
      "unknown value: invalid",
    ],
    ["set -g status off", "set -g status invalid", "unknown value: invalid"],
    ["set -g status off", "set -g unrelated-option off", "invalid option: unrelated-option"],
    ["bind-key -n S-Enter", "bind-key -n unrelated-key", "unknown key: unrelated-key"],
    ["send-keys -H", "send-keys -UnsupportedFlag", "unknown flag -U"],
  ]) {
    it(
      "propagates configuration errors through source-file: " + after,
      async () => {
        await fixture(async (f) => {
          const config = join(f.env.HOME, ".config/tmux/pi.conf");
          const original = readFileSync(config, "utf8");
          assert.ok(original.includes(before!));
          writeFileSync(config, original.replace(before!, after!));
          const result = await f.run(["restore"]);
          assert.equal(result.code, 1);
          assert.ok(result.err.includes(error!), result.err);
          assert.equal((await f.tmux(["show-options", "-gqv", "@pi-mux-generation"])).out, "");
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const [version, variable, hasBinding] of [
    ["2.9a", "PI_MUX_TEST_TMUX_29", false],
    ["3.0a", "PI_MUX_TEST_TMUX_30", true],
    ["3.4", "PI_MUX_TEST_TMUX_34", true],
  ] as const) {
    const binary = process.env[variable];
    it.skipIf(!binary)(
      "loads the compatibility declarations with tmux " + version,
      async () => {
        await fixture(async (f) => {
          const socket = join(f.root, "legacy.sock");
          async function legacy(args: string[]): Promise<Outcome> {
            const child = Bun.spawn([binary!, "-S", socket, ...args], {
              env: f.env,
              stdout: "pipe",
              stderr: "pipe",
            });
            const [out, err, code] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            return { out, err, code };
          }
          const config = readFileSync(join(f.env.HOME, ".config/tmux/pi.conf"), "utf8");
          const declarations = config
            .split("\n")
            .filter(
              (line) =>
                line.startsWith("set -sq extended-keys-format ") || line.startsWith("if-shell "),
            );
          assert.equal(declarations.length, 2);
          const compatibility = join(f.root, "compatibility.conf");
          writeFileSync(compatibility, declarations.join("\n") + "\n");
          try {
            const started = await legacy(["-f", join(f.root, "outer.conf"), "start-server"]);
            assert.equal(started.code, 0, started.err);
            const loaded = await legacy(["source-file", compatibility]);
            assert.equal(loaded.code, 0, loaded.err);
            assert.equal(loaded.err, "");
            const options = await legacy(["show-options", "-s"]);
            assert.equal(options.code, 0, options.err);
            assert.ok(!options.out.includes("extended-keys-format"));
            const bindings = await legacy(["list-keys", "-T", "root"]);
            assert.equal(bindings.code, 0, bindings.err);
            const binding = bindings.out.split("\n").find((line) => line.includes("S-Enter"));
            assert.equal(
              binding?.trim().replace(/\s+/g, " "),
              hasBinding ? shiftEnterBinding : undefined,
            );
          } finally {
            await legacy(["kill-server"]);
          }
        });
      },
      TIMEOUT_MS,
    );
  }
});

function fixtureEntries(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => [
      entry.name,
      ...(entry.isDirectory()
        ? fixtureEntries(join(directory, entry.name)).map((child) => join(entry.name, child))
        : []),
    ])
    .sort();
}

describe("pi-mux workspace list", () => {
  it(
    "returns an empty JSON array without creating directories or requiring launch resources",
    async () => {
      await fixture(async (f) => {
        const before = fixtureEntries(f.root);
        const result = await f.run(["list"], f.cwdB, {
          PI_CODING_AGENT_DIR: join(f.root, "absent-agent"),
        });
        assert.equal(result.code, 0, result.err);
        assert.equal(result.out, "[]\n");
        assert.equal(result.err, "");
        assert.deepEqual(fixtureEntries(f.root), before);
        assert.equal(existsSync(f.socket), false);
        assert.equal(existsSync(dirname(f.socket)), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "lists stopped registrations without restoring their saved candidates",
    async () => {
      await fixture(async (f) => {
        f.saved("snapshot-only-id");
        f.seed([{ id: "snapshot-only-id", cwd: f.cwdA }]);
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const before = readFileSync(path, "utf8");
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(JSON.parse(result.out), [{ cwd: f.cwdA, sessions: [], empty: [] }]);
        assert.equal(readFileSync(path, "utf8"), before);
        assert.equal(existsSync(f.socket), false);
        assert.equal(existsSync(dirname(f.socket)), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects an invalid registration record without changing it or stopping live pi",
    async () => {
      await fixture(async (f) => {
        const { metadata } = await publishedIdlePane(f);
        mkdirSync(join(f.agent, "pi-tmux"), { mode: 0o700 });
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const invalid = "{invalid restore file\n";
        writeFileSync(path, invalid);
        const result = await f.run(["list"]);
        assert.equal(result.code, 1, result.err);
        assert.equal(result.out, "");
        assert.match(result.err, /Cannot read snapshot/);
        assert.equal(readFileSync(path, "utf8"), invalid);
        assert.ok(existsSync(`/proc/${metadata.pid}`));
      });
    },
    TIMEOUT_MS,
  );

  it(
    "returns an empty array from a running server without sessions",
    async () => {
      await fixture(async (f) => {
        mkdirSync(dirname(f.socket), { recursive: true, mode: 0o700 });
        const started = await f.tmux(["-f", join(f.root, "outer.conf"), "start-server"]);
        assert.equal(started.code, 0, started.err);
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.equal(result.out, "[]\n");
        assert.equal(existsSync(join(f.agent, "pi-tmux")), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "groups every live pi under its registered workspace",
    async () => {
      await fixture(async (f) => {
        const entries = await Promise.all([
          publishedIdlePane(f, "ready", "first-id"),
          publishedIdlePane(f, "accepted", "second-id"),
        ]);
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        const actual = JSON.parse(result.out)[0].sessions.sort(
          (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id),
        );
        const expected = entries
          .map(({ metadata }) => ({
            id: metadata.id,
            file: metadata.file,
            state: null,
            title: null,
            publishPending: null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(actual, expected);
        assert.equal(existsSync(join(f.agent, "pi-tmux")), true);
      });
    },
    TIMEOUT_MS,
  );

  for (const state of ["running", "waiting-approval", "waiting-user"] as const) {
    it(
      "returns the session fields including null publishPending with state " + state,
      async () => {
        await fixture(async (f) => {
          const { pane, metadata } = await publishedIdlePane(f);
          const value = JSON.stringify(
            { version: 1, sessionId: metadata.id, state },
            null,
            state === "running" ? 2 : undefined,
          );
          const published = await f.tmux([
            "set-option",
            "-p",
            "-t",
            pane,
            "@pi_session_state",
            value,
          ]);
          assert.equal(published.code, 0, published.err);
          const imported = await f.run(["list"]);
          assert.equal(imported.code, 0, imported.err);
          const before = fixtureEntries(f.root);
          const options = await f.tmux(["show-options", "-g"]);
          const result = await f.run(["list"]);
          assert.equal(result.code, 0, result.err);
          assert.equal(result.err, "");
          assert.deepEqual(JSON.parse(result.out), [
            {
              cwd: metadata.cwd,
              sessions: [
                { id: metadata.id, file: metadata.file, state, title: null, publishPending: null },
              ],
              empty: [],
            },
          ]);
          assert.equal(existsSync(metadata.file), true);
          assert.equal(existsSync(join(f.agent, "pi-tmux")), true);
          assert.deepEqual(fixtureEntries(f.root), before);
          assert.equal((await f.tmux(["show-options", "-g"])).out, options.out);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "validates title and state independently after the common identity checks",
    async () => {
      await fixture(async (f) => {
        const { pane, metadata } = await publishedIdlePane(f);
        const cases = [
          {
            fields: { state: "running", title: "Saved title" },
            state: "running",
            title: "Saved title",
          },
          { fields: { state: "waiting-user", title: "" }, state: "waiting-user", title: "" },
          {
            fields: { state: "waiting-approval", title: "Quotes '\\\" \\n#{pane_id}" },
            state: "waiting-approval",
            title: "Quotes '\\\" \\n#{pane_id}",
          },
          { fields: { state: "running", title: null }, state: "running", title: null },
          { fields: { state: "running", title: 42 }, state: "running", title: null },
          { fields: { state: "running", title: {} }, state: "running", title: null },
          { fields: { state: "running", title: ["invalid"] }, state: "running", title: null },
          { fields: { state: "invalid", title: "Valid title" }, state: null, title: "Valid title" },
          { fields: { title: "Without state" }, state: null, title: "Without state" },
          {
            fields: { version: 2, state: "running", title: "Wrong version" },
            state: null,
            title: null,
          },
          {
            fields: { sessionId: "other-id", state: "running", title: "Other session" },
            state: null,
            title: null,
          },
        ];
        for (const { fields, state, title } of cases) {
          const value = JSON.stringify({ version: 1, sessionId: metadata.id, ...fields });
          const published = await f.tmux([
            "set-option",
            "-p",
            "-t",
            pane,
            "@pi_session_state",
            value,
          ]);
          assert.equal(published.code, 0, published.err);
          const result = await f.run(["list"]);
          assert.equal(result.code, 0, result.err);
          assert.deepEqual(
            JSON.parse(result.out),
            [
              {
                cwd: metadata.cwd,
                sessions: [
                  { id: metadata.id, file: metadata.file, state, title, publishPending: null },
                ],
                empty: [],
              },
            ],
            value,
          );
        }
      });
    },
    TIMEOUT_MS,
  );

  const unavailableStates = [
    { name: "unpublished", value: undefined },
    { name: "invalid JSON", value: "{invalid" },
    { name: "invalid multiline JSON", value: "invalid\n%1\t$1\tbad\t%%%invalid%%%\t1\t0" },
    { name: "null", value: "null" },
    { name: "an array", value: "[]" },
    {
      name: "another version",
      value: JSON.stringify({ version: 2, sessionId: "live-id", state: "running" }),
    },
    {
      name: "another conversation",
      value: JSON.stringify({ version: 1, sessionId: "other-id", state: "running" }),
    },
    {
      name: "an unknown state",
      value: JSON.stringify({ version: 1, sessionId: "live-id", state: "idle" }),
    },
    {
      name: "only the old phase field",
      value: JSON.stringify({ version: 1, sessionId: "live-id", phase: "running" }),
    },
    { name: "a missing state", value: JSON.stringify({ version: 1, sessionId: "live-id" }) },
  ];
  for (const { name, value } of unavailableStates) {
    it(
      "keeps the live identity with a null state for " + name,
      async () => {
        await fixture(async (f) => {
          const { pane, metadata } = await publishedIdlePane(f);
          if (value !== undefined) {
            const published = await f.tmux([
              "set-option",
              "-p",
              "-t",
              pane,
              "@pi_session_state",
              value,
            ]);
            assert.equal(published.code, 0, published.err);
          }
          const result = await f.run(["list"]);
          assert.equal(result.code, 0, result.err);
          assert.deepEqual(JSON.parse(result.out), [
            {
              cwd: metadata.cwd,
              sessions: [
                {
                  id: metadata.id,
                  file: metadata.file,
                  state: null,
                  title: null,
                  publishPending: null,
                },
              ],
              empty: [],
            },
          ]);
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const startup of ["legacy", "accepted"] as const) {
    it(
      "includes " + startup + " metadata without claiming restoration readiness",
      async () => {
        await fixture(async (f) => {
          const { metadata } = await publishedIdlePane(f, startup);
          const result = await f.run(["list"]);
          assert.equal(result.code, 0, result.err);
          assert.deepEqual(JSON.parse(result.out), [
            {
              cwd: metadata.cwd,
              sessions: [
                {
                  id: metadata.id,
                  file: metadata.file,
                  state: null,
                  title: null,
                  publishPending: null,
                },
              ],
              empty: [],
            },
          ]);
          assert.equal(existsSync(metadata.file), true);
          f.saved(metadata.id);
          f.seed([{ id: metadata.id, cwd: metadata.cwd }]);
          const restored = await f.run(["restore"]);
          assert.equal(restored.code, 2, restored.err);
          assert.deepEqual(f.snapshotCandidates(), [{ id: metadata.id, cwd: metadata.cwd }]);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "includes an unsaved new pi without changing its process or snapshot",
    async () => {
      await fixture(async (f) => {
        await f.client("empty", ["new"], f.cwdA);
        const pane = await firstPane(f);
        await waitFor(() =>
          f.snapshotCandidates().some((entry) => entry.id === pane.id) ? true : undefined,
        );
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const before = readFileSync(path, "utf8");
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(JSON.parse(result.out), [
          {
            cwd: pane.cwd,
            sessions: [],
            empty: [{ id: pane.id, file: pane.file }],
          },
        ]);
        assert.equal(existsSync(pane.file), false);
        assert.equal((await firstPane(f)).pid, pane.pid);
        assert.equal(readFileSync(path, "utf8"), before);
        await f.detachAll();
        assert.equal(await f.exitCode("empty"), 0);
      });
    },
    TIMEOUT_MS,
  );

  for (const ignored of ["unpublished", "dead"] as const) {
    it(
      "omits a pane that is " + ignored,
      async () => {
        await fixture(async (f) => {
          const { pane } = await publishedIdlePane(f);
          if (ignored === "unpublished") {
            assert.equal(
              (await f.tmux(["set-option", "-p", "-u", "-t", pane, "@pi-tmux-session"])).code,
              0,
            );
          } else {
            assert.equal(
              (await f.tmux(["set-option", "-p", "-t", pane, "remain-on-exit", "on"])).code,
              0,
            );
            assert.equal(
              (await f.tmux(["respawn-pane", "-k", "-t", pane, "--", "/bin/true"])).code,
              0,
            );
            await waitFor(async () =>
              (await f.tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"])).out.trim() ===
              "1"
                ? true
                : undefined,
            );
          }
          const result = await f.run(["list"]);
          assert.equal(result.code, 0, result.err);
          assert.equal(result.out, "[]\n");
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "omits a terminated child pi even while its pane shell remains alive",
    async () => {
      await fixture(async (f) => {
        const { pane, metadata } = await publishedIdlePane(f);
        assert.equal(
          (
            await f.tmux([
              "set-option",
              "-p",
              "-t",
              pane!,
              "@pi-tmux-session",
              Buffer.from(JSON.stringify({ ...metadata, processPid: 2147483647 })).toString(
                "base64",
              ),
            ])
          ).code,
          0,
        );
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(JSON.parse(result.out), []);
        assert.equal(existsSync(join(f.agent, "pi-tmux/pi-mux-restore.json")), false);
      });
    },
    TIMEOUT_MS,
  );

  for (const invalid of ["id", "cwd", "file", "pid", "processPid", "startup"] as const) {
    it(
      "rejects invalid live " + invalid + " metadata instead of reporting an empty list",
      async () => {
        await fixture(async (f) => {
          const { pane, metadata } = await publishedIdlePane(f);
          const changes = {
            id: { id: "bad id" },
            cwd: { cwd: "relative/cwd" },
            file: { file: "relative/file.jsonl" },
            pid: { pid: metadata.pid + 1 },
            processPid: { processPid: -1 },
            startup: { startup: "unknown" },
          };
          const encoded = Buffer.from(
            JSON.stringify({ ...metadata, ...changes[invalid] }),
          ).toString("base64");
          assert.equal(
            (await f.tmux(["set-option", "-p", "-t", pane, "@pi-tmux-session", encoded])).code,
            0,
          );
          const result = await f.run(["list"]);
          assert.equal(result.code, 1);
          assert.equal(result.out, "");
          assert.match(result.err, /Invalid pi session metadata/);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "reports tmux inspection failures without starting a server or creating state",
    async () => {
      await fixture(async (f) => {
        const wrapper = join(f.bin, "tmux");
        const previous = readFileSync(wrapper, "utf8");
        writeFileSync(
          wrapper,
          previous.replace(
            'case "$*" in',
            'case "$*" in\n  *"list-panes -a"*) echo "access refused" >&2; exit 1 ;;',
          ),
        );
        const result = await f.run(["list"]);
        assert.equal(result.code, 1);
        assert.equal(result.out, "");
        assert.match(result.err, /Cannot inspect pi sessions: access refused/);
        assert.equal(existsSync(f.socket), false);
        assert.equal(existsSync(dirname(f.socket)), false);
        assert.equal(existsSync(join(f.agent, "pi-tmux")), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "reports state inspection failures without returning a partial array",
    async () => {
      await fixture(async (f) => {
        await publishedIdlePane(f);
        const wrapper = join(f.bin, "tmux");
        const previous = readFileSync(wrapper, "utf8");
        writeFileSync(
          wrapper,
          previous.replace(
            'case "$*" in',
            'case "$*" in\n  *"show-options -pqv"*) echo "state access refused" >&2; exit 1 ;;',
          ),
        );
        const result = await f.run(["list"]);
        assert.equal(result.code, 1);
        assert.equal(result.out, "");
        assert.match(result.err, /state access refused/);
        assert.equal(existsSync(join(f.agent, "pi-tmux/pi-mux-restore.json")), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "uses only the renamed restore file without migrating the old basename",
    async () => {
      await fixture(async (f) => {
        f.saved("old-only-id");
        const directory = join(f.agent, "pi-tmux");
        mkdirSync(directory, { mode: 0o700 });
        const oldPath = join(directory, "active-sessions.json");
        const original =
          JSON.stringify({
            version: 1,
            generation: "old-server",
            sessions: [{ id: "old-only-id", cwd: f.cwdA }],
            pending: [],
          }) + "\n";
        writeFileSync(oldPath, original);
        const restored = await f.run(["restore"]);
        assert.equal(restored.code, 0, restored.err);
        assert.deepEqual(await f.panes(), []);
        assert.deepEqual(f.snapshotCandidates(), []);
        const snapshot = JSON.parse(readFileSync(join(directory, "pi-mux-restore.json"), "utf8"));
        assert.deepEqual(Object.keys(snapshot).sort(), ["generation", "version", "workspaces"]);
        assert.equal(snapshot.version, 1);
        assert.equal(readFileSync(oldPath, "utf8"), original);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux workspace operations", () => {
  for (const { ambiguous, separateWindow } of [
    { ambiguous: false, separateWindow: false },
    { ambiguous: true, separateWindow: false },
    { ambiguous: false, separateWindow: true },
    { ambiguous: true, separateWindow: true },
  ]) {
    it(
      `handles a real initializing managed pi beside another workspace, ambiguous=${ambiguous}, separateWindow=${separateWindow}`,
      async () => {
        await fixture(async (f) => {
          const id = "mixed-initializing-a";
          const file = f.saved(id, f.cwdA);
          f.seed([{ id, cwd: f.cwdA }]);
          const storePath = join(f.agent, "pi-tmux/pi-mux-restore.json");
          const original = JSON.stringify({
            version: 1,
            generation: "previous-server",
            workspaces: [
              { cwd: f.cwdA, sessions: [id] },
              { cwd: f.cwdB, sessions: [] },
            ],
          });
          writeFileSync(storePath, original);
          const started = join(f.root, "mixed-init-started");
          const released = join(f.root, "startup-released");
          writeFileSync(
            join(f.agent, "extensions/z-block-initialization.ts"),
            `import { existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("resources_discover", async () => {
    writeFileSync(${JSON.stringify(started)}, "");
    while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, 25));
  });
}`,
          );
          const restoring = f.launch(["restore"]);
          try {
            await waitFor(() => (existsSync(started) ? true : undefined));
            const identity = await f.tmux([
              "list-panes",
              "-a",
              "-F",
              "#{pane_id}\t#{pane_pid}\t#{session_id}",
            ]);
            const [initialPane, initialPid, session] = identity.out.trim().split("\t");
            const other = await f.tmux([
              ...(separateWindow ? ["new-window"] : ["split-window", "-d"]),
              "-P",
              "-F",
              "#{pane_id}\t#{pane_pid}",
              "-t",
              separateWindow ? session! : initialPane!,
              "-c",
              f.cwdB,
              "--",
              "sleep",
              "120",
            ]);
            assert.equal(other.code, 0, other.err);
            const [otherPane, otherPid] = other.out.trim().split("\t");
            const metadata = {
              id: "mixed-external-b",
              cwd: f.cwdB,
              file: join(f.agent, "b.jsonl"),
              pid: Number(otherPid),
              startup: "ready",
            };
            assert.equal(
              (
                await f.tmux([
                  "set-option",
                  "-p",
                  "-t",
                  otherPane!,
                  "@pi-tmux-session",
                  Buffer.from(JSON.stringify(metadata)).toString("base64"),
                ])
              ).code,
              0,
            );
            if (ambiguous) {
              const extra = await f.tmux([
                "split-window",
                "-d",
                "-t",
                initialPane!,
                "-c",
                f.cwdA,
                "--",
                "/usr/bin/env",
                `PI_TMUX_SESSION_ID=${id}`,
                "sleep",
                "120",
              ]);
              assert.equal(extra.code, 0, extra.err);
            }
            if (separateWindow)
              assert.equal(
                (await f.tmux(["display-message", "-p", "-t", session!, "#{pane_id}"])).out.trim(),
                otherPane,
              );
            restoring.kill("SIGKILL");
            await restoring.exited;
            const before = f.snapshot();
            const recordBefore = readFileSync(storePath, "utf8");
            const saved = readFileSync(file, "utf8");
            const removed = await f.run(["workspace", "unregister", f.cwdA]);
            assert.equal(removed.code, ambiguous ? 1 : 0, removed.err);
            assert.equal(existsSync(`/proc/${initialPid}`), ambiguous);
            assert.equal(
              (await f.tmux(["display-message", "-p", "-t", otherPane!, "#{pane_pid}"])).out.trim(),
              otherPid,
            );
            assert.equal((await f.tmux(["has-session", "-t", session!])).code, 0);
            assert.equal(readFileSync(file, "utf8"), saved);
            if (ambiguous) {
              assert.match(removed.err, /Cannot safely identify initializing pi/);
              assert.equal(readFileSync(storePath, "utf8"), recordBefore);
              assert.deepEqual(f.snapshot(), before);
            } else {
              assert.deepEqual(
                JSON.parse(readFileSync(storePath, "utf8")).workspaces.map(
                  ({ cwd }: { cwd: string }) => cwd,
                ),
                [f.cwdB],
              );
              assert.deepEqual(f.snapshotCandidates(), []);
            }
          } finally {
            restoring.kill("SIGKILL");
            await restoring.exited;
          }
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "does not restore a removed registration from an overlapping list's stale pane snapshot",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["new", "--detached"], f.cwdA)).code, 0);
        const live = await firstPane(f);
        writeFileSync(
          live.file,
          JSON.stringify({
            type: "session",
            version: 3,
            id: live.id,
            cwd: live.cwd,
            timestamp: new Date().toISOString(),
          }) + "\n",
        );
        const wrapper = join(f.bin, "tmux");
        const ready = join(f.root, "list-state-ready");
        const released = join(f.root, "list-state-released");
        writeFileSync(
          wrapper,
          readFileSync(wrapper, "utf8").replace(
            'case "$*" in',
            `case "$*" in
  *"show-options -pqv"*)
    if test "$TEST_PAUSE_LIST_STATE" = 1; then
      ${quote([Bun.which("tmux")!])} "$@"; code=$?
      touch ${quote([ready])}
      while ! test -f ${quote([released])}; do sleep 0.02; done
      exit "$code"
    fi ;;
`,
          ),
        );
        const listing = f.run(["list"], f.cwdB, { TEST_PAUSE_LIST_STATE: "1" });
        try {
          await waitFor(() => (existsSync(ready) ? true : undefined));
          const removed = await f.run(["workspace", "unregister", f.cwdA]);
          assert.equal(removed.code, 0, removed.err);
        } finally {
          writeFileSync(released, "");
        }
        const stale = await listing;
        assert.equal(stale.code, 0, stale.err);
        const after = await f.run(["list"]);
        assert.equal(after.code, 0, after.err);
        assert.deepEqual(JSON.parse(after.out), []);
        assert.deepEqual(f.snapshot().workspaces, []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "lists an empty registered workspace alongside an automatically imported live workspace",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["workspace", "register", f.cwdB])).code, 0);
        const { metadata } = await publishedIdlePane(f);
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(JSON.parse(result.out), [
          { cwd: f.cwdB, sessions: [], empty: [] },
          {
            cwd: f.cwdA,
            sessions: [
              {
                id: metadata.id,
                file: metadata.file,
                state: null,
                title: null,
                publishPending: null,
              },
            ],
            empty: [],
          },
        ]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "stops an unregistered external pi and leaves another workspace in the same tmux session alive",
    async () => {
      await fixture(async (f) => {
        const { pane, metadata } = await publishedIdlePane(f);
        const other = await f.tmux([
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}\t#{pane_pid}",
          "-t",
          pane!,
          "--",
          "sleep",
          "120",
        ]);
        assert.equal(other.code, 0, other.err);
        const [otherPane, otherPid] = other.out.trim().split("\t");
        const otherMetadata = {
          ...metadata,
          id: "same-session-other",
          cwd: f.cwdB,
          pid: Number(otherPid),
        };
        assert.equal(
          (
            await f.tmux([
              "set-option",
              "-p",
              "-t",
              otherPane!,
              "@pi-tmux-session",
              Buffer.from(JSON.stringify(otherMetadata)).toString("base64"),
            ])
          ).code,
          0,
        );
        assert.equal((await f.run(["workspace", "register", f.cwdB])).code, 0);
        const removed = await f.run(["workspace", "unregister", f.cwdA]);
        assert.equal(removed.code, 0, removed.err);
        assert.deepEqual(
          (await f.panes()).map((entry) => entry.id),
          [otherMetadata.id],
        );
        assert.equal((await firstPane(f)).pid, Number(otherPid));
        const listed = await f.run(["list"]);
        assert.deepEqual(JSON.parse(listed.out), [
          {
            cwd: f.cwdB,
            sessions: [
              {
                id: otherMetadata.id,
                file: otherMetadata.file,
                state: null,
                title: null,
                publishPending: null,
              },
            ],
            empty: [],
          },
        ]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "stops an initializing managed pi before removing its retry candidate",
    async () => {
      await fixture(async (f) => {
        const { pane, metadata } = await publishedIdlePane(f);
        const published = (await f.panes())[0]!;
        assert.equal(
          (
            await f.tmux([
              "set-environment",
              "-t",
              published.session,
              "PI_TMUX_SESSION_ID",
              metadata.id,
            ])
          ).code,
          0,
        );
        assert.equal(
          (await f.tmux(["set-option", "-pu", "-t", pane!, "@pi-tmux-session"])).code,
          0,
        );
        const launchToken = randomUUID();
        assert.equal(
          (
            await f.tmux([
              "respawn-pane",
              "-k",
              "-t",
              pane!,
              "--",
              "/usr/bin/env",
              `PI_TMUX_SESSION_ID=${metadata.id}`,
              `PI_TMUX_LAUNCH_TOKEN=${launchToken}`,
              "sleep",
              "120",
            ])
          ).code,
          0,
        );
        const currentPid = Number(
          (await f.tmux(["display-message", "-p", "-t", pane!, "#{pane_pid}"])).out.trim(),
        );
        assert.equal(
          (
            await f.tmux([
              "set-option",
              "-p",
              "-t",
              pane!,
              "@pi-mux-launch",
              JSON.stringify({ id: metadata.id, pid: currentPid, token: launchToken }),
            ])
          ).code,
          0,
        );
        f.seed([{ id: metadata.id, cwd: f.cwdA }]);
        const removed = await f.run(["workspace", "unregister", f.cwdA]);
        assert.equal(removed.code, 0, removed.err);
        assert.deepEqual(f.snapshotCandidates(), []);
        assert.deepEqual(await f.panes(), []);
        assert.equal((await f.tmux(["has-session", "-t", published.session])).code, 1);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "preserves registration and pi when the restore record is invalid",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["new", "--detached"], f.cwdA)).code, 0);
        const pane = await firstPane(f);
        assert.equal((await f.run(["snapshot"])).code, 0);
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        writeFileSync(path, "{invalid");

        const result = await f.run(["workspace", "unregister", f.cwdA]);
        assert.equal(result.code, 1);
        assert.equal(readFileSync(path, "utf8"), "{invalid");
        assert.equal((await firstPane(f)).pid, pane.pid);
      });
    },
    TIMEOUT_MS,
  );

  for (const action of ["register", "unregister"] as const) {
    it("parses workspace " + action + " with an absolute cwd", () => {
      assert.deepEqual(parseOperation(["workspace", action, "./workspace"]), {
        kind: "workspace",
        action,
        cwd: resolve("./workspace"),
      });
    });
  }

  for (const args of [
    ["workspace"],
    ["workspace", "register"],
    ["workspace", "delete", "/tmp"],
    ["workspace", "register", ""],
    ["workspace", "register", "/tmp", "extra"],
  ]) {
    it("rejects invalid workspace arguments " + JSON.stringify(args), () => {
      assert.throws(() => parseOperation(args), /usage:/);
    });
  }

  it(
    "registers and lists an empty workspace without launch resources or a server",
    async () => {
      await fixture(async (f) => {
        const extra = { PI_CODING_AGENT_DIR: join(f.root, "uninstalled-agent") };
        const registered = await f.run(["workspace", "register", "."], f.cwdA, extra);
        assert.equal(registered.code, 0, registered.err);
        const listed = await f.run(["list"], f.cwdB, extra);
        assert.equal(listed.code, 0, listed.err);
        assert.deepEqual(JSON.parse(listed.out), [{ cwd: f.cwdA, sessions: [], empty: [] }]);
        assert.equal(existsSync(f.socket), false);
        const store = JSON.parse(
          readFileSync(join(extra.PI_CODING_AGENT_DIR, "pi-tmux/pi-mux-restore.json"), "utf8"),
        );
        assert.deepEqual(store, {
          version: 1,
          generation: "",
          workspaces: [{ cwd: f.cwdA, sessions: [] }],
        });
      });
    },
    TIMEOUT_MS,
  );

  it(
    "preserves candidates, attributes, and generation when registering or listing an existing workspace",
    async () => {
      await fixture(async (f) => {
        const storePath = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const original = JSON.stringify({
          other: { value: 3 },
          version: 1,
          generation: "saved-generation",
          workspaces: [
            { cwd: f.cwdA, sessions: ["archived"] },
            { cwd: f.cwdB, sessions: [] },
          ],
        });
        mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
        writeFileSync(storePath, original);
        assert.equal((await f.run(["workspace", "register", f.cwdA])).code, 0);
        const listed = await f.run(["list"]);
        assert.deepEqual(JSON.parse(listed.out), [
          { cwd: f.cwdA, sessions: [], empty: [] },
          { cwd: f.cwdB, sessions: [], empty: [] },
        ]);
        assert.equal(readFileSync(storePath, "utf8"), original);
        assert.equal(existsSync(f.socket), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects registration of a missing directory",
    async () => {
      await fixture(async (f) => {
        const result = await f.run(["workspace", "register", join(f.root, "missing")]);
        assert.equal(result.code, 1);
        assert.equal(existsSync(join(f.agent, "pi-tmux/pi-mux-restore.json")), false);
        assert.equal(existsSync(f.socket), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "retains empty registration after normal pi termination",
    async () => {
      await fixture(async (f) => {
        const created = await f.run(["new", "--detached"], f.cwdA);
        assert.equal(created.code, 0, created.err);
        const pane = await firstPane(f);
        assert.equal((await f.tmux(["kill-session", "-t", pane.session])).code, 0);
        const listed = await f.run(["list"]);
        assert.deepEqual(JSON.parse(listed.out), [{ cwd: f.cwdA, sessions: [], empty: [] }]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "imports and stops a real external pi beneath a dedicated pane shell without stopping the shell",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["restore"])).code, 0);
        const id = "shell-external-id";
        const started = await f.tmux([
          "new-session",
          "-d",
          "-s",
          "shell-external",
          "-c",
          f.cwdA,
          "--",
          "sh",
          "-c",
          quote([join(f.bin, "pi"), "--session-id", id]) + "; sleep 120",
        ]);
        assert.equal(started.code, 0, started.err);
        const pane = await firstPane(f);
        const processPid = (pane as Pane & { processPid: number }).processPid;
        assert.ok(Number.isSafeInteger(processPid));
        assert.notEqual(processPid, pane.pid);
        const listed = await f.run(["list"]);
        assert.equal(listed.code, 0, listed.err);
        assert.deepEqual(JSON.parse(listed.out), [
          { cwd: f.cwdA, sessions: [], empty: [{ id, file: pane.file }] },
        ]);
        const removed = await f.run(["workspace", "unregister", f.cwdA]);
        assert.equal(removed.code, 0, removed.err);
        assert.equal(existsSync(`/proc/${processPid}`), false);
        assert.equal(existsSync(`/proc/${pane.pid}`), true);
        const after = await f.run(["list"]);
        assert.equal(after.code, 0, after.err);
        assert.deepEqual(JSON.parse(after.out), []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "imports a real externally launched pi in dedicated tmux and retains the empty registration",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["restore"])).code, 0);
        const id = "external-workspace-id";
        const started = await f.tmux([
          "new-session",
          "-d",
          "-s",
          "external",
          "-c",
          f.cwdA,
          "--",
          join(f.bin, "pi"),
          "--session-id",
          id,
        ]);
        assert.equal(started.code, 0, started.err);
        const pane = await firstPane(f);
        assert.equal(pane.id, id);
        assert.equal(
          f.snapshot().workspaces.some(({ cwd }) => cwd === f.cwdA),
          false,
        );
        const listed = await f.run(["list"]);
        assert.equal(listed.code, 0, listed.err);
        assert.deepEqual(JSON.parse(listed.out), [
          { cwd: f.cwdA, sessions: [], empty: [{ id, file: pane.file }] },
        ]);
        assert.equal((await f.tmux(["kill-session", "-t", pane.session])).code, 0);
        assert.deepEqual(JSON.parse((await f.run(["list"])).out), [
          { cwd: f.cwdA, sessions: [], empty: [] },
        ]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "does not import a real pi launched in another tmux server",
    async () => {
      await fixture(async (f) => {
        const id = "outside-workspace-id";
        const started = await f.tmux(
          [
            "-f",
            join(f.root, "outer.conf"),
            "new-session",
            "-d",
            "-s",
            "external",
            "-c",
            f.cwdA,
            "--",
            join(f.bin, "pi"),
            "--session-id",
            id,
          ],
          f.outer,
        );
        assert.equal(started.code, 0, started.err);
        await waitFor(() =>
          f.records<{ id: string }>("discovered").some((entry) => entry.id === id)
            ? true
            : undefined,
        );
        const listed = await f.run(["list"]);
        assert.equal(listed.code, 0, listed.err);
        assert.deepEqual(JSON.parse(listed.out), []);
        assert.equal(existsSync(join(f.agent, "pi-tmux/pi-mux-restore.json")), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "stops all target pi, removes only their registration and restore candidates, and retains saved files",
    async () => {
      await fixture(async (f) => {
        const candidates = [
          { id: "workspace-a-one", cwd: f.cwdA },
          { id: "workspace-a-two", cwd: f.cwdA },
          { id: "workspace-b-one", cwd: f.cwdB },
        ];
        const files = candidates.map(({ id, cwd }) => f.saved(id, cwd));
        f.seed(candidates);
        const restored = await f.run(["restore"]);
        assert.equal(restored.code, 0, restored.err);
        assert.equal((await f.run(["list"])).code, 0);
        const saved = files.map((file) => ({ file, content: readFileSync(file, "utf8") }));
        const other = (await f.panes()).find((pane) => pane.cwd === f.cwdB)!;
        const removed = await f.run(["workspace", "unregister", f.cwdA]);
        assert.equal(removed.code, 0, removed.err);
        assert.deepEqual(
          (await f.panes()).map((pane) => pane.id),
          [other.id],
        );
        assert.equal((await firstPane(f)).pid, other.pid);
        assert.deepEqual(f.snapshotCandidates(), [{ id: other.id, cwd: f.cwdB }]);
        assert.deepEqual(
          f.snapshot().workspaces.map(({ cwd }) => cwd),
          [f.cwdB],
        );
        for (const entry of saved) assert.equal(readFileSync(entry.file, "utf8"), entry.content);
        assert.equal((await f.run(["restore"])).code, 0);
        assert.deepEqual(
          (await f.panes()).map((pane) => pane.id),
          [other.id],
        );
      });
    },
    TIMEOUT_MS,
  );

  it(
    "unregisters a stopped workspace and its retry targets without starting tmux",
    async () => {
      await fixture(async (f) => {
        const file = f.saved("stopped-target");
        f.seed([
          { id: "stopped-target", cwd: f.cwdA },
          { id: "other-retry", cwd: f.cwdB },
        ]);
        assert.equal((await f.run(["workspace", "register", f.cwdA])).code, 0);
        rmSync(f.cwdA, { recursive: true });
        const result = await f.run(["workspace", "unregister", f.cwdA]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(f.snapshotCandidates(), [{ id: "other-retry", cwd: f.cwdB }]);
        assert.equal(existsSync(file), true);
        assert.equal(existsSync(f.socket), false);
        assert.equal((await f.run(["workspace", "unregister", f.cwdA])).code, 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "waits for the shared operation lock before stopping workspace pi",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["new", "--detached"], f.cwdA)).code, 0);
        const pane = await firstPane(f);
        assert.equal((await f.run(["snapshot"])).code, 0);
        const before = f.snapshot();
        const lock = createServer();
        const key = createHash("sha256")
          .update(realpathSync(join(f.agent, "pi-tmux")))
          .digest("hex");
        await waitFor(async () => {
          try {
            await new Promise<void>((resolve, reject) => {
              lock.once("error", reject);
              lock.listen(`\0pi-mux-${process.getuid!()}-${key}`, resolve);
            });
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
            return undefined;
          }
        });
        const removal = f.run(["workspace", "unregister", f.cwdA]);
        try {
          await Bun.sleep(150);
          assert.equal((await firstPane(f)).pid, pane.pid);
          assert.deepEqual(f.snapshot(), before);
        } finally {
          await new Promise<void>((resolve) => lock.close(() => resolve()));
        }
        const removed = await removal;
        assert.equal(removed.code, 0, removed.err);
        assert.deepEqual(f.snapshot().workspaces, []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "preserves registration when tmux refuses termination",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["new", "--detached"], f.cwdA)).code, 0);
        const pane = await firstPane(f);
        assert.equal((await f.run(["snapshot"])).code, 0);
        const storePath = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const original = readFileSync(storePath, "utf8");
        const wrapper = join(f.bin, "tmux");
        writeFileSync(
          wrapper,
          readFileSync(wrapper, "utf8").replace(
            'case "$*" in',
            'case "$*" in\n  *"kill-pane"*) echo "stop refused" >&2; exit 1 ;;',
          ),
        );
        const result = await f.run(["workspace", "unregister", f.cwdA]);
        assert.equal(result.code, 1);
        assert.match(result.err, /stop refused/);
        assert.equal(readFileSync(storePath, "utf8"), original);
        assert.equal((await firstPane(f)).pid, pane.pid);
      });
    },
    TIMEOUT_MS,
  );

  for (const original of [
    "{invalid",
    "[]",
    JSON.stringify({ version: 1, generation: "saved", workspaces: {} }),
    JSON.stringify({
      version: 1,
      generation: "saved",
      workspaces: [{ cwd: "/workspace", sessions: {} }],
    }),
  ]) {
    it(
      "preserves an invalid restore record " + original,
      async () => {
        await fixture(async (f) => {
          const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, original);
          for (const args of [
            ["list"],
            ["workspace", "register", f.cwdA],
            ["workspace", "unregister", f.cwdA],
          ]) {
            const result = await f.run(args);
            assert.equal(result.code, 1, JSON.stringify(args));
            assert.equal(readFileSync(path, "utf8"), original);
            assert.equal(existsSync(f.socket), false);
          }
        });
      },
      TIMEOUT_MS,
    );
  }
});

describe("pi-mux new argument contract", () => {
  it("defaults to an attached empty new session", () => {
    assert.deepEqual(parseOperation([]), { kind: "new", detached: false, clientPid: undefined });
    assert.deepEqual(parseOperation(["new"]), {
      kind: "new",
      detached: false,
      clientPid: undefined,
      cwd: undefined,
    });
    assert.deepEqual(parseOperation(["new", "--detached"]), {
      kind: "new",
      detached: true,
      clientPid: undefined,
      cwd: undefined,
    });
  });

  it("consumes only the first --detached and keeps the next argument as a request", () => {
    assert.deepEqual(parseOperation(["new", "--detached", "--detached"]), {
      kind: "new",
      detached: true,
      clientPid: undefined,
      request: "--detached",
      cwd: undefined,
    });
  });

  for (const detached of [false, true]) {
    for (const request of [
      "  'quoted' $(literal) `literal`\nnext line  ",
      "--option-like",
      "--detached is part of this request",
      "--fresh",
      "--initial-request",
      "--window-name",
      "--",
      "@/file with spaces.txt",
    ]) {
      it(`keeps one literal request with detached=${detached}: ${JSON.stringify(request)}`, () => {
        const args = ["new", ...(detached ? ["--detached"] : []), request];
        assert.deepEqual(parseOperation(args), {
          kind: "new",
          detached,
          clientPid: undefined,
          request,
          cwd: undefined,
        });
      });
    }
  }

  for (const args of [
    ["create", "name", "--", "request"],
    ["new", ""],
    ["new", " \n"],
    ["new", "a\0b"],
    ["new", "--detached", "a\0b"],
    ["new", "request", "--detached"],
    ["new", "first", "second"],
    ["new", "--", "request"],
    ["new", "--detached", "--", "request"],
  ]) {
    it("rejects malformed input: " + JSON.stringify(args), () => {
      assert.throws(() => parseOperation(args), /usage: pi-mux/);
    });
  }
});

describe("pi-mux new connection selection", () => {
  it(
    "creates independent sessions across concurrent detached calls and an attached call in the same cwd",
    async () => {
      await fixture(async (f) => {
        const results = await Promise.all([
          f.run(["new", "--detached"], f.cwdA),
          f.run(["new", "--detached"], f.cwdA),
        ]);
        const started = await waitFor(async () => {
          const panes = await f.panes();
          return panes.length === 2 ? panes : undefined;
        });
        for (const result of results) assert.equal(result.code, 0, result.err);
        for (const pane of started) {
          assert.equal(pane.cwd, f.cwdA);
          assert.equal(pane.startup, "ready");
          assert.equal(existsSync(pane.file), false);
        }
        assert.notEqual(started[0]!.id, started[1]!.id);
        assert.notEqual(started[0]!.session, started[1]!.session);
        assert.notEqual(started[0]!.pid, started[1]!.pid);
        assert.notEqual(started[0]!.pane, started[1]!.pane);
        for (const result of results) {
          const pane = started.find((entry) => result.out.includes(entry.id));
          assert.ok(pane);
          assert.match(result.out, new RegExp(`Pi session ${pane.id}\\nAttach with:`));
          assert.ok(result.out.includes(pane.session));
        }
        assert.equal((await f.tmux(["list-clients"])).out.trim(), "");
        const startedSessions = new Set(started.map((pane) => pane.session));
        await f.client("independent", ["new"], f.cwdA);
        const attachedSession = await waitFor(async () => {
          const panes = await f.panes();
          return panes.length === 3
            ? panes.find((pane) => !startedSessions.has(pane.session))?.session
            : undefined;
        });
        assert.ok(attachedSession);
        for (const pane of await f.panes()) {
          assert.equal(pane.cwd, f.cwdA);
          assert.equal(existsSync(pane.file), false);
        }
        assert.equal(new Set((await f.panes()).map((pane) => pane.session)).size, 3);
        await waitFor(async () =>
          (await f.tmux(["list-clients", "-F", "#{session_id}"])).out
            .trim()
            .split("\n")
            .includes(attachedSession)
            ? true
            : undefined,
        );
        await f.detachAll();
        assert.equal(await f.exitCode("independent"), 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "creates independent sessions for concurrent detached calls in different cwds",
    async () => {
      await fixture(async (f) => {
        const cwds = [f.cwdA, f.cwdB];
        const results = await Promise.all(cwds.map((cwd) => f.run(["new", "--detached"], cwd)));
        const original = await f.panes();
        assert.equal(original.length, 2);
        assert.notEqual(original[0]!.id, original[1]!.id);
        assert.notEqual(original[0]!.pid, original[1]!.pid);
        assert.notEqual(original[0]!.pane, original[1]!.pane);
        for (const [index, cwd] of cwds.entries()) {
          const pane = original.find((entry) => entry.cwd === cwd);
          assert.ok(pane);
          const result = results[index]!;
          assert.equal(result.code, 0, result.err);
          assert.ok(result.out.includes(pane.id));
          assert.ok(result.out.includes(pane.session));
          assert.equal(existsSync(pane.file), false);
          const another = await f.run(["new", "--detached"], cwd);
          assert.equal(another.code, 0, another.err);
          const created = await waitFor(async () =>
            (await f.panes()).find((entry) => entry.cwd === cwd && entry.id !== pane.id),
          );
          assert.ok(another.out.includes(created.id));
          assert.notEqual(created.session, pane.session);
          assert.equal(existsSync(created.file), false);
          const before = new Set(
            (await f.panes()).filter((entry) => entry.cwd === cwd).map((entry) => entry.session),
          );
          await f.client("independent-" + index, ["new"], cwd);
          const attachedSession = await waitFor(async () => {
            const sessions = (await f.panes())
              .filter((entry) => entry.cwd === cwd)
              .map((entry) => entry.session);
            return sessions.find((session) => !before.has(session));
          });
          await waitFor(async () =>
            (await f.tmux(["list-clients", "-F", "#{session_id}"])).out
              .trim()
              .split("\n")
              .includes(attachedSession)
              ? true
              : undefined,
          );
          await f.detachAll();
          assert.equal(await f.exitCode("independent-" + index), 0);
        }
      });
    },
    TIMEOUT_MS,
  );

  for (const detached of [false, true]) {
    it(
      `creates a separate empty session in another cwd with detached=${detached}`,
      async () => {
        await fixture(async (f) => {
          const opened = await f.run(["new", "--detached"], f.cwdA);
          assert.equal(opened.code, 0, opened.err);
          const original = await firstPane(f);
          if (detached) {
            const created = await f.run(["new", "--detached"], f.cwdB);
            assert.equal(created.code, 0, created.err);
          } else {
            await f.client("other-cwd", ["new"], f.cwdB);
          }
          const created = await waitFor(async () =>
            (await f.panes()).find((pane) => pane.cwd === f.cwdB),
          );
          assert.notEqual(created.id, original.id);
          assert.notEqual(created.pid, original.pid);
          assert.notEqual(created.pane, original.pane);
          assert.equal(existsSync(created.file), false);
          assert.equal(existsSync(original.file), false);
          const another = await f.run(["new", "--detached"], f.cwdA);
          assert.equal(another.code, 0, another.err);
          const fresh = await waitFor(async () =>
            (await f.panes()).find((pane) => pane.cwd === f.cwdA && pane.id !== original.id),
          );
          assert.ok(another.out.includes(fresh.id));
          assert.notEqual(fresh.session, original.session);
          assert.equal(existsSync(fresh.file), false);
          assert.deepEqual(
            (await f.panes()).find((pane) => pane.id === original.id),
            original,
          );
          if (!detached) {
            await waitFor(async () =>
              (await f.tmux(["list-clients", "-F", "#{session_id}"])).out.trim() === created.session
                ? true
                : undefined,
            );
            await f.detachAll();
            assert.equal(await f.exitCode("other-cwd"), 0);
          }
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "starts an independent session even when a legacy pi-empty session is running",
    async () => {
      await fixture(async (f) => {
        const opened = await f.run(["new", "--detached"], f.cwdA);
        assert.equal(opened.code, 0, opened.err);
        const original = await firstPane(f);
        const renamed = await f.tmux(["rename-session", "-t", original.session, "pi-empty"]);
        assert.equal(renamed.code, 0, renamed.err);
        const result = await f.run(["new", "--detached"], f.cwdA);
        assert.equal(result.code, 0, result.err);
        const panes = await f.panes();
        assert.equal(panes.length, 2);
        const created = panes.find((pane) => pane.id !== original.id);
        assert.ok(created);
        assert.ok(result.out.includes(created.id));
        assert.notEqual(created.session, original.session);
        assert.equal(created.cwd, f.cwdA);
        for (const pane of panes) assert.equal(existsSync(pane.file), false);
        const name = await f.tmux([
          "display-message",
          "-p",
          "-t",
          original.pane,
          "#{session_name}",
        ]);
        assert.equal(name.out.trim(), "pi-empty");
      });
    },
    TIMEOUT_MS,
  );

  for (const detached of [false, true]) {
    it(
      `starts an independent requested session with detached=${detached} in a cwd with a running empty session`,
      async () => {
        await fixture(async (f) => {
          const opened = await f.run(["new", "--detached"], f.cwdA);
          assert.equal(opened.code, 0, opened.err);
          const empty = await firstPane(f);
          const request = "fixture-initial independent request";
          if (detached) {
            const created = await f.run(["new", "--detached", request], f.cwdA);
            assert.equal(created.code, 0, created.err);
          } else {
            await f.client("requested", ["new", request], f.cwdA);
          }
          const requested = await waitFor(async () =>
            (await f.panes()).find((pane) => pane.id !== empty.id),
          );
          assert.notEqual(requested.session, empty.session);
          assert.equal(requested.cwd, f.cwdA);
          assert.equal(requested.startup, "accepted");
          assert.equal(existsSync(requested.file), false);
          assert.equal(
            (
              await f.tmux(["display-message", "-p", "-t", requested.pane, "#{window_name}"])
            ).out.trim(),
            "pi",
          );
          await waitFor(() =>
            f.records<Input>("inputs").some((entry) => entry.id === requested.id)
              ? true
              : undefined,
          );
          assert.deepEqual(
            f.records<Input>("inputs").map(({ id, text }) => ({ id, text })),
            [{ id: requested.id, text: request }],
          );
          if (detached) {
            assert.equal((await f.tmux(["list-clients"])).out.trim(), "");
          } else {
            await waitFor(async () =>
              (await f.tmux(["list-clients", "-F", "#{session_id}"])).out.trim() ===
              requested.session
                ? true
                : undefined,
            );
          }
          const another = await f.run(["new", "--detached"], f.cwdA);
          assert.equal(another.code, 0, another.err);
          const fresh = await waitFor(async () =>
            (await f.panes()).find((pane) => pane.id !== empty.id && pane.id !== requested.id),
          );
          assert.ok(another.out.includes(fresh.id));
          assert.notEqual(fresh.session, empty.session);
          assert.notEqual(fresh.session, requested.session);
          assert.equal(existsSync(fresh.file), false);
          assert.equal((await f.panes()).find((pane) => pane.id === empty.id)?.pid, empty.pid);
          if (!detached) {
            await f.detachAll();
            assert.equal(await f.exitCode("requested"), 0);
          }
        });
      },
      TIMEOUT_MS,
    );
  }
});

describe("pi-mux CLI boundaries", () => {
  it(
    "keeps concurrent new calls and an open of a saved session attached",
    async () => {
      await fixture(async (f) => {
        await f.client("initial", ["new"], f.cwdA);
        const first = await firstPane(f);
        await f.persist(first);
        await f.detachAll();
        assert.equal(await f.exitCode("initial"), 0);

        await Promise.all([
          f.client("slow", ["new"], f.cwdA),
          f.client("fast", ["new"], f.cwdA),
          f.client("open", ["open", first.id], f.cwdB),
        ]);
        await waitFor(async () => {
          const clients = await f.tmux(["list-clients", "-F", "#{client_name}"]);
          return clients.out.trim().split("\n").length === 3 ? true : undefined;
        });
        const panes = await f.panes();
        const empty = panes.filter((pane) => !existsSync(pane.file));
        assert.equal(empty.length, 2);
        for (const pane of empty) {
          assert.equal(pane.cwd, f.cwdA);
          assert.notEqual(pane.id, first.id);
          assert.notEqual(pane.pid, first.pid);
          assert.notEqual(pane.pane, first.pane);
        }
        assert.notEqual(empty[0]!.id, empty[1]!.id);
        assert.deepEqual(
          panes.find((pane) => pane.id === first.id),
          first,
        );
        await f.detachAll();
        for (const name of ["slow", "fast", "open"]) assert.equal(await f.exitCode(name), 0, name);
      });
    },
    TIMEOUT_MS,
  );

  for (const relative of [false, true]) {
    it(
      `reopens ${relative ? "a relative" : "an absolute"} project store with an explicit root from another cwd after runtime loss`,
      async () => {
        await fixture(async (f) => {
          const store = join(f.root, "project-store");
          mkdirSync(join(f.cwdA, ".pi"));
          writeFileSync(
            join(f.cwdA, ".pi/settings.json"),
            JSON.stringify({
              sessionDir: relative ? "../project-store" : store,
            }),
          );
          await f.client("initial", ["new"], f.cwdA);
          const first = await firstPane(f);
          assert.equal(dirname(first.file), store);
          await f.persist(first);
          await f.detachAll();
          assert.equal(await f.exitCode("initial"), 0);
          await f.tmux(["kill-server"]);
          rmSync(f.runtime, { recursive: true });
          mkdirSync(f.runtime, { mode: 0o700 });
          await f.client("reopen", ["open", first.id], f.cwdB, {
            PI_CODING_AGENT_SESSION_DIR: store,
          });
          const reopened = await firstPane(f);
          assert.equal(reopened.id, first.id);
          assert.equal(reopened.file, first.file);
          assert.equal(reopened.cwd, f.cwdA);
          assert.notEqual(reopened.pid, first.pid);
          await f.detachAll();
          assert.equal(await f.exitCode("reopen"), 0);
          await f.tmux(["kill-server"]);
          const unconfigured = await f.run(["open", first.id], f.cwdB);
          assert.notEqual(unconfigured.code, 0);
          assert.match(unconfigured.err, /Session not found/);
          assert.ok(existsSync(first.file));
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const symlink of [false, true]) {
    it(
      `reopens explicitly selected ${symlink ? "symlink" : "ordinary"} storage below the standard root without false ambiguity`,
      async () => {
        await fixture(async (f) => {
          const standard = join(f.agent, "sessions");
          const store = join(standard, symlink ? "alias" : "custom-store");
          if (symlink) {
            const physicalStore = join(f.root, "physical-store");
            mkdirSync(standard);
            mkdirSync(physicalStore);
            symlinkSync(physicalStore, store);
          } else {
            assert.equal(existsSync(store), false);
          }
          mkdirSync(join(f.cwdA, ".pi"));
          writeFileSync(join(f.cwdA, ".pi/settings.json"), JSON.stringify({ sessionDir: store }));
          await f.client("initial", ["new"], f.cwdA);
          const first = await firstPane(f);
          assert.equal(dirname(first.file), store);
          await f.persist(first);
          await f.detachAll();
          assert.equal(await f.exitCode("initial"), 0);
          const registry = join(f.agent, "pi-tmux/session-dirs");
          assert.ok(existsSync(registry), "Used storage roots must be recorded");
          const recorded = readdirSync(registry)
            .filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(registry, name), "utf8")));
          assert.ok(recorded.includes(store));
          await f.tmux(["kill-server"]);
          rmSync(f.runtime, { recursive: true });
          mkdirSync(f.runtime, { mode: 0o700 });
          await f.client("reopen", ["open", first.id], f.cwdB, {
            PI_CODING_AGENT_SESSION_DIR: store,
          });
          const reopened = await firstPane(f);
          assert.equal(reopened.id, first.id);
          assert.equal(realpathSync(reopened.file), realpathSync(first.file));
          assert.equal(reopened.cwd, f.cwdA);
          assert.notEqual(reopened.pid, first.pid);
          await f.client("same-file-open", ["open", first.id], f.cwdB, {
            PI_CODING_AGENT_SESSION_DIR: store,
          });
          await waitFor(async () => {
            const clients = await f.tmux(["list-clients", "-F", "#{client_name}"]);
            return clients.out.trim().split("\n").length === 2 ? true : undefined;
          });
          assert.equal((await f.panes()).filter((pane) => pane.id === first.id).length, 1);
          await f.detachAll(2);
          assert.equal(await f.exitCode("reopen"), 0);
          assert.equal(await f.exitCode("same-file-open"), 0);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "retains every concurrently registered empty workspace in the restore record and list",
    async () => {
      await fixture(async (f) => {
        const directories = Array.from({ length: 8 }, (_, index) =>
          join(f.root, "project-" + index),
        );
        for (const cwd of directories) mkdirSync(cwd);
        const results = await Promise.all(
          directories.map((cwd) => f.run(["workspace", "register", cwd], cwd)),
        );
        for (const result of results) assert.equal(result.code, 0, result.err);
        const expectedWorkspaces = directories.map((cwd) => ({ cwd, sessions: [] }));
        assert.deepEqual(
          f.snapshot().workspaces.sort((a, b) => a.cwd.localeCompare(b.cwd)),
          expectedWorkspaces,
        );
        const listed = await f.run(["list"]);
        assert.equal(listed.code, 0, listed.err);
        const listedWorkspaces = JSON.parse(listed.out) as {
          cwd: string;
          sessions: unknown[];
          empty: unknown[];
        }[];
        assert.deepEqual(
          listedWorkspaces.sort((a, b) => a.cwd.localeCompare(b.cwd)),
          expectedWorkspaces.map((workspace) => ({ ...workspace, empty: [] })),
        );
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects duplicate saved IDs within cwd groups before attaching and permits an unsaved live ID",
    async () => {
      await fixture(async (f) => {
        await f.client("initial", ["new"], f.cwdA);
        const first = await firstPane(f);
        await f.persist(first);
        await f.detachAll();
        const duplicate = join(dirname(first.file), "duplicate.jsonl");
        copyFileSync(first.file, duplicate);
        const ambiguous = await f.run(["open", first.id]);
        assert.notEqual(ambiguous.code, 0);
        assert.match(ambiguous.err, /Ambiguous session ID/);
        assert.equal((await f.panes()).find((pane) => pane.id === first.id)?.pid, first.pid);
        assert.equal((await f.tmux(["list-clients", "-F", "#{client_name}"])).out.trim(), "");
        rmSync(duplicate);
        writeFileSync(join(f.agent, "sessions/unrelated.jsonl"), "{invalid\n");
        await f.client("empty", ["new"], f.cwdB);
        const empty = await waitFor(async () =>
          (await f.panes()).find((pane) => pane.id !== first.id),
        );
        assert.equal(existsSync(empty.file), false);
        await f.client("unsaved-open", ["open", empty.id], f.cwdA);
        await waitFor(async () => {
          const clients = await f.tmux(["list-clients", "-F", "#{client_name}"]);
          return clients.out.trim().split("\n").length === 2 ? true : undefined;
        });
        assert.equal((await f.panes()).filter((pane) => pane.id === empty.id).length, 1);
        await f.detachAll();
        assert.equal(await f.exitCode("unsaved-open"), 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "drops past caller variables without mixing concurrent new and open environments",
    async () => {
      await fixture(async (f) => {
        const token =
          'caller-A-dummy-token\nDECOY=secret-fragment; export DECOY;\nquote\\" dollar$';
        await f.client("initial", ["new"], f.cwdA, { REVIEW_ONLY_TOKEN: token });
        const first = await firstPane(f);
        assert.ok(processEnvironment(first.pid).includes("REVIEW_ONLY_TOKEN=" + token));
        await f.persist(first);
        await f.detachAll();
        await f.client("second", ["new"], f.cwdB);
        const second = await waitFor(async () =>
          (await f.panes()).find((pane) => pane.id !== first.id),
        );
        assert.equal(
          processEnvironment(second.pid).some((entry) => entry.startsWith("REVIEW_ONLY_TOKEN=")),
          false,
        );
        await f.persist(second);
        await f.detachAll();
        await Promise.all([
          f.client("third", ["new"], f.cwdB, { CALLER_TAG: "new-caller" }),
          f.client("old-open", ["open", first.id], f.cwdA, { CALLER_TAG: "open-caller" }),
        ]);
        const third = await waitFor(async () =>
          (await f.panes()).find((pane) => !existsSync(pane.file)),
        );
        const thirdEnvironment = processEnvironment(third.pid);
        assert.ok(thirdEnvironment.includes("CALLER_TAG=new-caller"));
        assert.equal(
          thirdEnvironment.some((entry) => entry.startsWith("REVIEW_ONLY_TOKEN=")),
          false,
        );
        assert.equal(
          readFileSync(`/proc/${third.pid}/cmdline`, "utf8").includes("secret-fragment"),
          false,
        );
        assert.ok(processEnvironment(first.pid).includes("REVIEW_ONLY_TOKEN=" + token));
        assert.equal(
          processEnvironment(first.pid).some((entry) => entry.startsWith("CALLER_TAG=")),
          false,
        );
        assert.equal(readFileSync(`/proc/${first.pid}/cmdline`, "utf8").includes(token), false);
        await f.detachAll(2);
        assert.equal(await f.exitCode("third"), 0);
        assert.equal(await f.exitCode("old-open"), 0);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux snapshot and restoration", () => {
  it(
    "stores session ID strings grouped by workspace and retains empty registrations",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["restore"])).code, 0);
        const candidates = [
          { id: "first-id", cwd: f.cwdA },
          { id: "second-id", cwd: f.cwdA },
          { id: "other-id", cwd: f.cwdB },
        ];
        for (const { id, cwd } of candidates) {
          const created = await f.tmux([
            "new-session",
            "-d",
            "-s",
            id,
            "-c",
            cwd,
            "-e",
            `PI_TMUX_SESSION_ID=${id}`,
            "--",
            "sleep",
            "120",
          ]);
          assert.equal(created.code, 0, created.err);
        }
        const captured = await f.run(["snapshot"]);
        assert.equal(captured.code, 0, captured.err);
        const snapshot = f.snapshot();
        const workspaces = snapshot.workspaces
          .map((workspace) => ({ ...workspace, sessions: workspace.sessions.toSorted() }))
          .sort((left, right) => left.cwd.localeCompare(right.cwd));
        assert.deepEqual(Object.keys(snapshot).sort(), ["generation", "version", "workspaces"]);
        assert.equal(snapshot.version, 1);
        assert.equal(typeof snapshot.generation, "string");
        assert.deepEqual(workspaces, [
          { cwd: f.cwdA, sessions: ["first-id", "second-id"] },
          { cwd: f.cwdB, sessions: ["other-id"] },
        ]);
        for (const { id } of candidates) {
          assert.equal((await f.tmux(["kill-session", "-t", `=${id}`])).code, 0);
        }
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshot().workspaces, [
          { cwd: f.cwdA, sessions: [] },
          { cwd: f.cwdB, sessions: [] },
        ]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "retains successful and failed restore targets in the same workspace session array",
    async () => {
      await fixture(async (f) => {
        f.saved("first-id", f.cwdA);
        f.saved("retry-id", f.cwdA);
        f.saved("other-id", f.cwdB);
        mkdirSync(join(f.agent, "pi-tmux"), { mode: 0o700 });
        writeFileSync(
          join(f.agent, "pi-tmux/pi-mux-restore.json"),
          JSON.stringify({
            version: 1,
            generation: "previous-server",
            workspaces: [
              { cwd: f.cwdA, sessions: ["first-id", "retry-id"] },
              { cwd: f.cwdB, sessions: ["other-id"] },
            ],
          }),
        );
        writeFileSync(join(f.root, "fail-startup"), "retry-id");
        const restored = await f.run(["restore"]);
        assert.equal(restored.code, 2, restored.err);
        assert.equal((await f.run(["snapshot"])).code, 0);
        const workspaces = f
          .snapshot()
          .workspaces.map((workspace) => ({
            ...workspace,
            sessions: workspace.sessions.toSorted(),
          }))
          .sort((left, right) => left.cwd.localeCompare(right.cwd));
        assert.deepEqual(workspaces, [
          { cwd: f.cwdA, sessions: ["first-id", "retry-id"] },
          { cwd: f.cwdB, sessions: ["other-id"] },
        ]);
        await f.tmux(["kill-server"]);
        rmSync(join(f.root, "fail-startup"));
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        const retriedWorkspaces = f
          .snapshot()
          .workspaces.map((workspace) => ({
            ...workspace,
            sessions: workspace.sessions.toSorted(),
          }))
          .sort((left, right) => left.cwd.localeCompare(right.cwd));
        assert.deepEqual(retriedWorkspaces, [
          { cwd: f.cwdA, sessions: ["first-id", "retry-id"] },
          { cwd: f.cwdB, sessions: ["other-id"] },
        ]);
        assert.deepEqual(f.events(), []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "removes a normally closed target without dropping a failed target in the same workspace",
    async () => {
      await fixture(async (f) => {
        f.saved("good-id");
        f.saved("retry-id");
        f.seed(["good-id", "retry-id"].map((id) => ({ id, cwd: f.cwdA })));
        writeFileSync(join(f.root, "fail-startup"), "retry-id");
        assert.equal((await f.run(["restore"])).code, 2);
        const good = await firstPane(f);
        assert.equal(good.id, "good-id");
        await f.tmux(["send-keys", "-t", good.pane, "C-d"]);
        await waitFor(async () => ((await f.panes()).length === 0 ? true : undefined));
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshot().workspaces, [{ cwd: f.cwdA, sessions: ["retry-id"] }]);
        await f.tmux(["kill-server"]);
        rmSync(join(f.root, "fail-startup"));
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        assert.equal((await firstPane(f)).id, "retry-id");
        assert.deepEqual(f.snapshot().workspaces, [{ cwd: f.cwdA, sessions: ["retry-id"] }]);
      });
    },
    TIMEOUT_MS,
  );

  for (const invalid of [
    "missing-workspaces",
    "workspace-shape",
    "relative-cwd",
    "sessions-shape",
    "session-object",
    "invalid-id",
    "conflicting-cwd",
  ] as const) {
    it(
      `preserves a snapshot with ${invalid} while reporting invalid grouped input`,
      async () => {
        await fixture(async (f) => {
          const workspace = { cwd: f.cwdA, sessions: ["saved-id"] };
          const workspaces: unknown[] = [workspace];
          if (invalid === "workspace-shape") workspaces[0] = null;
          if (invalid === "relative-cwd") workspace.cwd = "relative";
          if (invalid === "sessions-shape") workspaces[0] = { ...workspace, sessions: "saved-id" };
          if (invalid === "session-object")
            workspaces[0] = { ...workspace, sessions: [{ id: "saved-id" }] };
          if (invalid === "invalid-id") workspace.sessions = ["invalid id"];
          if (invalid === "conflicting-cwd")
            workspaces.push({ cwd: f.cwdB, sessions: ["saved-id"] });
          const snapshot = {
            version: 1,
            generation: "previous-server",
            ...(invalid === "missing-workspaces"
              ? { sessions: [{ id: "saved-id", cwd: f.cwdA }] }
              : { workspaces }),
          };
          const original = JSON.stringify(snapshot) + "\n";
          mkdirSync(join(f.agent, "pi-tmux"), { mode: 0o700 });
          const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
          writeFileSync(path, original);
          const restored = await f.run(["restore"]);
          assert.equal(restored.code, 2, restored.err);
          assert.match(restored.err, /Invalid snapshot|Conflicting working directories/);
          assert.equal(readFileSync(path, "utf8"), original);
          assert.deepEqual(await f.panes(), []);
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const operation of ["new", "open"] as const) {
    it(
      `starts the dedicated server and restores saved conversations before ${operation}`,
      async () => {
        await fixture(async (f) => {
          f.saved("restored-id");
          f.seed([{ id: "restored-id", cwd: f.cwdA }]);
          assert.equal(existsSync(f.socket), false);
          if (operation === "new") {
            const created = await f.run(["new", "--detached"]);
            assert.equal(created.code, 0, created.err);
          } else {
            f.saved("opened-id");
            await f.client("startup-open", ["open", "opened-id"]);
          }
          const panes = await waitFor(async () => {
            const running = await f.panes();
            return running.length === 2 ? running : undefined;
          });
          const restored = panes.find((pane) => pane.id === "restored-id");
          assert.ok(restored);
          assert.equal(restored.cwd, f.cwdA);
          assert.equal(restored.startup, "ready");
          assert.equal((await f.run(["snapshot"])).code, 0);
          assert.deepEqual(
            f
              .snapshotCandidates()
              .map(({ id }) => id)
              .toSorted(),
            panes.map(({ id }) => id).toSorted(),
          );
          assert.deepEqual(f.events(), []);
          if (operation === "open") {
            assert.ok(panes.some((pane) => pane.id === "opened-id"));
            await f.detachAll();
            assert.equal(await f.exitCode("startup-open"), 0);
          } else {
            assert.equal((await f.tmux(["list-clients"])).out.trim(), "");
          }
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "snapshots pre-published session identity and the last normal close through hooks",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["restore"])).code, 0);
        const cwd = join(f.root, "cwd with spaces 'quote'\tand\nnewline");
        mkdirSync(cwd);
        const created = await f.tmux([
          "new-session",
          "-d",
          "-s",
          "raw",
          "-c",
          cwd,
          "-e",
          "PI_TMUX_SESSION_ID=raw-id",
          "--",
          "sleep",
          "120",
        ]);
        assert.equal(created.code, 0, created.err);
        await waitFor(() =>
          f.snapshotCandidates().some((entry) => entry.id === "raw-id") ? true : undefined,
        );
        assert.deepEqual(f.snapshotCandidates(), [{ id: "raw-id", cwd }]);
        assert.deepEqual(await f.panes(), []);
        assert.equal((await f.tmux(["kill-session", "-t", "=raw"])).code, 0);
        await waitFor(() => (f.snapshotCandidates().length === 0 ? true : undefined));
        assert.equal((await f.tmux(["display-message", "-p", "#{pid}"])).code, 0);
      });
    },
    TIMEOUT_MS,
  );

  for (const stop of ["kill-server", "SIGTERM", "SIGKILL"] as const) {
    it(
      "retains the last snapshot across " + stop + " and restores without replay",
      async () => {
        await fixture(async (f) => {
          const file = f.saved("saved-id");
          const original = readFileSync(file, "utf8");
          f.seed([{ id: "saved-id", cwd: f.cwdA }]);
          const restored = await f.run(["restore"]);
          assert.equal(restored.code, 0, restored.err);
          const first = await firstPane(f);
          const oldGeneration = f.snapshot().generation;
          if (stop === "kill-server") await f.tmux(["kill-server"]);
          else {
            const server = await f.tmux(["display-message", "-p", "#{pid}"]);
            process.kill(Number(server.out.trim()), stop);
          }
          await waitFor(async () =>
            (await f.tmux(["list-sessions"])).code !== 0 ? true : undefined,
          );
          const stopped = await f.run(["snapshot"]);
          assert.notEqual(stopped.code, 0);
          assert.deepEqual(f.snapshotCandidates(), [{ id: "saved-id", cwd: f.cwdA }]);
          assert.equal(
            (await f.tmux(["list-sessions"])).code,
            1,
            "snapshot must not start a server",
          );
          assert.equal((await f.run(["restore"])).code, 0);
          const reopened = await firstPane(f);
          assert.equal(reopened.id, first.id);
          assert.equal(reopened.cwd, first.cwd);
          assert.notEqual(reopened.pid, first.pid);
          assert.notEqual(f.snapshot().generation, oldGeneration);
          const beforeStaleHook = f.snapshot();
          assert.equal((await f.run(["snapshot", oldGeneration])).code, 0);
          assert.deepEqual(f.snapshot(), beforeStaleHook);
          assert.deepEqual(f.events(), []);
          const originalMessages = original
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.type === "message");
          const restoredMessages = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.type === "message");
          assert.deepEqual(restoredMessages, originalMessages);
          assert.equal(existsSync(join(f.cwdA, "should-not-run")), false);
          assert.equal((await f.tmux(["list-clients"])).out.trim(), "");
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "removes only absent saved conversations and keeps startup failures after hooks and another restart",
    async () => {
      await fixture(async (f) => {
        f.saved("good-id");
        f.saved("retry-id");
        f.seed(["good-id", "retry-id", "absent-id"].map((id) => ({ id, cwd: f.cwdA })));
        writeFileSync(join(f.root, "fail-startup"), "retry-id");
        const restored = await f.run(["restore"]);
        assert.equal(restored.code, 2);
        assert.match(restored.err, /retry-id: pi exited before startup/);
        assert.match(restored.err, /absent-id: saved conversation not found/);
        assert.deepEqual(
          f
            .snapshotCandidates()
            .map(({ id }) => id)
            .toSorted(),
          ["good-id", "retry-id"],
        );
        assert.deepEqual(
          (await f.panes()).map((pane) => pane.id),
          ["good-id"],
        );
        await f.client("normal", ["new"]);
        const normal = await waitFor(async () =>
          (await f.panes()).find((pane) => pane.id !== "good-id"),
        );
        await waitFor(() =>
          f.snapshotCandidates().some((entry) => entry.id === normal.id) ? true : undefined,
        );
        assert.deepEqual(
          f
            .snapshotCandidates()
            .map(({ id }) => id)
            .toSorted(),
          ["good-id", "retry-id", normal.id].toSorted(),
        );
        await f.detachAll();
        assert.equal(await f.exitCode("normal"), 0);
        await f.tmux(["kill-server"]);
        rmSync(join(f.root, "fail-startup"));
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        assert.deepEqual((await f.panes()).map((pane) => pane.id).sort(), ["good-id", "retry-id"]);
        assert.deepEqual(
          f
            .snapshotCandidates()
            .map((entry) => entry.id)
            .sort(),
          ["good-id", "retry-id"],
        );
      });
    },
    TIMEOUT_MS,
  );

  for (const failure of ["cwd", "duplicate", "invalid", "invalid-shape", "access"] as const) {
    it(
      "retains and retries a candidate after a " + failure + " failure",
      async () => {
        await fixture(async (f) => {
          const cwd = join(f.root, "retry-cwd");
          mkdirSync(cwd);
          const file = f.saved("retry-id", cwd);
          const contents = readFileSync(file, "utf8");
          f.seed([{ id: "retry-id", cwd }]);
          const duplicate = join(dirname(file), "duplicate.jsonl");
          if (failure === "cwd") rmSync(cwd, { recursive: true });
          if (failure === "duplicate") copyFileSync(file, duplicate);
          if (failure === "invalid") writeFileSync(file, "{invalid\n");
          if (failure === "invalid-shape") writeFileSync(file, "[]\n");
          if (failure === "access") chmodSync(file, 0o000);
          const restored = await f.run(["restore"]);
          assert.equal(restored.code, 2, restored.err);
          assert.match(restored.err, /restore retry-id:/);
          assert.deepEqual(f.snapshotCandidates(), [{ id: "retry-id", cwd }]);
          assert.equal((await f.run(["snapshot"])).code, 0);
          assert.deepEqual(f.snapshotCandidates(), [{ id: "retry-id", cwd }]);
          await f.tmux(["kill-server"]);
          if (failure === "cwd") mkdirSync(cwd);
          if (failure === "duplicate") rmSync(duplicate);
          if (failure === "invalid" || failure === "invalid-shape") writeFileSync(file, contents);
          if (failure === "access") chmodSync(file, 0o600);
          const retry = await f.run(["restore"]);
          assert.equal(retry.code, 0, retry.err);
          assert.equal((await firstPane(f)).id, "retry-id");
          assert.deepEqual(f.snapshotCandidates(), [{ id: "retry-id", cwd }]);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "preserves the complete input while restore, hooks, snapshot, new and open race",
    async () => {
      await fixture(async (f) => {
        for (const id of ["first-id", "second-id"]) f.saved(id);
        f.seed(["first-id", "second-id"].map((id) => ({ id, cwd: f.cwdA })));
        const restoring = f.launch(["restore"], f.cwdB, { TEST_PAUSE_CREATE: "1" });
        await waitFor(() => (existsSync(join(f.root, "create-ready")) ? true : undefined));
        assert.deepEqual(
          f
            .snapshotCandidates()
            .map((entry) => entry.id)
            .sort(),
          ["first-id", "second-id"],
        );
        const snapshotting = f.run(["snapshot"]);
        const secondRestore = f.run(["restore"]);
        await Promise.all([f.client("normal", ["new"]), f.client("same", ["open", "first-id"])]);
        writeFileSync(join(f.root, "create-released"), "");
        assert.equal(await restoring.exited, 0);
        assert.equal((await snapshotting).code, 0);
        assert.equal((await secondRestore).code, 0);
        await waitFor(async () => ((await f.panes()).length === 3 ? true : undefined));
        const panes = await f.panes();
        assert.equal(panes.filter((pane) => pane.id === "first-id").length, 1);
        assert.equal(panes.filter((pane) => pane.id === "second-id").length, 1);
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(
          f
            .snapshotCandidates()
            .map(({ id }) => id)
            .toSorted(),
          panes.map(({ id }) => id).toSorted(),
        );
        await f.detachAll(2);
        assert.equal(await f.exitCode("normal"), 0);
        assert.equal(await f.exitCode("same"), 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "releases a killed restore owner's lock without losing its restore targets",
    async () => {
      await fixture(async (f) => {
        for (const id of ["first-id", "second-id"]) f.saved(id);
        f.seed(["first-id", "second-id"].map((id) => ({ id, cwd: f.cwdA })));
        const restoring = f.launch(["restore"], f.cwdB, { TEST_PAUSE_CREATE: "1" });
        await waitFor(() => (existsSync(join(f.root, "create-ready")) ? true : undefined));
        restoring.kill("SIGKILL");
        await restoring.exited;
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(
          f
            .snapshotCandidates()
            .map((entry) => entry.id)
            .sort(),
          ["first-id", "second-id"],
        );
        const next = await f.run(["restore"]);
        assert.equal(next.code, 0, next.err);
        writeFileSync(join(f.root, "create-released"), "");
        assert.deepEqual((await f.panes()).map((pane) => pane.id).sort(), [
          "first-id",
          "second-id",
        ]);
        assert.deepEqual(
          f
            .snapshotCandidates()
            .map(({ id }) => id)
            .toSorted(),
          ["first-id", "second-id"],
        );
      });
    },
    TIMEOUT_MS,
  );

  it(
    "preserves an invalid snapshot while allowing a normal new session",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["restore"])).code, 0);
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const invalid = '{"version":1,"sessions":"broken"}\n';
        writeFileSync(path, invalid);
        const restored = await f.run(["restore"]);
        assert.equal(restored.code, 2);
        assert.match(restored.err, /Invalid snapshot/);
        await f.client("normal", ["new"]);
        await firstPane(f);
        assert.notEqual((await f.run(["snapshot"])).code, 0);
        assert.equal(readFileSync(path, "utf8"), invalid);
        await f.detachAll();
        assert.equal(await f.exitCode("normal"), 0);
      });
    },
    TIMEOUT_MS,
  );

  for (const operation of ["new", "open"] as const) {
    for (const record of ["invalid-json", "invalid-shape", "unreadable"] as const) {
      it(
        `continues ${operation} with ${record} recording deferred until the record is repaired`,
        async () => {
          await fixture(async (f) => {
            assert.equal((await f.run(["restore"])).code, 0);
            const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
            const previous = readFileSync(path, "utf8");
            const id = "deferred-open-id";
            if (operation === "open") f.saved(id, f.cwdA);
            const invalid =
              record === "invalid-json"
                ? "{broken"
                : JSON.stringify({ version: 1, generation: "saved", workspaces: {} });
            if (record === "unreadable") {
              rmSync(path);
              mkdirSync(path);
            } else writeFileSync(path, invalid);
            await f.client("deferred", operation === "new" ? ["new"] : ["open", id], f.cwdA);
            const target = await firstPane(f);
            assert.equal(target.cwd, f.cwdA);
            if (operation === "open") assert.equal(target.id, id);
            if (record === "unreadable") assert.equal(readdirSync(path).length, 0);
            else assert.equal(readFileSync(path, "utf8"), invalid);
            await f.detachAll();
            assert.equal(await f.exitCode("deferred"), 0);
            if (record === "unreadable") rmSync(path, { recursive: true });
            writeFileSync(path, previous);
            const listed = await f.run(["list"]);
            assert.equal(listed.code, 0, listed.err);
            assert.deepEqual(
              f.snapshot().workspaces.map(({ cwd }) => cwd),
              [f.cwdA],
            );
            assert.equal((await firstPane(f)).pid, target.pid);
          });
        },
        TIMEOUT_MS,
      );
    }
  }

  it(
    "keeps the old file when snapshot I/O fails",
    async () => {
      await fixture(async (f) => {
        assert.equal((await f.run(["restore"])).code, 0);
        const directory = join(f.agent, "pi-tmux");
        const path = join(directory, "pi-mux-restore.json");
        const contents = readFileSync(path, "utf8");
        chmodSync(directory, 0o500);
        try {
          const failed = await f.run(["snapshot"]);
          assert.notEqual(failed.code, 0);
          assert.match(failed.err, /EACCES/);
          assert.equal(readFileSync(path, "utf8"), contents);
        } finally {
          chmodSync(directory, 0o700);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "creates independent IDs and passes each initial request exactly once",
    async () => {
      await fixture(async (f) => {
        const request = "--session fixture-initial 'quoted' $(literal) `literal`\nnext line";
        const results = await Promise.all([
          f.run(["new", "--detached", request], f.cwdA, {
            PI_SESSION_ID: "parent-session",
            PI_TMUX_SESSION_ID: "parent-fixed",
            PI_AGENT_NAME: "senior",
            PI_AGENT_CONFIG: "/parent/config",
          }),
          f.run(["new", "--detached", request], f.cwdB),
        ]);
        for (const result of results) {
          assert.equal(result.code, 0, result.err);
          assert.match(result.out, /Pi session .*Attach with:/s);
        }
        await waitFor(() =>
          f.events().filter((event) => event.kind === "input").length === 2 ? true : undefined,
        );
        const created = await f.panes();
        assert.equal(new Set(created.map((pane) => pane.id)).size, 2);
        assert.equal(new Set(created.map((pane) => pane.session)).size, 2);
        assert.deepEqual(
          f
            .events()
            .filter((event) => event.kind === "input")
            .map((event) => event.payload),
          [request, request],
        );
        for (const pane of created) {
          const environment = processEnvironment(pane.pid);
          assert.ok(environment.includes("PI_TMUX_SESSION_ID=" + pane.id));
          assert.equal(environment.includes("PI_SESSION_ID=parent-session"), false);
          assert.equal(environment.includes("PI_AGENT_NAME=senior"), false);
          assert.equal(environment.includes("PI_AGENT_CONFIG=/parent/config"), false);
          assert.equal(existsSync(pane.file), false);
        }
        await f.client("normal", ["new"]);
        await waitFor(async () => ((await f.panes()).length === 3 ? true : undefined));
        const normal = (await f.panes()).find(
          (pane) => !created.some((entry) => entry.id === pane.id),
        )!;
        await f.client("reuse", ["new"], f.cwdA);
        await f.detachAll(2);
        assert.equal(await f.exitCode("normal"), 0);
        assert.equal(await f.exitCode("reuse"), 0);
        assert.equal((await f.panes()).filter((pane) => pane.id === normal.id).length, 1);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects malformed public commands before starting the dedicated server",
    async () => {
      await fixture(async (f) => {
        for (const args of [
          ["create"],
          ["create", "name", "--", "request"],
          ["new", ""],
          ["new", " \n"],
          ["new", "request", "--detached"],
          ["new", "first", "second"],
          ["new", "--", "request"],
          ["new", "--detached", "--", "request"],
          ["restore", "extra"],
          ["list", "extra"],
          ["list", "--json"],
          ["snapshot", "one", "two"],
          ["open", "-partial"],
        ]) {
          const failed = await f.run(args);
          assert.equal(failed.code, 1, JSON.stringify(args));
          assert.match(failed.err, /usage: pi-mux/);
        }
        assert.equal(existsSync(f.socket), false);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux standard CLI initial input", () => {
  for (const kind of [
    "text",
    "image",
    "empty",
    "missing",
    "literal",
    "dash",
    "detached",
    "separator",
    "slash",
    "skill",
    "history",
  ] as const) {
    it(
      `preserves standard pi CLI ${kind} input without startup control text`,
      async () => {
        await fixture(async (f) => {
          assert.equal((await f.run(["restore"])).code, 0);
          const file = join(f.cwdA, "fixture-initial " + kind + ".txt");
          if (kind === "text") writeFileSync(file, "fixture-initial file 'quoted'\nnext line\n");
          if (kind === "image")
            writeFileSync(
              file,
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
                "base64",
              ),
            );
          if (kind === "empty") writeFileSync(file, "");
          if (kind === "skill") {
            const skill = join(f.agent, "skills/fixture-initial/SKILL.md");
            mkdirSync(dirname(skill), { recursive: true });
            writeFileSync(
              skill,
              "---\nname: fixture-initial\ndescription: Fixture skill\n---\nfixture-initial skill body\n",
            );
          }
          const request = ["text", "image", "empty", "missing"].includes(kind)
            ? "@" + file
            : kind === "dash"
              ? "--fixture-initial 'quoted'\nnext line"
              : kind === "detached"
                ? "--detached"
                : kind === "separator"
                  ? "--"
                  : kind === "slash"
                    ? "/fixture-initial-command quoted arguments"
                    : kind === "skill"
                      ? "/skill:fixture-initial extra arguments"
                      : kind === "history"
                        ? "saved initial request 'quoted'\nnext line"
                        : "  fixture-initial 'quoted' $(literal) `literal`\nnext line  ";
          const standard = await f.standard(request);
          const created = await f.run(["new", "--detached", request], f.cwdA);
          if (kind === "missing") {
            assert.equal(created.code, 1, created.err);
            await waitFor(async () =>
              (await f.tmux(["has-session", "-t", "=standard-" + standard])).code !== 0
                ? true
                : undefined,
            );
            assert.match(readFileSync(join(f.root, "pi-stderr.log"), "utf8"), /File not found/);
            assert.deepEqual(f.records<Input>("inputs"), []);
            assert.deepEqual(await f.panes(), []);
            return;
          }
          assert.equal(created.code, 0, created.err);
          const pane = await firstPane(f);
          assert.equal(pane.startup, "accepted");
          const argv = readFileSync(join(f.root, "argv-" + pane.pid), "utf8")
            .split("\0")
            .filter(Boolean);
          assert.equal(argv.at(-1), request);
          assert.equal(
            argv.some((arg) => arg.includes("/pi-mux-startup-")),
            false,
          );
          if (kind === "empty") {
            await waitFor(() =>
              f.records<{ id: string }>("discovered").some((entry) => entry.id === standard)
                ? true
                : undefined,
            );
            assert.deepEqual(f.records<Input>("inputs"), []);
            assert.equal(existsSync(pane.file), false);
          } else if (kind === "slash") {
            const expected = await waitFor(() =>
              f
                .records<{ id: string; args: string }>("commands")
                .find((entry) => entry.id === standard),
            );
            const actual = await waitFor(() =>
              f
                .records<{ id: string; args: string }>("commands")
                .find((entry) => entry.id === pane.id),
            );
            assert.equal(actual.args, expected.args);
            assert.equal(f.records("commands").length, 2);
            assert.deepEqual(f.records<Input>("inputs"), []);
          } else {
            const expected = await waitFor(() =>
              f.records<Input>("inputs").find((entry) => entry.id === standard),
            );
            const actual = await waitFor(() =>
              f.records<Input>("inputs").find((entry) => entry.id === pane.id),
            );
            assert.equal(actual.source, "interactive");
            assert.deepEqual(
              { text: actual.text, source: actual.source, images: actual.images },
              { text: expected.text, source: expected.source, images: expected.images },
            );
            assert.equal(
              f.records<Input>("inputs").filter((entry) => entry.id === pane.id).length,
              1,
            );
            assert.equal(actual.text.includes("/pi-mux-startup-"), false);
            if (kind === "image") assert.equal(actual.images?.length, 1);
            if (kind === "text") assert.match(actual.text, /^<file name=/);
            if (kind === "skill" || kind === "history") {
              const expectedPrompt = await waitFor(() =>
                f.records<Prompt>("prompts").find((entry) => entry.id === standard),
              );
              const actualPrompt = await waitFor(() =>
                f.records<Prompt>("prompts").find((entry) => entry.id === pane.id),
              );
              assert.equal(actualPrompt.prompt, expectedPrompt.prompt);
              if (kind === "skill")
                assert.match(actualPrompt.prompt, /<skill name="fixture-initial"/);
              await waitFor(() =>
                existsSync(pane.file) &&
                readFileSync(pane.file, "utf8").includes(
                  kind === "skill" ? "skill body" : "saved initial request",
                )
                  ? true
                  : undefined,
              );
              const contents = readFileSync(pane.file, "utf8");
              const messages = contents
                .slice(0, contents.lastIndexOf("\n"))
                .split("\n")
                .map((line) => JSON.parse(line))
                .filter((entry) => entry.type === "message" && entry.message.role === "user");
              assert.equal(messages.length, 1);
              assert.equal(contents.includes("/pi-mux-startup-"), false);
            }
          }
          assert.equal(
            f.events().some((event) => event.kind === "tool"),
            false,
          );
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "returns initial-request acceptance while its slash command is still running",
    async () => {
      await fixture(async (f) => {
        const created = await f.run(["new", "--detached", "/fixture-initial-command blocked"]);
        assert.equal(created.code, 0, created.err);
        const pane = await firstPane(f);
        await waitFor(() =>
          f.records<{ id: string }>("commands").some((entry) => entry.id === pane.id)
            ? true
            : undefined,
        );
        assert.equal(pane.startup, "accepted");
        assert.equal(existsSync(join(f.root, "command-released")), false);
        assert.deepEqual(f.events(), []);
        writeFileSync(join(f.root, "command-released"), "");
        assert.equal(f.records("commands").length, 1);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never removes restore targets using initial-request acceptance metadata",
    async () => {
      await fixture(async (f) => {
        const released = join(f.root, "startup-released");
        const extension = join(f.agent, "extensions/z-create-failure.ts");
        writeFileSync(
          extension,
          `import { existsSync } from "node:fs";
export default function (pi) { pi.on("resources_discover", async () => {
  while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, 25));
  process.exit(42);
}); }\n`,
        );
        const created = await f.run(["new", "--detached", "fixture-initial should not start"]);
        assert.equal(created.code, 0, created.err);
        const pane = await firstPane(f);
        assert.equal(pane.startup, "accepted");
        assert.deepEqual(f.events(), []);
        f.saved(pane.id, pane.cwd);
        await waitFor(() =>
          f.snapshotCandidates().some((entry) => entry.id === pane.id) ? true : undefined,
        );
        const attempted = await f.run(["restore"]);
        assert.equal(attempted.code, 2, attempted.err);
        assert.match(attempted.err, /not confirmed initialization completion/);
        assert.deepEqual(f.snapshotCandidates(), [{ id: pane.id, cwd: pane.cwd }]);
        writeFileSync(released, "");
        await waitFor(async () => ((await f.panes()).length === 0 ? true : undefined));
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshotCandidates(), [{ id: pane.id, cwd: pane.cwd }]);
        await f.tmux(["kill-server"]);
        rmSync(extension);
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        assert.equal((await firstPane(f)).startup, "ready");
        assert.deepEqual(f.snapshotCandidates(), [{ id: pane.id, cwd: pane.cwd }]);
        assert.deepEqual(f.events(), []);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux asynchronous startup", () => {
  for (const phase of ["session_start", "resources_discover"] as const) {
    for (const outcome of ["ready", "exit"] as const) {
      it(
        `waits for ${phase} ${outcome} before resolving restoration`,
        async () => {
          await fixture(async (f) => {
            const candidate = { id: "initializing-id", cwd: f.cwdA };
            const file = f.saved(candidate.id);
            f.seed([candidate]);
            const started = join(f.root, "startup-started");
            const released = join(f.root, "startup-released");
            const extension = join(f.agent, "extensions/z-startup.ts");
            writeFileSync(
              extension,
              `import { existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.on(${JSON.stringify(phase)}, async () => {
    writeFileSync(${JSON.stringify(started)}, "");
    while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, 25));
    ${outcome === "exit" ? "process.exit(42);" : ""}
  });
}
`,
            );
            const restoring = f.launch(["restore"]);
            try {
              await waitFor(async () => {
                if (existsSync(started)) return true;
                if (restoring.exitCode !== null)
                  assert.fail(await new Response(restoring.stderr).text());
                return undefined;
              });
              assert.deepEqual(await f.panes(), [], "Initialization must not publish readiness");
              assert.deepEqual(f.snapshotCandidates(), [candidate]);
            } finally {
              writeFileSync(released, "");
            }
            const error = await new Response(restoring.stderr).text();
            assert.equal(await restoring.exited, outcome === "ready" ? 0 : 2, error);
            if (outcome === "exit") {
              assert.match(error, /pi exited before startup/);
              await waitFor(async () => ((await f.panes()).length === 0 ? true : undefined));
              assert.deepEqual(f.snapshotCandidates(), [candidate]);
              assert.equal((await f.run(["snapshot"])).code, 0);
              assert.deepEqual(f.snapshotCandidates(), [candidate]);
              assert.equal(existsSync(file), true);
              rmSync(extension);
              await f.tmux(["kill-server"]);
              const retried = await f.run(["restore"]);
              assert.equal(retried.code, 0, retried.err);
            }
            const pane = await firstPane(f);
            assert.equal(pane.id, candidate.id);
            assert.deepEqual(f.snapshotCandidates(), [candidate]);
            assert.deepEqual(f.events(), []);
            assert.equal(existsSync(join(f.cwdA, "should-not-run")), false);
            await f.tmux(["send-keys", "-t", pane.pane, "C-d"]);
            await waitFor(() => (f.snapshotCandidates().length === 0 ? true : undefined));
            assert.deepEqual(f.snapshotCandidates(), []);
            assert.equal(existsSync(file), true);
          });
        },
        TIMEOUT_MS,
      );
    }
  }

  for (const failure of ["factory", "helper-exit", "helper-timeout"] as const) {
    it(
      `retains a candidate without replay after ${failure} startup failure`,
      async () => {
        await fixture(async (f) => {
          const candidate = { id: "startup-failure-id", cwd: f.cwdA };
          f.saved(candidate.id);
          f.seed([candidate]);
          const extension = join(f.agent, "extensions/z-broken.ts");
          const wrapper = join(f.bin, "tmux");
          const original = readFileSync(wrapper, "utf8");
          const attempted = join(f.root, "startup-failure-attempted");
          if (failure === "factory")
            writeFileSync(
              extension,
              'export default function () { throw new Error("startup factory failure"); }',
            );
          else
            writeFileSync(
              wrapper,
              original.replace(
                'case "$*" in',
                `
case "$*" in
  *"display-message"*"#{@pi-mux-launch}"*)
    touch ${quote([attempted])}
    echo "injected ${failure}" >&2
    ${failure === "helper-timeout" ? "exec sleep 6" : "exit 42"} ;;
esac
case "$*" in`,
              ),
            );
          const failed = await f.run(["restore"]);
          assert.equal(failed.code, 2, failed.err);
          assert.match(failed.err, /pi exited before startup/);
          if (failure !== "factory") {
            assert.equal(existsSync(attempted), true);
            assert.match(
              readFileSync(join(f.root, "pi-stderr.log"), "utf8"),
              new RegExp("pi-mux startup failed: injected " + failure),
            );
          }
          assert.deepEqual(f.events(), []);
          assert.equal(existsSync(join(f.cwdA, "should-not-run")), false);
          assert.deepEqual(f.snapshotCandidates(), [candidate]);
          assert.equal((await f.run(["snapshot"])).code, 0);
          assert.deepEqual(f.snapshotCandidates(), [candidate]);
          rmSync(extension, { force: true });
          writeFileSync(wrapper, original);
          await f.tmux(["kill-server"]);
          const retried = await f.run(["restore"]);
          assert.equal(retried.code, 0, retried.err);
          assert.equal((await firstPane(f)).id, candidate.id);
          assert.deepEqual(f.snapshotCandidates(), [candidate]);
          assert.deepEqual(f.events(), []);
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const phase of ["confirmation", "publication", "committed-publication"] as const) {
    for (const failure of ["denied", "timeout"] as const) {
      it(
        `preserves restore targets when ${phase} is ${failure}`,
        async () => {
          await fixture(async (f) => {
            const candidate = { id: "publication-id", cwd: f.cwdA };
            f.saved(candidate.id);
            f.seed([candidate]);
            const wrapper = join(f.bin, "tmux");
            const original = readFileSync(wrapper, "utf8");
            const attempted = join(f.root, "publication-failure-attempted");
            const verified = join(f.root, "publication-verified");
            writeFileSync(
              wrapper,
              original.replace(
                'case "$*" in',
                `
case "$*" in
  *"set-option -p"*"@pi-tmux-session"*) operation=publication ;;
  *"if-shell"*"set-option -gu"*"@pi-mux-restoring-"*) operation=confirmation ;;
  *) operation=other ;;
esac
${phase === "committed-publication" ? `if test "$operation" = confirmation; then touch ${quote([verified])}; fi` : ""}
if test "$operation" = ${phase === "committed-publication" ? "publication" : phase}; then
  ${phase === "committed-publication" ? `${quote([Bun.which("tmux")!])} "$@" || exit "$?"` : ""}
  touch ${quote([attempted])}
  ${failure === "timeout" ? "sleep 2" : ""}
  echo "injected ${phase} ${failure}" >&2
  exit 42
fi
case "$*" in`,
              ),
            );
            const restored = await f.run(["restore"]);
            if (phase === "publication") {
              assert.equal(restored.code, 2, restored.err);
              assert.equal(existsSync(attempted), true);
              assert.deepEqual(await f.panes(), []);
              assert.equal((await f.run(["snapshot"])).code, 0);
              assert.deepEqual(f.snapshotCandidates(), [candidate]);
              writeFileSync(wrapper, original);
              await f.tmux(["kill-server"]);
              const retried = await f.run(["restore"]);
              assert.equal(retried.code, 0, retried.err);
              assert.equal((await firstPane(f)).id, candidate.id);
              assert.deepEqual(f.snapshotCandidates(), [candidate]);
            } else {
              assert.equal(restored.code, 0, restored.err);
              assert.equal(existsSync(attempted), phase === "committed-publication");
              if (phase === "committed-publication")
                await waitFor(() => (existsSync(verified) ? true : undefined));
              const pane = await firstPane(f);
              assert.equal(pane.startup, "ready");
              assert.deepEqual(f.snapshotCandidates(), [candidate]);
              await f.tmux(["send-keys", "-t", pane.pane, "C-d"]);
              await waitFor(async () =>
                (await f.tmux(["list-sessions", "-F", "#{session_id}"])).out.trim() === ""
                  ? true
                  : undefined,
              );
              assert.equal((await f.run(["snapshot"])).code, 0);
              assert.deepEqual(f.snapshotCandidates(), []);
            }
            assert.deepEqual(f.events(), []);
          });
        },
        TIMEOUT_MS,
      );
    }
  }

  for (const outcome of ["ready", "remarked", "exit"] as const) {
    it(
      `handles ${outcome} after the restore owner dies during initialization`,
      async () => {
        await fixture(async (f) => {
          const candidate = { id: "orphaned-id", cwd: f.cwdA };
          f.saved(candidate.id);
          f.seed([candidate]);
          const started = join(f.root, "startup-started");
          const released = join(f.root, "startup-released");
          writeFileSync(
            join(f.agent, "extensions/z-orphaned.ts"),
            `import { existsSync, writeFileSync } from "node:fs";
export default function (pi) { pi.on("resources_discover", async () => {
  writeFileSync(${JSON.stringify(started)}, "");
  while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, 25));
  ${outcome === "exit" ? "process.exit(42);" : ""}
}); }\n`,
          );
          const restoring = f.launch(["restore"]);
          await waitFor(() => (existsSync(started) ? true : undefined));
          restoring.kill("SIGKILL");
          await restoring.exited;
          writeFileSync(released, "");
          if (outcome !== "exit") {
            const pane = await firstPane(f);
            assert.equal(pane.startup, "ready");
            if (outcome === "remarked")
              assert.equal(
                (await f.tmux(["set-option", "-g", `@pi-mux-restoring-${candidate.id}`, "1"])).code,
                0,
              );
            await f.tmux(["send-keys", "-t", pane.pane, "C-d"]);
          }
          await waitFor(async () =>
            (await f.tmux(["list-sessions", "-F", "#{session_id}"])).out.trim() === ""
              ? true
              : undefined,
          );
          const captured = await f.run(["snapshot"]);
          assert.equal(captured.code, 0, captured.err);
          assert.deepEqual(f.snapshotCandidates(), outcome === "exit" ? [candidate] : []);
          const retried = await f.run(["restore"]);
          assert.equal(retried.code, outcome === "exit" ? 2 : 0, retried.err);
          assert.deepEqual(await f.panes(), []);
          assert.deepEqual(f.events(), []);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "retains an initialization timeout through snapshot and another restart",
    async () => {
      await fixture(async (f) => {
        const candidate = { id: "timeout-id", cwd: f.cwdA };
        f.saved(candidate.id);
        f.seed([candidate]);
        const extension = join(f.agent, "extensions/z-hanging.ts");
        writeFileSync(
          extension,
          'export default function (pi) { pi.on("session_start", async () => { await new Promise(() => {}); }); }',
        );
        const timedOut = await f.run(["restore"]);
        assert.equal(timedOut.code, 2, timedOut.err);
        assert.match(timedOut.err, /pi startup timed out/);
        assert.deepEqual(await f.panes(), []);
        assert.deepEqual(f.snapshotCandidates(), [candidate]);
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshotCandidates(), [candidate]);
        await f.tmux(["kill-server"]);
        rmSync(extension);
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        assert.equal((await firstPane(f)).id, candidate.id);
        assert.deepEqual(f.snapshotCandidates(), [candidate]);
        assert.deepEqual(f.events(), []);
      });
    },
    TIMEOUT_MS + 30_000,
  );
});

describe("pi-mux conservative failure handling", () => {
  it(
    "retains a candidate when its selected storage root is inaccessible and retries with the same root",
    async () => {
      await fixture(async (f) => {
        const file = f.saved("inaccessible-id");
        const restricted = join(f.root, "restricted");
        const store = join(restricted, "sessions");
        mkdirSync(store, { recursive: true, mode: 0o700 });
        copyFileSync(file, join(store, "fixture_inaccessible-id.jsonl"));
        rmSync(file);
        f.seed([{ id: "inaccessible-id", cwd: f.cwdA }]);
        chmodSync(restricted, 0o000);
        try {
          const failed = await f.run(["restore"], f.cwdB, { PI_CODING_AGENT_SESSION_DIR: store });
          assert.equal(failed.code, 2, failed.err);
          assert.match(failed.err, /EACCES/);
          assert.deepEqual(f.snapshotCandidates(), [{ id: "inaccessible-id", cwd: f.cwdA }]);
          assert.equal((await f.run(["snapshot"])).code, 0);
          await f.tmux(["kill-server"]);
        } finally {
          chmodSync(restricted, 0o700);
        }
        const restored = await f.run(["restore"], f.cwdB, {
          PI_CODING_AGENT_SESSION_DIR: store,
        });
        assert.equal(restored.code, 0, restored.err);
        assert.equal((await firstPane(f)).id, "inaccessible-id");
        assert.deepEqual(f.snapshotCandidates(), [{ id: "inaccessible-id", cwd: f.cwdA }]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps duplicate running identities as restore targets until the next server generation",
    async () => {
      await fixture(async (f) => {
        f.saved("duplicate-id");
        f.seed([{ id: "duplicate-id", cwd: f.cwdA }]);
        assert.equal((await f.run(["restore"])).code, 0);
        assert.equal(
          (
            await f.tmux([
              "new-session",
              "-d",
              "-s",
              "duplicate",
              "-c",
              f.cwdA,
              "-e",
              "PI_TMUX_SESSION_ID=duplicate-id",
              "--",
              "sleep",
              "120",
            ])
          ).code,
          0,
        );
        const failed = await f.run(["restore"]);
        assert.equal(failed.code, 2);
        assert.match(failed.err, /Multiple pi processes are running for session duplicate-id/);
        assert.deepEqual(f.snapshotCandidates(), [{ id: "duplicate-id", cwd: f.cwdA }]);
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshotCandidates(), [{ id: "duplicate-id", cwd: f.cwdA }]);
        await f.tmux(["kill-server"]);
        assert.equal((await f.run(["restore"])).code, 0);
        assert.equal((await firstPane(f)).id, "duplicate-id");
        assert.deepEqual(f.snapshotCandidates(), [{ id: "duplicate-id", cwd: f.cwdA }]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "does not replace a populated snapshot when server inspection is rejected",
    async () => {
      await fixture(async (f) => {
        f.saved("saved-id");
        f.seed([{ id: "saved-id", cwd: f.cwdA }]);
        assert.equal((await f.run(["restore"])).code, 0);
        const wrapper = join(f.bin, "tmux");
        const previous = readFileSync(wrapper, "utf8");
        writeFileSync(
          wrapper,
          previous.replace(
            'case "$*" in',
            [
              'case "$*" in',
              '  *"list-sessions -F"*) if test "$TEST_REJECT_SNAPSHOT" = 1; then echo "access refused" >&2; exit 1; fi ;;',
            ].join("\n"),
          ),
        );
        const before = f.snapshot();
        const rejected = await f.run(["snapshot"], f.cwdB, { TEST_REJECT_SNAPSHOT: "1" });
        assert.notEqual(rejected.code, 0);
        assert.match(rejected.err, /access refused/);
        assert.deepEqual(f.snapshot(), before);
        assert.equal((await f.panes()).length, 1);
      });
    },
    TIMEOUT_MS,
  );
});

async function stateFor(
  f: MuxFixture,
  id: string,
  source: Awaited<ReturnType<typeof notificationSource>>,
  state: string,
  title: string | null = null,
) {
  return await waitFor(async () => {
    const result = await f.run([
      "state",
      id,
      state,
      "--source",
      JSON.stringify(source),
      "--title",
      JSON.stringify(title),
    ]);
    return result.code === 75 ? undefined : result;
  });
}

async function paneState(f: MuxFixture, pane: string): Promise<unknown> {
  const result = await f.tmux(["show-options", "-pqv", "-t", pane, "@pi_session_state"]);
  assert.equal(result.code, 0, result.err);
  return result.out.trim() ? JSON.parse(result.out) : undefined;
}

async function openClient(
  f: MuxFixture,
  name: string,
  id: string,
  temporary = false,
): Promise<Pane> {
  await f.client(name, ["open", ...(temporary ? ["--temporary"] : []), id]);
  return await waitFor(async () =>
    (await f.panes()).find((pane) => pane.id === id && pane.startup === "ready"),
  );
}

describe("pi-mux temporary lifecycle", () => {
  it(
    "excludes temporary open before startup restoration and all later snapshots, then promotes on running",
    async () => {
      await fixture(async (f) => {
        enableStatePublisher(f);
        f.saved("temporary-id");
        f.saved("other-id", f.cwdB);
        f.seed([
          { id: "temporary-id", cwd: f.cwdA },
          { id: "other-id", cwd: f.cwdB },
        ]);
        const opened = await openClient(f, "temporary-view", "temporary-id", true);
        await waitFor(async () =>
          ((await paneState(f, opened.pane)) as { state?: string })?.state === "waiting-user"
            ? true
            : undefined,
        );
        const before = await f.panes();
        assert.equal(before.length, 2);
        const initialCandidates = f.snapshotCandidates();
        assert.deepEqual(initialCandidates, [{ id: "other-id", cwd: f.cwdB }]);
        const listed = await f.run(["list"]);
        assert.equal(listed.code, 0, listed.err);
        const workspaces = JSON.parse(listed.out) as {
          sessions: { id: string; temporary?: true }[];
        }[];
        const sessions = workspaces.flatMap((workspace) => workspace.sessions);
        assert.equal(sessions.find((entry) => entry.id === opened.id)?.temporary, true);
        assert.equal(
          Object.hasOwn(
            sessions.find((entry) => entry.id === "other-id")!,
            "temporary",
          ),
          false,
        );
        const source = await notificationSource(f, opened);
        for (const state of ["waiting-user", "waiting-approval"]) {
          const published = await stateFor(f, opened.id, source, state, "Viewing only");
          assert.deepEqual(published, { code: 0, out: "", err: "" });
          assert.equal((await f.run(["snapshot"])).code, 0);
          assert.deepEqual(f.snapshotCandidates(), initialCandidates);
        }
        const title = "Quoted 'title' \"\n#{pane_id} $(touch /unsafe)";
        const running = await stateFor(f, opened.id, source, "running", title);
        assert.deepEqual(running, { code: 0, out: "", err: "" });
        assert.deepEqual(await paneState(f, opened.pane), {
          version: 1,
          sessionId: opened.id,
          state: "running",
          title,
        });
        assert.deepEqual(
          new Set(f.snapshotCandidates().map((entry) => entry.id)),
          new Set(["temporary-id", "other-id"]),
        );
        assert.equal((await stateFor(f, opened.id, source, "running", title)).code, 0);
        assert.equal((await stateFor(f, opened.id, source, "waiting-user", title)).code, 0);
        await f.detachAll();
        await openClient(f, "reconnect-temporary", opened.id, true);
        await f.detachAll();
        const after = await f.panes();
        assert.deepEqual(
          after.map(({ id, pid, pane }) => ({ id, pid, pane })),
          before.map(({ id, pid, pane }) => ({ id, pid, pane })),
        );
        const normalList = JSON.parse((await f.run(["list"])).out) as { sessions: object[] }[];
        assert.equal(
          normalList
            .flatMap((workspace) => workspace.sessions)
            .some((session) => Object.hasOwn(session, "temporary")),
          false,
        );
        const clear = await waitFor(async () => {
          const result = await f.run([
            "state",
            opened.id,
            "--clear",
            "--source",
            JSON.stringify(source),
          ]);
          return result.code === 75 ? undefined : result;
        });
        assert.deepEqual(clear, { code: 0, out: "", err: "" });
        assert.equal(await paneState(f, opened.pane), undefined);
        assert.equal(f.snapshotCandidates().length, 2);
        const closed = await f.run(["close", opened.id]);
        assert.deepEqual(closed, { code: 0, out: "", err: "" });
        assert.deepEqual(f.snapshotCandidates(), initialCandidates);
        assert.equal(existsSync(opened.file), true);
        assert.equal(
          (await f.panes()).find((pane) => pane.id === "other-id")?.pid,
          before.find((pane) => pane.id === "other-id")?.pid,
        );
      });
    },
    TIMEOUT_MS,
  );

  it(
    "normal open promotes the same Pi immediately while temporary reconnection does not",
    async () => {
      await fixture(async (f) => {
        f.saved("view-id");
        const opened = await openClient(f, "first-view", "view-id", true);
        await f.detachAll();
        const reconnected = await openClient(f, "second-view", "view-id", true);
        await f.detachAll();
        assert.equal(reconnected.pid, opened.pid);
        assert.deepEqual(f.snapshotCandidates(), []);
        const promoted = await openClient(f, "normal-view", "view-id");
        await f.detachAll();
        assert.equal(promoted.pid, opened.pid);
        assert.equal(promoted.pane, opened.pane);
        assert.deepEqual(f.snapshotCandidates(), [{ id: "view-id", cwd: f.cwdA }]);
        assert.equal((await f.run(["restore"])).code, 0);
        assert.equal((await f.panes()).length, 1);
        assert.equal((await f.panes())[0]?.pid, opened.pid);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never restores a viewing-only Pi after server restart",
    async () => {
      await fixture(async (f) => {
        f.saved("view-id");
        f.saved("keep-id", f.cwdB);
        f.seed([{ id: "keep-id", cwd: f.cwdB }]);
        await openClient(f, "view-only", "view-id", true);
        await f.detachAll();
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshotCandidates(), [{ id: "keep-id", cwd: f.cwdB }]);
        await f.tmux(["kill-server"]);
        assert.equal((await f.run(["restore"])).code, 0);
        assert.deepEqual(
          (await f.panes()).map((pane) => pane.id),
          ["keep-id"],
        );
      });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps restore candidates untouched when temporary conversation resolution fails",
    async () => {
      await fixture(async (f) => {
        const file = f.saved("duplicate-id");
        f.seed([{ id: "duplicate-id", cwd: f.cwdA }]);
        copyFileSync(file, join(dirname(file), "duplicate.jsonl"));
        const before = readFileSync(join(f.agent, "pi-tmux/pi-mux-restore.json"), "utf8");
        const rejected = await f.run(["open", "--temporary", "duplicate-id"]);
        assert.equal(rejected.code, 1);
        assert.match(rejected.err, /Ambiguous session ID/);
        assert.equal(readFileSync(join(f.agent, "pi-tmux/pi-mux-restore.json"), "utf8"), before);
        assert.deepEqual(await f.panes(), []);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux state identity and persistence boundaries", () => {
  it(
    "does not mark or promote a different conversation in another pane of the temporary session",
    async () => {
      await fixture(async (f) => {
        f.saved("temporary-parent");
        const target = await openClient(f, "same-session-view", "temporary-parent", true);
        await f.detachAll();
        const created = await f.tmux([
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}\t#{pane_pid}",
          "-t",
          target.session,
          "sleep",
          "120",
        ]);
        assert.equal(created.code, 0, created.err);
        const [pane, pid] = created.out.trim().split("\t");
        assert.ok(pane && pid);
        const sibling = {
          id: "sibling-id",
          cwd: target.cwd,
          file: join(f.agent, "sibling.jsonl"),
          pid: Number(pid),
          token: randomUUID(),
        };
        assert.equal(
          (
            await f.tmux([
              "set-option",
              "-p",
              "-t",
              pane,
              "@pi-tmux-session",
              Buffer.from(JSON.stringify(sibling)).toString("base64"),
            ])
          ).code,
          0,
        );
        const source = await notificationSource(f, { pane, pid: sibling.pid });
        assert.equal((await stateFor(f, sibling.id, source, "running")).code, 0);
        assert.equal((await listedSession(f, target.id))?.temporary, true);
        assert.equal((await listedSession(f, sibling.id))?.temporary, undefined);
        assert.deepEqual(f.snapshotCandidates(), []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects an old server's state and clear after socket and pane identifiers are reused",
    async () => {
      await fixture(async (f) => {
        const first = await publishedIdlePane(f);
        const old = await notificationSource(f, { pane: first.pane, pid: first.metadata.pid });
        assert.equal((await stateFor(f, first.metadata.id, old, "running")).code, 0);
        await f.tmux(["kill-server"]);
        const replacement = await publishedIdlePane(f);
        const source = await notificationSource(f, {
          pane: replacement.pane,
          pid: replacement.metadata.pid,
        });
        assert.equal(
          (await stateFor(f, replacement.metadata.id, source, "waiting-user", "New lifetime")).code,
          0,
        );
        const before = await paneState(f, replacement.pane);
        assert.equal((await stateFor(f, first.metadata.id, old, "running")).code, 1);
        assert.equal(
          (await f.run(["state", first.metadata.id, "--clear", "--source", JSON.stringify(old)]))
            .code,
          1,
        );
        assert.deepEqual(await paneState(f, replacement.pane), before);
      });
    },
    TIMEOUT_MS,
  );

  for (const failure of ["write-denied", "invalid-record"] as const) {
    it(
      `repairs an already published running promotion after ${failure} without stopping Pi`,
      async () => {
        await fixture(async (f) => {
          const configuration = join(f.env.HOME, ".config/tmux/pi.conf");
          writeFileSync(
            configuration,
            readFileSync(configuration, "utf8").replace(/^set-hook.*$/gm, ""),
          );
          f.saved("repair-id");
          const target = await openClient(f, "repair-view", "repair-id", true);
          await f.detachAll();
          const source = await notificationSource(f, target);
          const stateDirectory = join(f.agent, "pi-tmux");
          const path = join(stateDirectory, "pi-mux-restore.json");
          const original = readFileSync(path, "utf8");
          try {
            if (failure === "write-denied") chmodSync(stateDirectory, 0o500);
            else writeFileSync(path, "{broken");
            const failed = await stateFor(
              f,
              target.id,
              source,
              "running",
              "Published before persistence",
            );
            assert.equal(failed.code, 1);
            assert.match(failed.err, /repair-id/);
            assert.deepEqual(await paneState(f, target.pane), {
              version: 1,
              sessionId: target.id,
              state: "running",
              title: "Published before persistence",
            });
            assert.equal(
              readFileSync(path, "utf8"),
              failure === "write-denied" ? original : "{broken",
            );
            assert.equal((await f.panes())[0]?.pid, target.pid);
          } finally {
            chmodSync(stateDirectory, 0o700);
            if (failure === "invalid-record") writeFileSync(path, original);
          }
          assert.deepEqual(
            await stateFor(f, target.id, source, "running", "Published before persistence"),
            { code: 0, out: "", err: "" },
          );
          assert.deepEqual(f.snapshotCandidates(), [{ id: target.id, cwd: target.cwd }]);
          assert.equal((await f.panes())[0]?.pid, target.pid);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "repairs a failed normal-open promotion on the same running Pi",
    async () => {
      await fixture(async (f) => {
        const configuration = join(f.env.HOME, ".config/tmux/pi.conf");
        writeFileSync(
          configuration,
          readFileSync(configuration, "utf8").replace(/^set-hook.*$/gm, ""),
        );
        f.saved("open-repair-id");
        const target = await openClient(f, "open-repair-view", "open-repair-id", true);
        await f.detachAll();
        const directory = join(f.agent, "pi-tmux");
        const original = f.snapshot();
        try {
          chmodSync(directory, 0o500);
          const failed = await f.run(["open", target.id]);
          assert.equal(failed.code, 1);
          assert.match(failed.err, /Cannot update open session open-repair-id/);
          assert.deepEqual(f.snapshot(), original);
        } finally {
          chmodSync(directory, 0o700);
        }
        const repaired = await openClient(f, "open-repair-normal", target.id);
        await f.detachAll();
        assert.equal(repaired.pid, target.pid);
        assert.deepEqual(f.snapshotCandidates(), [{ id: target.id, cwd: target.cwd }]);
      });
    },
    TIMEOUT_MS,
  );

  for (const store of ["absent", "invalid", "unreadable"] as const) {
    it(
      `publishes and clears on an external uninitialized server with ${store} restore record`,
      async () => {
        await fixture(async (f) => {
          const { pane, metadata } = await publishedIdlePane(f, "legacy", "external-id");
          const source = await notificationSource(f, { pane, pid: metadata.pid });
          const storePath = join(f.agent, "pi-tmux/pi-mux-restore.json");
          mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
          if (store === "invalid") writeFileSync(storePath, "{broken");
          if (store === "unreadable") mkdirSync(storePath);
          for (const state of ["waiting-user", "running", "waiting-approval"]) {
            const result = await stateFor(f, metadata.id, source, state);
            assert.deepEqual(result, { code: 0, out: "", err: "" });
          }
          assert.equal((await f.tmux(["show-options", "-gqv", "@pi-mux-generation"])).out, "");
          const cleaned = await f.run([
            "state",
            metadata.id,
            "--clear",
            "--source",
            JSON.stringify(source),
          ]);
          assert.deepEqual(cleaned, { code: 0, out: "", err: "" });
          assert.equal(await paneState(f, pane), undefined);
          if (store === "absent") assert.equal(existsSync(storePath), false);
          if (store === "invalid") assert.equal(readFileSync(storePath, "utf8"), "{broken");
          if (store === "unreadable") assert.equal(existsSync(storePath), true);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "rejects duplicate live identities before publishing or clearing",
    async () => {
      await fixture(async (f) => {
        const first = await publishedIdlePane(f, "ready", "duplicate-first");
        const source = await notificationSource(f, { pane: first.pane, pid: first.metadata.pid });
        assert.equal((await stateFor(f, first.metadata.id, source, "waiting-user")).code, 0);
        const before = await paneState(f, first.pane);
        const other = await publishedIdlePane(f, "ready", "duplicate-second");
        const metadata = { ...other.metadata, id: first.metadata.id };
        assert.equal(
          (
            await f.tmux([
              "set-option",
              "-p",
              "-t",
              other.pane,
              "@pi-tmux-session",
              Buffer.from(JSON.stringify(metadata)).toString("base64"),
            ])
          ).code,
          0,
        );
        assert.equal((await stateFor(f, first.metadata.id, source, "running")).code, 1);
        assert.equal(
          (await f.run(["state", first.metadata.id, "--clear", "--source", JSON.stringify(source)]))
            .code,
          1,
        );
        assert.deepEqual(await paneState(f, first.pane), before);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects each stale source component and a mismatched conversation without changing publication",
    async () => {
      await fixture(async (f) => {
        const { pane, metadata } = await publishedIdlePane(f);
        const source = await notificationSource(f, { pane, pid: metadata.pid });
        assert.equal((await stateFor(f, metadata.id, source, "waiting-user", "Original")).code, 0);
        const original = await paneState(f, pane);
        const badSources = [
          { ...source, socket: f.outer },
          { ...source, serverPid: source.serverPid + 1 },
          { ...source, pane: "%99999" },
          { ...source, pid: source.pid + 1 },
          { ...source, token: "11111111-2222-4333-8444-555555555555" },
        ];
        for (const invalid of badSources) {
          const failed = await stateFor(f, metadata.id, invalid, "running");
          assert.equal(failed.code, 1, JSON.stringify(invalid));
          assert.match(failed.err, new RegExp(metadata.id));
          assert.deepEqual(await paneState(f, pane), original);
          assert.equal(
            (await f.run(["state", metadata.id, "--clear", "--source", JSON.stringify(invalid)]))
              .code,
            1,
          );
        }
        assert.equal((await stateFor(f, "other-id", source, "running")).code, 1);
        assert.deepEqual(await paneState(f, pane), original);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "publishes running under the shared lock when promotion and repair are unnecessary",
    async () => {
      await fixture(async (f) => {
        const { pane, metadata } = await publishedIdlePane(f);
        const source = await notificationSource(f, { pane, pid: metadata.pid });
        const stateDirectory = join(f.agent, "pi-tmux");
        mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
        const key = createHash("sha256").update(realpathSync(stateDirectory)).digest("hex");
        const lock = createServer();
        await new Promise<void>((resolve, reject) => {
          lock.once("error", reject);
          lock.listen(`\0pi-mux-${process.getuid!()}-${key}`, resolve);
        });
        try {
          const result = await stateFor(f, metadata.id, source, "running");
          assert.deepEqual(result, { code: 0, out: "", err: "" });
          assert.deepEqual(await paneState(f, pane), {
            version: 1,
            sessionId: metadata.id,
            state: "running",
            title: null,
          });
          assert.equal(existsSync(join(stateDirectory, "pi-mux-restore.json")), false);
        } finally {
          await new Promise<void>((resolve) => lock.close(() => resolve()));
        }
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux temporary conversations", () => {
  it("parses only the leading temporary flag and validates state payloads before side effects", () => {
    assert.deepEqual(parseOperation(["open", "--temporary", "complete-id"]), {
      kind: "open",
      temporary: true,
      id: "complete-id",
    });
    assert.deepEqual(parseOperation(["open", "complete-id"]), {
      kind: "open",
      temporary: false,
      id: "complete-id",
    });
    for (const argv of [
      ["open", "--temporary"],
      ["open", "complete-id", "--temporary"],
      ["open", "--temporary", "--temporary", "complete-id"],
    ])
      assert.throws(() => parseOperation(argv), /usage:/);
    const source = {
      socket: "/tmp/server.sock",
      serverPid: 1,
      pane: "%0",
      pid: 2,
      token: "11111111-2222-4333-8444-555555555555",
    };
    const json = JSON.stringify(source);
    assert.deepEqual(
      parseOperation(["state", "complete-id", "running", "--title", '"title"', "--source", json]),
      {
        kind: "state",
        id: "complete-id",
        source,
        notification: { clear: false, state: "running", title: "title" },
      },
    );
    for (const args of [
      ["running", "--source", json],
      ["running", "--title", "1", "--source", json],
      ["running", "--title", "null", "--source", "{}"],
      ["running", "--title", "null", "--source", "{broken"],
      ["running", "--title", "null", "--source", json, "--source", json],
      ["--clear", "--source", json, "--title", "null"],
      ["idle", "--source", json, "--title", "null"],
    ])
      assert.throws(() => parseOperation(["state", "complete-id", ...args]), /state complete-id:/);
  });

  it(
    "excludes a temporary target before restoring other candidates and normally opens the same Pi without downgrade",
    async () => {
      await fixture(async (f) => {
        enableStatePublisher(f);
        f.saved("temporary-target");
        f.saved("other-retained", f.cwdB);
        f.seed([
          { id: "temporary-target", cwd: f.cwdA },
          { id: "other-retained", cwd: f.cwdB },
        ]);
        await f.client("browse", ["open", "--temporary", "temporary-target"]);
        const target = await waitFor(async () =>
          (await f.panes()).find((pane) => pane.id === "temporary-target"),
        );
        await waitFor(async () =>
          (await listedSession(f, target.id))?.state === "waiting-user" ? true : undefined,
        );
        const other = (await f.panes()).find((pane) => pane.id === "other-retained");
        assert.ok(other);
        assert.equal((await f.panes()).length, 2);
        assert.equal((await listedSession(f, target.id))?.temporary, true);
        for (let i = 0; i < 2; i++) {
          const snapshot = await f.run(["snapshot"]);
          assert.equal(snapshot.code, 0, snapshot.err);
          assert.deepEqual(f.snapshotCandidates(), [{ id: other.id, cwd: other.cwd }]);
        }
        const origin = JSON.stringify(await notificationSource(f, target));
        const title = await f.run([
          "state",
          target.id,
          "waiting-approval",
          "--source",
          origin,
          "--title",
          '"Browsing title"',
        ]);
        assert.equal(title.code, 0, title.err);
        assert.equal((await listedSession(f, target.id))?.temporary, true);
        assert.equal((await listedSession(f, target.id))?.title, "Browsing title");
        const clear = await f.run(["state", target.id, "--clear", "--source", origin]);
        assert.equal(clear.code, 0, clear.err);
        assert.equal((await listedSession(f, target.id))?.temporary, true);
        await f.detachAll();
        assert.equal(await f.exitCode("browse"), 0);
        await f.client("normal", ["open", target.id]);
        await waitFor(() =>
          f.snapshotCandidates().some((entry) => entry.id === target.id) ? true : undefined,
        );
        await f.detachAll();
        assert.equal(await f.exitCode("normal"), 0);
        assert.equal((await listedSession(f, target.id))?.temporary, undefined);
        await f.client("no-downgrade", ["open", "--temporary", target.id]);
        await f.detachAll();
        assert.equal(await f.exitCode("no-downgrade"), 0);
        const current = (await f.panes()).find((pane) => pane.id === target.id)!;
        assert.deepEqual(
          { pid: current.pid, pane: current.pane },
          { pid: target.pid, pane: target.pane },
        );
        assert.equal((await f.panes()).length, 2);
        assert.equal((await listedSession(f, target.id))?.temporary, undefined);
        assert.equal(readdirSync(f.root).filter((entry) => entry.startsWith("argv-")).length, 2);
        const closed = await f.run(["close", target.id]);
        assert.equal(closed.code, 0, closed.err);
        assert.deepEqual(
          (await f.panes()).map((pane) => pane.id),
          [other.id],
        );
        assert.ok(existsSync(target.file));
      });
    },
    TIMEOUT_MS,
  );

  it(
    "promotes the existing Pi from the real publisher's running event and retains it after settling",
    async () => {
      await fixture(async (f) => {
        enableStatePublisher(f);
        f.saved("execute-temporary");
        await f.client("execute", ["open", "--temporary", "execute-temporary"]);
        const target = await firstPane(f);
        await waitFor(async () =>
          (await listedSession(f, target.id))?.state === "waiting-user" ? true : undefined,
        );
        assert.equal((await listedSession(f, target.id))?.temporary, true);
        assert.deepEqual(f.snapshotCandidates(), []);
        await f.persist(target);
        await waitFor(() =>
          f.snapshotCandidates().some((entry) => entry.id === target.id) ? true : undefined,
        );
        await waitFor(async () =>
          (await listedSession(f, target.id))?.state === "waiting-user" ? true : undefined,
        );
        const origin = JSON.stringify(await notificationSource(f, target));
        const repeated = await f.run([
          "state",
          target.id,
          "running",
          "--title",
          "null",
          "--source",
          origin,
        ]);
        assert.equal(repeated.code, 0, repeated.err);
        const waited = await f.run([
          "state",
          target.id,
          "waiting-user",
          "--title",
          "null",
          "--source",
          origin,
        ]);
        assert.equal(waited.code, 0, waited.err);
        assert.equal((await listedSession(f, target.id))?.temporary, undefined);
        assert.equal((await f.panes())[0]!.pid, target.pid);
        assert.equal((await f.panes()).length, 1);
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshotCandidates(), [{ id: target.id, cwd: target.cwd }]);
        await f.detachAll();
        assert.equal(await f.exitCode("execute"), 0);
        const closed = await f.run(["close", target.id]);
        assert.equal(closed.code, 0, closed.err);
        assert.ok(existsSync(target.file));
      });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps a temporary-only conversation out of restore after closing and validates missing targets without removing candidates",
    async () => {
      await fixture(async (f) => {
        f.saved("browse-close");
        f.seed([{ id: "browse-close", cwd: f.cwdA }]);
        const before = f.snapshot();
        const missing = await f.run(["open", "--temporary", "missing-id"]);
        assert.equal(missing.code, 1);
        assert.deepEqual(f.snapshot(), before);
        await f.client("browse-close", ["open", "--temporary", "browse-close"]);
        const target = await firstPane(f);
        await f.detachAll();
        assert.equal(await f.exitCode("browse-close"), 0);
        const closed = await f.run(["close", target.id]);
        assert.equal(closed.code, 0, closed.err);
        assert.deepEqual(f.snapshotCandidates(), []);
        assert.equal((await f.run(["restore"])).code, 0);
        assert.deepEqual(await f.panes(), []);
        assert.ok(existsSync(target.file));
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux conditional close", () => {
  it("parses only the leading --if-temporary flag", () => {
    assert.deepEqual(parseOperation(["close", "--if-temporary", "complete-id"]), {
      kind: "close",
      id: "complete-id",
      ifTemporary: true,
    });
    assert.deepEqual(parseOperation(["close", "complete-id"]), {
      kind: "close",
      id: "complete-id",
      ifTemporary: false,
    });
    for (const argv of [
      ["close", "complete-id", "--if-temporary"],
      ["close", "--if-temporary", "--if-temporary", "complete-id"],
      ["close", "--if-temporary"],
    ])
      assert.throws(() => parseOperation(argv), /usage:/);
  });

  it(
    "stops a temporary Pi with candidate removal and keeps the saved file",
    async () => {
      await fixture(async (f) => {
        const file = f.saved("conditional-id");
        f.seed([{ id: "other-kept", cwd: f.cwdB }]);
        const opened = await openClient(f, "conditional-view", "conditional-id", true);
        await f.detachAll();
        const result = await f.run(["close", "--if-temporary", opened.id]);
        assert.deepEqual(result, { code: 0, out: "", err: "" });
        assert.deepEqual(await f.panes(), []);
        await waitFor(() =>
          f.snapshotCandidates().some((entry) => entry.id === opened.id) ? undefined : true,
        );
        assert.equal(existsSync(file), true);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps a promoted Pi, its pane, and restore candidates unchanged",
    async () => {
      await fixture(async (f) => {
        f.saved("promoted-id");
        const opened = await openClient(f, "promoted-view", "promoted-id", true);
        const source = await notificationSource(f, opened);
        assert.equal((await stateFor(f, opened.id, source, "running")).code, 0);
        await f.detachAll();
        assert.deepEqual(f.snapshotCandidates(), [{ id: opened.id, cwd: f.cwdA }]);
        const result = await f.run(["close", "--if-temporary", opened.id]);
        assert.deepEqual(result, { code: 0, out: "", err: "" });
        assert.equal((await f.panes())[0]?.pid, opened.pid);
        assert.deepEqual(f.snapshotCandidates(), [{ id: opened.id, cwd: f.cwdA }]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "succeeds without any change when no running target exists",
    async () => {
      await fixture(async (f) => {
        f.saved("absent-id");
        f.seed([{ id: "absent-id", cwd: f.cwdA }]);
        const before = f.snapshot();
        const result = await f.run(["close", "--if-temporary", "absent-id"]);
        assert.deepEqual(result, { code: 0, out: "", err: "" });
        assert.deepEqual(f.snapshot(), before);
        assert.deepEqual(await f.panes(), []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects duplicate live identities without stopping either",
    async () => {
      await fixture(async (f) => {
        const first = await publishedIdlePane(f, "ready", "duplicate-close-first");
        const second = await publishedIdlePane(f, "ready", "duplicate-close-second");
        const duplicated = { ...second.metadata, id: first.metadata.id };
        assert.equal(
          (
            await f.tmux([
              "set-option",
              "-p",
              "-t",
              second.pane,
              "@pi-tmux-session",
              Buffer.from(JSON.stringify(duplicated)).toString("base64"),
            ])
          ).code,
          0,
        );
        const result = await f.run(["close", "--if-temporary", first.metadata.id]);
        assert.equal(result.code, 1);
        assert.match(result.err, /Multiple pi processes/);
        assert.equal((await f.panes()).length, 2);
        assert.equal(existsSync(`/proc/${first.metadata.pid}`), true);
        assert.equal(existsSync(`/proc/${second.metadata.pid}`), true);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux list title fallback", () => {
  it(
    "resolves the latest session_info name when no published title exists",
    async () => {
      await fixture(async (f) => {
        const { metadata } = await publishedIdlePane(f, "ready", "fallback-id");
        const file = join(f.agent, "sessions", "fallback-id.jsonl");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          [
            JSON.stringify({ type: "session", version: 3, id: metadata.id, cwd: f.cwdA }),
            JSON.stringify({ type: "session_info", name: "Older name" }),
            JSON.stringify({
              type: "message",
              message: { role: "user", content: "first user message" },
            }),
            JSON.stringify({ type: "session_info", name: "Latest name" }),
          ].join("\n") + "\n",
        );
        const listed = JSON.parse((await f.run(["list"])).out) as {
          sessions: { id: string; state: string | null; title: string | null }[];
        }[];
        const session = listed
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === metadata.id);
        assert.ok(session);
        assert.equal(session.title, "Latest name");
        assert.equal(session.state, null);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "falls back to the shaped first user message when no session_info name exists",
    async () => {
      await fixture(async (f) => {
        const { metadata } = await publishedIdlePane(f, "ready", "first-message-id");
        const file = join(f.agent, "sessions", "first-message-id.jsonl");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          [
            JSON.stringify({ type: "session", version: 3, id: metadata.id, cwd: f.cwdA }),
            JSON.stringify({
              type: "message",
              message: { role: "system", content: "preamble" },
            }),
            JSON.stringify({
              type: "message",
              message: {
                role: "user",
                content: [
                  { type: "toolCall", name: "bash", arguments: {} },
                  { type: "text", text: "fix\n\n  the\tbuild" },
                  { type: "text", text: " now" },
                ],
              },
            }),
          ].join("\n") + "\n",
        );
        const listed = JSON.parse((await f.run(["list"])).out) as {
          sessions: { id: string; state: string | null; title: string | null }[];
        }[];
        const session = listed
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === metadata.id);
        assert.ok(session);
        assert.equal(session.title, "fix the build now");
        assert.equal(session.state, null);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "prefers the published title over the saved session name",
    async () => {
      await fixture(async (f) => {
        const { pane, metadata } = await publishedIdlePane(f, "ready", "published-id");
        const file = join(f.agent, "sessions", "published-id.jsonl");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          [JSON.stringify({ type: "session_info", name: "Saved name" })].join("\n") + "\n",
        );
        await f.tmux([
          "set-option",
          "-p",
          "-t",
          pane,
          "@pi_session_state",
          JSON.stringify({
            version: 1,
            sessionId: metadata.id,
            state: "running",
            title: "Published name",
          }),
        ]);
        const listed = JSON.parse((await f.run(["list"])).out) as {
          sessions: { id: string; state: string | null; title: string | null }[];
        }[];
        const session = listed
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === metadata.id);
        assert.deepEqual(session, {
          id: metadata.id,
          file: metadata.file,
          state: "running",
          title: "Published name",
          publishPending: null,
        });
      });
    },
    TIMEOUT_MS,
  );

  it(
    "treats an empty latest name as an explicit clear and falls back to the first user message",
    async () => {
      await fixture(async (f) => {
        const { metadata } = await publishedIdlePane(f, "ready", "cleared-id");
        const file = join(f.agent, "sessions", "cleared-id.jsonl");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          [
            JSON.stringify({ type: "session_info", name: "Previous name" }),
            JSON.stringify({
              type: "message",
              message: { role: "user", content: "cleared falls back to me" },
            }),
            JSON.stringify({ type: "session_info", name: "" }),
          ].join("\n") + "\n",
        );
        const listed = JSON.parse((await f.run(["list"])).out) as {
          sessions: { id: string; title: string | null }[];
        }[];
        const session = listed
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === metadata.id);
        assert.equal(session?.title, "cleared falls back to me");
      });
    },
    TIMEOUT_MS,
  );

  it(
    "separates missing session files and uses null titles for unreadable or entry-less files",
    async () => {
      await fixture(async (f) => {
        const created = await publishedIdlePane(f, "ready", "created-id");
        const missing = await publishedIdlePane(f, "ready", "missing-id");
        const plain = await publishedIdlePane(f, "ready", "plain-id");
        const createdFile = join(f.agent, "sessions", "created-id.jsonl");
        rmSync(createdFile);
        rmSync(missing.metadata.file);
        mkdirSync(createdFile, { recursive: true });
        const plainFile = join(f.agent, "sessions", "plain-id.jsonl");
        mkdirSync(dirname(plainFile), { recursive: true });
        writeFileSync(
          plainFile,
          JSON.stringify({ type: "session", version: 3, id: "plain-id" }) + "\n",
        );
        const listed = JSON.parse((await f.run(["list"])).out) as {
          sessions: { id: string; title: string | null }[];
          empty: { id: string; file: string }[];
        }[];
        const titles = new Map(
          listed.flatMap((workspace) => workspace.sessions).map((entry) => [entry.id, entry.title]),
        );
        assert.equal(titles.get(created.metadata.id), null);
        assert.equal(titles.has(missing.metadata.id), false);
        assert.deepEqual(
          listed.flatMap((workspace) => workspace.empty),
          [{ id: missing.metadata.id, file: missing.metadata.file }],
        );
        assert.equal(titles.get(plain.metadata.id), null);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux conditional close edge paths", () => {
  it(
    "stops an initializing temporary managed pi before its metadata is published",
    async () => {
      await fixture(async (f) => {
        const id = "initializing-temporary";
        const launchToken = randomUUID();
        mkdirSync(dirname(f.socket), { recursive: true, mode: 0o700 });
        const created = await f.tmux([
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{session_id}\t#{pane_id}\t#{pane_pid}",
          "-s",
          "initializing-" + id,
          "-c",
          f.cwdA,
          "--",
          "/usr/bin/env",
          `PI_TMUX_SESSION_ID=${id}`,
          `PI_TMUX_TEMPORARY=${id}`,
          `PI_TMUX_LAUNCH_TOKEN=${launchToken}`,
          "sleep",
          "120",
        ]);
        assert.equal(created.code, 0, created.err);
        const [session, pane, pidText] = created.out.trim().split("\t");
        const pid = Number(pidText);
        assert.ok(session && pane && pid);
        assert.equal(
          (await f.tmux(["set-environment", "-t", session, "PI_TMUX_SESSION_ID", id])).code,
          0,
        );
        assert.equal(
          (await f.tmux(["set-environment", "-t", session, "PI_TMUX_TEMPORARY", id])).code,
          0,
        );
        assert.equal(
          (
            await f.tmux([
              "set-option",
              "-p",
              "-t",
              pane,
              "@pi-mux-launch",
              JSON.stringify({ id, pid, token: launchToken }),
            ])
          ).code,
          0,
        );
        const result = await f.run(["close", "--if-temporary", id]);
        assert.deepEqual(result, { code: 0, out: "", err: "" });
        assert.deepEqual(await f.panes(), []);
        assert.equal(existsSync(`/proc/${pid}`), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "returns 0 for a non-temporary target even when the restore record is invalid",
    async () => {
      await fixture(async (f) => {
        f.saved("normal-open-id");
        const opened = await openClient(f, "normal-open-view", "normal-open-id");
        await f.detachAll();
        await f.exitCode("normal-open-view");
        const record = join(f.agent, "pi-tmux/pi-mux-restore.json");
        await waitFor(async () => {
          const observed = readFileSync(record, "utf8");
          await Bun.sleep(200);
          return readFileSync(record, "utf8") === observed ? true : undefined;
        });
        writeFileSync(record, "{broken");
        const promoted = await f.run(["close", "--if-temporary", opened.id]);
        assert.deepEqual(promoted, { code: 0, out: "", err: "" });
        assert.equal((await f.panes())[0]?.pid, opened.pid);
        assert.equal(readFileSync(record, "utf8"), "{broken");
      });
    },
    TIMEOUT_MS,
  );

  it(
    "returns 0 for an absent target without touching an invalid restore record",
    async () => {
      await fixture(async (f) => {
        f.saved("absent-invalid-id");
        f.seed([{ id: "absent-invalid-id", cwd: f.cwdA }]);
        const record = join(f.agent, "pi-tmux/pi-mux-restore.json");
        writeFileSync(record, "{broken");
        const result = await f.run(["close", "--if-temporary", "absent-invalid-id"]);
        assert.deepEqual(result, { code: 0, out: "", err: "" });
        assert.equal(readFileSync(record, "utf8"), "{broken");
        assert.deepEqual(await f.panes(), []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps a temporary pi running and reports an invalid restore record without stopping",
    async () => {
      await fixture(async (f) => {
        f.saved("broken-record-id");
        const opened = await openClient(f, "broken-record-view", "broken-record-id", true);
        await f.detachAll();
        await f.exitCode("broken-record-view");
        const record = join(f.agent, "pi-tmux/pi-mux-restore.json");
        await waitFor(async () => {
          const observed = readFileSync(record, "utf8");
          await Bun.sleep(200);
          return readFileSync(record, "utf8") === observed ? true : undefined;
        });
        writeFileSync(record, "{broken");
        const result = await f.run(["close", "--if-temporary", opened.id]);
        assert.equal(result.code, 1, JSON.stringify(result));
        assert.match(result.err, /Cannot close session broken-record-id/);
        assert.match(result.err, /Cannot read snapshot|Invalid snapshot/);
        assert.equal((await f.panes())[0]?.pid, opened.pid);
        assert.equal(existsSync(`/proc/${opened.pid}`), true);
        assert.equal(readFileSync(record, "utf8"), "{broken");
        assert.equal(existsSync(opened.file), true);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux session messaging", () => {
  it(
    "delivers a sent message into a running session and reports consumption",
    async () => {
      await fixture(async (f) => {
        const sender = randomUUID();
        const created = await f.run(
          ["new", "--detached", "fixture-initial message for messaging"],
          f.cwdA,
        );
        assert.equal(created.code, 0, created.err);
        const pane = await firstPane(f);
        const result = await f.run(
          ["send", "--wait", "30", pane.id, "handover from another session"],
          f.cwdB,
          { PI_SESSION_ID: sender },
        );
        assert.equal(result.code, 0, result.err);
        assert.equal(result.out.trim(), "delivered");
        const transcript = await waitFor(() => {
          const content = existsSync(pane.file) ? readFileSync(pane.file, "utf8") : "";
          return content.includes("agent-message") &&
            content.includes("handover from another session")
            ? content
            : undefined;
        });
        assert.match(transcript, new RegExp(`Message from pi session ${sender} at `));
        const remaining = await f.tmux(["show-options", "-p", "-t", pane.pane]);
        assert.equal(remaining.out.includes("@pi-mux-msg-"), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "fails loudly when the target conversation is not running",
    async () => {
      await fixture(async (f) => {
        const result = await f.run(["send", randomUUID(), "anyone there"]);
        assert.equal(result.code, 1);
        assert.match(result.err, /Session not found/);
      });
    },
    TIMEOUT_MS,
  );
});
