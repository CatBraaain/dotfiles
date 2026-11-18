import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { editorCommand, openPromptSnapshot, writePromptSnapshot } from "./renderer.ts";

const directories: string[] = [];
const paths: string[] = [];

afterEach(() => {
  paths.splice(0).forEach((path) => rmSync(path, { force: true }));
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function temporaryDirectory(): string {
  const root = "/tmp/work/dotfiles";
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "prompt-viewer-"));
  directories.push(directory);
  return directory;
}

function context(
  exec: ExtensionAPI["exec"] = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
    truncated: false,
  }),
) {
  const sessionId = randomUUID();
  paths.push(`/tmp/${sessionId}_system_prompt.md`);
  const notifications: { message: string; type: string }[] = [];
  const cwd = temporaryDirectory();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi/settings.json"),
    JSON.stringify({ externalEditor: "test-editor --wait" }),
  );
  const ctx = {
    cwd,
    modelRegistry: {},
    sessionManager: { getSessionId: () => sessionId },
    isProjectTrusted: () => true,
    ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
  } as unknown as ExtensionCommandContext;
  return { pi: { exec }, ctx, sessionId, notifications };
}

describe("writePromptSnapshot", () => {
  it("writes verbatim text with private permissions and replaces the same path", () => {
    const directory = temporaryDirectory();
    const path = writePromptSnapshot("session-1", "first\n\n", directory);
    assert.equal(path, join(directory, "session-1_system_prompt.md"));
    assert.equal(readFileSync(path, "utf8"), "first\n\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(writePromptSnapshot("session-1", "second", directory), path);
    assert.equal(readFileSync(path, "utf8"), "second");
  });

  it("replaces a symlink without writing through it", () => {
    const directory = temporaryDirectory();
    const target = join(directory, "target");
    writeFileSync(target, "keep");
    const path = join(directory, "session-1_system_prompt.md");
    symlinkSync(target, path);
    writePromptSnapshot("session-1", "private", directory);
    assert.equal(lstatSync(path).isSymbolicLink(), false);
    assert.equal(readFileSync(target, "utf8"), "keep");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("rejects session IDs that could escape the temporary directory", () => {
    assert.throws(
      () => writePromptSnapshot("../escape", "private", temporaryDirectory()),
      /session ID/,
    );
  });
});

describe("editorCommand", () => {
  it("preserves quoted arguments and quotes the snapshot path", () => {
    assert.equal(
      editorCommand('"/opt/editor name" --wait', "/tmp/prompt name.md"),
      "'/opt/editor name' --wait '/tmp/prompt name.md'",
    );
  });

  it("rejects shell operators", () => {
    assert.throws(() => editorCommand("code; echo unsafe", "/tmp/prompt.md"), /shell operators/);
    assert.throws(() => editorCommand("", "/tmp/prompt.md"), /command/);
  });
});

describe("openPromptSnapshot", () => {
  it("explains the initial state without writing or starting a process", async () => {
    const { pi, ctx, sessionId, notifications } = context();
    let calls = 0;
    pi.exec = async () => {
      calls += 1;
      throw new Error("unexpected execution");
    };
    await openPromptSnapshot(pi, ctx, undefined);
    assert.equal(calls, 0);
    assert.throws(() => statSync(`/tmp/${sessionId}_system_prompt.md`), /ENOENT/);
    assert.match(notifications[0]!.message, /No system prompt has been sent/);
  });

  it("opens the configured editor through a process and keeps edits local", async () => {
    const { ctx, pi, sessionId, notifications } = context();
    const calls: {
      command: string;
      args: string[];
      options?: { cwd?: string; timeout?: number };
    }[] = [];
    const path = `/tmp/${sessionId}_system_prompt.md`;
    pi.exec = async (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(readFileSync(path, "utf8"), "sent prompt");
      writeFileSync(path, "user edit");
      return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
    };
    await openPromptSnapshot(pi, ctx, "sent prompt");
    await openPromptSnapshot(pi, ctx, "sent prompt");
    assert.deepEqual(
      calls,
      [1, 2].map(() => ({
        command: "bash",
        args: ["-c", `test-editor --wait ${path}`],
        options: { cwd: ctx.cwd, timeout: 24 * 60 * 60 * 1000 },
      })),
    );
    assert.equal(readFileSync(path, "utf8"), "user edit");
    assert.deepEqual(notifications, []);
  });

  it("reports killed, truncated, and failed editor processes", async () => {
    const cases = [
      {
        result: { code: 1, killed: true, truncated: false, stderr: "Timed out" },
        message: "Timed out",
      },
      {
        result: { code: 1, killed: false, truncated: true, stdout: "Partial output" },
        message: "Partial output",
      },
      {
        result: { code: 2, killed: false, truncated: false, stderr: "Editor error" },
        message: "Editor error",
      },
      { result: { code: 1, killed: false, truncated: false }, message: "External editor failed" },
    ];
    for (const { result, message } of cases) {
      const { pi, ctx, notifications } = context();
      pi.exec = async () => ({
        stdout: "stdout" in result ? (result.stdout ?? "") : "",
        stderr: "stderr" in result ? (result.stderr ?? "") : "",
        code: result.code,
        killed: result.killed,
        truncated: result.truncated,
      });
      await openPromptSnapshot(pi, ctx, "private");
      assert.equal(notifications[0]!.type, "error");
      assert.match(notifications[0]!.message, new RegExp(message));
    }
  });
});
