import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { parse } from "shell-quote";
import {
  requestBackgroundBash,
  registerBackgroundBash,
  type BackgroundBashContext,
  type BackgroundBashOutcome,
  type BackgroundBashRequest,
} from "../tools/background-bash";
import { displayLibrary } from "./library.data";
import {
  shotOpenui,
  SHOT_TIMEOUT_SECONDS,
  SHOT_BASH_TIMEOUT_SECONDS,
  type SnapshotInput,
} from "./snapshot";
import { runSnapshot } from "./snapshot-cli";

function completeMock(path: string): void {
  const directory = dirname(path);
  renameSync(join(directory, "pending"), join(directory, "running"));
  writeFileSync(join(directory, "finished.json"), JSON.stringify({ ok: true }));
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
let workDir: string;
beforeAll(() => {
  mkdirSync("/tmp/work/dotfiles/openui-preview-tests", { recursive: true });
  workDir = mkdtempSync("/tmp/work/dotfiles/openui-preview-tests/snapshot-");
  writeFileSync(join(workDir, "spec.json"), JSON.stringify(displayLibrary.toSpec()));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});
const context = { modelRegistry: {} } as BackgroundBashContext;

function inputOf(request: BackgroundBashRequest): { input: SnapshotInput; path: string } {
  const args = parse(request.params.command);
  assert.equal(args.length, 7);
  assert.equal(args[0], "env");
  assert.equal(args[4], "bun");
  assert.match(String(args[5]), /snapshot-cli\.ts$/);
  const path = args[6] as string;
  const ownedDir = dirname(path);
  assert.deepEqual(args.slice(1, 4), [`TMPDIR=${ownedDir}`, `TMP=${ownedDir}`, `TEMP=${ownedDir}`]);
  return { input: JSON.parse(readFileSync(path, "utf8")), path };
}

describe("shotOpenui", () => {
  it("cleans real Playwright launch-failure artifacts through the shared Bash request", async () => {
    const root = tmpdir();
    const before = new Set(readdirSync(root));
    let ownedDir = "";
    const dispose = registerBackgroundBash(
      context,
      async (request) => {
        const { path } = inputOf(request);
        ownedDir = dirname(path);
        const child = Bun.spawn(["bash", "-c", request.params.command], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(workDir, "empty-browser-cache") },
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert.deepEqual(readdirSync(ownedDir).sort(), ["finished.json", "input.json", "running"]);
        return {
          content: [{ type: "text", text: stdout + stderr }],
          details: {},
          isError: exitCode !== 0,
        };
      },
      () => {},
    );
    try {
      const result = await shotOpenui(
        'root = Stack([TextContent("cleanup probe")])',
        "real-launch-failure",
        {
          outDir: workDir,
          context,
          generatedDir: workDir,
          requestBash: requestBackgroundBash,
        },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /No existing Chromium executable/);
      assert.equal(existsSync(ownedDir), false);
      const leaked = readdirSync(root).filter(
        (name) =>
          /^(playwright-artifacts-|playwright_chromiumdev_profile-|ob-|op-)/.test(name) &&
          !before.has(name),
      );
      assert.deepEqual(leaked, []);
    } finally {
      dispose();
    }
  }, 20_000);

  it("passes input as JSON data through the shared Bash entry with a 15-second deadline", async () => {
    let requestCount = 0;
    let inputPath = "";
    const source = 'root = Stack([TextContent("$(touch /tmp/never); \\\"quoted\\\"")])';
    const result = await shotOpenui(source, "success", {
      outDir: workDir,
      context,
      generatedDir: "/generated spec with spaces",
      async requestBash(request) {
        requestCount += 1;
        const { input, path } = inputOf(request);
        inputPath = path;
        assert.equal(request.context, context);
        assert.equal(request.params.timeout, SHOT_BASH_TIMEOUT_SECONDS);
        assert.equal(SHOT_BASH_TIMEOUT_SECONDS, 20);
        assert.equal(request.signal, undefined);
        assert.equal(SHOT_TIMEOUT_SECONDS, 15);
        assert.equal(input.source, source);
        assert.equal(input.generatedDir, "/generated spec with spaces");
        assert.ok(input.deadline > Date.now() && input.deadline <= Date.now() + 15_000);
        assert.ok(!request.params.command.includes("touch"));
        writeFileSync(input.pngPath, PNG);
        completeMock(path);
        assert.notEqual(input.pngPath, join(workDir, "success.png"));
        return { status: "completed", result: { content: [], details: {} } };
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.pngPath, /success\.png$/);
    assert.equal(requestCount, 1);
    assert.equal(existsSync(dirname(inputPath)), false);
  });

  for (const [name, outcome] of [
    ["unavailable API", { status: "unavailable", error: new Error("No API") }],
    ["deadline", { status: "failed", error: new Error("Background Bash request timed out") }],
    ["interruption", { status: "aborted", reason: new Error("interrupted") }],
    [
      "command denial",
      {
        status: "completed",
        result: {
          details: {},
          isError: true,
          content: [{ type: "text", text: "Command requires a reason" }],
        },
      },
    ],
  ] satisfies Array<[string, BackgroundBashOutcome]>) {
    it(`cleans temporary input and partial output after ${name} without retry`, async () => {
      let inputPath = "";
      let pngPath = "";
      let calls = 0;
      const result = await shotOpenui("root = Stack([])", name, {
        outDir: workDir,
        context,
        async requestBash(request) {
          calls += 1;
          const { input, path } = inputOf(request);
          inputPath = path;
          pngPath = input.pngPath;
          const profile = join(dirname(path), "playwright_chromiumdev_profile-test");
          mkdirSync(profile);
          writeFileSync(join(profile, "partial"), "partial");
          writeFileSync(pngPath, "partial");
          return outcome;
        },
      });
      assert.equal(result.ok, false);
      assert.equal(calls, 1);
      assert.equal(existsSync(dirname(inputPath)), false);
      assert.equal(existsSync(pngPath), false);
      if (!result.ok) assert.match(result.error, /OpenUI snapshot/);
    });
  }

  it("rejects a successful Bash result without a PNG", async () => {
    const result = await shotOpenui("root = Stack([])", "missing", {
      outDir: workDir,
      context,
      async requestBash(request) {
        completeMock(inputOf(request).path);
        return { status: "completed", result: { content: [], details: {} } };
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /ENOENT/);
  });
  it("rejects a non-PNG output even when Bash succeeds", async () => {
    const result = await shotOpenui("root = Stack([])", "not-png", {
      outDir: workDir,
      context,
      async requestBash(request) {
        const { input, path } = inputOf(request);
        writeFileSync(input.pngPath, "not PNG");
        completeMock(path);
        return { status: "completed", result: { content: [], details: {} } };
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /did not produce a PNG/);
  });
  it("does not start Bash for an already interrupted shot", async () => {
    let calls = 0;
    const result = await shotOpenui("root = Stack([])", "already-aborted", {
      outDir: workDir,
      context,
      signal: AbortSignal.abort(new Error("cancelled before launch")),
      async requestBash() {
        calls += 1;
        throw new Error("unexpected launch");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.equal(existsSync(join(workDir, "already-aborted.png")), false);
  });

  it("waits for cooperative cleanup before returning an interruption", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let inputPath = "";
    let returned = false;
    const pending = shotOpenui("root = Stack([])", "cooperative", {
      outDir: workDir,
      context,
      signal: controller.signal,
      async requestBash(request) {
        const { path } = inputOf(request);
        inputPath = path;
        assert.equal(request.signal, undefined);
        try {
          await runSnapshot(path, async (_input, signal) => {
            entered();
            await new Promise<void>((resolve) =>
              signal!.addEventListener("abort", () => resolve(), { once: true }),
            );
            await cleanup;
            signal!.throwIfAborted();
          });
          return { status: "completed", result: { content: [], details: {} } };
        } catch (error) {
          return {
            status: "completed",
            result: {
              content: [{ type: "text", text: String(error) }],
              isError: true,
              details: {},
            },
          };
        }
      },
    }).then((result) => {
      returned = true;
      return result;
    });
    await started;
    controller.abort(new Error("user interruption"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(returned, false);
    assert.equal(existsSync(dirname(inputPath)), true);
    release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(existsSync(dirname(inputPath)), false);
    assert.equal(existsSync(join(workDir, "cooperative.png")), false);
  });

  it("does not publish a staged PNG when interruption wins at command completion", async () => {
    const controller = new AbortController();
    const result = await shotOpenui("root = Stack([])", "late-abort", {
      outDir: workDir,
      context,
      signal: controller.signal,
      async requestBash(request) {
        const { path, input } = inputOf(request);
        writeFileSync(input.pngPath, PNG);
        completeMock(path);
        controller.abort(new Error("interrupted before publish"));
        return { status: "completed", result: { content: [], details: {} } };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(workDir, "late-abort.png")), false);
  });

  it("reports abnormal CLI exit without treating missing cleanup as completion", async () => {
    let owned = "";
    const result = await shotOpenui("root = Stack([])", "cli-exit", {
      outDir: workDir,
      context,
      async requestBash(request) {
        owned = dirname(inputOf(request).path);
        renameSync(join(owned, "pending"), join(owned, "running"));
        writeFileSync(join(owned, "running", "owner.json"), JSON.stringify({ pid: 2147483647 }));
        return { status: "failed", error: new Error("CLI terminated") };
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /exited without confirming browser cleanup/);
    assert.equal(existsSync(join(owned, "cancel")), true);
    assert.equal(existsSync(join(workDir, "cli-exit.png")), false);
    rmSync(owned, { recursive: true, force: true });
  });

  it("bounds the wait when the recorded PID is still alive without a completion notice", async () => {
    let owned = "";
    const started = Date.now();
    const result = await shotOpenui("root = Stack([])", "unconfirmed-owner", {
      outDir: workDir,
      context,
      async requestBash(request) {
        owned = dirname(inputOf(request).path);
        renameSync(join(owned, "pending"), join(owned, "running"));
        writeFileSync(join(owned, "running", "owner.json"), JSON.stringify({ pid: process.pid }));
        return { status: "unavailable", error: new Error("API stopped") };
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cleanup could not be confirmed/);
    assert.ok(Date.now() - started < 7000);
    assert.equal(existsSync(join(owned, "cancel")), true);
    process.kill(process.pid, 0);
    rmSync(owned, { recursive: true, force: true });
  }, 10000);

  it("handles an absent registered API without spawning a fallback", async () => {
    const result = await shotOpenui("root = Stack([])", "no-api", {
      outDir: workDir,
      context,
      requestBash: requestBackgroundBash,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /No active background Bash API/);
  });
});
