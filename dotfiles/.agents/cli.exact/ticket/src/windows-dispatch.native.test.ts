import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatcherName } from "./dispatch";

const psmux = process.platform === "win32" ? Bun.which("psmux.exe") : null;
const main = join(import.meta.dir, "main.ts");
const ticketId = "20260626-123456";

async function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = Bun.spawn(argv, { env, cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function successful(out: Awaited<ReturnType<typeof run>>): string {
  assert.equal(out.code, 0, JSON.stringify(out));
  return out.stdout;
}

async function nativeFixture(
  work: (fixture: {
    env: NodeJS.ProcessEnv;
    root: string;
    ticket(...args: string[]): ReturnType<typeof run>;
    tmux(...args: string[]): ReturnType<typeof run>;
    keep(name: string, ...args: string[]): Promise<void>;
  }) => Promise<void>,
) {
  assert.ok(psmux);
  const root = mkdtempSync(join(tmpdir(), "ticket-dispatch-native-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const data = join(root, "registry");
  mkdirSync(data);
  const socket = join(root, "isolated.sock");
  const config = join(root, "psmux.conf");
  writeFileSync(config, "set -g warm off\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: root,
    HOME: root,
    PSMUX_DATA_DIR: data,
    PSMUX_CONFIG_FILE: config,
    PSMUX_NO_WARM: "1",
    TICKET_TEST_TMUX_SOCKET: socket,
    TICKET_TEST_TICK_MS: "100",
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PATH: `${bin};${dirname(psmux)};${process.env.PATH}`,
  };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH" && key !== "PATH") delete env[key];
  }
  for (const key of [
    "TMUX",
    "TMUX_PANE",
    "PSMUX_TARGET_SESSION",
    "PSMUX_TARGET_FULL",
    "PSMUX_ROUTE_WARM",
  ])
    delete env[key];

  function ticket(...args: string[]) {
    return run([process.execPath, main, "dispatch", ...args], env, root);
  }
  function tmux(...args: string[]) {
    return run([psmux!, "-S", socket, ...args], env, root);
  }
  async function keep(name: string, ...args: string[]) {
    const powershell = join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const command = Buffer.from("Start-Sleep -Seconds 180", "utf16le").toString("base64");
    successful(
      await tmux(
        "new-session",
        "-d",
        "-s",
        name,
        ...args,
        "--",
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        command,
      ),
    );
  }
  try {
    const mock = join(root, "mock.ts");
    writeFileSync(
      mock,
      `
import assert from "node:assert/strict";
const [inspect, action, socket, ...args] = process.argv.slice(2);
assert.equal(inspect, "inspect");
function query(...args) {
  return Bun.spawnSync(["psmux.exe", "-S", socket, ...args], {windowsHide: true});
}
function managementGeneration() {
  const result = query("display-message", "-p", "#{server_instance}");
  const generation = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{16}$/.test(generation)) {
    console.error("no management generation"); process.exit(1);
  }
  return generation;
}
if (action === "--management") {
  if (process.env.TICKET_TEST_MANAGEMENT_READY === "0") {
    console.error("initial restoration pending"); process.exit(1);
  }
  console.log(JSON.stringify({state: "ready", generation: managementGeneration()}));
} else if (action === "--create-dispatch-worker") {
  assert.equal(args.length, 7);
  const [generation, name, project, token, cwd, powershell, encoded] = args;
  assert.equal(generation, managementGeneration());
  assert.equal(name, "ticket_dispatch_" + (project ? Buffer.from(project).toString("hex") : "all"));
  assert.match(token, /^[0-9a-f-]{36}$/);
  const result = query("new-session", "-d", "-s", name, "-c", cwd,
    "-e", "TICKET_DISPATCH_WORKER_TOKEN=" + token,
    "-e", "TICKET_DISPATCH_ROLE=dispatcher",
    "-e", "TICKET_DISPATCH_PROJECT=" + project,
    "--", powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded);
  if (result.exitCode !== 0) console.error(result.stderr.toString());
  process.exit(result.exitCode ?? 1);
} else if (action === "--dispatch-inventory") {
  if (process.env.TICKET_TEST_INVALID_INVENTORY === "1") {
    console.error("incomplete peer inventory"); process.exit(1);
  }
  const listed = query("list-sessions", "-F", "#{session_name} #{session_created}");
  assert.equal(listed.exitCode, 0);
  function environment(name, key) {
    const result = query("show-environment", "-t", "=" + name, key);
    const value = result.stdout.toString().trimEnd();
    if (result.exitCode === 0 && value.startsWith(key + "=")) return value.slice(key.length + 1);
  }
  const sessions = [];
  for (const line of listed.stdout.toString().trim().split(/\\r?\\n/)) {
    const [name, created] = line.split(" ");
    if (environment(name, "TICKET_DISPATCH_ROLE") !== "pi") continue;
    sessions.push({ name, created: Number(created),
      project: environment(name, "TICKET_DISPATCH_PROJECT"), ticketId: environment(name, "TICKET_DISPATCH_ID") });
  }
  console.log(JSON.stringify({ sessions }));
} else {
  console.error("Unexpected pi-mux invocation: " + JSON.stringify([inspect, action, socket, ...args])); process.exit(1);
}
`,
    );
    successful(
      await run(
        [process.execPath, "build", "--compile", mock, "--outfile", join(bin, "pi-mux.exe")],
        env,
        root,
      ),
    );
    await work({ env, root, ticket, tmux, keep });
  } finally {
    await tmux("kill-server");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function seedProject(root: string, project: string): void {
  const store = join(root, ".agents", "tickets", project);
  mkdirSync(store, { recursive: true });
  mkdirSync(join(root, "projects", project), { recursive: true });
  writeFileSync(join(store, `${ticketId}.md`), "---\nstatus: locked\n---\n\n# Test ticket\n");
}

describe.skipIf(!psmux)("native Windows dispatcher with an isolated psmux namespace", () => {
  it("requires restored management even on an empty store and never stops an external worker name", async () => {
    await nativeFixture(async ({ env, root, ticket, tmux, keep }) => {
      const project = "empty";
      mkdirSync(join(root, ".agents", "tickets", project), { recursive: true });
      mkdirSync(join(root, "projects", project), { recursive: true });
      const start = ["start", "--status", "locked", "--project", project];
      const absent = await ticket(...start);
      assert.equal(absent.code, 1, JSON.stringify(absent));
      assert.equal((await tmux("list-sessions")).code, 1);
      await keep("anchor");
      for (const args of [[], ["--status", "open", "--status", "locked"]]) {
        const unsupported = await ticket("start", "--project", project, ...args);
        assert.equal(unsupported.code, 1, JSON.stringify(unsupported));
        assert.match(unsupported.stderr, /requires --status locked/);
      }
      const one = await ticket("one", "--project", project, ticketId);
      assert.equal(one.code, 1, JSON.stringify(one));
      assert.match(one.stderr, /one is not supported/);
      assert.equal(successful(await tmux("list-sessions", "-F", "#{session_name}")), "anchor");
      env.TICKET_TEST_MANAGEMENT_READY = "0";
      const unready = await ticket(...start);
      assert.equal(unready.code, 1, JSON.stringify(unready));
      assert.match(unready.stderr, /initial restoration pending/);
      env.TICKET_TEST_MANAGEMENT_READY = "1";
      env.TICKET_TEST_INVALID_INVENTORY = "1";
      const incomplete = await ticket("start", "--status", "locked", "--all");
      assert.equal(incomplete.code, 1, JSON.stringify(incomplete));
      assert.match(incomplete.stderr, /incomplete peer inventory/);
      assert.equal(successful(await tmux("list-sessions", "-F", "#{session_name}")), "anchor");
      delete env.TICKET_TEST_INVALID_INVENTORY;
      assert.match(successful(await ticket(...start)), /dispatcher started/);
      const deadline = Date.now() + 8_000;
      const name = dispatcherName(project);
      while ((await tmux("has-session", "-t", `=${name}`)).code === 0 && Date.now() < deadline)
        await Bun.sleep(50);
      const compiled = join(root, "ticket.exe");
      successful(
        await run([process.execPath, "build", "--compile", main, "--outfile", compiled], env, root),
      );
      assert.match(
        successful(await run([compiled, "dispatch", ...start], env, root)),
        /dispatcher started/,
      );
      const compiledDeadline = Date.now() + 8_000;
      while (
        (await tmux("has-session", "-t", `=${name}`)).code === 0 &&
        Date.now() < compiledDeadline
      )
        await Bun.sleep(50);
      await keep(name);
      assert.match(successful(await ticket("stop", "--project", project)), /already stopped/);
      successful(await tmux("has-session", "-t", `=${name}`));
    });
  }, 60_000);

  it("lists, replaces and stops only the selected scope while preserving retained pi sessions", async () => {
    await nativeFixture(async ({ root, ticket, tmux, keep }) => {
      const projects = ["quote's project", "second"];
      await keep("anchor");
      for (const [index, project] of projects.entries()) {
        seedProject(root, project);
        await keep(
          `handle_retained_${index}`,
          "-e",
          "TICKET_DISPATCH_ROLE=pi",
          "-e",
          `TICKET_DISPATCH_PROJECT=${project}`,
          "-e",
          `TICKET_DISPATCH_ID=${ticketId}`,
        );
      }
      const [one, two] = projects as [string, string];
      const first = successful(await ticket("start", "--status", "locked", "--project", one));
      assert.equal(first, `dispatcher started: ${dispatcherName(one)}`);
      assert.match(
        successful(await ticket("start", "--status", "locked", "--project", two)),
        /started/,
      );
      const overlap = await ticket("start", "--status", "locked", "--all");
      assert.equal(overlap.code, 1, JSON.stringify(overlap));
      assert.match(overlap.stderr, /overlapping dispatcher/);
      assert.match(successful(await ticket("stop", "--all")), /already stopped/);
      assert.match(
        successful(await ticket("start", "--status", "locked", "--project", one)),
        /restarted/,
      );
      const entries = successful(await ticket("list"));
      assert.ok(
        entries.includes(dispatcherName(one)) && entries.includes(dispatcherName(two)),
        entries,
      );
      assert.match(successful(await ticket("stop", "--project", one)), /dispatcher stopped/);
      assert.match(successful(await ticket("stop", "--project", two)), /dispatcher stopped/);
      assert.equal(successful(await ticket("list")), "no dispatcher running");
      successful(await tmux("has-session", "-t", "=handle_retained_0"));
      successful(await tmux("has-session", "-t", "=handle_retained_1"));
      assert.match(
        successful(await ticket("start", "--status", "locked", "--all")),
        /dispatcher started/,
      );
      assert.match(successful(await ticket("list")), /\(all\)/);
      assert.match(successful(await ticket("stop", "--all")), /dispatcher stopped/);
    });
  }, 90_000);
});
