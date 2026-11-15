import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  generateScript,
  generateTaskScript,
  loadConfig,
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
