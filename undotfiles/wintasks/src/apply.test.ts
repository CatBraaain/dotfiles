import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { runApply, taskPath, type SyncOptions, type Writer } from "./apply.ts";
import type { Schtasks } from "./schtasks.ts";
import type { DateTime } from "./datetime.ts";
import { parseDefs } from "./def.ts";
import { renderTaskXml } from "./xml.ts";

const FIXED_NOW: DateTime = { y: 2026, mo: 1, d: 15, h: 10, mi: 0, s: 0 };

// tests/common/mod.rs: strips the shared two-space indent from each line.
const definitions = (tasks: string): string =>
  tasks
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");

const ONE_TASK =
  "  - name: backup\n    trigger: { type: cron, value: '0 9 * * *' }\n    action: { command: cmd.exe, args: /c backup }\n";

class StringWriter implements Writer {
  private parts: string[] = [];
  write(text: string): void {
    this.parts.push(text);
  }
  toString(): string {
    return this.parts.join("");
  }
}

class FakeSchtasks implements Schtasks {
  queryXml: string;
  creates: string[] = [];
  createXmls: string[] = [];
  deletes: string[] = [];
  failCreate: string | null;
  failDelete: string | null;

  constructor(init: { queryXml: string; failCreate?: string | null; failDelete?: string | null }) {
    this.queryXml = init.queryXml;
    this.failCreate = init.failCreate ?? null;
    this.failDelete = init.failDelete ?? null;
  }

  query(): string {
    return this.queryXml;
  }

  create(path: string, xml: string): void {
    if (this.failCreate === path) throw new Error("denied");
    this.creates.push(path);
    this.createXmls.push(xml);
  }

  delete(path: string): void {
    if (this.failDelete === path) throw new Error("denied");
    this.deletes.push(path);
  }
}

const queriedTask = (path: string, body: string): string =>
  `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><URI>${path.replaceAll("\\", "/")}</URI></RegistrationInfo>${body}</Task>`;

function run(
  yaml: string,
  dryRun: boolean,
  scheduler: Schtasks,
): { code: number; out: string; err: string } {
  const out = new StringWriter();
  const err = new StringWriter();
  const code = runApply(
    { yamlText: yaml, file: "wintasks.yaml", mount: "WinTasks" },
    { dryRun },
    scheduler,
    FIXED_NOW,
    out,
    err,
  );
  return { code, out: out.toString(), err: err.toString() };
}

function dryRunOf(yaml: string, scheduler: FakeSchtasks): string {
  const dryScheduler = new FakeSchtasks({
    queryXml: scheduler.queryXml,
    failCreate: scheduler.failCreate,
    failDelete: scheduler.failDelete,
  });
  const { code, out, err } = run(yaml, true, dryScheduler);
  assert.equal(code, 0, err);
  return out;
}

function mixedSyncFixture(): { yaml: string; scheduler: FakeSchtasks } {
  const yaml = definitions(
    "  - name: fresh\n    trigger: { type: cron, value: '0 9 * * *' }\n    action: { command: cmd.exe, args: /c fresh }\n  - name: refresh\n    trigger: { type: cron, value: '0 9 * * *' }\n    action: { command: cmd.exe, args: /c refresh }\n",
  );
  const scheduler = new FakeSchtasks({
    queryXml:
      queriedTask(
        "\\WinTasks\\cron\\refresh",
        "<Actions><Exec><Command>old.exe</Command></Exec></Actions>",
      ) + queriedTask("\\WinTasks\\obsolete", ""),
  });
  return { yaml, scheduler };
}

describe("apply sync", () => {
  it("creates desired tasks and deletes all omitted tasks in mount", () => {
    const yaml = definitions(ONE_TASK);
    const scheduler = new FakeSchtasks({
      queryXml:
        queriedTask("\\WinTasks", "") +
        queriedTask("\\WinTasks\\other\\obsolete", "") +
        queriedTask("\\Outside\\keep", ""),
    });
    const expected = dryRunOf(yaml, scheduler);
    const { code, out, err } = run(yaml, false, scheduler);
    assert.equal(code, 0, err);
    assert.deepEqual(scheduler.creates, ["\\WinTasks\\cron\\backup"]);
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    assert.equal(scheduler.createXmls[0], renderTaskXml(defs.tasks[0]!, FIXED_NOW));
    assert.deepEqual(scheduler.deletes, ["\\WinTasks", "\\WinTasks\\other\\obsolete"]);
    assert.equal(out, expected);
  });

  it("updates mount task regardless of description and dry run shows diff", () => {
    const yaml = definitions(ONE_TASK);
    const scheduler = new FakeSchtasks({
      queryXml: queriedTask(
        "\\WinTasks\\cron\\backup",
        "<Actions><Exec><Command>old.exe</Command></Exec></Actions>",
      ),
    });
    const { code, out, err } = run(yaml, true, scheduler);
    assert.equal(code, 0, err);
    assert.ok(scheduler.creates.length === 0 && scheduler.deletes.length === 0);
    assert.ok(
      out.startsWith("update \\WinTasks\\cron\\backup\n--- current\n+++ desired\n@@\n"),
      out,
    );
    assert.ok(out.includes("-      <Command>old.exe</Command>"), out);
  });

  it("update replaces existing mount task", () => {
    const yaml = definitions(ONE_TASK);
    const scheduler = new FakeSchtasks({
      queryXml: queriedTask(
        "\\WinTasks\\cron\\backup",
        "<Actions><Exec><Command>old.exe</Command></Exec></Actions>",
      ),
    });
    const expected = dryRunOf(yaml, scheduler);
    const { code, out, err } = run(yaml, false, scheduler);
    assert.equal(code, 0, err);
    assert.deepEqual(scheduler.creates, ["\\WinTasks\\cron\\backup"]);
    assert.equal(out, expected);
  });

  it("query metadata and case differences are no change", () => {
    const yaml = definitions(ONE_TASK);
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const desired = renderTaskXml(defs.tasks[0]!, FIXED_NOW);
    const current = desired
      .replace(
        "<RegistrationInfo/>",
        "<RegistrationInfo><URI>\\wintasks\\cron\\backup</URI><Date>2026-01-15T10:00:00</Date></RegistrationInfo>",
      )
      .replace("<Principal>", "<Principal><UserId>S-1-5-18</UserId>")
      .replace("<Settings>", "<Settings><Enabled>true</Enabled>")
      .replace("<Actions>", '<Actions Context="Author">');
    const scheduler = new FakeSchtasks({ queryXml: current });
    const { code, out, err } = run(yaml, true, scheduler);
    assert.equal(code, 0, err);
    assert.equal(out, "no-change \\WinTasks\\cron\\backup\n");
    assert.ok(scheduler.creates.length === 0 && scheduler.deletes.length === 0);
  });

  it("dry run ignores owned principal and settings reordering", () => {
    const yaml = definitions(ONE_TASK);
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const desired = renderTaskXml(defs.tasks[0]!, FIXED_NOW);
    const current = desired
      .replace(
        "<RegistrationInfo/>",
        "<RegistrationInfo><URI>\\WinTasks\\cron\\backup</URI></RegistrationInfo>",
      )
      .replace(
        "      <RunLevel>LeastPrivilege</RunLevel>\n      <LogonType>InteractiveToken</LogonType>",
        "      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>",
      )
      .replace(
        "    <StartWhenAvailable>true</StartWhenAvailable>\n    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n    <StartWhenAvailable>true</StartWhenAvailable>\n    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      );
    const scheduler = new FakeSchtasks({ queryXml: current });
    const { code, out, err } = run(yaml, true, scheduler);
    assert.equal(code, 0, err);
    assert.equal(out, "no-change \\WinTasks\\cron\\backup\n");
    assert.ok(scheduler.creates.length === 0 && scheduler.deletes.length === 0);
  });

  it("mixed sync reports definition order then delete and orders scheduler calls", () => {
    const { yaml, scheduler } = mixedSyncFixture();
    const expected = dryRunOf(yaml, scheduler);
    const { code, out, err } = run(yaml, false, scheduler);
    assert.equal(code, 0, err);
    assert.equal(out, expected);
    assert.deepEqual(
      scheduler.creates,
      ["\\WinTasks\\cron\\fresh", "\\WinTasks\\cron\\refresh"],
      "create calls must follow definition order",
    );
    assert.deepEqual(scheduler.deletes, ["\\WinTasks\\obsolete"]);
  });

  it("dry run reports no output for an empty desired state", () => {
    const scheduler = new FakeSchtasks({ queryXml: "" });
    const { code, out, err } = run("[]\n", true, scheduler);
    assert.equal(code, 0, err);
    assert.equal(out, "");
    assert.ok(scheduler.creates.length === 0 && scheduler.deletes.length === 0);
  });

  it("wrapped query tasks are no change", () => {
    const yaml = definitions(
      "  - name: startup\n    trigger: { type: now, value: x }\n    action: { command: startup.exe }\n  - name: SyncTime\n    trigger: { type: now, value: x }\n    action: { command: synctime.exe }\n",
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const queryXml = defs.tasks
      .map((definition, index) => {
        const path = taskPath(definition, "WinTasks");
        const desired = renderTaskXml(definition, FIXED_NOW);
        const uri = index === 0 ? `<URI>${path}</URI>` : `<URI><![CDATA[${path}]]></URI>`;
        return desired
          .replace(
            "<RegistrationInfo/>",
            `<RegistrationInfo>${uri}<Date>2026-01-15T10:00:00</Date></RegistrationInfo>`,
          )
          .replace(
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<?xml version="1.0" encoding="UTF-16"?>',
          );
      })
      .join("\n");
    const scheduler = new FakeSchtasks({ queryXml: `<Tasks>${queryXml}</Tasks>` });
    const { code, out, err } = run(yaml, true, scheduler);
    assert.equal(code, 0, err);
    assert.equal(out, "no-change \\WinTasks\\now\\startup\nno-change \\WinTasks\\now\\SyncTime\n");
    assert.ok(scheduler.creates.length === 0 && scheduler.deletes.length === 0);
  });

  it("dry run diffs update and delete but not create", () => {
    const { yaml, scheduler } = mixedSyncFixture();
    const { code, out, err } = run(yaml, true, scheduler);
    assert.equal(code, 0, err);
    assert.ok(
      scheduler.creates.length === 0 && scheduler.deletes.length === 0,
      "dry-run must not change the system",
    );
    assert.ok(
      out.startsWith(
        "create \\WinTasks\\cron\\fresh\nupdate \\WinTasks\\cron\\refresh\n--- current\n+++ desired\n@@\n",
      ),
      `create must have no diff and update must be followed by its diff: ${out}`,
    );
    assert.ok(out.includes("-      <Command>old.exe</Command>"), out);
    assert.ok(
      out.includes("delete \\WinTasks\\obsolete\n--- current\n+++ desired\n@@\n"),
      "delete must be followed by its diff",
    );
  });

  it("malformed query stops at that document but keeps prior tasks", () => {
    const yaml = definitions(
      "  - name: wanted\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n",
    );
    const scheduler = new FakeSchtasks({
      queryXml:
        queriedTask("\\WinTasks\\gone", "") + "<!broken>" + queriedTask("\\WinTasks\\ignored", ""),
    });
    const { code, err } = run(yaml, false, scheduler);
    assert.equal(code, 0, err);
    assert.deepEqual(scheduler.deletes, ["\\WinTasks\\gone"]);
  });

  it("scheduler failures continue and are reported", () => {
    const yaml = definitions(
      "  - name: one\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n  - name: two\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n",
    );
    const scheduler = new FakeSchtasks({
      queryXml: "",
      failCreate: "\\WinTasks\\now\\one",
    });
    const { code, out, err } = run(yaml, false, scheduler);
    assert.equal(code, 1);
    assert.deepEqual(scheduler.creates, ["\\WinTasks\\now\\two"]);
    assert.equal(out, "create \\WinTasks\\now\\two\n");
    assert.equal(err, "error: schtasks /Create /TN \\WinTasks\\now\\one failed: denied\n");
  });

  it("delete failures are reported after desired tasks continue", () => {
    const yaml = definitions(ONE_TASK);
    const scheduler = new FakeSchtasks({
      queryXml: queriedTask("\\WinTasks\\obsolete", ""),
      failDelete: "\\WinTasks\\obsolete",
    });
    const { code, out, err } = run(yaml, false, scheduler);
    assert.equal(code, 1);
    assert.deepEqual(scheduler.creates, ["\\WinTasks\\cron\\backup"]);
    assert.equal(out, "create \\WinTasks\\cron\\backup\n");
    assert.equal(err, "error: schtasks /Delete /TN \\WinTasks\\obsolete failed: denied\n");
  });

  it("query failure exits immediately", () => {
    const yaml = definitions(ONE_TASK);
    const queryFailure: Schtasks = {
      query() {
        throw new Error("schtasks /Query /XML failed: denied");
      },
      create() {
        throw new Error("query failure must stop before create");
      },
      delete() {
        throw new Error("query failure must stop before delete");
      },
    };
    const out = new StringWriter();
    const err = new StringWriter();
    const code = runApply(
      { yamlText: yaml, file: "wintasks.yaml", mount: "WinTasks" },
      { dryRun: false },
      queryFailure,
      FIXED_NOW,
      out,
      err,
    );
    assert.equal(code, 1);
    assert.equal(out.toString(), "");
    assert.equal(err.toString(), "wintasks: schtasks /Query /XML failed: denied\n");
  });

  it("yaml parse failure exits one before query", () => {
    const preflightFailure: Schtasks = {
      query() {
        throw new Error("preflight failures must stop before schtasks /Query");
      },
      create() {
        throw new Error("preflight failures must stop before schtasks /Create");
      },
      delete() {
        throw new Error("preflight failures must stop before schtasks /Delete");
      },
    };
    const out = new StringWriter();
    const err = new StringWriter();
    const code = runApply(
      {
        yamlText: "- name: broken\n  trigger: [\n",
        file: "wintasks.yaml",
        mount: "WinTasks",
      },
      { dryRun: false },
      preflightFailure,
      FIXED_NOW,
      out,
      err,
    );
    assert.equal(code, 1);
    assert.equal(out.toString(), "");
    assert.match(
      err.toString(),
      /^wintasks: wintasks\.yaml:3:/,
      `located parse errors must use \`wintasks: <file>:<line>:<col>: \`: ${err.toString()}`,
    );
  });

  it("xml generation failure exits one before query", () => {
    const yaml = definitions(
      "  - name: backup\n    trigger: { type: cron, value: 'bad cron' }\n    action: { command: cmd.exe }\n",
    );
    const preflightFailure: Schtasks = {
      query() {
        throw new Error("preflight failures must stop before schtasks /Query");
      },
      create() {
        throw new Error("preflight failures must stop before schtasks /Create");
      },
      delete() {
        throw new Error("preflight failures must stop before schtasks /Delete");
      },
    };
    const out = new StringWriter();
    const err = new StringWriter();
    const code = runApply(
      { yamlText: yaml, file: "wintasks.yaml", mount: "WinTasks" },
      { dryRun: false },
      preflightFailure,
      FIXED_NOW,
      out,
      err,
    );
    assert.equal(code, 1);
    assert.equal(out.toString(), "");
    assert.equal(
      err.toString(),
      "wintasks: wintasks.yaml: XML generation failed for task `backup`: invalid cron expression `bad cron`: expected 5 fields (minute hour day month weekday), got 2\n",
    );
  });

  it("dry run delete prints diff", () => {
    const yaml = definitions(
      "  - name: backup\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n",
    );
    const scheduler = new FakeSchtasks({
      queryXml: queriedTask("\\WinTasks\\obsolete", "<Actions/>"),
    });
    const { code, out, err } = run(yaml, true, scheduler);
    assert.equal(code, 0, err);
    assert.ok(out.includes("delete \\WinTasks\\obsolete\n--- current\n+++ desired\n@@\n"));
    assert.ok(scheduler.creates.length === 0 && scheduler.deletes.length === 0);
  });

  it("reports each no change entry in a dry run", () => {
    const yaml = definitions(
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n",
    );
    const desired = definitions(
      "  - name: task\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n",
    );
    const defs = parseDefs(desired, "wintasks.yaml", "WinTasks");
    const current = renderTaskXml(defs.tasks[0]!, FIXED_NOW).replace(
      "<RegistrationInfo/>",
      "<RegistrationInfo><URI>\\WinTasks\\now\\task</URI><Description>old</Description></RegistrationInfo>",
    );
    const scheduler = new FakeSchtasks({ queryXml: current });
    const { code, out, err } = run(yaml, true, scheduler);
    assert.equal(code, 0, err);
    assert.equal(out, "no-change \\WinTasks\\now\\task\n");
  });
});
