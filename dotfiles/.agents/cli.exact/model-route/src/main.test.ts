import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The CLI project dir; bun resolves package.json's main field inside it (the
// same entry the deployed `bun ~/.agents/cli/model-route` uses).
const CLI_DIR = join(import.meta.dir, "..");
const CONFIG_DIR_PARTS = [".agents", "config"];
const homes: string[] = [];

async function routeHome(): Promise<string> {
  const home = await mkdtemp("/tmp/model-route-cli-");
  homes.push(home);
  return home;
}

async function writeConfig(home: string, yaml: string): Promise<void> {
  await mkdir(join(home, ...CONFIG_DIR_PARTS), { recursive: true });
  await writeFile(join(home, ...CONFIG_DIR_PARTS, "agents.yaml"), yaml);
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runAt(home: string, args: string[], options: RunOptions = {}): RunResult {
  const result = Bun.spawnSync([process.execPath, CLI_DIR, ...args], {
    cwd: options.cwd ?? home,
    env: { ...process.env, HOME: home, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

const SPEC_EXAMPLE = `
agents:
  junior:
    class: low
classes:
  low:
    - provider: primary
      model: model-a
      when: "false"
    - provider: backup
      model: family/model-b
`;

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("model-route CLI", () => {
  it("picks the spec example's unconditional fallback for --agent and --class", async () => {
    const home = await routeHome();
    await writeConfig(home, SPEC_EXAMPLE);
    const byAgent = runAt(home, ["--agent", "junior"]);
    assert.equal(byAgent.code, 0);
    assert.equal(byAgent.stdout, '{"provider":"backup","model":"family/model-b"}\n');
    assert.equal(byAgent.stderr, "");
    assert.equal(runAt(home, ["--class", "low"]).stdout, byAgent.stdout);
  });

  it("rejects invalid input with an empty stdout and exit code 1", async () => {
    const home = await routeHome();
    await writeConfig(home, SPEC_EXAMPLE);
    const cases = [
      ["--agent", "junior", "--class", "low"],
      [],
      ["--agent"],
      ["--class"],
      ["--agent", "--class", "junior"],
      ["--agent", "junior", "extra"],
      ["--opt"],
      ["help"],
    ];
    for (const args of cases) {
      const result = runAt(home, args);
      assert.equal(result.code, 1, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.notEqual(result.stderr.trim(), "", args.join(" "));
    }
  });

  it("rejects names not defined in the config, matched exactly", async () => {
    const home = await routeHome();
    await writeConfig(home, SPEC_EXAMPLE);
    for (const args of [
      ["--agent", "nobody"],
      ["--agent", "Junior"],
      ["--class", "middle"],
    ]) {
      const result = runAt(home, args);
      assert.equal(result.code, 1, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.match(result.stderr, new RegExp(args.at(-1)!));
    }
  });

  it("reports a missing config file as a config error with the path", async () => {
    const home = await routeHome();
    const result = runAt(home, ["--agent", "junior"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /agents\.yaml/);
    assert.match(result.stderr, /cannot read config file/);
  });

  it("reports config errors with the config file path and cause", async () => {
    const cases: Array<[string, RegExp]> = [
      ["agents: [unclosed", /invalid YAML/],
      ["- just\n- a list", /config must be a YAML mapping/],
      ["agents: 3\nclasses: {}", /agents must be a mapping/],
      ["agents: {}\nclasses: 7", /classes must be a mapping/],
      ["agents:\n  junior: low\nclasses: {}", /agents\.junior must be a mapping/],
      [
        `agents:\n  junior: {}\nclasses:\n  low:\n    - provider: p\n      model: m`,
        /agents\.junior\.class must be a non-empty string/,
      ],
      [
        `agents:\n  junior:\n    class: ""\nclasses: {}`,
        /agents\.junior\.class must be a non-empty string/,
      ],
      ["agents: {}\nclasses:\n  low: fallback", /classes\.low must be an array/],
      ["agents: {}\nclasses:\n  low:\n    - fallback", /classes\.low\[0\]: candidate must be a mapping/],
      ["agents: {}\nclasses:\n  low:\n    - model: m", /provider must be a non-empty string/],
      [
        "agents: {}\nclasses:\n  low:\n    - provider: p\n      model: \"\"",
        /model must be a non-empty string/,
      ],
      [
        "agents: {}\nclasses:\n  low:\n    - provider: p\n      model: m\n      when: 3",
        /when must be a string/,
      ],
      [
        `agents: {}\nclasses:\n  low:\n    - provider: p\n      model: m\n      when: "true"\n    - provider: q\n      model: n\n      when: "false"`,
        /no unconditional fallback candidate/,
      ],
    ];
    for (const [yaml, cause] of cases) {
      const home = await routeHome();
      await writeConfig(home, yaml);
      const result = runAt(home, ["--agent", "junior"]);
      assert.equal(result.code, 1, yaml);
      assert.equal(result.stdout, "", yaml);
      assert.match(result.stderr, /agents\.yaml/, yaml);
      assert.match(result.stderr, cause, yaml);
    }
  });

  it("validates the whole config even when the requested class is fine", async () => {
    const home = await routeHome();
    await writeConfig(home, `
agents:
  junior:
    class: low
  ghost:
    class: gone
classes:
  low:
    - provider: p
      model: m
`);
    const result = runAt(home, ["--class", "low"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /agents\.ghost references undefined class "gone"/);
  });

  it("stops at the first satisfied candidate", async () => {
    const home = await routeHome();
    await writeConfig(home, `
agents:
  junior:
    class: low
classes:
  low:
    - provider: first
      model: m1
      when: "false"
    - provider: second
      model: m2
      when: "true"
    - provider: third
      model: m3
      when: "touch $HOME/evaluated; true"
    - provider: fallback
      model: m4
`);
    const result = runAt(home, ["--agent", "junior"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '{"provider":"second","model":"m2"}\n');
    assert.equal(await exists(join(home, "evaluated")), false);
  });

  it("treats empty and whitespace-only when as unconditional", async () => {
    const home = await routeHome();
    await writeConfig(home, `
agents: {}
classes:
  low:
    - provider: blank
      model: m
      when: ""
    - provider: spaces
      model: m2
      when: "   "
`);
    const result = runAt(home, ["--class", "low"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '{"provider":"blank","model":"m"}\n');
  });

  it("runs when commands with the caller's cwd and environment", async () => {
    const home = await routeHome();
    await writeConfig(home, `
agents:
  junior:
    class: low
classes:
  low:
    - provider: envpick
      model: m
      when: '[ "$MODEL_ROUTE_TEST" = on ]'
    - provider: cwdpick
      model: m2
      when: "test -f marker.txt"
    - provider: fallback
      model: m3
`);
    const withEnv = runAt(home, ["--agent", "junior"], { env: { MODEL_ROUTE_TEST: "on" } });
    assert.equal(withEnv.stdout, '{"provider":"envpick","model":"m"}\n');
    await writeFile(join(home, "marker.txt"), "");
    const inHome = runAt(home, ["--agent", "junior"]);
    assert.equal(inHome.stdout, '{"provider":"cwdpick","model":"m2"}\n');
    const elsewhere = runAt(home, ["--agent", "junior"], { cwd: "/" });
    assert.equal(elsewhere.stdout, '{"provider":"fallback","model":"m3"}\n');
  });

  it("discards when command output and prints only the JSON line", async () => {
    const home = await routeHome();
    await writeConfig(home, `
agents: {}
classes:
  low:
    - provider: p
      model: m
      when: "echo noise-out; echo noise-err >&2; true"
    - provider: fallback
      model: f
`);
    const result = runAt(home, ["--class", "low"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '{"provider":"p","model":"m"}\n');
    assert.equal(result.stderr, "");
  });

  it("evaluates identical provider/model lines independently", async () => {
    const home = await routeHome();
    await writeConfig(home, `
agents: {}
classes:
  low:
    - provider: same
      model: m
      when: "false"
    - provider: same
      model: m
`);
    const result = runAt(home, ["--class", "low"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '{"provider":"same","model":"m"}\n');
  });

  it("skips a when command that exceeds the 5 second limit", async () => {
    // The CLI's own limit is 5s, so allow headroom over bun test's default.
    const home = await routeHome();
    await writeConfig(home, `
agents:
  junior:
    class: low
classes:
  low:
    - provider: slow
      model: m
      when: "sleep 30"
    - provider: fallback
      model: f
`);
    const startedAt = Date.now();
    const result = runAt(home, ["--agent", "junior"]);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.stdout, '{"provider":"fallback","model":"f"}\n');
    assert.ok(elapsedMs < 10_000, `expected the 5s timeout, took ${elapsedMs}ms`);
  }, 20_000);

  it("ignores config items outside the routing schema", async () => {
    const home = await routeHome();
    await writeConfig(home, `
default: main
_systemPrompts:
  overview: hello
agents:
  junior:
    class: low
    tools: ["*"]
    systemPrompt: be nice
    subagents: [senior]
classes:
  low:
    - provider: p
      model: m
      cooldownSeconds: 60
`);
    const result = runAt(home, ["--agent", "junior"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '{"provider":"p","model":"m"}\n');
  });
});
