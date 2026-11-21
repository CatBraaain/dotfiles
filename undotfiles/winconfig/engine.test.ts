import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, spyOn } from "bun:test";
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

  it("defaults tasks without an action entry to skip", () => {
    const selection = selectRunnableTasks(definitions, actions, false);
    assert.ok(selection.notices.includes("Skipped: Sample > NoEntry[skip]"));
    assert.ok(selection.runnables.every((task) => task.name !== "NoEntry"));
  });

  it("defaults tasks in an unspecified action group to skip under reverse", () => {
    const selection = selectRunnableTasks(definitions, {}, true);
    assert.deepEqual(selection.runnables, []);
    assert.deepEqual(selection.notices, [
      "Skipped: Sample > Applied[skip]",
      "Skipped: Sample > Reverted[skip]",
      "Skipped: Sample > Skipped[skip]",
      "Skipped: Sample > NoEntry[skip]",
    ]);
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
  it("keeps wildcard characters literal in registry paths", () => {
    assert.equal(psQuotedRegistryPath("HKCR\\*\\shell"), '"Registry::HKCR\\*\\shell"');
    assert.equal(psQuotedRegistryPath("HKCU\\a?b[1]"), '"Registry::HKCU\\a?b[1]"');
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
    assert.ok(selection.notices.includes("Skipped: Personalization > HideVisualStudio[skip]"));
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

  it("emits existing asterisk paths unescaped as literal targets", () => {
    const script = generateScript(selection.runnables);
    assert.ok(script.includes('"Registry::HKCR\\*\\shell\\pintohomefile"'));
    assert.ok(script.includes('"Registry::HKCR\\*\\shell\\VSCode"'));
    assert.ok(script.includes('"Registry::HKCU\\Software\\Classes\\*\\shell\\ShareX"'));
    assert.ok(!script.includes("``*"));
  });

  it("resolves and creates registry paths without wildcard interpretation", () => {
    const script = generateScript(selection.runnables);
    assert.ok(script.includes("Test-Path -LiteralPath $Path"));
    assert.ok(script.includes("Remove-Item -LiteralPath $Path"));
    assert.ok(script.includes("Set-ItemProperty -LiteralPath $Path"));
    assert.ok(script.includes("Remove-ItemProperty -LiteralPath $Path"));
    assert.ok(script.includes("New-Item -Path $Path"));
    assert.ok(!script.includes("Replace('`*', '*')"));
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
      const noticeLines = result.stderr.toString().trimEnd().split("\n");
      for (const line of noticeLines) {
        assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3} \| Skipped: /);
      }
      const untimedNotices = result.stderr
        .toString()
        .replace(/^\d{2}:\d{2}:\d{2}\.\d{3} \| /gm, "");
      assert.equal(untimedNotices, expectedNotices);
      assert.equal(result.stderr.toString().includes("\x1b["), false);
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
  const stderrTtyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  beforeEach(() => {
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
  });

  afterEach(() => {
    if (stderrTtyDescriptor) Object.defineProperty(process.stderr, "isTTY", stderrTtyDescriptor);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  });

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

describe("CLI log compatibility", () => {
  for (const isTTY of [true, false, undefined]) {
    for (const noColor of [undefined, "", "1"]) {
      it(`uses parent stderr TTY=${isTTY} and NO_COLOR=${JSON.stringify(noColor)} for notices and elevated reports`, async () => {
        const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
        const previousNoColor = process.env.NO_COLOR;
        const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
        Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: isTTY });
        if (noColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColor;
        try {
          const colorEnabled = isTTY === true && noColor === undefined;
          const result = await main([], {
            platform: "win32",
            which(command) {
              return command + ".exe";
            },
            async execute(command) {
              const script = readFileSync(command.at(-1)!, "utf8");
              assert.ok(script.includes(`$script:WinconfigUseColor = $${colorEnabled}`));
              return 0;
            },
          });
          assert.equal(result, 0);
          const config = loadConfig(import.meta.dir);
          const { notices } = selectRunnableTasks(config.definitions, config.actions, false);
          const actualLines = stderr.mock.calls.map(([chunk]) => String(chunk));
          assert.equal(actualLines.length, notices.length);
          for (const [index, line] of actualLines.entries()) {
            assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3} \| /);
            const expectedNotice = colorEnabled
              ? notices[index]!.replace("Skipped", "\x1b[33mSkipped\x1b[0m")
              : notices[index]!;
            assert.equal(line.slice("00:00:00.000 | ".length), expectedNotice + "\n");
          }
        } finally {
          stderr.mockRestore();
          if (ttyDescriptor) Object.defineProperty(process.stderr, "isTTY", ttyDescriptor);
          else Reflect.deleteProperty(process.stderr, "isTTY");
          if (previousNoColor === undefined) delete process.env.NO_COLOR;
          else process.env.NO_COLOR = previousNoColor;
        }
      });
    }
  }
});

describe("PowerShell log compatibility", () => {
  const pwsh = Bun.which("pwsh");
  const definitions = definitionsFromYaml(`
Definitions:
  Sample:
    Denied:
      description: Safe exception injection.
      script:
        apply: |
          Write-Output 'raw-before-failure'
          throw [System.UnauthorizedAccessException]::new('injected denial')
    Success:
      description: Safe output only.
      script:
        apply: |
          Write-Output '<PermissionDenied> is raw output'
          return
          throw 'unreachable'
    Empty:
      description: No operations.
    Unchanged:
      description: No registry operations.
      registries:
        - path: HKCU\\Software\\NeverTouched
          new_existence: <NotChange>
    ExplicitSkip:
      description: Must not execute.
      script: { apply: "throw 'unreachable'" }
    MissingAction:
      description: Must not execute.
      script: { apply: "throw 'unreachable'" }
`);
  const actions = actionsFromYaml(`
Actions:
  Sample:
    Denied: apply
    Success: apply
    Empty: apply
    Unchanged: apply
    ExplicitSkip: skip
`);

  for (const colorEnabled of [false, true]) {
    it.skipIf(pwsh === null)(
      `reports exact labels and reasons to timed stderr with color=${colorEnabled}`,
      () => {
        withTemporaryDirectory((directory) => {
          const { runnables } = selectRunnableTasks(definitions, actions, false);
          const scriptPath = join(directory, "safe-logging.ps1");
          writeFileSync(scriptPath, "\uFEFF" + generateScript(runnables, { colorEnabled }));
          const result = Bun.spawnSync([pwsh!, "-NoProfile", "-File", scriptPath], {
            env: { ...process.env, NO_COLOR: "1" },
            stdout: "pipe",
            stderr: "pipe",
          });
          assert.equal(result.exitCode, 1);
          assert.deepEqual(result.stdout.toString().trimEnd().split(/\r?\n/), [
            "raw-before-failure",
            "<PermissionDenied> is raw output",
          ]);
          const reportLines = result.stderr.toString().trimEnd().split(/\r?\n/);
          const taskReportLines = reportLines.slice(0, 4);
          const summaryLines = reportLines.slice(4);
          for (const line of taskReportLines) {
            assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3} \| /);
          }
          for (const line of summaryLines) {
            assert.doesNotMatch(line, /\d{2}:\d{2}:\d{2}\.\d{3} \| /);
          }
          const messages = taskReportLines.map((line) => line.slice("00:00:00.000 | ".length));
          const expectedReports = colorEnabled
            ? [
                "\x1b[31mTaskError\x1b[0m: Sample > Denied[apply] - \x1b[31mpermission denied (administrator privileges are required)\x1b[0m",
                "\x1b[32mSuccess\x1b[0m: Sample > Success[apply]",
                "\x1b[33mSkipped\x1b[0m: Sample > Empty[apply] - \x1b[33mno operations\x1b[0m",
                "\x1b[33mSkipped\x1b[0m: Sample > Unchanged[apply] - \x1b[33mno operations\x1b[0m",
              ]
            : [
                "TaskError: Sample > Denied[apply] - permission denied (administrator privileges are required)",
                "Success: Sample > Success[apply]",
                "Skipped: Sample > Empty[apply] - no operations",
                "Skipped: Sample > Unchanged[apply] - no operations",
              ];
          assert.deepEqual(messages, expectedReports);
          const failedCount = colorEnabled ? "\x1b[31m1\x1b[0m" : "1";
          assert.deepEqual(summaryLines, [
            "",
            "─".repeat(40),
            `Summary: success=1 failed=${failedCount} skipped=2`,
          ]);
        });
      },
    );
  }

  it.skipIf(pwsh === null)(
    "keeps the zero exit code and empty counts when all actions are skipped",
    () => {
      withTemporaryDirectory((directory) => {
        const { runnables } = selectRunnableTasks(definitions, {}, false);
        const scriptPath = join(directory, "empty-logging.ps1");
        writeFileSync(scriptPath, "\uFEFF" + generateScript(runnables));
        const result = Bun.spawnSync([pwsh!, "-NoProfile", "-File", scriptPath], {
          stdout: "pipe",
          stderr: "pipe",
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.toString(), "");
        assert.deepEqual(result.stderr.toString().trimEnd().split(/\r?\n/), [
          "",
          "─".repeat(40),
          "Summary: success=0 failed=0 skipped=0",
        ]);
        assert.equal(result.stderr.toString().includes("\x1b["), false);
      });
    },
  );

  it.skipIf(pwsh === null)("keeps the zero failed count uncolored when color is enabled", () => {
    withTemporaryDirectory((directory) => {
      const okDefinitions = definitionsFromYaml(`
Definitions:
  Sample:
    Success:
      description: Safe output only.
      script:
        apply: Write-Output ok
`);
      const okActions = actionsFromYaml("Actions:\n  Sample:\n    Success: apply\n");
      const { runnables } = selectRunnableTasks(okDefinitions, okActions, false);
      const scriptPath = join(directory, "success-logging.ps1");
      writeFileSync(scriptPath, "\uFEFF" + generateScript(runnables, { colorEnabled: true }));
      const result = Bun.spawnSync([pwsh!, "-NoProfile", "-File", scriptPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(result.exitCode, 0);
      const lines = result.stderr.toString().trimEnd().split(/\r?\n/);
      assert.match(lines[0]!, /^\d{2}:\d{2}:\d{2}\.\d{3} \| /);
      assert.equal(
        lines[0]!.slice("00:00:00.000 | ".length),
        "\x1b[32mSuccess\x1b[0m: Sample > Success[apply]",
      );
      assert.deepEqual(lines.slice(1), [
        "",
        "─".repeat(40),
        "Summary: success=1 failed=0 skipped=0",
      ]);
      assert.equal(result.stderr.toString().includes("failed=\x1b["), false);
    });
  });
});

describe("CiTool output suppression", () => {
  const pwsh = Bun.which("pwsh");
  const body = loadConfig(import.meta.dir).definitions.Security?.DisableSmartAppControl;

  for (const mode of ["apply", "revert"] as const) {
    it.skipIf(pwsh === null)(`suppresses CiTool stdout while keeping the call for ${mode}`, () => {
      assert.ok(body !== undefined, "Security > DisableSmartAppControl must exist");
      withTemporaryDirectory((directory) => {
        const callLogPath = join(directory, "citool-calls.txt");
        const mock = [
          "function CiTool {",
          `    Add-Content -LiteralPath ${psDoubleQuoted(callLogPath)} -Value ('called: ' + ($args -join ' '))`,
          "    Write-Output '{\"OperationResult\":0}'",
          "}",
        ].join("\n");
        const scriptOnlyBody: DefinitionBody = { ...body, registries: [], scheduled_tasks: [] };
        const scriptPath = join(directory, "citool.ps1");
        writeFileSync(
          scriptPath,
          "\uFEFF" +
            mock +
            "\n" +
            generateScript([
              {
                groupName: "Security",
                name: "DisableSmartAppControl",
                body: scriptOnlyBody,
                mode,
              },
            ]),
        );
        const result = Bun.spawnSync([pwsh!, "-NoProfile", "-File", scriptPath], {
          stdout: "pipe",
          stderr: "pipe",
        });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        assert.equal(result.stdout.toString(), "");
        assert.ok(
          result.stderr.toString().includes(`Success: Security > DisableSmartAppControl[${mode}]`),
        );
        assert.equal(readFileSync(callLogPath, "utf8").trimEnd(), "called: --refresh --json");
      });
    });
  }

  it.skipIf(pwsh === null)(
    "reports a CiTool failure instead of swallowing it through Out-Null",
    () => {
      assert.ok(body !== undefined, "Security > DisableSmartAppControl must exist");
      withTemporaryDirectory((directory) => {
        const mock = [
          "function CiTool {",
          "    throw [System.UnauthorizedAccessException]::new('injected CiTool denial')",
          "}",
        ].join("\n");
        const scriptOnlyBody: DefinitionBody = { ...body, registries: [], scheduled_tasks: [] };
        const scriptPath = join(directory, "citool-failure.ps1");
        writeFileSync(
          scriptPath,
          "\uFEFF" +
            mock +
            "\n" +
            generateScript([
              {
                groupName: "Security",
                name: "DisableSmartAppControl",
                body: scriptOnlyBody,
                mode: "apply",
              },
            ]),
        );
        const result = Bun.spawnSync([pwsh!, "-NoProfile", "-File", scriptPath], {
          stdout: "pipe",
          stderr: "pipe",
        });
        assert.equal(result.exitCode, 1);
        assert.ok(
          result.stderr
            .toString()
            .includes(
              "TaskError: Security > DisableSmartAppControl[apply] - permission denied (administrator privileges are required)",
            ),
        );
      });
    },
  );
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
