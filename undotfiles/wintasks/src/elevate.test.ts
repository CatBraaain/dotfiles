import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { runSync, type Writer } from "./apply.ts";
import type { ElevationRequest, ElevationRuntime } from "./elevate.ts";
import type { Schtasks } from "./schtasks.ts";
import type { DateTime } from "./datetime.ts";
import { parseDefs } from "./def.ts";
import { renderTaskXml } from "./xml.ts";

const FIXED_NOW: DateTime = { y: 2026, mo: 1, d: 15, h: 10, mi: 0, s: 0 };
const MOUNT = "WinTasks";
const CLI_ARGS = ["--mount", MOUNT];
const EXEC_PATH = "bun.exe";
const SCRIPT_PATH = "src/cli.ts";

const CREATE_YAML =
  "- name: task\n  trigger: { type: now, value: x }\n  action: { command: cmd.exe }\n";

class StringWriter implements Writer {
  private parts: string[] = [];
  write(text: string): void {
    this.parts.push(text);
  }
  toString(): string {
    return this.parts.join("");
  }
}

class RecordingScheduler implements Schtasks {
  queryXml: string;
  creates: string[] = [];
  deletes: string[] = [];

  constructor(queryXml: string) {
    this.queryXml = queryXml;
  }

  query(): string {
    return this.queryXml;
  }

  create(path: string): void {
    this.creates.push(path);
  }

  delete(path: string): void {
    this.deletes.push(path);
  }
}

class FakeRuntime implements ElevationRuntime {
  platform: NodeJS.Platform;
  gsudoPath: string | null;
  elevated: boolean;
  childExitCode: number;
  selfElevationCommands: string[][] = [];

  constructor(init: {
    platform?: NodeJS.Platform;
    gsudoPath?: string | null;
    elevated?: boolean;
    childExitCode?: number;
  }) {
    this.platform = init.platform ?? "win32";
    this.gsudoPath = init.gsudoPath !== undefined ? init.gsudoPath : "C:\\Tools\\gsudo.exe";
    this.elevated = init.elevated ?? false;
    this.childExitCode = init.childExitCode ?? 0;
  }

  which(command: string): string | null {
    return command === "gsudo" ? this.gsudoPath : null;
  }

  isElevated(): boolean {
    return this.elevated;
  }

  selfElevate(request: ElevationRequest): number {
    this.selfElevationCommands.push([
      "gsudo",
      "-d",
      request.execPath,
      request.scriptPath,
      ...request.args,
    ]);
    return this.childExitCode;
  }
}

function queriedTask(path: string, body: string): string {
  return `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><URI>${path.replaceAll("\\", "/")}</URI></RegistrationInfo>${body}</Task>`;
}

function noChangeFixture(): { yaml: string; queryXml: string } {
  const defs = parseDefs(CREATE_YAML, "wintasks.yaml", MOUNT);
  const desired = renderTaskXml(defs.tasks[0]!, FIXED_NOW);
  const queryXml = desired.replace(
    "<RegistrationInfo/>",
    `<RegistrationInfo><URI>\\${MOUNT}\\now\\task</URI></RegistrationInfo>`,
  );
  return { yaml: CREATE_YAML, queryXml };
}

function run(
  yaml: string,
  queryXml: string,
  dryRun: boolean,
  runtime: FakeRuntime,
): { code: number; out: string; err: string; scheduler: RecordingScheduler } {
  const definitions = parseDefs(yaml, "wintasks.yaml", MOUNT);
  const scheduler = new RecordingScheduler(queryXml);
  const out = new StringWriter();
  const err = new StringWriter();
  const code = runSync(
    definitions,
    "wintasks.yaml",
    { dryRun },
    scheduler,
    FIXED_NOW,
    out,
    err,
    { args: CLI_ARGS, execPath: EXEC_PATH, scriptPath: SCRIPT_PATH, runtime },
  );
  return { code, out: out.toString(), err: err.toString(), scheduler };
}

describe("elevation gate", () => {
  it("dry run does not elevate", () => {
    const runtime = new FakeRuntime({});
    const { code, out, err } = run(CREATE_YAML, "", true, runtime);
    assert.equal(code, 0, err);
    assert.deepEqual(runtime.selfElevationCommands, []);
    assert.ok(out.startsWith("create \\WinTasks\\now\\task"), out);
  });

  it("elevates once through gsudo and returns the child exit code", () => {
    const runtime = new FakeRuntime({ childExitCode: 7 });
    const { code, out, err, scheduler } = run(CREATE_YAML, "", false, runtime);
    assert.equal(code, 7, err);
    assert.deepEqual(runtime.selfElevationCommands, [
      ["gsudo", "-d", EXEC_PATH, SCRIPT_PATH, ...CLI_ARGS],
    ]);
    assert.deepEqual(scheduler.creates, []);
    assert.deepEqual(scheduler.deletes, []);
    assert.equal(out, "");
    assert.equal(err, "");
  });

  it("elevates when only deletions are needed", () => {
    const runtime = new FakeRuntime({});
    const { code, scheduler } = run("[]\n", queriedTask(`\\${MOUNT}\\obsolete`, ""), false, runtime);
    assert.equal(code, 0);
    assert.equal(runtime.selfElevationCommands.length, 1);
    assert.deepEqual(scheduler.deletes, []);
  });

  it("applies directly when already elevated", () => {
    const runtime = new FakeRuntime({ elevated: true });
    const { code, out, err, scheduler } = run(CREATE_YAML, "", false, runtime);
    assert.equal(code, 0, err);
    assert.deepEqual(scheduler.creates, [`\\${MOUNT}\\now\\task`]);
    assert.equal(out, `create \\${MOUNT}\\now\\task\n`);
    assert.deepEqual(runtime.selfElevationCommands, []);
  });

  it("skips elevation when every task is no-change", () => {
    const { yaml, queryXml } = noChangeFixture();
    const runtime = new FakeRuntime({});
    const { code, out, err } = run(yaml, queryXml, false, runtime);
    assert.equal(code, 0, err);
    assert.equal(out, `no-change \\${MOUNT}\\now\\task\n`);
    assert.deepEqual(runtime.selfElevationCommands, []);
  });

  it("fails immediately when gsudo is missing and changes are needed", () => {
    const runtime = new FakeRuntime({ gsudoPath: null });
    const { code, out, err, scheduler } = run(CREATE_YAML, "", false, runtime);
    assert.equal(code, 1);
    assert.equal(out, "");
    assert.equal(err, "wintasks: gsudo was not found in PATH\n");
    assert.deepEqual(scheduler.creates, []);
    assert.deepEqual(runtime.selfElevationCommands, []);
  });

  it("reports success without gsudo when no changes are needed", () => {
    const { yaml, queryXml } = noChangeFixture();
    const runtime = new FakeRuntime({ gsudoPath: null });
    const { code, out, err } = run(yaml, queryXml, false, runtime);
    assert.equal(code, 0, err);
    assert.equal(out, `no-change \\${MOUNT}\\now\\task\n`);
    assert.deepEqual(runtime.selfElevationCommands, []);
  });

  it("skips the gate on non-win32 platforms", () => {
    const runtime = new FakeRuntime({ platform: "linux", gsudoPath: null });
    const { code, err, scheduler } = run(CREATE_YAML, "", false, runtime);
    assert.equal(code, 0, err);
    assert.deepEqual(scheduler.creates, [`\\${MOUNT}\\now\\task`]);
    assert.deepEqual(runtime.selfElevationCommands, []);
  });
});
