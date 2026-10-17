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
  MANAGED_KEYS_FILE,
  acquireHookLock,
  buildHarnessPackageJson,
  buildHarnessSource,
  clearRecoveryRecord,
  formatStatusLine,
  loadManagedKeys,
  managedKeysSha256,
  parseAsarPackageName,
  manageConfig,
  sha256Hex,
  recoveryRecordPath,
  resolvePaths,
  runHarnessMode,
  validateManagedKeys,
} from "./manage-config.apply.ts";

const hookScriptPath = join(import.meta.dir, "manage-config.apply.ts");

function expectHookError(run: () => unknown, code: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof HookError && error.code === code,
  );
}

describe("resolvePaths", () => {
  it("resolves Linux production defaults under HOME", () => {
    const expectedProfileDir = join("/home/example", ".config", "open-whispr");
    const paths = resolvePaths("linux", { HOME: "/home/example" });
    assert.equal(paths.managedKeysDir, import.meta.dir);
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
    assert.equal(paths.managedKeysDir, import.meta.dir);
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
    const keysDir = join(tmpdir(), "openwhispr-unit-keys");
    const profileDir = join(tmpdir(), "openwhispr-unit-profile");
    const paths = resolvePaths("linux", {
      OPENWHISPR_E2E: "1",
      OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
      OPENWHISPR_E2E_PROFILE: profileDir,
    });
    assert.equal(paths.isE2E, true);
    assert.equal(paths.managedKeysDir, keysDir);
    assert.equal(paths.profileDir, profileDir);
  });

  it("rejects an e2e managed keys dir outside tmpdir", () => {
    expectHookError(
      () =>
        resolvePaths("linux", {
          OPENWHISPR_E2E: "1",
          OPENWHISPR_E2E_PROFILE: join(tmpdir(), "profile"),
          OPENWHISPR_E2E_MANAGED_KEYS: "/home/example/keys",
        }),
      "INVALID_INPUT",
    );
  });

  it("rejects an e2e profile outside tmpdir", () => {
    expectHookError(
      () =>
        resolvePaths("linux", {
          OPENWHISPR_E2E: "1",
          OPENWHISPR_E2E_PROFILE: "/home/example/.config/open-whispr",
          OPENWHISPR_E2E_MANAGED_KEYS: join(tmpdir(), "keys"),
        }),
      "INVALID_INPUT",
    );
  });
});

describe("validateManagedKeys and loadManagedKeys", () => {
  function writeDeclaration(root: string, yamlText: string): string {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, MANAGED_KEYS_FILE), yamlText, "utf8");
    return root;
  }

  it("expands inline values including multiline block scalars", () => {
    const root = writeDeclaration(
      mkdtempSync(join(tmpdir(), "openwhispr-keys-")),
      [
        "keys:",
        "  - key: customPrompt.cleanup",
        "    value: |",
        "      cleanup text",
        "      second line",
        "  - key: useDictationAgent",
        '    value: "false"',
        "",
      ].join("\n"),
    );
    assert.deepEqual(loadManagedKeys(root), [
      { key: "customPrompt.cleanup", value: "cleanup text\nsecond line\n" },
      { key: "useDictationAgent", value: "false" },
    ]);
  });

  it("loads the shipped declaration and computes a stable hash", () => {
    const targets = loadManagedKeys(import.meta.dir);
    const keys = targets.map((target) => target.key);
    assert.deepEqual(keys.sort(), [
      "customPrompt.cleanup",
      "notifyMeetingDetection",
      "useDictationAgent",
    ]);
    assert.match(managedKeysSha256(targets), /^[0-9a-f]{64}$/);
    assert.equal(
      managedKeysSha256(targets),
      managedKeysSha256(loadManagedKeys(import.meta.dir)),
    );
  });

  it("rejects duplicate keys", () => {
    expectHookError(
      () =>
        validateManagedKeys({
          keys: [{ key: "a", value: "1" }, { key: "a", value: "2" }],
        }),
      "INVALID_INPUT",
    );
  });

  it("rejects a non-string value", () => {
    expectHookError(
      () => validateManagedKeys({ keys: [{ key: "a", value: false }] }),
      "INVALID_INPUT",
    );
  });

  it("rejects empty keys arrays", () => {
    expectHookError(
      () => validateManagedKeys({ keys: [] }),
      "INVALID_INPUT",
    );
  });

  it("rejects an invalid YAML declaration", () => {
    const root = writeDeclaration(
      mkdtempSync(join(tmpdir(), "openwhispr-keys-")),
      "keys: [broken",
    );
    expectHookError(() => loadManagedKeys(root), "INVALID_INPUT");
  });
});

describe("status line", () => {
  it("formats a machine-readable single line", () => {
    const line = formatStatusLine({
      status: "applied",
      code: "OK",
      keysSha256: "abc123",
    });
    assert.equal(line, "status=applied code=OK keys_sha256=abc123");
    assert.equal(line.includes("\n"), false);
  });

  it("marks an unknown key hash with a dash", () => {
    const line = formatStatusLine({
      status: "error",
      code: "LOCKED",
      keysSha256: null,
    });
    assert.equal(line, "status=error code=LOCKED keys_sha256=-");
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

  it("writes only targets passed via environment and restores failed keys", () => {
    assert.ok(source.includes("OW_HARNESS_TARGETS_JSON"));
    assert.ok(source.includes("restore-failed"));
    assert.equal(
      buildHarnessPackageJson().includes("open-whispr-config-harness"),
      true,
    );
  });

  it("reads and writes every declared target key", () => {
    assert.ok(source.includes("target.key"));
    assert.ok(source.includes("readKey(target.key)"));
    assert.ok(source.includes("setKey(target.key"));
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
        await import("./manage-config.apply.ts");
      await writeRecoveryRecord(profileDir, {
        phase: "verify",
        keys: [
          {
            key: "useDictationAgent",
            previousValue: "true",
            previousSha256: "def",
          },
        ],
        keysSha256: "abc",
      });
      assert.ok(existsSync(recoveryRecordPath(profileDir)));
      await clearRecoveryRecord(profileDir);
      assert.equal(existsSync(recoveryRecordPath(profileDir)), false);
    })();
  });
});

const e2eEnabled = process.env.OPENWHISPR_E2E === "1";
const maybeIt = e2eEnabled ? it : it.skip;

type StatusLine = { status: string; code: string; keysSha256: string };

function parseStatusLine(stdout: string): StatusLine {
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const match = /^status=(\S+) code=(\S+) keys_sha256=(\S+)$/.exec(lastLine);
  assert.ok(match, `unexpected status line: ${lastLine}`);
  return {
    status: match[1]!,
    code: match[2]!,
    keysSha256: match[3]!,
  };
}

describe("config registration with an uninitialized profile", () => {
  const fixtureRoots: string[] = [];
  const fixtureYaml = [
    "keys:",
    "  - key: customPrompt.cleanup",
    "    value: |",
    "      Remove only fillers. Keep 来週、いや、再来週.",
    '  - key: notifyMeetingDetection',
    '    value: "false"',
    '  - key: useDictationAgent',
    '    value: "false"',
    "",
  ].join("\n");

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
    const keysDir = join(root, "keys");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, MANAGED_KEYS_FILE), fixtureYaml, "utf8");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      OPENWHISPR_E2E: "1",
      OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
      OPENWHISPR_E2E_PROFILE: profileDir,
      OPENWHISPR_E2E_APP_DIR: appDir,
    };
    return { root, appDir, profileDir, keysDir, platform, env };
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

  for (const profileState of ["missing", "unrecognized-files"] as const) {
    it(`skips a ${profileState} profile without creating runtime or changing files`, async () => {
      const fixture = createFixture();
      if (profileState === "unrecognized-files") {
        mkdirSync(fixture.profileDir);
        writeFileSync(
          join(fixture.profileDir, ".env"),
          "preserve-fixture-settings\n",
        );
      }
      const before = snapshot(fixture.root);
      const runtimesBefore = runtimeEntries();
      const expectedKeysSha256 = managedKeysSha256(
        loadManagedKeys(fixture.keysDir),
      );
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "skipped");
      assert.equal(outcome.code, "OK");
      assert.equal(outcome.keysSha256, expectedKeysSha256);
      assert.match(
        outcome.detail ?? "",
        /launch and quit OpenWhispr, then run apply again/,
      );
      assert.ok(outcome.detail?.includes(fixture.profileDir));
      assert.equal(
        formatStatusLine(outcome),
        `status=skipped code=OK keys_sha256=${expectedKeysSha256}`,
      );
      assert.deepEqual(snapshot(fixture.root), before);
      assert.deepEqual(runtimeEntries(), runtimesBefore);
      assert.equal(existsSync(recoveryRecordPath(fixture.profileDir)), false);
      assert.equal(
        existsSync(
          join(
            tmpdir(),
            `openwhispr-manage-config-${sha256Hex(fixture.profileDir).slice(0, 16)}.lock`,
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
      `openwhispr-manage-config-${sha256Hex(fixture.profileDir).slice(0, 16)}.lock`,
    );
    const lockBefore = statSync(lockPath);
    try {
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "skipped");
      assert.equal(outcome.code, "OK");
      assert.equal(statSync(lockPath).mtimeMs, lockBefore.mtimeMs);
    } finally {
      await release();
    }
  });

  for (const invalidDeclaration of [
    "missing",
    "blank-value",
    "nul-value",
    "badyaml",
  ] as const) {
    it(`rejects a ${invalidDeclaration} managed keys file before skipping`, async () => {
      const fixture = createFixture();
      const invalidYaml: Record<string, string> = {
        "blank-value": 'keys:\n  - key: a\n    value: " \\n"\n',
        "nul-value": 'keys:\n  - key: "a"\n    value: "a\\0b"\n',
        badyaml: "keys: [broken",
      };
      if (invalidDeclaration === "missing")
        rmSync(join(fixture.keysDir, MANAGED_KEYS_FILE));
      else
        writeFileSync(
          join(fixture.keysDir, MANAGED_KEYS_FILE),
          invalidYaml[invalidDeclaration],
          "utf8",
        );
      rmSync(fixture.appDir, { recursive: true });
      const before = snapshot(fixture.root);
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.equal(outcome.keysSha256, null);
      assert.match(outcome.detail ?? "", /managed key/);
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
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.equal(
        outcome.keysSha256,
        managedKeysSha256(loadManagedKeys(fixture.keysDir)),
      );
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
      const outcome = await manageConfig(fixture);
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
      keysSha256: managedKeysSha256(loadManagedKeys(fixture.keysDir)),
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
    rmSync(join(fixture.keysDir, MANAGED_KEYS_FILE));
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
    assert.equal(stdout, "status=error code=INVALID_INPUT keys_sha256=-\n");
    assert.match(stderr, /managed keys file is missing/);
    assert.ok(stderr.includes(join(fixture.keysDir, MANAGED_KEYS_FILE)));
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
  const e2eYaml = [
    "keys:",
    "  - key: customPrompt.cleanup",
    "    value: |",
    '      Remove only unambiguous fillers: "uh", "um", "えー", "えーと".',
    "      Keep 来週、いや、再来週 and code: `x = 1`.",
    '  - key: notifyMeetingDetection',
    '    value: "false"',
    '  - key: useDictationAgent',
    '    value: "false"',
    "",
  ].join("\n");
  const seededValues: Record<string, string> = {
    "customPrompt.cleanup": "old-fixture-prompt",
    notifyMeetingDetection: "true",
    useDictationAgent: "true",
  };
  let e2eRoot = "";
  let keysDir = "";
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

  async function seedProfile(): Promise<void> {
    const run = await runHarnessMode({
      mode: "seed",
      runtimeDir,
      profileDir,
      platform: e2ePlatform,
      env: harnessEnv(),
      seedJson: JSON.stringify({
        ...seededValues,
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
    keysDir = join(e2eRoot, "keys");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, MANAGED_KEYS_FILE), e2eYaml, "utf8");
    profileDir = join(e2eRoot, "profile");
    const { ensureShadowRuntime } = await import("./manage-config.apply.ts");
    runtimeDir = await ensureShadowRuntime(e2eAppDir, e2ePlatform);
    await seedProfile();
  }, 120_000);

  afterAll(async () => {
    if (!e2eEnabled) return;
    await stopHoldHelper();
  });

  maybeIt(
    "applies the managed keys with unicode fidelity and preserves unrelated keys",
    async () => {
      await seedProfile();
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
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
      assert.equal(storage["customPrompt.cleanup"], promptText);
      assert.equal(storage.notifyMeetingDetection, "false");
      assert.equal(storage.useDictationAgent, "false");
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
          OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
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
      await seedProfile();
      await startHoldHelper();
      try {
        const result = await runHookScript(
          hookOverrides({
            OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
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
      assert.deepEqual(
        {
          "customPrompt.cleanup": storage["customPrompt.cleanup"],
          notifyMeetingDetection: storage.notifyMeetingDetection,
          useDictationAgent: storage.useDictationAgent,
          model: storage.model,
        },
        { ...seededValues, model: "preserve-fixture-model" },
      );
    },
    180_000,
  );

  maybeIt(
    "rejects an invalid declaration without touching the profile",
    async () => {
      const brokenKeysDir = join(e2eRoot, "broken-keys");
      mkdirSync(brokenKeysDir, { recursive: true });
      writeFileSync(
        join(brokenKeysDir, MANAGED_KEYS_FILE),
        "keys: [broken",
        "utf8",
      );
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_MANAGED_KEYS: brokenKeysDir,
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
