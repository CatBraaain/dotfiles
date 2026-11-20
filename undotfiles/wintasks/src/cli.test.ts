import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithScheduler, HELP, parseCli, USAGE, type CliOptions } from "./cli.ts";
import type { Writer } from "./apply.ts";
import type { Schtasks } from "./schtasks.ts";

const EXPECTED_HELP =
  "wintasks - synchronize Windows Task Scheduler tasks from wintasks.yaml\n\n" +
  "Usage: wintasks [OPTIONS]\n\n" +
  "Options:\n" +
  "  --mount FOLDER  Synchronize tasks under this Task Scheduler folder (default: wintasks)\n" +
  "  --dry-run       Show planned changes without modifying the system\n" +
  "  --path FILE     Read task definitions from FILE (default: wintasks.yaml)\n" +
  "  -h, --help      Show this help message";
const EXPECTED_USAGE = "usage: wintasks [OPTIONS]";
const CLI_PATH = join(import.meta.dir, "..");

class StringWriter implements Writer {
  private parts: string[] = [];
  write(text: string): void {
    this.parts.push(text);
  }
  toString(): string {
    return this.parts.join("");
  }
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  const code = runWithScheduler(args, stdout, stderr, {
    query() {
      throw new Error("scheduler must not run");
    },
    create() {
      throw new Error("scheduler must not run");
    },
    delete() {
      throw new Error("scheduler must not run");
    },
  });
  return { code, stdout: stdout.toString(), stderr: stderr.toString() };
}

function spawnCli(values: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const output = Bun.spawnSync([process.execPath, CLI_PATH, ...values], { cwd });
  return {
    code: output.exitCode ?? -1,
    stdout: output.stdout.toString(),
    stderr: output.stderr.toString(),
  };
}

class RecordingSchtasks implements Schtasks {
  created: string[] = [];
  query(): string {
    return "";
  }
  create(path: string): void {
    this.created.push(path);
  }
  delete(): void {}
}

function runWithMount(mount: string | null): { code: number; created: string[]; err: string } {
  const directory = mkdtempSync(join(tmpdir(), "wintasks-cli-"));
  const definitionsPath = join(directory, "tasks.yaml");
  writeFileSync(
    definitionsPath,
    "- name: task\n  trigger: { type: now, value: x }\n  action: { command: cmd.exe }\n",
  );
  const args = ["--path", definitionsPath];
  if (mount !== null) args.push("--mount", mount);
  const scheduler = new RecordingSchtasks();
  const out = new StringWriter();
  const err = new StringWriter();
  const code = runWithScheduler(args, out, err, scheduler);
  rmSync(directory, { recursive: true, force: true });
  return { code, created: scheduler.created, err: err.toString() };
}

describe("cli parsing", () => {
  it("mount defaults to wintasks and can be overridden", () => {
    const expected: CliOptions = {
      dryRun: false,
      mount: "wintasks",
      path: "wintasks.yaml",
      help: false,
    };
    assert.deepEqual(parseCli([]), expected);
    assert.equal(parseCli(["--mount", "WinTasks"]).mount, "WinTasks");
  });

  it("cli options are parsed", () => {
    assert.equal(parseCli(["--mount", "WinTasks", "--dry-run"]).dryRun, true);
    assert.equal(parseCli(["--help"]).help, true);
    assert.equal(parseCli(["-h"]).help, true);
    assert.equal(parseCli(["--help", "--dry-run", "--path", "input.yaml"]).help, true);
    assert.equal(parseCli(["--mount", "Other", "--path", "input.yaml"]).path, "input.yaml");
    assert.equal(parseCli(["--mount", "Other"]).mount, "Other");
    for (const invalid of [
      ["--render"],
      ["apply"],
      ["render"],
      ["--path=input.yaml"],
      ["--path"],
      ["--mount"],
      ["--mount", "--help"],
      ["--mount=Other"],
      ["--prune"],
    ]) {
      assert.throws(() => parseCli(invalid), Error, JSON.stringify(invalid));
    }
  });

  it("help constant matches the spec canonical text", () => {
    assert.equal(HELP, EXPECTED_HELP);
  });

  it("usage errors write prefix usage and exit two", () => {
    const { code, stdout, stderr } = runCli(["--unknown"]);
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.equal(USAGE, EXPECTED_USAGE);
    assert.equal(stderr, `wintasks: unexpected argument \`--unknown\`\n${EXPECTED_USAGE}\n`);
  });

  it("help does not hide unknown argument errors", () => {
    for (const values of [
      ["--help", "--unknown"],
      ["-h", "--unknown"],
    ]) {
      const { code, stdout, stderr } = runCli(values);
      assert.equal(code, 2, `args: ${values}`);
      assert.equal(stdout, "", `args: ${values}`);
      assert.equal(
        stderr,
        `wintasks: unexpected argument \`--unknown\`\n${EXPECTED_USAGE}\n`,
        `args: ${values}`,
      );
    }
  });

  it("sync uses wintasks when mount is omitted", () => {
    const { code, created, err } = runWithMount(null);
    assert.equal(code, 0, err);
    assert.deepEqual(created, ["\\wintasks\\now\\task"]);
  });

  it("sync uses explicit mount folder", () => {
    const { code, created, err } = runWithMount("WinTasks");
    assert.equal(code, 0, err);
    assert.deepEqual(created, ["\\WinTasks\\now\\task"]);
  });
});

describe("cli subprocess", () => {
  it("help writes canonical output without reading definitions", () => {
    const directory = mkdtempSync(join(tmpdir(), "wintasks-cli-"));
    for (const values of [
      ["--help"],
      ["-h"],
      ["--help", "--dry-run"],
      ["--help", "--path", "custom.yaml"],
      ["--help", "--mount", "WinTasks"],
      ["--mount", "WinTasks", "--help"],
      ["-h", "--dry-run", "--path", "custom.yaml"],
    ]) {
      const { code, stdout, stderr } = spawnCli(values, directory);
      assert.equal(code, 0, `args: ${values}`);
      assert.equal(stdout, EXPECTED_HELP, `args: ${values}`);
      assert.equal(stderr, "", `args: ${values}`);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("invalid mount exits one before scheduler query", () => {
    const directory = mkdtempSync(join(tmpdir(), "wintasks-cli-"));
    writeFileSync(
      join(directory, "custom.yaml"),
      "- name: task\n  trigger: { type: now, value: x }\n  action: { command: cmd.exe }\n",
    );
    const { code, stdout, stderr } = spawnCli(
      ["--mount", "\\", "--path", "custom.yaml"],
      directory,
    );
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.equal(stderr, "wintasks: custom.yaml: mount must be a non-root folder path\n");
    rmSync(directory, { recursive: true, force: true });
  });

  it("path error uses the custom definition file", () => {
    const directory = mkdtempSync(join(tmpdir(), "wintasks-cli-"));
    const { code, stdout, stderr } = spawnCli(
      ["--mount", "WinTasks", "--path", "custom.yaml"],
      directory,
    );
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /^wintasks: custom\.yaml: /, stderr);
    assert.ok(!stderr.includes("usage"), stderr);
    rmSync(directory, { recursive: true, force: true });
  });

  it("path parse error uses the custom definition file", () => {
    const directory = mkdtempSync(join(tmpdir(), "wintasks-cli-"));
    writeFileSync(join(directory, "custom.yaml"), "mount: WinTasks\n");
    const { code, stdout, stderr } = spawnCli(
      ["--mount", "WinTasks", "--path", "custom.yaml"],
      directory,
    );
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /^wintasks: custom\.yaml:/, stderr);
    assert.ok(!stderr.includes("usage"), stderr);
    rmSync(directory, { recursive: true, force: true });
  });

  it("missing definitions file exits one with error and no usage", () => {
    const directory = mkdtempSync(join(tmpdir(), "wintasks-cli-"));
    const { code, stdout, stderr } = spawnCli([], directory);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /^wintasks: wintasks\.yaml: /, stderr);
    assert.ok(!stderr.includes("usage"), stderr);
    rmSync(directory, { recursive: true, force: true });
  });
});
