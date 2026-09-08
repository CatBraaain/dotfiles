import assert from "node:assert/strict";
import { describe, it } from "bun:test";

import { Bootstrap, parseConfig, run, type Entry, type Runtime } from "./bootstrap.ts";

const stateCommands = [
  ["brew", "list", "--formula", "-1"],
  ["brew", "list", "--cask", "-1"],
  ["uv", "tool", "list"],
  ["bun", "pm", "ls", "-g"],
  ["gup", "list", "--json"],
] as const;

class FakeRuntime implements Runtime {
  readonly commands: string[][] = [];
  readonly errors: string[] = [];
  readonly logs: string[] = [];
  readonly outputs = new Map<string, string>();
  readonly failures = new Set<string>();

  constructor() {
    for (const command of stateCommands) this.outputs.set(command.join("\0"), "");
    this.outputs.set(["gup", "list", "--json"].join("\0"), "[]");
  }

  execute(command: readonly string[]): void {
    this.commands.push([...command]);
    if (this.failures.has(command.join(" "))) throw new Error(`failed: ${command.join(" ")}`);
  }

  output(command: readonly string[]): string {
    const key = command.join("\0");
    if (this.failures.has(command.join(" "))) throw new Error(`failed: ${command.join(" ")}`);
    return this.outputs.get(key) ?? "";
  }

  outputAllowFailure(command: readonly string[]): string {
    return this.outputs.get(command.join("\0")) ?? "";
  }

  log(message: string): void {
    this.logs.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

function bootstrap(
  entries: readonly Entry[],
  runtime: FakeRuntime,
  platform: "linux" | "windows" = "linux",
  handlers = new Map<string, () => void | Promise<void>>(),
): Bootstrap {
  return new Bootstrap(platform, entries, runtime, handlers);
}

describe("parseConfig", () => {
  it("preserves ordered single-key entries", () => {
    const entries = parseConfig("- apt: curl\n- uv: ruff\n- run: echo ready\n");

    assert.deepEqual(entries, [
      { key: "apt", value: "curl" },
      { key: "uv", value: "ruff" },
      { key: "run", value: "echo ready" },
    ]);
  });

  it("rejects every invalid configuration shape", () => {
    for (const source of [
      "not yaml: [",
      "apt: curl",
      "- curl",
      "- apt: [curl]",
      "- { apt: curl, uv: ruff }",
      "- unknown: value",
    ]) {
      assert.throws(() => parseConfig(source));
    }
  });
});

describe("CLI entrypoint", () => {
  it("rejects missing, extra, and unknown arguments before reading configuration", async () => {
    for (const arguments_ of [[], ["sync", "extra"], ["unknown"]]) {
      const runtime = new FakeRuntime();
      let configReads = 0;

      const exitCode = await run(
        arguments_,
        async () => {
          configReads += 1;
          return "- run: echo ready";
        },
        runtime,
      );

      assert.equal(exitCode, 1);
      assert.equal(configReads, 0);
      assert.deepEqual(runtime.commands, []);
      assert.deepEqual(runtime.errors, [
        "usage: bun undotfiles/bootstrap/bootstrap.ts <sync|diff>",
      ]);
    }
  });

  it("stops before host operations when configuration is missing or invalid", async () => {
    for (const readConfig of [
      async () => {
        throw new Error("config.yaml is missing");
      },
      async () => "- apt: [curl]",
    ]) {
      const runtime = new FakeRuntime();

      const exitCode = await run(["sync"], readConfig, runtime);

      assert.equal(exitCode, 1);
      assert.deepEqual(runtime.commands, []);
      assert.equal(runtime.errors.length, 1);
    }
  });

  it("makes just install a sync entrypoint", async () => {
    const justfile = await Bun.file(new URL("../../justfile", import.meta.url)).text();

    assert.match(justfile, /\ninstall:\n  bun undotfiles\/bootstrap\/bootstrap\.ts sync\n/);
  });
});

describe("sync", () => {
  it("removes undesired packages by manager order before ordered installs", async () => {
    const runtime = new FakeRuntime();
    runtime.outputs.set("brew\0list\0--cask\0-1", "keep-cask\nold-cask");
    runtime.outputs.set("brew\0list\0--formula\0-1", "keep-formula\nold-formula");
    runtime.outputs.set("bun\0pm\0ls\0-g", "keep-bun@1\nold-bun@1");
    runtime.outputs.set(
      "gup\0list\0--json",
      '[{"import_path":"keep-go","name":"keep"},{"import_path":"old-go","name":"old"}]',
    );
    runtime.outputs.set("uv\0tool\0list", "keep-uv 1\nold-uv 1");
    const entries: Entry[] = [
      { key: "uv", value: "keep-uv>=2" },
      { key: "bun", value: "keep-bun@2" },
      { key: "go", value: "keep-go@v2" },
      { key: "brew-formula", value: "keep-formula" },
      { key: "brew-cask", value: "keep-cask" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands.slice(0, 5), [
      ["brew", "uninstall", "--cask", "old-cask"],
      ["brew", "uninstall", "old-formula"],
      ["bun", "remove", "-g", "old-bun"],
      ["gup", "remove", "--force", "old"],
      ["uv", "tool", "uninstall", "old-uv"],
    ]);
    assert.deepEqual(runtime.commands.slice(5, 7), [
      ["uv", "tool", "install", "keep-uv>=2"],
      ["bun", "add", "-g", "keep-bun@2"],
    ]);
    assert.deepEqual(runtime.commands.at(-2), ["brew", "install", "keep-formula"]);
    assert.deepEqual(runtime.commands.at(-1), ["brew", "install", "--cask", "keep-cask"]);
  });

  it("passes every configured package value to its backend install operation", async () => {
    const runtime = new FakeRuntime();
    const entries: Entry[] = [
      { key: "apt", value: "curl=8" },
      { key: "winget", value: "Ignored.On.Linux@1" },
      { key: "uv", value: "ruff==1" },
      { key: "bun", value: "@scope/tool@2" },
      { key: "go", value: "example.com/tool@v3" },
      { key: "brew-formula", value: "jq" },
      { key: "brew-cask", value: "visual-studio-code" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands.slice(0, 5), [
      ["sudo", "apt", "update"],
      ["sudo", "apt", "install", "-y", "curl=8"],
      ["uv", "tool", "install", "ruff==1"],
      ["bun", "add", "-g", "@scope/tool@2"],
      ["gup", "import", "--file", runtime.commands[4]![3]!],
    ]);
    assert.deepEqual(runtime.commands.slice(-2), [
      ["brew", "install", "jq"],
      ["brew", "install", "--cask", "visual-studio-code"],
    ]);
    assert.equal(
      runtime.commands.some((command) => command[0] === "winget"),
      false,
    );
  });

  it("ignores apt on Windows and winget on Linux", async () => {
    const linux = new FakeRuntime();
    const windows = new FakeRuntime();
    const entries: Entry[] = [
      { key: "apt", value: "curl" },
      { key: "winget", value: "Microsoft.PowerToys@0.1" },
    ];

    await bootstrap(entries, linux).sync();
    await bootstrap(entries, windows, "windows").sync();

    assert.deepEqual(linux.commands, [
      ["sudo", "apt", "update"],
      ["sudo", "apt", "install", "-y", "curl"],
    ]);
    assert.deepEqual(windows.commands, [
      ["winget", "install", "--id", "Microsoft.PowerToys", "-e", "--version", "0.1"],
    ]);
  });

  it("continues after a state read failure while skipping that manager", async () => {
    const runtime = new FakeRuntime();
    runtime.failures.add("uv tool list");
    const entries: Entry[] = [
      { key: "uv", value: "ruff" },
      { key: "bun", value: "prettier" },
      { key: "run", value: "echo done" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 1);
    assert.equal(
      runtime.commands.some((command) => command[0] === "uv"),
      false,
    );
    assert.deepEqual(runtime.commands, [
      ["bun", "add", "-g", "prettier"],
      ["bash", "-c", "echo done"],
    ]);
    assert.match(runtime.errors[0]!, /^uv state:/);
  });

  it("records failures and continues with later entries", async () => {
    const runtime = new FakeRuntime();
    runtime.failures.add("bun add -g broken");
    const entries: Entry[] = [
      { key: "bun", value: "broken" },
      { key: "run", value: "echo done" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 1);
    assert.deepEqual(runtime.commands.slice(-2), [
      ["bun", "add", "-g", "broken"],
      ["bash", "-c", "echo done"],
    ]);
  });

  it("calls known custom handlers, rejects unknown handlers, and skips Linux-only handlers on Windows", async () => {
    const runtime = new FakeRuntime();
    let knownCalls = 0;
    const entries: Entry[] = [
      { key: "custom", value: "known" },
      { key: "custom", value: "unknown" },
    ];

    const exitCode = await bootstrap(
      entries,
      runtime,
      "linux",
      new Map([
        [
          "known",
          () => {
            knownCalls += 1;
          },
        ],
      ]),
    ).sync();

    assert.equal(exitCode, 1);
    assert.equal(knownCalls, 1);
    assert.match(runtime.errors.at(-1)!, /unknown custom handler/);

    const windowsRuntime = new FakeRuntime();
    const windowsExitCode = await bootstrap(
      [
        { key: "custom", value: "drawio" },
        { key: "custom", value: "android-sdk" },
      ],
      windowsRuntime,
      "windows",
    ).sync();
    assert.equal(windowsExitCode, 0);
    assert.deepEqual(windowsRuntime.commands, []);
  });

  it("runs commands on every sync with the platform shell", async () => {
    const linux = new FakeRuntime();
    const windows = new FakeRuntime();
    const entries: Entry[] = [{ key: "run", value: "echo ready" }];

    await bootstrap(entries, linux).sync();
    await bootstrap(entries, windows, "windows").sync();

    assert.deepEqual(linux.commands, [["bash", "-c", "echo ready"]]);
    assert.deepEqual(windows.commands, [["pwsh", "-Command", "echo ready"]]);
  });
});

describe("diff", () => {
  it("shows removals before ordered plans without changing the host", async () => {
    const runtime = new FakeRuntime();
    runtime.outputs.set("bun\0pm\0ls\0-g", "old@1");
    const entries: Entry[] = [
      { key: "bun", value: "new@2" },
      { key: "run", value: "echo ready" },
      { key: "custom", value: "known" },
    ];

    const exitCode = await bootstrap(
      entries,
      runtime,
      "linux",
      new Map([["known", () => undefined]]),
    ).diff();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands, []);
    assert.deepEqual(runtime.logs, [
      "remove bun: old",
      "install / update bun: new@2",
      "run: echo ready",
      "custom: known",
    ]);
  });

  it("omits unavailable managers and Windows-only skipped custom handlers from plans", async () => {
    const runtime = new FakeRuntime();
    runtime.failures.add("uv tool list");
    const entries: Entry[] = [
      { key: "apt", value: "curl" },
      { key: "uv", value: "ruff" },
      { key: "custom", value: "drawio" },
      { key: "custom", value: "unknown" },
      { key: "run", value: "echo ready" },
    ];

    const exitCode = await bootstrap(entries, runtime, "windows").diff();

    assert.equal(exitCode, 1);
    assert.deepEqual(runtime.logs, ["custom: unknown", "run: echo ready"]);
    assert.match(runtime.errors[0]!, /^uv state:/);
    assert.match(runtime.errors[1]!, /unknown custom handler/);
  });
});
