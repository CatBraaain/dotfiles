import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, spyOn } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  generateScript,
  generateTaskScript,
  loadConfig,
  main,
  normalizeRegistryPath,
  parseActions,
  parseDefinitions,
  psDoubleQuoted,
  psQuotedRegistryPath,
  selectRunnableTasks,
  validateActionReferences,
  type Actions,
  type DefinitionBody,
  type Definitions,
  type ExecutableMode,
} from "./engine.ts";

function definitionsFromYaml(text: string): Definitions {
  return parseDefinitions(parseYaml(text));
}

function actionsFromYaml(text: string): Actions {
  return parseActions(parseYaml(text));
}

function runnableTask(body: DefinitionBody, mode: ExecutableMode, name = "Task") {
  return { groupName: "Sample", name, body, mode };
}

const REGISTRY_TASK_YAML = `
Definitions:
  Sample:
    Task:
      description: Sample registry task.
      registries:
        - path: HKCU\\Software\\Sample
          entries:
            - name: Enabled
              type: DWord
              old_value: "1"
              new_value: "0"
`;

const SCHTASK_TASK_YAML = `
Definitions:
  Sample:
    Task:
      description: Sample scheduled task.
      scheduled_tasks:
        - full_path: \\Microsoft\\Windows\\Sample
          old_state: Enabled
          new_state: Disabled
`;

const SCRIPT_TASK_YAML = `
Definitions:
  Sample:
    Task:
      description: Sample script task.
      script:
        apply: Write-Output apply-done
        revert: Write-Output revert-done
`;

describe("normalizeRegistryPath", () => {
  it("converts long hive names and prefixes to the short form", () => {
    assert.equal(normalizeRegistryPath("HKEY_CURRENT_USER\\Software\\X"), "HKCU\\Software\\X");
    assert.equal(normalizeRegistryPath("HKCU:\\Software\\X"), "HKCU\\Software\\X");
    assert.equal(normalizeRegistryPath("Registry::HKLM:\\Software\\X"), "HKLM\\Software\\X");
    assert.equal(normalizeRegistryPath("HKEY_CLASSES_ROOT\\*\\shell"), "HKCR\\*\\shell");
  });

  it("keeps already-normalized paths unchanged", () => {
    assert.equal(normalizeRegistryPath("HKCU\\Software\\X"), "HKCU\\Software\\X");
    assert.equal(normalizeRegistryPath("HKCR\\*\\shell\\VSCode"), "HKCR\\*\\shell\\VSCode");
  });
});

describe("parseDefinitions", () => {
  it("fills defaults for optional keys", () => {
    const definitions = definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Minimal task.
`);
    const body = definitions.Sample?.Task;
    assert.ok(body !== undefined);
    assert.deepEqual(body.registries, []);
    assert.deepEqual(body.scheduled_tasks, []);
    assert.deepEqual(body.script, { apply: "", revert: "" });
  });

  it("applies <Exist> as the default key existence", () => {
    const definitions = definitionsFromYaml(REGISTRY_TASK_YAML);
    const registry = definitions.Sample?.Task?.registries[0];
    assert.ok(registry !== undefined);
    assert.equal(registry.old_existence, "<Exist>");
    assert.equal(registry.new_existence, "<Exist>");
  });

  it("rejects unknown body keys such as services", () => {
    assert.throws(
      () =>
        definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Unsupported.
      services:
        - name: Svc
          old_startup: Manual
          new_startup: Disabled
`),
      /unknown key "services"/,
    );
  });

  it("rejects a registry value kind outside the allowed list", () => {
    assert.throws(
      () =>
        definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Bad kind.
      registries:
        - path: HKCU\\Software\\Sample
          entries:
            - name: Enabled
              type: Boolean
              old_value: "1"
              new_value: "0"
`),
      /type: expected one of/,
    );
  });

  it("rejects an existence literal outside the allowed list", () => {
    assert.throws(
      () =>
        definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Bad existence.
      registries:
        - path: HKCU\\Software\\Sample
          new_existence: <Maybe>
`),
      /new_existence: expected one of/,
    );
  });

  it("rejects a non-string entry value", () => {
    assert.throws(
      () =>
        definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Numeric value.
      registries:
        - path: HKCU\\Software\\Sample
          entries:
            - name: Enabled
              type: DWord
              old_value: 1
              new_value: 0
`),
      /expected a string, got number/,
    );
  });

  it("rejects a task without description", () => {
    assert.throws(
      () =>
        definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      registries: []
`),
      /missing required key "description"/,
    );
  });
});

describe("parseActions", () => {
  it("parses apply, revert, and skip modes", () => {
    const actions = actionsFromYaml(`
Actions:
  Sample:
    A: apply
    B: revert
    C: skip
`);
    assert.equal(actions.Sample?.A, "apply");
    assert.equal(actions.Sample?.B, "revert");
    assert.equal(actions.Sample?.C, "skip");
  });

  it("rejects an unknown mode", () => {
    assert.throws(
      () =>
        actionsFromYaml(`
Actions:
  Sample:
    A: execute
`),
      /expected one of \[apply, revert, skip\]/,
    );
  });
});

describe("validateActionReferences", () => {
  const definitions = definitionsFromYaml(REGISTRY_TASK_YAML);

  it("passes when every action references an existing task", () => {
    const actions = actionsFromYaml("Actions:\n  Sample:\n    Task: apply\n");
    validateActionReferences(definitions, actions);
  });

  it("fails listing tasks missing from definitions", () => {
    const actions = actionsFromYaml("Actions:\n  Sample:\n    Ghost: apply\n");
    assert.throws(
      () => validateActionReferences(definitions, actions),
      /references tasks missing from definitions.yaml: Sample > Ghost/,
    );
  });
});

describe("selectRunnableTasks", () => {
  const definitions = definitionsFromYaml(`
Definitions:
  Sample:
    Applied:
      description: A.
      script: { apply: a, revert: r }
    Reverted:
      description: B.
      script: { apply: a, revert: r }
    Skipped:
      description: C.
      script: { apply: a, revert: r }
    NoEntry:
      description: D.
      script: { apply: a, revert: r }
`);
  const actions = actionsFromYaml(`
Actions:
  Sample:
    Applied: apply
    Reverted: revert
    Skipped: skip
`);

  it("excludes tasks without an action entry as NoAction", () => {
    const selection = selectRunnableTasks(definitions, actions, false);
    assert.ok(selection.notices.includes("NoAction: Sample > NoEntry"));
    assert.ok(selection.runnables.every((task) => task.name !== "NoEntry"));
  });

  it("excludes skip tasks with a Skipped notice", () => {
    const selection = selectRunnableTasks(definitions, actions, false);
    assert.ok(selection.notices.includes("Skipped: Sample > Skipped[skip]"));
    assert.ok(selection.runnables.every((task) => task.name !== "Skipped"));
  });

  it("flips apply and revert under reverse", () => {
    const selection = selectRunnableTasks(definitions, actions, true);
    const applied = selection.runnables.find((task) => task.name === "Applied");
    const reverted = selection.runnables.find((task) => task.name === "Reverted");
    assert.equal(applied?.mode, "revert");
    assert.equal(reverted?.mode, "apply");
  });

  it("keeps skip skipped under reverse", () => {
    const selection = selectRunnableTasks(definitions, actions, true);
    assert.ok(selection.notices.includes("Skipped: Sample > Skipped[skip]"));
  });
});

describe("PowerShell quoting", () => {
  it("escapes a wildcard asterisk with a literal backtick in registry paths", () => {
    assert.equal(psQuotedRegistryPath("HKCR\\*\\shell"), '"Registry::HKCR\\``*\\shell"');
  });

  it("doubles literal backticks in registry paths", () => {
    assert.equal(psQuotedRegistryPath("HKCU\\a`b"), '"Registry::HKCU\\a``b"');
  });

  it("escapes quotes, dollars, and backticks in double-quoted values", () => {
    const original = "wsl bash -lc \"code $(wslpath '%V')\"";
    const expected = `"wsl bash -lc ` + "`" + `"code ` + "`" + `$(wslpath '%V')` + "`" + `"` + '"';
    assert.equal(psDoubleQuoted(original), expected);
  });
});

describe("generateTaskScript", () => {
  it("emits a three-line banner with the task title and mode", () => {
    const body = definitionsFromYaml(REGISTRY_TASK_YAML).Sample?.Task;
    assert.ok(body !== undefined);
    const script = generateTaskScript(runnableTask(body, "apply"));
    const title = "Sample > Task - [apply]";
    const lines = script.split("\n");
    assert.equal(lines[0], `# ${"-".repeat(title.length)}`);
    assert.equal(lines[1], `# ${title}`);
    assert.equal(lines[2], lines[0]);
    assert.equal(lines[3], "");
  });

  it("uses the new_* side for apply and the old_* side for revert", () => {
    const body = definitionsFromYaml(REGISTRY_TASK_YAML).Sample?.Task;
    assert.ok(body !== undefined);
    const applyScript = generateTaskScript(runnableTask(body, "apply"));
    const revertScript = generateTaskScript(runnableTask(body, "revert"));
    assert.ok(applyScript.includes('-Value "0"'));
    assert.ok(revertScript.includes('-Value "1"'));
  });

  it("generates Remove-RegistryPath for a <NotExist> key existence", () => {
    const definitions = definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Removing key.
      registries:
        - path: HKCU\\Software\\Sample
          new_existence: <NotExist>
`);
    const body = definitions.Sample?.Task;
    assert.ok(body !== undefined);
    const script = generateTaskScript(runnableTask(body, "apply"));
    assert.ok(script.includes('Remove-RegistryPath -Path "Registry::HKCU\\Software\\Sample"'));
    assert.ok(!script.includes("New-RegistryPath"));
  });

  it("generates Remove-RegistryEntry for a <NotExist> entry value", () => {
    const definitions = definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Removing value.
      registries:
        - path: HKCU\\Software\\Sample
          entries:
            - name: Enabled
              type: DWord
              old_value: "1"
              new_value: <NotExist>
`);
    const body = definitions.Sample?.Task;
    assert.ok(body !== undefined);
    const script = generateTaskScript(runnableTask(body, "apply"));
    assert.ok(
      script.includes(
        'Remove-RegistryEntry -Path "Registry::HKCU\\Software\\Sample" -Name "Enabled"',
      ),
    );
    assert.ok(!script.includes("Set-RegistryEntry"));
  });

  it("emits operations and raw script as separate scriptblocks", () => {
    const definitions = definitionsFromYaml(`
Definitions:
  Sample:
    Task:
      description: Registry plus script.
      registries:
        - path: HKCU\\Software\\Sample
          entries:
            - name: Enabled
              type: DWord
              old_value: "1"
              new_value: "0"
      script:
        apply: Write-Output apply-done
        revert: Write-Output revert-done
`);
    const body = definitions.Sample?.Task;
    assert.ok(body !== undefined);
    const script = generateTaskScript(runnableTask(body, "apply"));
    assert.ok(script.includes("} -RawScript {"));
    assert.ok(script.includes("Write-Output apply-done"));
    assert.ok(!script.includes("Write-Output revert-done"));
  });

  it("emits the schtask state per direction", () => {
    const body = definitionsFromYaml(SCHTASK_TASK_YAML).Sample?.Task;
    assert.ok(body !== undefined);
    const applyScript = generateTaskScript(runnableTask(body, "apply"));
    const revertScript = generateTaskScript(runnableTask(body, "revert"));
    assert.ok(applyScript.includes("GetTask('\\Microsoft\\Windows\\Sample').Enabled = $false"));
    assert.ok(revertScript.includes("GetTask('\\Microsoft\\Windows\\Sample').Enabled = $true"));
  });

  it("wraps a raw-only task in a single RawScript block", () => {
    const body = definitionsFromYaml(SCRIPT_TASK_YAML).Sample?.Task;
    assert.ok(body !== undefined);
    const script = generateTaskScript(runnableTask(body, "apply"));
    assert.ok(script.includes("-RawScript {"));
    assert.ok(!script.includes("} -RawScript {"));
  });
});

describe("generateScript", () => {
  const definitions = definitionsFromYaml(REGISTRY_TASK_YAML);
  const actions = actionsFromYaml("Actions:\n  Sample:\n    Task: apply\n");

  it("places helpers, task banners, and the summary in order", () => {
    const { runnables } = selectRunnableTasks(definitions, actions, false);
    const script = generateScript(runnables);
    const helperIndex = script.indexOf("function Invoke-WinconfigTask");
    const bannerIndex = script.indexOf("# Sample > Task - [apply]");
    const summaryCallIndex = script.lastIndexOf("Write-WinconfigSummary");
    assert.ok(helperIndex !== -1 && bannerIndex !== -1 && summaryCallIndex !== -1);
    assert.ok(helperIndex < bannerIndex);
    assert.ok(bannerIndex < summaryCallIndex);
  });

  it("starts with ErrorActionPreference and ends with the summary and a newline", () => {
    const { runnables } = selectRunnableTasks(definitions, actions, false);
    const script = generateScript(runnables);
    assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'"));
    assert.ok(script.endsWith("Write-WinconfigSummary\n"));
  });
});

describe("repository config", () => {
  const config = loadConfig(import.meta.dir);
  const selection = selectRunnableTasks(config.definitions, config.actions, false);

  it("loads all definition groups including the user Personalization group", () => {
    const groups = Object.keys(config.definitions);
    assert.equal(groups.length, 15);
    assert.equal(groups.at(-1), "Personalization");
  });

  it("selects every tasked definition except the unlisted and skipped ones", () => {
    assert.equal(selection.runnables.length, 65);
    assert.ok(selection.notices.includes("NoAction: Personalization > HideVisualStudio"));
    assert.ok(
      selection.notices.includes("Skipped: Windows > EnableWindowsRestoreLastSession[skip]"),
    );
  });

  it("generates a banner for every runnable task", () => {
    const script = generateScript(selection.runnables);
    const bannerCount = [...script.matchAll(/^# .+ - \[(apply|revert)\]$/gm)].length;
    assert.equal(bannerCount, selection.runnables.length);
  });

  it("flips the revert-mode FileExplorer task to apply under reverse", () => {
    const reversed = selectRunnableTasks(config.definitions, config.actions, true);
    const task = reversed.runnables.find(
      (candidate) =>
        candidate.groupName === "FileExplorer" && candidate.name === "EnableRestoreLastSession",
    );
    assert.equal(task?.mode, "apply");
  });
});

function runCli(args: string[]) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "engine.ts"), ...args], {
    cwd: import.meta.dir,
    env: { ...process.env, PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function withTemporaryDirectory(test: (directory: string) => void) {
  const parent = join(tmpdir(), "work", "dotfiles", "winconfig-script");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "cli-test-"));
  try {
    test(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("print CLI", () => {
  const config = loadConfig(import.meta.dir);

  for (const reverse of [false, true]) {
    const direction = reverse ? ["revert"] : [];
    const selection = selectRunnableTasks(config.definitions, config.actions, reverse);
    const expectedScript = generateScript(selection.runnables);
    const expectedNotices = selection.notices.join("\n") + "\n";

    it(`prints the ${reverse ? "reversed" : "Actions"} selection without PowerShell`, () => {
      const result = runCli([...direction, "--print"]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.toString(), expectedScript);
      assert.equal(result.stderr.toString(), expectedNotices);
    });
  }

  for (const args of [["script"], ["script", "revert"], ["--output", "a.ps1"]]) {
    it(`rejects unknown arguments ${JSON.stringify(args)}`, () => {
      const result = runCli(args);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout.toString(), "");
      assert.match(result.stderr.toString(), /unknown arguments:.*usage:/);
    });
  }
});

describe("CLI execution boundary", () => {
  const config = loadConfig(import.meta.dir);

  for (const reverse of [false, true]) {
    for (const powershell of ["pwsh", "powershell"]) {
      it(`elevates ${reverse ? "revert" : "normal"} execution with ${powershell} and preserves the exit code`, async () => {
        const gsudoPath = "C:\\Program Files\\gsudo\\gsudo.exe";
        const powershellPath = `C:\\Program Files\\${powershell}\\${powershell}.exe`;
        const lookedUp: string[] = [];
        let scriptPath = "";
        const expectedScript =
          "\uFEFF" +
          generateScript(
            selectRunnableTasks(config.definitions, config.actions, reverse).runnables,
          );
        const result = await main(reverse ? ["revert"] : [], {
          platform: "win32",
          which(command) {
            lookedUp.push(command);
            if (command === "gsudo") return gsudoPath;
            return command === powershell ? powershellPath : null;
          },
          async execute(command) {
            scriptPath = command.at(-1)!;
            assert.deepEqual(command, [
              gsudoPath,
              powershellPath,
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              scriptPath,
            ]);
            assert.equal(readFileSync(scriptPath, "utf8"), expectedScript);
            return 7;
          },
        });
        assert.equal(result, 7);
        assert.equal(existsSync(scriptPath), false);
        assert.deepEqual(
          lookedUp,
          powershell === "pwsh" ? ["gsudo", "pwsh"] : ["gsudo", "pwsh", "powershell"],
        );
      });
    }
  }

  it("rejects non-Windows execution before command lookup", async () => {
    const result = await main([], {
      platform: "linux",
      which() {
        throw new Error("unexpected command lookup");
      },
      async execute() {
        throw new Error("unexpected process execution");
      },
    });
    assert.equal(result, 1);
  });

  for (const missing of ["gsudo", "PowerShell"]) {
    it(`rejects execution when ${missing} is missing`, async () => {
      const result = await main([], {
        platform: "win32",
        which(command) {
          return missing === "PowerShell" && command === "gsudo" ? "gsudo.exe" : null;
        },
        async execute() {
          throw new Error("unexpected process execution");
        },
      });
      assert.equal(result, 1);
    });
  }

  it("removes the temporary script and propagates a process start failure", async () => {
    let scriptPath = "";
    const failure = new Error("mock process start failure");
    await assert.rejects(
      main([], {
        platform: "win32",
        which(command) {
          return command + ".exe";
        },
        async execute(command) {
          scriptPath = command.at(-1)!;
          assert.equal(existsSync(scriptPath), true);
          throw failure;
        },
      }),
      failure,
    );
    assert.equal(existsSync(scriptPath), false);
  });

  for (const args of [["--print"], ["revert", "--print"]]) {
    it(`generates ${JSON.stringify(args)} without command lookup on Windows`, async () => {
      const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const result = await main(args, {
          platform: "win32",
          which() {
            throw new Error("unexpected command lookup");
          },
          async execute() {
            throw new Error("unexpected process execution");
          },
        });
        assert.equal(result, 0);
        const expected = generateScript(
          selectRunnableTasks(config.definitions, config.actions, args.includes("revert"))
            .runnables,
        );
        assert.equal(stdout.mock.calls[0]?.[0], expected);
      } finally {
        stdout.mockRestore();
      }
    });
  }

  for (const args of [["script"], ["--output", "a.ps1"]]) {
    it(`rejects ${JSON.stringify(args)} before command lookup or elevation`, async () => {
      await assert.rejects(
        main(args, {
          platform: "win32",
          which() {
            throw new Error("unexpected command lookup");
          },
          async execute() {
            throw new Error("unexpected process execution");
          },
        }),
        /unknown arguments:.*usage:/,
      );
    });
  }
});

describe("just argument forwarding", () => {
  const just = Bun.which("just");
  const pwsh = Bun.which("pwsh");
  const root = join(import.meta.dir, "../..");
  const justfile = readFileSync(join(root, "justfile"), "utf8");
  const recipes = justfile
    .split("[positional-arguments]\n")
    .slice(1)
    .map((section) => section.split("\n\n")[0]!);

  it.skipIf(just === null || pwsh === null)(
    "forwards revert and --print and propagates CLI errors through the Windows recipe",
    () => {
      withTemporaryDirectory((directory) => {
        const recipe = recipes.find((candidate) => candidate.includes("[windows]"));
        assert.ok(recipe !== undefined);
        const recipePath = join(directory, "justfile");
        writeFileSync(recipePath, "[positional-arguments]\n" + recipe.replace("[windows]\n", ""));
        const command = [just!, "--justfile", recipePath, "--working-directory", root, "winconfig"];
        const result = Bun.spawnSync([...command, "revert", "--print"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        const config = loadConfig(import.meta.dir);
        const expected = generateScript(
          selectRunnableTasks(config.definitions, config.actions, true).runnables,
        );
        assert.equal(result.stdout.toString(), expected);
        for (const argument of ["invalid", "日本語 with space"]) {
          const invalid = Bun.spawnSync([...command, argument], {
            stdout: "pipe",
            stderr: "pipe",
          });
          assert.equal(invalid.exitCode, 1);
          assert.equal(invalid.stdout.toString(), "");
          assert.ok(
            invalid.stderr
              .toString()
              .includes(`unknown arguments: ${argument} (usage: bun engine.ts [revert] [--print])`),
          );
        }
      });
    },
    15_000,
  );
});
