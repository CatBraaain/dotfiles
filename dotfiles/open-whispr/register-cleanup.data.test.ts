import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HookError,
  STORAGE_KEY,
  acquireHookLock,
  buildHarnessPackageJson,
  buildHarnessSource,
  clearRecoveryRecord,
  formatStatusLine,
  parseAsarPackageName,
  registerCleanup,
  sha256Hex,
  recoveryRecordPath,
  resolvePaths,
  runHarnessMode,
  validatePromptBytes,
} from "./register-cleanup.apply.ts";

const hookScriptPath = join(import.meta.dir, "register-cleanup.apply.ts");

function expectHookError(run: () => unknown, code: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof HookError && error.code === code,
  );
}

describe("validatePromptBytes", () => {
  it("accepts a unicode multiline prompt and returns its sha256", () => {
    const text =
      'Remove えーと and "uh".\nKeep 来週、いや、再来週 and `x = 1`.\n';
    const validated = validatePromptBytes(Buffer.from(text, "utf8"));
    assert.equal(validated.text, text);
    assert.match(validated.sha256Hex, /^[0-9a-f]{64}$/);
  });

  it("rejects a blank prompt", () => {
    expectHookError(
      () => validatePromptBytes(Buffer.from("", "utf8")),
      "INVALID_INPUT",
    );
  });

  it("rejects a whitespace-only prompt", () => {
    expectHookError(
      () => validatePromptBytes(Buffer.from(" \n\t \n", "utf8")),
      "INVALID_INPUT",
    );
  });

  it("rejects a prompt containing NUL", () => {
    expectHookError(
      () => validatePromptBytes(Buffer.from("a\0b", "utf8")),
      "INVALID_INPUT",
    );
  });

  it("rejects bytes that are not valid UTF-8", () => {
    expectHookError(
      () => validatePromptBytes(Buffer.from([0xff, 0xfe, 0x41])),
      "INVALID_INPUT",
    );
  });
});

describe("resolvePaths", () => {
  it("resolves Linux production defaults under HOME", () => {
    const expectedProfileDir = join("/home/example", ".config", "open-whispr");
    const paths = resolvePaths("linux", { HOME: "/home/example" });
    assert.equal(
      paths.promptPath,
      join(expectedProfileDir, "cleanup-prompt.txt"),
    );
    assert.equal(paths.profileDir, expectedProfileDir);
    assert.equal(paths.appDir, "/opt/OpenWhispr");
    assert.equal(paths.appBinaryName, "open-whispr-app");
    assert.equal(paths.isE2E, false);
  });

  it("resolves Windows production defaults from APPDATA and LOCALAPPDATA", () => {
    const paths = resolvePaths("win32", {
      APPDATA: join(tmpdir(), "appdata"),
      LOCALAPPDATA: join(tmpdir(), "localappdata"),
    });
    const expectedProfile = join(join(tmpdir(), "appdata"), "open-whispr");
    assert.equal(paths.profileDir, expectedProfile);
    assert.equal(paths.promptPath, join(expectedProfile, "cleanup-prompt.txt"));
    assert.equal(
      paths.appDir,
      join(join(tmpdir(), "localappdata"), "Programs", "OpenWhispr"),
    );
    assert.equal(paths.appBinaryName, "OpenWhispr.exe");
  });

  it("rejects Windows without APPDATA", () => {
    expectHookError(
      () => resolvePaths("win32", { LOCALAPPDATA: "/x" }),
      "INVALID_INPUT",
    );
  });

  it("rejects Linux without HOME", () => {
    expectHookError(() => resolvePaths("linux", {}), "INVALID_INPUT");
  });

  it("rejects unsupported platforms", () => {
    expectHookError(
      () => resolvePaths("darwin", { HOME: "/home/example" }),
      "INVALID_INPUT",
    );
  });

  it("honors e2e overrides only for paths under tmpdir", () => {
    const promptPath = join(tmpdir(), "openwhispr-unit-prompt.txt");
    const profileDir = join(tmpdir(), "openwhispr-unit-profile");
    const paths = resolvePaths("linux", {
      OPENWHISPR_E2E: "1",
      OPENWHISPR_E2E_PROMPT: promptPath,
      OPENWHISPR_E2E_PROFILE: profileDir,
    });
    assert.equal(paths.isE2E, true);
    assert.equal(paths.promptPath, promptPath);
    assert.equal(paths.profileDir, profileDir);
  });

  it("rejects an e2e profile outside tmpdir", () => {
    expectHookError(
      () =>
        resolvePaths("linux", {
          OPENWHISPR_E2E: "1",
          OPENWHISPR_E2E_PROFILE: "/home/example/.config/open-whispr",
          OPENWHISPR_E2E_PROMPT: join(tmpdir(), "prompt.txt"),
        }),
      "INVALID_INPUT",
    );
  });
});

describe("storage key", () => {
  it("touches only the customPrompt.cleanup key", () => {
    assert.equal(STORAGE_KEY, "customPrompt.cleanup");
  });
});

describe("status line", () => {
  it("formats a machine-readable single line", () => {
    const line = formatStatusLine({
      status: "applied",
      code: "OK",
      promptSha256: "abc123",
    });
    assert.equal(line, "status=applied code=OK prompt_sha256=abc123");
    assert.equal(line.includes("\n"), false);
  });

  it("marks an unknown prompt hash with a dash", () => {
    const line = formatStatusLine({
      status: "error",
      code: "LOCKED",
      promptSha256: null,
    });
    assert.equal(line, "status=error code=LOCKED prompt_sha256=-");
  });
});

describe("harness source guards", () => {
  const source = buildHarnessSource();

  it("requires an absolute expected profile before anything else", () => {
    assert.ok(source.includes("OW_HARNESS_PROFILE"));
    assert.ok(source.includes("isAbsolute"));
    assert.ok(source.includes("process.exit(90)"));
  });

  it("acquires the singleton lock and reports LOCKED on contention", () => {
    assert.ok(source.includes("requestSingleInstanceLock"));
    assert.ok(source.includes('status: "locked"'));
    assert.ok(source.includes("app.exit(23)"));
  });

  it("uses a hidden sandboxed window without node integration", () => {
    assert.ok(source.includes("show: false"));
    assert.ok(source.includes("sandbox: true"));
    assert.ok(source.includes("nodeIntegration: false"));
  });

  it("serves an inert file-protocol document and denies other requests and permissions", () => {
    assert.ok(source.includes('protocol.handle("file"'));
    assert.ok(source.includes('startsWith("file:")'));
    assert.ok(source.includes("setPermissionRequestHandler"));
    assert.ok(source.includes("callback(false)"));
  });

  it("never enables remote debugging or disables the sandbox", () => {
    assert.equal(source.includes("remote-debugging"), false);
    assert.equal(source.includes("inspect"), false);
    assert.equal(source.includes("--no-sandbox"), false);
  });

  it("writes only the managed storage key", () => {
    assert.ok(source.includes(STORAGE_KEY));
    assert.ok(source.includes("restore-failed"));
    assert.equal(
      buildHarnessPackageJson().includes(
        "open-whispr-cleanup-registration-harness",
      ),
      true,
    );
  });
});

function buildAsarFixture(packageName: string): Buffer {
  const packageJson = Buffer.from(
    JSON.stringify({ name: packageName, version: "9.9.9" }),
    "utf8",
  );
  const jsonLength = Buffer.byteLength(
    JSON.stringify({
      files: { "package.json": { offset: "0", size: packageJson.length } },
    }),
    "utf8",
  );
  const padding = (4 - (jsonLength % 4)) % 4;
  const headerPickleLength = 8 + jsonLength + padding;
  const header = Buffer.alloc(16 + jsonLength + padding);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerPickleLength, 4);
  header.writeUInt32LE(headerPickleLength - 4, 8);
  header.writeUInt32LE(jsonLength, 12);
  header.write(
    JSON.stringify({
      files: { "package.json": { offset: "0", size: packageJson.length } },
    }),
    16,
    "utf8",
  );
  return Buffer.concat([header, packageJson]);
}

describe("asar package identity", () => {
  it("extracts the package name from an asar archive", () => {
    const asar = buildAsarFixture("open-whispr-fixture");
    assert.equal(parseAsarPackageName(asar), "open-whispr-fixture");
  });

  it("rejects malformed asar bytes", () => {
    expectHookError(
      () => parseAsarPackageName(Buffer.from([1, 2, 3])),
      "INVALID_INPUT",
    );
  });

  it("rejects an asar without a package.json entry", () => {
    const json = Buffer.from(JSON.stringify({ files: {} }), "utf8");
    const header = Buffer.alloc(16 + json.length);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(8 + json.length, 4);
    header.writeUInt32LE(4 + json.length, 8);
    header.writeUInt32LE(json.length, 12);
    header.write(JSON.stringify({ files: {} }), 16, "utf8");
    expectHookError(
      () => parseAsarPackageName(Buffer.concat([header, json])),
      "INVALID_INPUT",
    );
  });
});

describe("hook lock and recovery record", () => {
  it("excludes concurrent registration runs for the same profile", async () => {
    const profileDir = join(tmpdir(), `openwhispr-lock-fixture-${Date.now()}`);
    const release = await acquireHookLock(profileDir, 300);
    try {
      await assert.rejects(
        acquireHookLock(profileDir, 300),
        (error: unknown) =>
          error instanceof HookError && error.code === "LOCKED",
      );
    } finally {
      await release();
    }
    const releaseAgain = await acquireHookLock(profileDir, 300);
    await releaseAgain();
  });

  it("writes and clears a recovery record", async () => {
    const profileDir = join(
      tmpdir(),
      `openwhispr-recovery-fixture-${Date.now()}`,
    );
    await (async () => {
      const { writeRecoveryRecord } =
        await import("./register-cleanup.apply.ts");
      await writeRecoveryRecord(profileDir, {
        phase: "verify",
        promptSha256: "abc",
        previousValue: "old prompt",
        previousSha256: "def",
      });
      assert.ok(existsSync(recoveryRecordPath(profileDir)));
      await clearRecoveryRecord(profileDir);
      assert.equal(existsSync(recoveryRecordPath(profileDir)), false);
    })();
  });
});

const e2eEnabled = process.env.OPENWHISPR_E2E === "1";
const maybeIt = e2eEnabled ? it : it.skip;

type StatusLine = { status: string; code: string; promptSha256: string };

function parseStatusLine(stdout: string): StatusLine {
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const match = /^status=(\S+) code=(\S+) prompt_sha256=(\S+)$/.exec(lastLine);
  assert.ok(match, `unexpected status line: ${lastLine}`);
  return {
    status: match[1]!,
    code: match[2]!,
    promptSha256: match[3]!,
  };
}

describe("registration with an uninitialized profile", () => {
  const fixtureRoots: string[] = [];
  const promptText = "Remove only fillers. Keep 来週、いや、再来週.\n";

  function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "openwhispr-uninitialized-"));
    fixtureRoots.push(root);
    const appDir = join(root, "app");
    mkdirSync(join(appDir, "resources"), { recursive: true });
    writeFileSync(
      join(appDir, "resources", "app.asar"),
      buildAsarFixture("open-whispr"),
    );
    const platform =
      process.platform === "win32" ? ("win32" as const) : ("linux" as const);
    const binaryName =
      platform === "win32" ? "OpenWhispr.exe" : "open-whispr-app";
    writeFileSync(join(appDir, binaryName), `unused fixture binary: ${root}`);
    const profileDir = join(root, "profile");
    const promptPath = join(root, "cleanup-prompt.txt");
    writeFileSync(promptPath, promptText);
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      OPENWHISPR_E2E: "1",
      OPENWHISPR_E2E_PROMPT: promptPath,
      OPENWHISPR_E2E_PROFILE: profileDir,
      OPENWHISPR_E2E_APP_DIR: appDir,
    };
    return { root, appDir, profileDir, promptPath, platform, env };
  }

  function snapshot(root: string) {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .sort()
      .map((entry) => {
        const path = join(root, entry);
        return [
          entry,
          statSync(path).isDirectory()
            ? null
            : readFileSync(path).toString("hex"),
        ];
      });
  }

  function runtimeEntries() {
    return readdirSync(tmpdir())
      .filter((entry) =>
        /^(openwhispr-register-runtime-|openwhispr-runtime-|openwhispr-harness-home-)/.test(
          entry,
        ),
      )
      .sort();
  }

  afterAll(() => {
    for (const root of fixtureRoots)
      rmSync(root, { recursive: true, force: true });
  });

  for (const profileState of ["missing", "prompt-only"] as const) {
    it(`skips a ${profileState} profile without creating runtime or changing files`, async () => {
      const fixture = createFixture();
      if (profileState === "prompt-only") {
        mkdirSync(fixture.profileDir);
        fixture.env.OPENWHISPR_E2E_PROMPT = join(
          fixture.profileDir,
          "cleanup-prompt.txt",
        );
        writeFileSync(fixture.env.OPENWHISPR_E2E_PROMPT, promptText);
        writeFileSync(
          join(fixture.profileDir, ".env"),
          "preserve-fixture-settings\n",
        );
      }
      const before = snapshot(fixture.root);
      const runtimesBefore = runtimeEntries();
      const outcome = await registerCleanup(fixture);
      assert.equal(outcome.status, "skipped");
      assert.equal(outcome.code, "OK");
      assert.equal(outcome.promptSha256, sha256Hex(promptText));
      assert.match(
        outcome.detail ?? "",
        /launch and quit OpenWhispr, then run apply again/,
      );
      assert.ok(outcome.detail?.includes(fixture.profileDir));
      assert.equal(
        formatStatusLine(outcome),
        `status=skipped code=OK prompt_sha256=${sha256Hex(promptText)}`,
      );
      assert.deepEqual(snapshot(fixture.root), before);
      assert.deepEqual(runtimeEntries(), runtimesBefore);
      assert.equal(existsSync(recoveryRecordPath(fixture.profileDir)), false);
      assert.equal(
        existsSync(
          join(
            tmpdir(),
            `openwhispr-register-cleanup-${sha256Hex(fixture.profileDir).slice(0, 16)}.lock`,
          ),
        ),
        false,
      );
    });
  }

  it("skips without waiting for or releasing an existing hook lock", async () => {
    const fixture = createFixture();
    const release = await acquireHookLock(fixture.profileDir, 300);
    const lockPath = join(
      tmpdir(),
      `openwhispr-register-cleanup-${sha256Hex(fixture.profileDir).slice(0, 16)}.lock`,
    );
    const lockBefore = statSync(lockPath);
    try {
      const outcome = await registerCleanup(fixture);
      assert.equal(outcome.status, "skipped");
      assert.equal(outcome.code, "OK");
      assert.equal(statSync(lockPath).mtimeMs, lockBefore.mtimeMs);
    } finally {
      await release();
    }
  });

  for (const invalidPrompt of ["missing", "blank", "nul", "utf8"] as const) {
    it(`rejects a ${invalidPrompt} prompt before skipping`, async () => {
      const fixture = createFixture();
      const invalidBytes = {
        blank: Buffer.from(" \n"),
        nul: Buffer.from("a\0b"),
        utf8: Buffer.from([0xff]),
      };
      if (invalidPrompt === "missing") rmSync(fixture.promptPath);
      else writeFileSync(fixture.promptPath, invalidBytes[invalidPrompt]);
      rmSync(fixture.appDir, { recursive: true });
      const before = snapshot(fixture.root);
      const outcome = await registerCleanup(fixture);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.equal(outcome.promptSha256, null);
      assert.match(outcome.detail ?? "", /prompt file/);
      assert.deepEqual(snapshot(fixture.root), before);
    });
  }

  for (const invalidApp of ["missing", "malformed", "wrong-name"] as const) {
    it(`rejects a ${invalidApp} app before skipping`, async () => {
      const fixture = createFixture();
      const asarPath = join(fixture.appDir, "resources", "app.asar");
      if (invalidApp === "missing") rmSync(fixture.appDir, { recursive: true });
      else
        writeFileSync(
          asarPath,
          invalidApp === "malformed"
            ? Buffer.from([1, 2, 3])
            : buildAsarFixture("other-app"),
        );
      const before = snapshot(fixture.root);
      const outcome = await registerCleanup(fixture);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.equal(outcome.promptSha256, sha256Hex(promptText));
      assert.match(outcome.detail ?? "", /installed app/);
      assert.deepEqual(snapshot(fixture.root), before);
    });
  }

  for (const marker of ["Preferences", "Local Storage"] as const) {
    it(`does not skip a profile recognized by ${marker}`, async () => {
      const fixture = createFixture();
      mkdirSync(fixture.profileDir);
      if (marker === "Preferences")
        writeFileSync(join(fixture.profileDir, marker), "{}");
      else mkdirSync(join(fixture.profileDir, marker));
      rmSync(
        join(
          fixture.appDir,
          fixture.platform === "linux" ? "open-whispr-app" : "OpenWhispr.exe",
        ),
      );
      const before = snapshot(fixture.root);
      const outcome = await registerCleanup(fixture);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.match(outcome.detail ?? "", /installed app binary is missing/);
      assert.deepEqual(snapshot(fixture.root), before);
    });
  }

  it("returns CLI exit 0 with plain stdout detail and empty stderr", async () => {
    const fixture = createFixture();
    const before = snapshot(fixture.root);
    const runtimesBefore = runtimeEntries();
    const child = Bun.spawn([process.execPath, hookScriptPath], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(exitCode, 0);
    assert.deepEqual(parseStatusLine(stdout), {
      status: "skipped",
      code: "OK",
      promptSha256: sha256Hex(promptText),
    });
    assert.match(stdout, /launch and quit OpenWhispr, then run apply again/);
    assert.ok(stdout.includes(fixture.profileDir));
    assert.equal(stdout.includes("\u001b"), false);
    assert.equal(stderr, "");
    assert.deepEqual(snapshot(fixture.root), before);
    assert.deepEqual(runtimeEntries(), runtimesBefore);
  });

  it("keeps CLI input errors on stderr with exit 2", async () => {
    const fixture = createFixture();
    rmSync(fixture.promptPath);
    const before = snapshot(fixture.root);
    const child = Bun.spawn([process.execPath, hookScriptPath], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(exitCode, 2);
    assert.equal(stdout, "status=error code=INVALID_INPUT prompt_sha256=-\n");
    assert.match(stderr, /prompt file is missing/);
    assert.ok(stderr.includes(fixture.promptPath));
    assert.deepEqual(snapshot(fixture.root), before);
  });
});

describe("e2e with the installed Electron runtime", () => {
  const e2ePlatform =
    process.platform === "win32" ? ("win32" as const) : ("linux" as const);
  const e2eAppDir =
    e2ePlatform === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "Programs", "OpenWhispr")
      : "/opt/OpenWhispr";
  const promptText =
    'Remove only unambiguous fillers: "uh", "um", "えー", "えーと".\n' +
    "Keep 来週、いや、再来週 and code: `x = 1`.\n";
  let e2eRoot = "";
  let promptPath = "";
  let profileDir = "";
  let runtimeDir = "";
  let holdChild: ChildProcess | null = null;
  let holdCleanup: (() => Promise<void>) | null = null;

  const harnessEnv = (): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    return env;
  };

  const hookEnv = (
    overrides: Record<string, string>,
  ): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: "/tmp",
    OPENWHISPR_E2E: "1",
    ...(e2ePlatform === "win32"
      ? {
          APPDATA: process.env.APPDATA ?? "",
          LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
        }
      : {}),
    ...overrides,
  });

  const hookOverrides = (
    extra: Record<string, string>,
  ): Record<string, string> => ({
    OPENWHISPR_E2E_APP_DIR: e2eAppDir,
    ...extra,
  });

  async function runHookScript(
    overrides: Record<string, string>,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const child = spawn("bun", [hookScriptPath], { env: hookEnv(overrides) });
      let stdout = "";
      let stderr = "";
      child.stdout.on(
        "data",
        (chunk: Buffer) => (stdout += chunk.toString("utf8")),
      );
      child.stderr.on(
        "data",
        (chunk: Buffer) => (stderr += chunk.toString("utf8")),
      );
      child.on("error", (error) =>
        resolve({ exitCode: null, stdout, stderr: String(error) }),
      );
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }

  async function startHoldHelper(): Promise<void> {
    const run = await runHarnessMode({
      mode: "hold",
      runtimeDir,
      profileDir,
      platform: e2ePlatform,
      env: harnessEnv(),
      keepAlive: true,
      holdMs: 300_000,
      timeoutMs: 60_000,
    });
    assert.equal(
      run.outcome.kind,
      "ok",
      `hold helper did not become ready: ${JSON.stringify(run.outcome)}`,
    );
    holdChild = run.child;
    holdCleanup = run.cleanup;
  }

  async function stopHoldHelper(): Promise<void> {
    const child = holdChild;
    holdChild = null;
    if (child?.pid) {
      try {
        if (e2ePlatform === "linux") process.kill(-child.pid, "SIGKILL");
        else
          spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
            windowsHide: true,
          });
      } catch {}
      await new Promise((resolve) => {
        child.on("close", () => resolve(null));
        setTimeout(resolve, 5_000);
      });
    }
    await holdCleanup?.();
    holdCleanup = null;
  }

  async function seedProfile(cleanupValue: string): Promise<void> {
    const run = await runHarnessMode({
      mode: "seed",
      runtimeDir,
      profileDir,
      platform: e2ePlatform,
      env: harnessEnv(),
      seedJson: JSON.stringify({
        [STORAGE_KEY]: cleanupValue,
        model: "preserve-fixture-model",
        otherPrompt: "preserve-fixture-prompt",
      }),
      timeoutMs: 60_000,
    });
    assert.equal(
      run.outcome.kind,
      "ok",
      `seed run failed: ${JSON.stringify(run.outcome)}`,
    );
  }

  async function dumpStorage(): Promise<Record<string, string>> {
    const run = await runHarnessMode({
      mode: "dump",
      runtimeDir,
      profileDir,
      platform: e2ePlatform,
      env: harnessEnv(),
      allowDump: true,
      timeoutMs: 60_000,
    });
    assert.equal(
      run.outcome.kind,
      "ok",
      `dump run failed: ${JSON.stringify(run.outcome)}`,
    );
    return run.outcome.kind === "ok" ? (run.outcome.payload.storage ?? {}) : {};
  }

  beforeAll(async () => {
    if (!e2eEnabled) return;
    e2eRoot = mkdtempSync(join(tmpdir(), "openwhispr-hook-e2e-"));
    promptPath = join(e2eRoot, "cleanup-prompt.txt");
    writeFileSync(promptPath, promptText, "utf8");
    profileDir = join(e2eRoot, "profile");
    const { ensureShadowRuntime } = await import("./register-cleanup.apply.ts");
    runtimeDir = await ensureShadowRuntime(e2eAppDir, e2ePlatform);
    await seedProfile("old-fixture-prompt");
  }, 120_000);

  afterAll(async () => {
    if (!e2eEnabled) return;
    await stopHoldHelper();
  });

  maybeIt(
    "applies the prompt with unicode fidelity and preserves unrelated keys",
    async () => {
      await seedProfile("old-fixture-prompt");
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_PROMPT: promptPath,
          OPENWHISPR_E2E_PROFILE: profileDir,
        }),
      );
      const status = parseStatusLine(result.stdout);
      assert.deepEqual(
        [status.status, status.code],
        ["applied", "OK"],
        result.stderr,
      );
      assert.equal(result.exitCode, 0);
      const storage = await dumpStorage();
      assert.equal(storage[STORAGE_KEY], promptText);
      assert.equal(storage.model, "preserve-fixture-model");
      assert.equal(storage.otherPrompt, "preserve-fixture-prompt");
    },
    180_000,
  );

  maybeIt(
    "is unchanged on an idempotent second run",
    async () => {
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_PROMPT: promptPath,
          OPENWHISPR_E2E_PROFILE: profileDir,
        }),
      );
      const status = parseStatusLine(result.stdout);
      assert.deepEqual(
        [status.status, status.code],
        ["unchanged", "OK"],
        result.stderr,
      );
      assert.equal(result.exitCode, 0);
    },
    120_000,
  );

  maybeIt(
    "aborts with LOCKED before writing when the singleton lock is held",
    async () => {
      await seedProfile("old-fixture-prompt");
      await startHoldHelper();
      try {
        const result = await runHookScript(
          hookOverrides({
            OPENWHISPR_E2E_PROMPT: promptPath,
            OPENWHISPR_E2E_PROFILE: profileDir,
          }),
        );
        const status = parseStatusLine(result.stdout);
        assert.deepEqual(
          [status.status, status.code],
          ["error", "LOCKED"],
          result.stderr,
        );
        assert.equal(result.exitCode, 3);
        assert.equal(
          result.stderr.trim(),
          "the profile singleton lock is held by another process; OpenWhispr is likely running — quit it and run apply again",
        );
        assert.ok(
          holdChild?.exitCode === null || holdChild?.exitCode === undefined,
          "helper was stopped",
        );
      } finally {
        await stopHoldHelper();
      }
      const storage = await dumpStorage();
      assert.equal(storage[STORAGE_KEY], "old-fixture-prompt");
      assert.equal(storage.model, "preserve-fixture-model");
    },
    180_000,
  );

  maybeIt(
    "rejects a prompt file that does not exist without touching the profile",
    async () => {
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_PROMPT: join(e2eRoot, "missing-prompt.txt"),
          OPENWHISPR_E2E_PROFILE: profileDir,
        }),
      );
      const status = parseStatusLine(result.stdout);
      assert.deepEqual(
        [status.status, status.code],
        ["error", "INVALID_INPUT"],
        result.stderr,
      );
      assert.equal(result.exitCode, 2);
    },
    120_000,
  );
});
