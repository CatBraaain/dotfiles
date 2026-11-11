import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  mkdirSync(join(agent, "extensions/tools"));
  symlinkSync(
    resolve(EXTENSION_DIR, "../tools/background-bash.ts"),
    join(agent, "extensions/tools/background-bash.ts"),
  );
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
  *"source-file -")
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
      generation: string;
      sessions: { id: string; cwd: string }[];
      pending: { id: string; cwd: string }[];
    };
  }

  function seed(candidates: { id: string; cwd: string }[]) {
    mkdirSync(join(agent, "pi-tmux"), { mode: 0o700 });
    writeFileSync(
      join(agent, "pi-tmux/pi-mux-restore.json"),
      JSON.stringify({
        version: 1,
        generation: "previous-server",
        sessions: candidates,
        pending: [],
      }),
    );
  }

  function saved(id: string, cwd = cwdA) {
    const file = join(agent, "sessions", "fixture_" + id + ".jsonl");
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
  const metadata = {
    id,
    cwd: f.cwdA,
    file: join(f.agent, "sessions", id + ".jsonl"),
    pid: Number(pid),
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

describe("pi-mux read-only list", () => {
  it(
    "returns an empty JSON array without creating directories or requiring launch resources",
    async () => {
      await fixture(async (f) => {
        const before = readdirSync(f.root, { recursive: true }).sort();
        const result = await f.run(["list"], f.cwdB, {
          PI_CODING_AGENT_DIR: join(f.root, "absent-agent"),
        });
        assert.equal(result.code, 0, result.err);
        assert.equal(result.out, "[]\n");
        assert.equal(result.err, "");
        assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), before);
        assert.equal(existsSync(f.socket), false);
        assert.equal(existsSync(dirname(f.socket)), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "does not use or restore a stopped server's snapshot",
    async () => {
      await fixture(async (f) => {
        f.saved("snapshot-only-id");
        f.seed([{ id: "snapshot-only-id", cwd: f.cwdA }]);
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const before = readFileSync(path, "utf8");
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.equal(result.out, "[]\n");
        assert.equal(readFileSync(path, "utf8"), before);
        assert.equal(existsSync(f.socket), false);
        assert.equal(existsSync(dirname(f.socket)), false);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "reads live identities even when the restore file is invalid",
    async () => {
      await fixture(async (f) => {
        const { metadata } = await publishedIdlePane(f);
        mkdirSync(join(f.agent, "pi-tmux"), { mode: 0o700 });
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const invalid = "{invalid restore file\n";
        writeFileSync(path, invalid);
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(JSON.parse(result.out), [
          { id: metadata.id, cwd: metadata.cwd, file: metadata.file, state: null, title: null },
        ]);
        assert.equal(readFileSync(path, "utf8"), invalid);
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
    "returns every live pi as a separate five-field record",
    async () => {
      await fixture(async (f) => {
        const entries = await Promise.all([
          publishedIdlePane(f, "ready", "first-id"),
          publishedIdlePane(f, "accepted", "second-id"),
        ]);
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        const actual = JSON.parse(result.out).sort((a: { id: string }, b: { id: string }) =>
          a.id.localeCompare(b.id),
        );
        const expected = entries
          .map(({ metadata }) => ({
            id: metadata.id,
            cwd: metadata.cwd,
            file: metadata.file,
            state: null,
            title: null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(actual, expected);
        assert.equal(existsSync(join(f.agent, "pi-tmux")), false);
      });
    },
    TIMEOUT_MS,
  );

  for (const state of ["running", "waiting-approval", "waiting-user"] as const) {
    it(
      "returns only the five public fields with state " + state,
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
          const before = readdirSync(f.root, { recursive: true }).sort();
          const options = await f.tmux(["show-options", "-g"]);
          const result = await f.run(["list"]);
          assert.equal(result.code, 0, result.err);
          assert.equal(result.err, "");
          assert.deepEqual(JSON.parse(result.out), [
            { id: metadata.id, cwd: metadata.cwd, file: metadata.file, state, title: null },
          ]);
          assert.equal(existsSync(metadata.file), false);
          assert.equal(existsSync(join(f.agent, "pi-tmux")), false);
          assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), before);
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
            [{ id: metadata.id, cwd: metadata.cwd, file: metadata.file, state, title }],
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
            { id: metadata.id, cwd: metadata.cwd, file: metadata.file, state: null, title: null },
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
            { id: metadata.id, cwd: metadata.cwd, file: metadata.file, state: null, title: null },
          ]);
          assert.equal(existsSync(metadata.file), false);
          f.saved(metadata.id);
          f.seed([{ id: metadata.id, cwd: metadata.cwd }]);
          const restored = await f.run(["restore"]);
          assert.equal(restored.code, 2, restored.err);
          assert.deepEqual(f.snapshot().pending, [{ id: metadata.id, cwd: metadata.cwd }]);
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
          f.snapshot().sessions.some((entry) => entry.id === pane.id) ? true : undefined,
        );
        const path = join(f.agent, "pi-tmux/pi-mux-restore.json");
        const before = readFileSync(path, "utf8");
        const result = await f.run(["list"]);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(JSON.parse(result.out), [
          { id: pane.id, cwd: pane.cwd, file: pane.file, state: null, title: null },
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

  for (const invalid of ["id", "cwd", "file", "pid", "startup"] as const) {
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
        assert.equal(existsSync(join(f.agent, "pi-tmux")), false);
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
        assert.deepEqual(f.snapshot().sessions, []);
        assert.deepEqual(f.snapshot().pending, []);
        const snapshot = JSON.parse(readFileSync(join(directory, "pi-mux-restore.json"), "utf8"));
        assert.deepEqual(Object.keys(snapshot).sort(), [
          "generation",
          "pending",
          "sessions",
          "version",
        ]);
        assert.equal(snapshot.version, 1);
        assert.equal(readFileSync(oldPath, "utf8"), original);
      });
    },
    TIMEOUT_MS,
  );
});

describe("pi-mux new argument contract", () => {
  it("defaults to an attached empty new session", () => {
    assert.deepEqual(parseOperation([]), { kind: "new", detached: false });
    assert.deepEqual(parseOperation(["new"]), { kind: "new", detached: false });
    assert.deepEqual(parseOperation(["new", "--detached"]), { kind: "new", detached: true });
  });

  it("consumes only the first --detached and keeps the next argument as a request", () => {
    assert.deepEqual(parseOperation(["new", "--detached", "--detached"]), {
      kind: "new",
      detached: true,
      request: "--detached",
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
        assert.deepEqual(parseOperation(args), { kind: "new", detached, request });
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
    "reuses one empty session across concurrent detached calls and an attached call in the same cwd",
    async () => {
      await fixture(async (f) => {
        const results = await Promise.all([
          f.run(["new", "--detached"], f.cwdA),
          f.run(["new", "--detached"], f.cwdA),
        ]);
        const pane = await firstPane(f);
        assert.equal(pane.startup, "ready");
        for (const result of results) {
          assert.equal(result.code, 0, result.err);
          assert.match(result.out, new RegExp(`Pi session ${pane.id}\\nAttach with:`));
          assert.ok(result.out.includes(pane.session));
        }
        assert.equal((await f.panes()).length, 1);
        assert.equal(existsSync(pane.file), false);
        assert.equal((await f.tmux(["list-clients"])).out.trim(), "");
        assert.equal(pane.cwd, f.cwdA);
        await f.client("reuse", ["new"], f.cwdA);
        await waitFor(async () =>
          (await f.tmux(["list-clients", "-F", "#{session_id}"])).out.trim() === pane.session
            ? true
            : undefined,
        );
        assert.deepEqual(await f.panes(), [pane]);
        await f.detachAll();
        assert.equal(await f.exitCode("reuse"), 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps concurrent empty reservations separate for different cwds",
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
          const reused = await f.run(["new", "--detached"], cwd);
          assert.equal(reused.code, 0, reused.err);
          assert.ok(reused.out.includes(pane.id));
          await f.client("reuse-" + index, ["new"], cwd);
          await waitFor(async () =>
            (await f.tmux(["list-clients", "-F", "#{session_id}"])).out.trim() === pane.session
              ? true
              : undefined,
          );
          assert.deepEqual(await f.panes(), original);
          await f.detachAll();
          assert.equal(await f.exitCode("reuse-" + index), 0);
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
          const reused = await f.run(["new", "--detached"], f.cwdA);
          assert.equal(reused.code, 0, reused.err);
          assert.ok(reused.out.includes(original.id));
          assert.equal((await f.panes()).length, 2);
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

  for (const sameCwd of [true, false]) {
    it(
      `reuses a legacy pi-empty session only in the same cwd: sameCwd=${sameCwd}`,
      async () => {
        await fixture(async (f) => {
          const opened = await f.run(["new", "--detached"], f.cwdA);
          assert.equal(opened.code, 0, opened.err);
          const original = await firstPane(f);
          const renamed = await f.tmux(["rename-session", "-t", original.session, "pi-empty"]);
          assert.equal(renamed.code, 0, renamed.err);
          const cwd = sameCwd ? f.cwdA : f.cwdB;
          const result = await f.run(["new", "--detached"], cwd);
          assert.equal(result.code, 0, result.err);
          const panes = await f.panes();
          assert.equal(panes.length, sameCwd ? 1 : 2);
          assert.equal(result.out.includes(original.id), sameCwd);
          assert.deepEqual(
            panes.find((pane) => pane.id === original.id),
            original,
          );
          assert.ok(panes.some((pane) => pane.cwd === cwd));
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
  }

  for (const detached of [false, true]) {
    it(
      `starts an independent requested session with detached=${detached} without consuming an empty session`,
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
          const reused = await f.run(["new", "--detached"], f.cwdA);
          assert.equal(reused.code, 0, reused.err);
          assert.ok(reused.out.includes(empty.id));
          assert.equal((await f.panes()).length, 2);
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
    "keeps concurrent new and open attached across a saved reservation rename",
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
        assert.equal(empty.length, 1);
        assert.equal(empty[0]!.cwd, f.cwdA);
        assert.notEqual(empty[0]!.id, first.id);
        assert.notEqual(empty[0]!.pid, first.pid);
        assert.notEqual(empty[0]!.pane, first.pane);
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
      `reopens ${relative ? "a relative" : "an absolute"} project store after runtime loss from another cwd`,
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
          await f.client("reopen", ["open", first.id], f.cwdB);
          const reopened = await firstPane(f);
          assert.equal(reopened.id, first.id);
          assert.equal(reopened.file, first.file);
          assert.equal(reopened.cwd, f.cwdA);
          assert.notEqual(reopened.pid, first.pid);
          await f.detachAll();
          assert.equal(await f.exitCode("reopen"), 0);
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const symlink of [false, true]) {
    it(
      `reopens registered ${symlink ? "symlink" : "ordinary"} storage below the standard root without false ambiguity`,
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
          await f.client("reopen", ["open", first.id], f.cwdB);
          const reopened = await firstPane(f);
          assert.equal(reopened.id, first.id);
          assert.equal(realpathSync(reopened.file), realpathSync(first.file));
          assert.equal(reopened.cwd, f.cwdA);
          assert.notEqual(reopened.pid, first.pid);
          await f.client("same-file-open", ["open", first.id], f.cwdB);
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
    "retains every concurrently registered project storage directory",
    async () => {
      await fixture(async (f) => {
        const directories = Array.from({ length: 8 }, (_, index) =>
          join(f.root, "project-" + index),
        );
        const stores = directories.map((cwd) => join(cwd, "store"));
        for (const [index, cwd] of directories.entries()) {
          mkdirSync(join(cwd, ".pi"), { recursive: true });
          writeFileSync(
            join(cwd, ".pi/settings.json"),
            JSON.stringify({ sessionDir: stores[index] }),
          );
        }
        const results = await Promise.all(
          directories.map((cwd) => f.run(["open", "missing-id"], cwd)),
        );
        for (const result of results) assert.match(result.err, /Session not found/);
        const registry = join(f.agent, "pi-tmux/session-dirs");
        const recorded = readdirSync(registry)
          .filter((name) => name.endsWith(".json"))
          .map((name) => JSON.parse(readFileSync(join(registry, name), "utf8")));
        assert.deepEqual(recorded.sort(), stores.sort());
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects duplicate saved IDs before attaching to a live pi and permits an unsaved live ID",
    async () => {
      await fixture(async (f) => {
        await f.client("initial", ["new"], f.cwdA);
        const first = await firstPane(f);
        await f.persist(first);
        await f.detachAll();
        const duplicate = join(f.agent, "sessions/duplicate.jsonl");
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
          assert.deepEqual(f.snapshot().pending, []);
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
          f.snapshot().sessions.some((entry) => entry.id === "raw-id") ? true : undefined,
        );
        assert.deepEqual(f.snapshot().sessions, [{ id: "raw-id", cwd }]);
        assert.deepEqual(await f.panes(), []);
        assert.equal((await f.tmux(["kill-session", "-t", "=raw"])).code, 0);
        await waitFor(() => (f.snapshot().sessions.length === 0 ? true : undefined));
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
          assert.deepEqual(f.snapshot().sessions, [{ id: "saved-id", cwd: f.cwdA }]);
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
        assert.deepEqual(f.snapshot().pending, [{ id: "retry-id", cwd: f.cwdA }]);
        assert.deepEqual(
          (await f.panes()).map((pane) => pane.id),
          ["good-id"],
        );
        await f.client("normal", ["new"]);
        const normal = await waitFor(async () =>
          (await f.panes()).find((pane) => pane.id !== "good-id"),
        );
        await waitFor(() =>
          f.snapshot().sessions.some((entry) => entry.id === normal.id) ? true : undefined,
        );
        assert.deepEqual(f.snapshot().pending, [{ id: "retry-id", cwd: f.cwdA }]);
        await f.detachAll();
        assert.equal(await f.exitCode("normal"), 0);
        await f.tmux(["kill-server"]);
        rmSync(join(f.root, "fail-startup"));
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        assert.deepEqual((await f.panes()).map((pane) => pane.id).sort(), ["good-id", "retry-id"]);
        assert.deepEqual(f.snapshot().pending, []);
        assert.deepEqual(
          f
            .snapshot()
            .sessions.map((entry) => entry.id)
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
          assert.deepEqual(f.snapshot().pending, [{ id: "retry-id", cwd }]);
          assert.equal((await f.run(["snapshot"])).code, 0);
          assert.deepEqual(f.snapshot().pending, [{ id: "retry-id", cwd }]);
          await f.tmux(["kill-server"]);
          if (failure === "cwd") mkdirSync(cwd);
          if (failure === "duplicate") rmSync(duplicate);
          if (failure === "invalid" || failure === "invalid-shape") writeFileSync(file, contents);
          if (failure === "access") chmodSync(file, 0o600);
          const retry = await f.run(["restore"]);
          assert.equal(retry.code, 0, retry.err);
          assert.equal((await firstPane(f)).id, "retry-id");
          assert.deepEqual(f.snapshot().pending, []);
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
            .snapshot()
            .pending.map((entry) => entry.id)
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
        assert.deepEqual(f.snapshot().pending, []);
        await f.detachAll(2);
        assert.equal(await f.exitCode("normal"), 0);
        assert.equal(await f.exitCode("same"), 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "releases a killed restore owner's lock without losing its pending set",
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
            .snapshot()
            .pending.map((entry) => entry.id)
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
        assert.deepEqual(f.snapshot().pending, []);
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
    "never removes pending candidates using initial-request acceptance metadata",
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
          f.snapshot().sessions.some((entry) => entry.id === pane.id) ? true : undefined,
        );
        const attempted = await f.run(["restore"]);
        assert.equal(attempted.code, 2, attempted.err);
        assert.match(attempted.err, /not confirmed initialization completion/);
        assert.deepEqual(f.snapshot().pending, [{ id: pane.id, cwd: pane.cwd }]);
        writeFileSync(released, "");
        await waitFor(async () => ((await f.panes()).length === 0 ? true : undefined));
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshot().pending, [{ id: pane.id, cwd: pane.cwd }]);
        await f.tmux(["kill-server"]);
        rmSync(extension);
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        assert.equal((await firstPane(f)).startup, "ready");
        assert.deepEqual(f.snapshot().pending, []);
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
              assert.deepEqual(f.snapshot().pending, [candidate]);
            } finally {
              writeFileSync(released, "");
            }
            const error = await new Response(restoring.stderr).text();
            assert.equal(await restoring.exited, outcome === "ready" ? 0 : 2, error);
            if (outcome === "exit") {
              assert.match(error, /pi exited before startup/);
              await waitFor(() => (f.snapshot().sessions.length === 0 ? true : undefined));
              assert.deepEqual(f.snapshot().pending, [candidate]);
              assert.equal((await f.run(["snapshot"])).code, 0);
              assert.deepEqual(f.snapshot().pending, [candidate]);
              assert.equal(existsSync(file), true);
              rmSync(extension);
              await f.tmux(["kill-server"]);
              const retried = await f.run(["restore"]);
              assert.equal(retried.code, 0, retried.err);
            }
            const pane = await firstPane(f);
            assert.equal(pane.id, candidate.id);
            assert.deepEqual(f.snapshot().pending, []);
            assert.deepEqual(f.events(), []);
            assert.equal(existsSync(join(f.cwdA, "should-not-run")), false);
            await f.tmux(["send-keys", "-t", pane.pane, "C-d"]);
            await waitFor(() => (f.snapshot().sessions.length === 0 ? true : undefined));
            assert.deepEqual(f.snapshot().pending, []);
            assert.equal(existsSync(file), true);
          });
        },
        TIMEOUT_MS,
      );
    }
  }

  for (const failure of ["factory", "unavailable", "denied"] as const) {
    it(
      `retains a candidate without replay after ${failure} startup failure`,
      async () => {
        await fixture(async (f) => {
          const candidate = { id: "startup-failure-id", cwd: f.cwdA };
          f.saved(candidate.id);
          f.seed([candidate]);
          const extension = join(f.agent, "extensions/z-broken.ts");
          const tools = join(f.agent, "extensions/fixture-tools.ts");
          const toolsSource = readFileSync(tools, "utf8");
          const guardrails = join(f.root, "guardrails.yaml");
          const policy = readFileSync(guardrails, "utf8");
          if (failure === "factory")
            writeFileSync(
              extension,
              'export default function () { throw new Error("startup factory failure"); }',
            );
          else if (failure === "unavailable") rmSync(tools);
          else
            writeFileSync(
              join(f.root, "guardrails.yaml"),
              'commands:\n  - ".*":\n      - deny: []\n',
            );
          const failed = await f.run(["restore"]);
          assert.equal(failed.code, 2, failed.err);
          assert.match(failed.err, /pi exited before startup/);
          assert.deepEqual(f.events(), []);
          assert.deepEqual(f.snapshot().pending, [candidate]);
          assert.equal((await f.run(["snapshot"])).code, 0);
          assert.deepEqual(f.snapshot().pending, [candidate]);
          rmSync(extension, { force: true });
          writeFileSync(tools, toolsSource);
          writeFileSync(guardrails, policy);
          await f.tmux(["kill-server"]);
          const retried = await f.run(["restore"]);
          assert.equal(retried.code, 0, retried.err);
          assert.equal((await firstPane(f)).id, candidate.id);
          assert.deepEqual(f.snapshot().pending, []);
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
        assert.deepEqual(f.snapshot().pending, [candidate]);
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshot().pending, [candidate]);
        await f.tmux(["kill-server"]);
        rmSync(extension);
        const retried = await f.run(["restore"]);
        assert.equal(retried.code, 0, retried.err);
        assert.equal((await firstPane(f)).id, candidate.id);
        assert.deepEqual(f.snapshot().pending, []);
        assert.deepEqual(f.events(), []);
      });
    },
    TIMEOUT_MS + 30_000,
  );
});

describe("pi-mux conservative failure handling", () => {
  it(
    "retains a candidate when its registered storage root is inaccessible",
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
          assert.deepEqual(f.snapshot().pending, [{ id: "inaccessible-id", cwd: f.cwdA }]);
          assert.equal((await f.run(["snapshot"])).code, 0);
          await f.tmux(["kill-server"]);
        } finally {
          chmodSync(restricted, 0o700);
        }
        const restored = await f.run(["restore"]);
        assert.equal(restored.code, 0, restored.err);
        assert.equal((await firstPane(f)).id, "inaccessible-id");
        assert.deepEqual(f.snapshot().pending, []);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "keeps duplicate running identities pending until the next server generation",
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
        assert.deepEqual(f.snapshot().pending, [{ id: "duplicate-id", cwd: f.cwdA }]);
        assert.equal((await f.run(["snapshot"])).code, 0);
        assert.deepEqual(f.snapshot().pending, [{ id: "duplicate-id", cwd: f.cwdA }]);
        await f.tmux(["kill-server"]);
        assert.equal((await f.run(["restore"])).code, 0);
        assert.equal((await firstPane(f)).id, "duplicate-id");
        assert.deepEqual(f.snapshot().pending, []);
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
