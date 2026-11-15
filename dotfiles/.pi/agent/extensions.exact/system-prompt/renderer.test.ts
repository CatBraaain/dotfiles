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
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerBackgroundBash } from "../tools/background-bash.ts";
import { editorCommand, openPromptSnapshot, writePromptSnapshot } from "./renderer.ts";

const directories: string[] = [];
const paths: string[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
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

function context() {
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
  return { ctx, sessionId, notifications };
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
  it("explains the initial state without writing or calling Bash", async () => {
    const { ctx, sessionId, notifications } = context();
    let calls = 0;
    disposers.push(
      registerBackgroundBash(
        ctx,
        async () => {
          calls += 1;
          throw new Error("unexpected execution");
        },
        () => {},
      ),
    );
    await openPromptSnapshot(ctx, undefined);
    assert.equal(calls, 0);
    assert.throws(() => statSync(`/tmp/${sessionId}_system_prompt.md`), /ENOENT/);
    assert.match(notifications[0]!.message, /No system prompt has been sent/);
  });

  it("uses the configured editor through registered Bash and keeps edited files local", async () => {
    const { ctx, sessionId, notifications } = context();
    const commands: string[] = [];
    const path = `/tmp/${sessionId}_system_prompt.md`;
    disposers.push(
      registerBackgroundBash(
        ctx,
        async (request) => {
          commands.push(request.params.command);
          assert.equal(readFileSync(path, "utf8"), "sent prompt");
          writeFileSync(path, "user edit");
          return { content: [], details: undefined, structuredContent: { exit_code: 0 } };
        },
        () => {},
      ),
    );
    await openPromptSnapshot(ctx, "sent prompt");
    await openPromptSnapshot(ctx, "sent prompt");
    assert.deepEqual(commands, [`test-editor --wait ${path}`, `test-editor --wait ${path}`]);
    assert.equal(readFileSync(path, "utf8"), "user edit");
    assert.deepEqual(notifications, []);
  });

  it("reports an unavailable or invalidated Bash runtime without a fallback", async () => {
    for (const invalidated of [false, true]) {
      const { ctx, notifications } = context();
      if (invalidated) {
        disposers.push(
          registerBackgroundBash(
            ctx,
            async () => {
              throw new Error("must not execute");
            },
            () => {
              throw new Error("runtime inactive");
            },
          ),
        );
      }
      await openPromptSnapshot(ctx, "private");
      assert.equal(notifications[0]!.type, "error");
      assert.match(notifications[0]!.message, /Bash/);
    }
  });

  it("reports guarded command errors", async () => {
    const { ctx, notifications } = context();
    disposers.push(
      registerBackgroundBash(
        ctx,
        async () => ({
          content: [{ type: "text", text: "Command denied" }],
          details: undefined,
          isError: true,
        }),
        () => {},
      ),
    );
    await openPromptSnapshot(ctx, "private");
    assert.match(notifications[0]!.message, /Command denied/);
    assert.equal(notifications[0]!.type, "error");
  });
});
