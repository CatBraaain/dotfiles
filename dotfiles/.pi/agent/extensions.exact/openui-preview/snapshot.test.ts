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
import { afterAll, beforeAll, describe, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { displayLibrary } from "./library.data";
import {
  shotOpenui,
  SHOT_TIMEOUT_SECONDS,
  SHOT_PROCESS_TIMEOUT_SECONDS,
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
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type SnapshotExecResult = ExecResult & { truncated?: boolean };

function inputOf(args: string[]): { input: SnapshotInput; path: string } {
  assert.equal(args.length, 6);
  assert.deepEqual(
    args.slice(0, 3).map((value) => value.split("=", 1)[0]),
    ["TMPDIR", "TMP", "TEMP"],
  );
  const ownedDir = args[0]!.slice("TMPDIR=".length);
  assert.deepEqual(args.slice(0, 3), [`TMPDIR=${ownedDir}`, `TMP=${ownedDir}`, `TEMP=${ownedDir}`]);
  assert.equal(args[3], "bun");
  assert.match(args[4]!, /snapshot-cli\.ts$/);
  const path = args[5];
  assert.ok(path);
  return { input: JSON.parse(readFileSync(path, "utf8")), path };
}

function processResult(
  stdout = "",
  stderr = "",
  code = 0,
  killed = false,
  truncated = false,
): SnapshotExecResult {
  return { stdout, stderr, code, killed, truncated };
}

describe("shotOpenui", () => {
  it("cleans real Playwright launch-failure artifacts through pi.exec", async () => {
    const root = mkdtempSync(join(workDir, "launch-temp-"));
    const previousTempDir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      const before = new Set(readdirSync(root));
      let ownedDir = "";
      const result = await shotOpenui(
        'root = Stack([TextContent("cleanup probe")])',
        "real-launch-failure",
        {
          outDir: workDir,
          generatedDir: workDir,
          exec: async (command, args) => {
            const { path } = inputOf(args);
            ownedDir = dirname(path);
            const child = Bun.spawn([command, ...args], {
              stdout: "pipe",
              stderr: "pipe",
              env: {
                ...process.env,
                PLAYWRIGHT_BROWSERS_PATH: join(workDir, "empty-browser-cache"),
              },
            });
            const [stdout, stderr, code] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            assert.deepEqual(readdirSync(ownedDir).sort(), [
              "finished.json",
              "input.json",
              "running",
            ]);
            return processResult(stdout, stderr, code);
          },
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
      if (previousTempDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTempDir;
    }
  }, 20_000);

  it("passes input as JSON data through pi.exec with a 15-second deadline", async () => {
    let requestCount = 0;
    let inputPath = "";
    const source = 'root = Stack([TextContent("$(touch /tmp/never); \\\"quoted\\\"")])';
    const result = await shotOpenui(source, "success", {
      outDir: workDir,
      generatedDir: "/generated spec with spaces",
      async exec(command, args, options) {
        requestCount += 1;
        assert.equal(command, "env");
        const { input, path } = inputOf(args);
        inputPath = path;
        assert.equal(options?.timeout, SHOT_PROCESS_TIMEOUT_SECONDS * 1_000);
        assert.equal(SHOT_PROCESS_TIMEOUT_SECONDS, 20);
        assert.equal(SHOT_TIMEOUT_SECONDS, 15);
        assert.equal(input.source, source);
        assert.equal(input.generatedDir, "/generated spec with spaces");
        assert.ok(input.deadline > Date.now() && input.deadline <= Date.now() + 15_000);
        assert.ok(!args.join(" ").includes("touch"));
        writeFileSync(input.pngPath, PNG);
        completeMock(path);
        assert.notEqual(input.pngPath, join(workDir, "success.png"));
        return processResult();
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.pngPath, /success\.png$/);
    assert.equal(requestCount, 1);
    assert.equal(existsSync(dirname(inputPath)), false);
  });

  for (const [name, outcome] of [
    ["unavailable process", new Error("No API")],
    ["deadline", processResult("", "", -1, true)],
    ["truncated output", processResult("", "", 0, false, true)],
    ["interruption", new Error("interrupted")],
    ["command failure", processResult("", "Command requires a reason", 1)],
  ] satisfies Array<[string, SnapshotExecResult | Error]>) {
    it(`cleans temporary input and partial output after ${name} without retry`, async () => {
      let inputPath = "";
      let pngPath = "";
      let calls = 0;
      const result = await shotOpenui("root = Stack([])", name, {
        outDir: workDir,
        async exec(_command, args) {
          calls += 1;
          const { input, path } = inputOf(args);
          inputPath = path;
          pngPath = input.pngPath;
          const profile = join(dirname(path), "playwright_chromiumdev_profile-test");
          mkdirSync(profile);
          writeFileSync(join(profile, "partial"), "partial");
          writeFileSync(pngPath, "partial");
          if (outcome instanceof Error) throw outcome;
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

  it("rejects a successful process result without a PNG", async () => {
    const result = await shotOpenui("root = Stack([])", "missing", {
      outDir: workDir,
      async exec(_command, args) {
        completeMock(inputOf(args).path);
        return processResult();
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /ENOENT/);
  });
  it("rejects a non-PNG output even when the process succeeds", async () => {
    const result = await shotOpenui("root = Stack([])", "not-png", {
      outDir: workDir,
      async exec(_command, args) {
        const { input, path } = inputOf(args);
        writeFileSync(input.pngPath, "not PNG");
        completeMock(path);
        return processResult();
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /did not produce a PNG/);
  });
  it("does not start a process for an already interrupted shot", async () => {
    let calls = 0;
    const result = await shotOpenui("root = Stack([])", "already-aborted", {
      outDir: workDir,
      signal: AbortSignal.abort(new Error("cancelled before launch")),
      async exec() {
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
      signal: controller.signal,
      async exec(_command, args) {
        const { path } = inputOf(args);
        inputPath = path;
        try {
          await runSnapshot(path, async (_input, signal) => {
            entered();
            await new Promise<void>((resolve) =>
              signal!.addEventListener("abort", () => resolve(), { once: true }),
            );
            await cleanup;
            signal!.throwIfAborted();
          });
          return processResult();
        } catch (error) {
          return processResult("", String(error), 1);
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
      signal: controller.signal,
      async exec(_command, args) {
        const { path, input } = inputOf(args);
        writeFileSync(input.pngPath, PNG);
        completeMock(path);
        controller.abort(new Error("interrupted before publish"));
        return processResult();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(workDir, "late-abort.png")), false);
  });

  it("reports abnormal CLI exit without treating missing cleanup as completion", async () => {
    let owned = "";
    const result = await shotOpenui("root = Stack([])", "cli-exit", {
      outDir: workDir,
      async exec(_command, args) {
        owned = dirname(inputOf(args).path);
        renameSync(join(owned, "pending"), join(owned, "running"));
        writeFileSync(join(owned, "running", "owner.json"), JSON.stringify({ pid: 2147483647 }));
        throw new Error("process terminated");
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
      async exec(_command, args) {
        owned = dirname(inputOf(args).path);
        renameSync(join(owned, "pending"), join(owned, "running"));
        writeFileSync(join(owned, "running", "owner.json"), JSON.stringify({ pid: process.pid }));
        throw new Error("process stopped");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cleanup could not be confirmed/);
    assert.ok(Date.now() - started < 7000);
    assert.equal(existsSync(join(owned, "cancel")), true);
    process.kill(process.pid, 0);
    rmSync(owned, { recursive: true, force: true });
  }, 10000);

  it("reports a process launch failure", async () => {
    const result = await shotOpenui("root = Stack([])", "process-launch", {
      outDir: workDir,
      async exec() {
        throw new Error("process launch failed");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /process launch failed/);
  });
});
