import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { effectiveSetting, logonXmlName, parseDefs, resolveWorkingDirectory } from "./def.ts";

// tests/common/mod.rs: strips the shared two-space indent from each line.
const definitions = (tasks: string): string =>
  tasks
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");

describe("def schema", () => {
  it("parses root sequence with mount supplied by cli", () => {
    const yaml = definitions(
      "  - name: backup\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n",
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    assert.equal(defs.mount, "WinTasks");
    assert.equal(defs.tasks.length, 1);
  });

  it("accepts empty sequence but rejects empty or null documents", () => {
    assert.doesNotThrow(() => parseDefs("[]\n", "wintasks.yaml", "WinTasks"));
    for (const yaml of ["", "~\n"]) {
      assert.throws(
        () => parseDefs(yaml, "wintasks.yaml", "WinTasks"),
        (error: Error) =>
          error.message === "wintasks.yaml: no task definitions found (file is empty or null)",
        JSON.stringify(yaml),
      );
    }
  });

  it("rejects invalid mounts supplied by cli", () => {
    const yaml = definitions(
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: c }\n",
    );
    for (const mount of ["", "\\", "Root\\", "\\Root"]) {
      assert.throws(() => parseDefs(yaml, "wintasks.yaml", mount), Error, JSON.stringify(mount));
    }
  });

  it("rejects root mappings and duplicate task names", () => {
    assert.throws(() => parseDefs("tasks: []\n", "wintasks.yaml", "WinTasks"));
    assert.throws(() => parseDefs("mount: WinTasks\ntasks: []\n", "wintasks.yaml", "WinTasks"));
    const duplicate = definitions(
      "  - name: same\n    trigger: { type: now, value: x }\n    action: { command: c }\n  - name: same\n    trigger: { type: now, value: x }\n    action: { command: c }\n",
    );
    assert.throws(() => parseDefs(duplicate, "wintasks.yaml", "WinTasks"));
  });

  it("resolves actions and settings", () => {
    const yaml = definitions(
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: 'C:\\Tools\\app.exe' }\n    setting: { run_as: 'true', logon_type: s4u }\n",
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const task = defs.tasks[0]!;
    assert.equal(logonXmlName(effectiveSetting(task).logonType), "S4U");
    assert.equal(resolveWorkingDirectory(task.action[0]!), "C:\\Tools");

    for (const command of ["C:\\app.exe", "C:/app.exe"]) {
      assert.equal(resolveWorkingDirectory({ command }), "C:\\");
    }
  });

  it("rejects missing and unknown nested keys", () => {
    for (const tasks of [
      "  - name: task\n    action: { command: c }\n",
      "  - name: task\n    trigger: { type: now, value: x }\n",
      "  - name: task\n    trigger: { type: now }\n    action: { command: c }\n",
      "  - name: task\n    trigger: { type: now, value: x, extra: true }\n    action: { command: c }\n",
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: c, extra: true }\n",
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: c }\n    setting: { extra: true }\n",
    ]) {
      assert.throws(() => parseDefs(definitions(tasks), "wintasks.yaml", "WinTasks"), Error, tasks);
    }
  });

  it("rejects empty and nested task names before sync", () => {
    for (const name of ["", "child\\\\grandchild", "child/grandchild"]) {
      const yaml = definitions(
        `  - name: '${name}'\n    trigger: { type: now, value: x }\n    action: { command: c }\n`,
      );
      assert.throws(
        () => parseDefs(yaml, "wintasks.yaml", "WinTasks"),
        (error: Error) => error.message === `wintasks.yaml: invalid task name \`${name}\``,
      );
    }
  });

  it("rejects case insensitive duplicate task paths", () => {
    const yaml = definitions(
      "  - name: Task\n    trigger: { type: now, value: x }\n    action: { command: c }\n  - name: task\n    trigger: { type: now, value: x }\n    action: { command: c }\n",
    );
    assert.throws(
      () => parseDefs(yaml, "wintasks.yaml", "WinTasks"),
      (error: Error) =>
        error.message === "wintasks.yaml: duplicate task path `\\WinTasks\\now\\task`",
    );
  });

  it("duplicate task name error names file and backticked name", () => {
    const yaml = definitions(
      "  - name: x\n    trigger: { type: now, value: x }\n    action: { command: c }\n  - name: x\n    trigger: { type: now, value: x }\n    action: { command: c }\n",
    );
    assert.throws(
      () => parseDefs(yaml, "wintasks.yaml", "WinTasks"),
      (error: Error) => error.message === "wintasks.yaml: duplicate task name `x`",
    );
  });

  it("located yaml parse errors carry line and column prefix", () => {
    const yaml = "- name: task\n  trigger: [\n";
    let message = "";
    try {
      parseDefs(yaml, "wintasks.yaml", "WinTasks");
      assert.fail("expected a parse error");
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /^wintasks\.yaml:3:/);
  });

  it("rejects unknown logon type", () => {
    const yaml = definitions(
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: c }\n    setting: { logon_type: batch }\n",
    );
    assert.throws(() => parseDefs(yaml, "wintasks.yaml", "WinTasks"));
  });

  it("validates setting boolean values", () => {
    for (const value of ["true", "false", "'true'", "'false'"]) {
      const yaml = definitions(
        `  - name: task\n    trigger: { type: now, value: x }\n    action: { command: c }\n    setting: { run_as: ${value} }\n`,
      );
      assert.doesNotThrow(() => parseDefs(yaml, "wintasks.yaml", "WinTasks"), Error, value);
    }
    const yaml = definitions(
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: c }\n    setting: { run_as: yes }\n",
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    assert.throws(() => effectiveSetting(defs.tasks[0]!));
  });
});
