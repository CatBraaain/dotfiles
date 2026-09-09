import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";

import { Bootstrap, coalesceEntries, parseConfig, run, type Entry, type Runtime } from "./bootstrap.ts";

const stateCommands = [
  ["brew", "leaves"],
  ["brew", "list", "--cask", "-1"],
  ["uv", "tool", "list"],
  ["bun", "pm", "ls", "-g"],
  ["gup", "list", "--json"],
] as const;

class FakeRuntime implements Runtime {
  readonly commands: string[][] = [];
  readonly events: string[] = [];
  readonly errors: string[] = [];
  readonly logs: string[] = [];
  readonly outputs = new Map<string, string>();
  readonly failures = new Set<string>();

  constructor() {
    for (const command of stateCommands) this.outputs.set(command.join("\0"), "");
    this.outputs.set(["gup", "list", "--json"].join("\0"), "[]");
  }

  execute(command: readonly string[]): void {
    this.events.push(`execute ${command.join(" ")}`);
    this.commands.push([...command]);
    if (command.slice(0, 3).join(" ") === "gh release download") {
      const directory = command[command.indexOf("--dir") + 1]!;
      writeFileSync(join(directory, "drawio-amd64-1.0.0.deb"), "");
    }
    if (this.failures.has(command.join(" "))) throw new Error(`failed: ${command.join(" ")}`);
  }

  output(command: readonly string[]): string {
    this.events.push(`output ${command.join(" ")}`);
    const key = command.join("\0");
    if (this.failures.has(command.join(" "))) throw new Error(`failed: ${command.join(" ")}`);
    return this.outputs.get(key) ?? "";
  }

  outputAllowFailure(command: readonly string[]): string {
    this.events.push(`outputAllowFailure ${command.join(" ")}`);
    return this.outputs.get(command.join("\0")) ?? "";
  }

  succeeds(command: readonly string[]): boolean {
    this.events.push(`succeeds ${command.join(" ")}`);
    return !this.failures.has(command.join(" "));
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
  handlers = new Map<string, () => void | Promise<void>>(),
): Bootstrap {
  return new Bootstrap(entries, runtime, handlers);
}

describe("parseConfig", () => {
  it("preserves ordered single-key entries", () => {
    const entries = parseConfig(
      "- apt: curl\n- brew: jq\n- brew-cask: visual-studio-code\n- deb-get: code\n- uv: ruff\n- run: echo ready\n",
    );

    assert.deepEqual(entries, [
      { key: "apt", value: "curl" },
      { key: "brew", value: "jq" },
      { key: "brew-cask", value: "visual-studio-code" },
      { key: "deb-get", value: "code" },
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
      "- winget: Microsoft.PowerToys",
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

  it("declares bootstrap dependencies before their dependent entries", async () => {
    const config = parseConfig(await Bun.file(new URL("./config.yaml", import.meta.url)).text());
    const goRuntimeIndex = config.findIndex(
      (entry) => entry.key === "brew" && entry.value === "go",
    );
    const goIndex = config.findIndex((entry) => entry.key === "go");
    const androidCaskIndex = config.findIndex(
      (entry) => entry.key === "brew-cask" && entry.value === "android-commandlinetools",
    );
    const androidHandlerIndex = config.findIndex(
      (entry) => entry.key === "custom" && entry.value === "android-sdk",
    );

    assert.ok(goRuntimeIndex >= 0 && goRuntimeIndex < goIndex);
    assert.ok(androidCaskIndex >= 0 && androidCaskIndex < androidHandlerIndex);
  });
});

describe("coalesceEntries", () => {
  it("merges consecutive batchable entries with the same key", () => {
    const entries: Entry[] = [
      { key: "brew", value: "jq" },
      { key: "brew", value: "ripgrep" },
      { key: "run", value: "echo ready" },
      { key: "brew", value: "fd" },
      { key: "apt", value: "curl" },
      { key: "apt", value: "wget" },
      { key: "bun", value: "prettier" },
      { key: "uv", value: "ruff" },
      { key: "uv", value: "black" },
      { key: "brew-cask", value: "visual-studio-code" },
      { key: "brew-cask", value: "iterm2" },
    ];

    assert.deepEqual(coalesceEntries(entries), [
      { key: "brew", values: ["jq", "ripgrep"] },
      { key: "run", value: "echo ready" },
      { key: "brew", values: ["fd"] },
      { key: "apt", values: ["curl", "wget"] },
      { key: "bun", values: ["prettier"] },
      { key: "uv", values: ["ruff", "black"] },
      { key: "brew-cask", values: ["visual-studio-code", "iterm2"] },
    ]);
  });

  it("does not merge non-batchable or interrupted sequences", () => {
    const entries: Entry[] = [
      { key: "go", value: "example.com/a" },
      { key: "go", value: "example.com/b" },
      { key: "deb-get", value: "code" },
      { key: "deb-get", value: "other" },
      { key: "brew", value: "jq" },
      { key: "run", value: "echo break" },
      { key: "brew", value: "fd" },
    ];

    assert.deepEqual(coalesceEntries(entries), [
      { key: "go", values: ["example.com/a", "example.com/b"] },
      { key: "deb-get", values: ["code", "other"] },
      { key: "brew", values: ["jq"] },
      { key: "run", value: "echo break" },
      { key: "brew", values: ["fd"] },
    ]);
  });
});

describe("sync", () => {
  it("installs consecutive batchable entries in one backend command", async () => {
    const runtime = new FakeRuntime();
    const entries: Entry[] = [
      { key: "apt", value: "curl" },
      { key: "apt", value: "wget" },
      { key: "brew", value: "jq" },
      { key: "brew", value: "ripgrep" },
      { key: "brew-cask", value: "visual-studio-code" },
      { key: "brew-cask", value: "iterm2" },
      { key: "bun", value: "prettier" },
      { key: "bun", value: "eslint" },
      { key: "uv", value: "ruff" },
      { key: "uv", value: "black" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands.slice(0, 7), [
      ["sudo", "apt", "update"],
      ["sudo", "apt", "install", "-y", "curl", "wget"],
      ["brew", "install", "jq", "ripgrep"],
      ["brew", "install", "--cask", "visual-studio-code", "iterm2"],
      ["bun", "add", "-g", "prettier", "eslint"],
      ["uv", "tool", "install", "ruff"],
      ["uv", "tool", "install", "black"],
    ]);
  });

  it("installs all entries before removing unused packages by manager order", async () => {
    const runtime = new FakeRuntime();
    runtime.outputs.set("brew\0list\0--cask\0-1", "keep-cask\nold-cask");
    runtime.outputs.set("brew\0leaves", "keep-formula\nold-formula");
    runtime.outputs.set(
      "bun\0pm\0ls\0-g",
      "/home/username/.bun/install/global\n├── @scope/tool@1\n└── old-bun@1",
    );
    runtime.outputs.set(
      "gup\0list\0--json",
      '[{"import_path":"keep-go","name":"keep"},{"import_path":"old-go","name":"old"}]',
    );
    runtime.outputs.set("uv\0tool\0list", "trafilatura 1\n- trafilatura\nold-uv 1\n- old-uv");
    const entries: Entry[] = [
      { key: "uv", value: "trafilatura[all]" },
      { key: "bun", value: "@scope/tool@2" },
      { key: "go", value: "keep-go@v2" },
      { key: "brew", value: "keep-formula" },
      { key: "brew-cask", value: "keep-cask" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 0);
    const firstStateRead = runtime.events.indexOf("output brew list --cask -1");
    const firstCleanup = runtime.events.indexOf("execute brew uninstall --cask old-cask");
    assert.ok(firstStateRead > 4);
    assert.equal(firstCleanup - firstStateRead, stateCommands.length);
    assert.deepEqual(runtime.commands.slice(0, 5), [
      ["uv", "tool", "install", "trafilatura[all]"],
      ["bun", "add", "-g", "@scope/tool@2"],
      ["go", "install", "keep-go@v2"],
      ["brew", "install", "keep-formula"],
      ["brew", "install", "--cask", "keep-cask"],
    ]);
    assert.deepEqual(runtime.commands.slice(5), [
      ["brew", "uninstall", "--cask", "old-cask"],
      ["brew", "uninstall", "old-formula"],
      ["bun", "remove", "-g", "old-bun"],
      ["gup", "remove", "--force", "old"],
      ["uv", "tool", "uninstall", "old-uv"],
    ]);
  });

  it("passes every configured package value to its backend install operation", async () => {
    const runtime = new FakeRuntime();
    const entries: Entry[] = [
      { key: "apt", value: "curl=8" },
      { key: "deb-get", value: "code" },
      { key: "uv", value: "ruff==1" },
      { key: "bun", value: "@scope/tool@2" },
      { key: "go", value: "example.com/tool@v3" },
      { key: "brew", value: "jq" },
      { key: "brew-cask", value: "visual-studio-code" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands.slice(0, 8), [
      ["sudo", "apt", "update"],
      ["sudo", "apt", "install", "-y", "curl=8"],
      ["deb-get", "install", "code"],
      ["uv", "tool", "install", "ruff==1"],
      ["bun", "add", "-g", "@scope/tool@2"],
      ["go", "install", "example.com/tool@v3"],
      ["brew", "install", "jq"],
      ["brew", "install", "--cask", "visual-studio-code"],
    ]);
  });

  it("installs consecutive go entries in one go install command", async () => {
    const runtime = new FakeRuntime();
    const entries: Entry[] = [
      { key: "go", value: "example.com/a" },
      { key: "go", value: "example.com/b@v2" },
    ];

    const exitCode = await bootstrap(entries, runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands[0], [
      "go",
      "install",
      "example.com/a@latest",
      "example.com/b@v2",
    ]);
  });

  it("installs a Go tool without a version suffix", async () => {
    const runtime = new FakeRuntime();

    const exitCode = await bootstrap([{ key: "go", value: "example.com/tool" }], runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands[0], ["go", "install", "example.com/tool@latest"]);
  });

  it("bootstraps deb-get before installing its packages when it is missing", async () => {
    const runtime = new FakeRuntime();
    runtime.failures.add("deb-get version");

    const exitCode = await bootstrap(
      [
        { key: "deb-get", value: "code" },
        { key: "deb-get", value: "other" },
      ],
      runtime,
    ).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands, [
      ["sudo", "apt", "install", "-y", "curl", "lsb-release", "wget", "jq"],
      [
        "bash",
        "-c",
        "curl -fsSL https://raw.githubusercontent.com/wimpysworld/deb-get/main/deb-get | sudo -E bash -s install deb-get",
      ],
      ["deb-get", "install", "code", "other"],
    ]);
  });

  it("does not bootstrap deb-get when it is already installed", async () => {
    const runtime = new FakeRuntime();

    const exitCode = await bootstrap([{ key: "deb-get", value: "code" }], runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands, [["deb-get", "install", "code"]]);
  });

  it("continues after a state read failure while skipping that manager's cleanup", async () => {
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
      runtime.commands.some(
        (command) => command[0] === "uv" && command[1] === "tool" && command[2] === "install",
      ),
      true,
    );
    assert.deepEqual(runtime.commands, [
      ["uv", "tool", "install", "ruff"],
      ["bun", "add", "-g", "prettier"],
      ["bash", "-c", "echo done"],
    ]);
    assert.equal(
      runtime.commands.some(
        (command) => command[0] === "uv" && command[1] === "tool" && command[2] === "uninstall",
      ),
      false,
    );
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

  it("calls known custom handlers and rejects unknown handlers", async () => {
    const runtime = new FakeRuntime();
    let knownCalls = 0;
    const entries: Entry[] = [
      { key: "custom", value: "known" },
      { key: "custom", value: "unknown" },
    ];

    const exitCode = await bootstrap(
      entries,
      runtime,
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
  });

  it("continues after a custom handler failure", async () => {
    const runtime = new FakeRuntime();

    const exitCode = await bootstrap(
      [
        { key: "custom", value: "broken" },
        { key: "run", value: "echo done" },
      ],
      runtime,
      new Map([["broken", () => Promise.reject(new Error("failed"))]]),
    ).sync();

    assert.equal(exitCode, 1);
    assert.deepEqual(runtime.commands, [["bash", "-c", "echo done"]]);
    assert.deepEqual(runtime.errors, ["custom broken: failed"]);
  });

  it("installs the Android SDK custom handler", async () => {
    const runtime = new FakeRuntime();

    const exitCode = await new Bootstrap([{ key: "custom", value: "android-sdk" }], runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands, [
      [
        "android",
        `--sdk=${join(homedir(), ".android-sdk")}`,
        "sdk",
        "install",
        "cmdline-tools/latest",
        "platform-tools",
      ],
    ]);
  });

  it("downloads and installs the latest draw.io deb", async () => {
    const runtime = new FakeRuntime();
    runtime.outputs.set(
      [
        "gh",
        "release",
        "view",
        "--repo",
        "jgraph/drawio-desktop",
        "--json",
        "tagName",
        "--jq",
        ".tagName",
      ].join("\0"),
      "v1.0.0",
    );

    const exitCode = await new Bootstrap([{ key: "custom", value: "drawio" }], runtime).sync();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands[0], [
      "gh",
      "release",
      "download",
      "v1.0.0",
      "--repo",
      "jgraph/drawio-desktop",
      "--pattern",
      "drawio-amd64-*.deb",
      "--dir",
      runtime.commands[0]![9]!,
    ]);
    assert.match(runtime.commands[1]![4]!, /\/drawio-amd64-1\.0\.0\.deb$/);
  });

  it("runs commands on every sync with bash", async () => {
    const runtime = new FakeRuntime();

    await bootstrap([{ key: "run", value: "echo ready" }], runtime).sync();

    assert.deepEqual(runtime.commands, [["bash", "-c", "echo ready"]]);
  });

  it("continues after a run command failure", async () => {
    const runtime = new FakeRuntime();
    runtime.failures.add("bash -c broken");

    const exitCode = await bootstrap(
      [
        { key: "run", value: "broken" },
        { key: "run", value: "echo done" },
      ],
      runtime,
    ).sync();

    assert.equal(exitCode, 1);
    assert.deepEqual(runtime.commands, [
      ["bash", "-c", "broken"],
      ["bash", "-c", "echo done"],
    ]);
    assert.deepEqual(runtime.errors, ["install run: broken: failed: bash -c broken"]);
  });
});

describe("diff", () => {
  it("shows removals before ordered plans without changing the host", async () => {
    const runtime = new FakeRuntime();
    runtime.outputs.set("bun\0pm\0ls\0-g", "/home/username/.bun/install/global\n└── old@1");
    const entries: Entry[] = [
      { key: "bun", value: "new@2" },
      { key: "deb-get", value: "code" },
      { key: "run", value: "echo ready" },
      { key: "custom", value: "known" },
    ];

    const exitCode = await bootstrap(
      entries,
      runtime,
      new Map([["known", () => undefined]]),
    ).diff();

    assert.equal(exitCode, 0);
    assert.deepEqual(runtime.commands, []);
    assert.deepEqual(runtime.logs, [
      "remove bun: old",
      "install / update bun: new@2",
      "install / update deb-get: code",
      "run: echo ready",
      "custom: known",
    ]);
  });

  it("omits unavailable managers from plans", async () => {
    const runtime = new FakeRuntime();
    runtime.failures.add("uv tool list");
    const entries: Entry[] = [
      { key: "apt", value: "curl" },
      { key: "uv", value: "ruff" },
      { key: "custom", value: "unknown" },
      { key: "run", value: "echo ready" },
    ];

    const exitCode = await bootstrap(entries, runtime).diff();

    assert.equal(exitCode, 1);
    assert.deepEqual(runtime.logs, [
      "install / update apt: curl",
      "custom: unknown",
      "run: echo ready",
    ]);
    assert.match(runtime.errors[0]!, /^uv state:/);
    assert.match(runtime.errors[1]!, /unknown custom handler/);
  });
});
