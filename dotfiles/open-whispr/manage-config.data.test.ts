import assert from "node:assert/strict";
import { Database as FixtureDatabase } from "bun:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  HookError,
  MANAGED_KEYS_FILE,
  acquireHookLock,
  buildHarnessPackageJson,
  buildHarnessSource,
  clearRecoveryRecord,
  formatStatusLine,
  loadManagedKeys,
  loadManagedConfig,
  validateDictionary,
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
const fixtureTimeoutMs = 5_000;
const e2eHookTimeoutMs = 180_000;

function verifyPaths(): void {
  // resolves Linux production defaults under HOME
  {
    const expectedProfileDir = join("/home/example", ".config", "open-whispr");
    const paths = resolvePaths("linux", { HOME: "/home/example" });
    assert.equal(paths.managedKeysDir, import.meta.dir);
    assert.equal(paths.profileDir, expectedProfileDir);
    assert.equal(paths.appDir, "/opt/OpenWhispr");
    assert.equal(paths.appBinaryName, "open-whispr-app");
    assert.equal(paths.isE2E, false);
  }
  // resolves Windows production defaults from APPDATA and LOCALAPPDATA
  {
    const paths = resolvePaths("win32", {
      APPDATA: join(tmpdir(), "appdata"),
      LOCALAPPDATA: join(tmpdir(), "localappdata"),
    });
    const expectedProfile = join(join(tmpdir(), "appdata"), "open-whispr");
    assert.equal(paths.profileDir, expectedProfile);
    assert.equal(paths.managedKeysDir, import.meta.dir);
    assert.equal(paths.appDir, join(join(tmpdir(), "localappdata"), "Programs", "OpenWhispr"));
    assert.equal(paths.appBinaryName, "OpenWhispr.exe");
  }
  // rejects Windows without APPDATA
  assert.throws(
    () => resolvePaths("win32", { LOCALAPPDATA: "/x" }),
    (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
  );
  // rejects Linux without HOME
  assert.throws(
    () => resolvePaths("linux", {}),
    (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
  );
  // rejects unsupported platforms
  assert.throws(
    () => resolvePaths("darwin", { HOME: "/home/example" }),
    (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
  );
  // honors e2e overrides only for paths under tmpdir
  {
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
  }
  // rejects an e2e managed keys dir outside tmpdir
  assert.throws(
    () =>
      resolvePaths("linux", {
        OPENWHISPR_E2E: "1",
        OPENWHISPR_E2E_PROFILE: join(tmpdir(), "profile"),
        OPENWHISPR_E2E_MANAGED_KEYS: "/home/example/keys",
      }),
    (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
  );
  // rejects an e2e profile outside tmpdir
  assert.throws(
    () =>
      resolvePaths("linux", {
        OPENWHISPR_E2E: "1",
        OPENWHISPR_E2E_PROFILE: "/home/example/.config/open-whispr",
        OPENWHISPR_E2E_MANAGED_KEYS: join(tmpdir(), "keys"),
      }),
    (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
  );
}

function verifyManagedKeys(): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "openwhispr-checks-"));
  try {
    function writeDeclaration(root: string, yamlText: string): string {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, MANAGED_KEYS_FILE), yamlText, "utf8");
      return root;
    }
    // expands inline values including multiline block scalars
    {
      const root = writeDeclaration(
        join(fixtureRoot, "inline"),
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
    }
    // loads the shipped declaration and computes a stable hash
    {
      const targets = loadManagedKeys(import.meta.dir);
      const keys = targets.map((target) => target.key);
      assert.deepEqual(keys.sort(), [
        "customPrompt.cleanup",
        "notifyMeetingDetection",
        "snippets",
        "useDictationAgent",
      ]);
      assert.match(managedKeysSha256(targets), /^[0-9a-f]{64}$/);
      assert.equal(managedKeysSha256(targets), managedKeysSha256(loadManagedKeys(import.meta.dir)));
    }
    // declares the dot-files pronunciation snippet replacing . files and .files with dotfiles
    {
      const targets = loadManagedKeys(import.meta.dir);
      const entry = targets.find((target) => target.key === "snippets");
      assert.ok(entry, "snippets entry must exist in the shipped declaration");
      const snippets = JSON.parse(entry.value) as unknown;
      assert.deepEqual(snippets, [
        { trigger: ". files", replacement: "dotfiles" },
        { trigger: ".files", replacement: "dotfiles" },
      ]);
    }
    // rejects duplicate keys
    assert.throws(
      () =>
        validateManagedKeys({
          keys: [
            { key: "a", value: "1" },
            { key: "a", value: "2" },
          ],
        }),
      (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
    );
    // rejects a non-string value
    assert.throws(
      () => validateManagedKeys({ keys: [{ key: "a", value: false }] }),
      (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
    );
    // rejects empty keys arrays
    assert.throws(
      () => validateManagedKeys({ keys: [] }),
      (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
    );
    // rejects an invalid YAML declaration
    {
      const root = writeDeclaration(join(fixtureRoot, "invalid"), "keys: [broken");
      assert.throws(
        () => loadManagedKeys(root),
        (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
      );
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function verifyDictionaryDeclarations(): void {
  {
    const { dictionary } = loadManagedConfig(import.meta.dir);
    assert.ok(dictionary);
    assert.equal(dictionary.length, 32);
    assert.equal(dictionary.join(", ").length, 300);
    assert.equal(
      sha256Hex(JSON.stringify(dictionary)),
      "082daeb3707712456b0fba15dcd18a53de1236be94a687e9ec8f596be179ba4a",
    );
  }
  const fixtureRoot = mkdtempSync(join(tmpdir(), "openwhispr-dictionary-input-"));
  try {
    const declaration = join(fixtureRoot, MANAGED_KEYS_FILE);
    const keysYaml = 'keys: [{ key: a, value: "b" }]\n';
    writeFileSync(declaration, keysYaml);
    assert.equal(loadManagedConfig(fixtureRoot).dictionary, undefined);
    writeFileSync(declaration, keysYaml + "dictionary: []\n");
    assert.deepEqual(loadManagedConfig(fixtureRoot).dictionary, []);
    writeFileSync(declaration, keysYaml + 'dictionary: [" Old ", "old", "", "日本語句"]\n');
    assert.deepEqual(loadManagedConfig(fixtureRoot).dictionary, ["Old", "日本語句"]);
    for (const invalid of [null, "word", [123], [null], ["bad\0word"]]) {
      writeFileSync(declaration, keysYaml + "dictionary: " + JSON.stringify(invalid));
      assert.throws(
        () => loadManagedConfig(fixtureRoot),
        (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
      );
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  // preserves storage-only declarations and removes empty words
  assert.deepEqual(validateDictionary(undefined), []);
  assert.deepEqual(validateDictionary([]), []);
  assert.deepEqual(validateDictionary(["", "  ", "\t"]), []);
  // trims words and keeps the first spelling for case-insensitive duplicates
  assert.deepEqual(validateDictionary([" Bun ", "bun", "BUN", "日本語句", " 日本語句 "]), [
    "Bun",
    "日本語句",
  ]);
  for (const invalid of [null, "word", [123], [null], ["bad\0word"]]) {
    // rejects invalid dictionary input ${JSON.stringify(invalid)}
    assert.throws(
      () => validateDictionary(invalid),
      (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
    );
  }
  // includes dictionary words in the declaration hash
  {
    const keys = [{ key: "a", value: "b" }];
    assert.notEqual(managedKeysSha256(keys), managedKeysSha256(keys, []));
    assert.notEqual(managedKeysSha256(keys), managedKeysSha256(keys, ["Bun"]));
    assert.notEqual(managedKeysSha256(keys, ["Bun"]), managedKeysSha256(keys, ["Godot"]));
    assert.equal(managedKeysSha256(keys, ["Bun"]), managedKeysSha256(keys, ["Bun"]));
  }
}

function verifyStatusLines(): void {
  // formats a machine-readable single line
  {
    const line = formatStatusLine({
      status: "applied",
      code: "OK",
      keysSha256: "abc123",
    });
    assert.equal(line, "status=applied code=OK keys_sha256=abc123");
    assert.equal(line.includes("\n"), false);
  }
  // marks an unknown key hash with a dash
  {
    const line = formatStatusLine({
      status: "error",
      code: "LOCKED",
      keysSha256: null,
    });
    assert.equal(line, "status=error code=LOCKED keys_sha256=-");
  }
}

function verifyHarnessGuards(): void {
  const source = buildHarnessSource();
  // requires an absolute expected profile before anything else
  assert.ok(source.includes("OW_HARNESS_PROFILE"));
  assert.ok(source.includes("isAbsolute"));
  assert.ok(source.includes("process.exit(90)"));
  // acquires the singleton lock and reports LOCKED on contention
  assert.ok(source.includes("requestSingleInstanceLock"));
  assert.ok(source.includes('status: "locked"'));
  assert.ok(source.includes("app.exit(23)"));
  // uses a hidden sandboxed window without node integration
  assert.ok(source.includes("show: false"));
  assert.ok(source.includes("sandbox: true"));
  assert.ok(source.includes("nodeIntegration: false"));
  // serves an inert file-protocol document and denies other requests and permissions
  assert.ok(source.includes('protocol.handle("file"'));
  assert.ok(source.includes('startsWith("file:")'));
  assert.ok(source.includes("setPermissionRequestHandler"));
  assert.ok(source.includes("callback(false)"));
  // never enables remote debugging or disables the sandbox
  assert.equal(source.includes("remote-debugging"), false);
  assert.equal(source.includes("inspect"), false);
  assert.equal(source.includes("--no-sandbox"), false);
  // writes only targets passed via environment and restores failed keys
  assert.ok(source.includes("OW_HARNESS_TARGETS_JSON"));
  assert.ok(source.includes("restore-failed"));
  assert.equal(buildHarnessPackageJson().includes("open-whispr-config-harness"), true);
  // reads and writes every declared target key
  assert.ok(source.includes("target.key"));
  assert.ok(source.includes("readKey(target.key)"));
  assert.ok(source.includes("setKey(target.key"));
}

async function verifyStorageRecovery(): Promise<void> {
  for (const failure of [
    "add-and-remove",
    "remove-only",
    "already-exact",
    "empty-clear",
    "no-dictionary",
    "dictionary-registration",
    "dictionary-removal",
    "dictionary-verification",
    "registration",
    "verification",
    "first-flush",
    "second-flush",
    "database-close",
    "window-destroy",
    "app-quit",
  ] as const) {
    // keeps registration and cleanup consistent for ${failure}
    const before = new Map([
      ["first", "old-first"],
      ["second", "old-second"],
    ]);
    const storage = new Map(before);
    const reads = new Map<string, number>();
    let injected = false;
    let payload:
      | { status: string; restoreFailed: string[]; detail?: string; dictionaryRemoved?: number }
      | undefined;
    const dictionaryOnly = [
      "add-and-remove",
      "remove-only",
      "already-exact",
      "empty-clear",
      "no-dictionary",
    ].includes(failure);
    const declaredWords =
      failure === "no-dictionary"
        ? undefined
        : failure === "empty-clear"
          ? []
          : failure === "already-exact"
            ? ["existing", "UNMANAGED"]
            : failure === "remove-only"
              ? ["Unmanaged"]
              : ["Unmanaged", "Added"];
    let databaseOpens = 0;
    let flushCount = 0;
    const db = new FixtureDatabase(":memory:");
    const databaseClose = db.close.bind(db);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      db.exec("CREATE TABLE custom_dictionary (word TEXT, attributes TEXT DEFAULT 'new')");
      const initialRows = [
        { word: "Existing", attributes: "preserve-existing" },
        { word: "Unmanaged", attributes: "preserve-unmanaged" },
        { word: " Existing ", attributes: "preserve-padded" },
        { word: "EXISTING", attributes: "preserve-uppercase" },
      ];
      for (const row of initialRows)
        db.query("INSERT INTO custom_dictionary VALUES (?, ?)").run(row.word, row.attributes);

      let closedWords: unknown[] = [];
      db.close = function () {
        closedWords = db.query("SELECT * FROM custom_dictionary ORDER BY rowid").all();
        if (failure === "database-close") throw new Error("fixture database close failure");
      };
      class DictionaryFixture {
        db = db;
        _dictionaryWriteStatements() {}
        getDictionary() {
          return (
            this.db.query("SELECT word FROM custom_dictionary ORDER BY rowid").all() as {
              word: string;
            }[]
          ).map((row) => row.word);
        }
        _dictionaryRows() {
          const rows = this.db
            .query("SELECT rowid AS id, word FROM custom_dictionary ORDER BY rowid")
            .all() as Array<{ id: number; word: string }>;
          return { rows, byLower: new Map(rows.map((row) => [row.word.toLowerCase(), row])) };
        }
        _deleteDictionaryRow(_statements: unknown, existing?: { id: number }) {
          if (!existing) return false;
          if (failure !== "dictionary-verification")
            this.db.query("DELETE FROM custom_dictionary WHERE rowid = ?").run(existing.id);
          if (failure === "dictionary-removal")
            throw new Error("fixture dictionary removal failure");
          return true;
        }
        applyDictionaryChanges({ add = [], remove = [] }: { add?: string[]; remove?: string[] }) {
          const { byLower } = this._dictionaryRows();
          const additions = new Set(add.map((word) => word.trim().toLowerCase()));
          const removals = new Set(remove.map((word) => word.trim().toLowerCase()));
          for (const lower of additions) removals.delete(lower);
          for (const lower of removals)
            this._deleteDictionaryRow(this._dictionaryWriteStatements(), byLower.get(lower));
          for (const word of add)
            this.db.query("INSERT INTO custom_dictionary (word) VALUES (?)").run(word.trim());
          if (failure === "dictionary-registration")
            throw new Error("fixture dictionary registration failure");
          return { success: true };
        }
      }
      function OpenFixtureDatabase() {
        databaseOpens += 1;
        return db;
      }
      const localStorage = {
        getItem(key: string) {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          if (failure === "verification" && key === "second" && count === 2) return "mismatch";
          return storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
          if (failure === "registration" && key === "second" && !injected) {
            injected = true;
            throw new Error("fixture storage write failure");
          }
        },
        removeItem(key: string) {
          storage.delete(key);
        },
      };
      const nodeRequire = createRequire(import.meta.url);
      async function runFixture() {
        await new Promise<void>((resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`storage recovery fixture timed out: ${failure}`)),
            fixtureTimeoutMs,
          );
          const electron = {
            app: {
              setPath() {},
              requestSingleInstanceLock() {
                return true;
              },
              on() {},
              whenReady() {
                return Promise.resolve();
              },
              quit() {
                if (failure === "app-quit") throw new Error("fixture app quit failure");
                resolve();
              },
              exit(code: number) {
                if (code === 0) resolve();
                else reject(new Error(`harness exited with ${code}`));
              },
            },
            BrowserWindow: class {
              webContents = {
                async executeJavaScript(source: string) {
                  return runInNewContext(source, { localStorage });
                },
              };
              async loadURL() {}
              destroy() {
                if (failure === "window-destroy") throw new Error("fixture window destroy failure");
              }
            },
            session: {
              defaultSession: {
                webRequest: { onBeforeRequest() {} },
                protocol: { handle() {} },
                setPermissionRequestHandler() {},
                flushStorageData() {
                  flushCount += 1;
                  if (
                    (failure === "first-flush" && flushCount === 1) ||
                    (failure === "second-flush" && flushCount === 2)
                  )
                    throw new Error("fixture storage flush failure");
                },
              },
            },
          };
          runInNewContext(buildHarnessSource(), {
            require(name: string) {
              if (name === "electron") return electron;
              if (name.endsWith(join("helpers", "database.js"))) return DictionaryFixture;
              if (name.endsWith(join("node_modules", "better-sqlite3"))) return OpenFixtureDatabase;
              return nodeRequire(name);
            },
            process: {
              env: {
                OW_HARNESS_PROFILE: join(tmpdir(), "in-memory-harness-profile"),
                OW_HARNESS_MODE: "apply",
                OW_HARNESS_APP_ASAR: join(tmpdir(), "in-memory-app", "app.asar"),
                ...(declaredWords === undefined
                  ? {}
                  : { OW_HARNESS_DICTIONARY_JSON: JSON.stringify(declaredWords) }),
                OW_HARNESS_TARGETS_JSON: JSON.stringify(
                  dictionaryOnly
                    ? [...before].map(([key, value]) => ({ key, value }))
                    : [
                        { key: "first", value: "new-first" },
                        { key: "second", value: "new-second" },
                        { key: "new-key", value: "new-value" },
                      ],
                ),
              },
              exit(code: number) {
                reject(new Error(`harness exited with ${code}`));
              },
            },
            console: {
              log(line: string) {
                payload = JSON.parse(line);
              },
              error: reject,
            },
          });
        });
        clearTimeout(timeout);
      }
      await runFixture();
      if (
        [
          "registration",
          "verification",
          "first-flush",
          "dictionary-registration",
          "dictionary-removal",
          "dictionary-verification",
        ].includes(failure)
      ) {
        assert.equal(payload?.status, "error", failure);
        assert.deepEqual(payload?.restoreFailed, []);
        assert.deepEqual(storage, before);
        assert.deepEqual(closedWords, initialRows);
      } else if (dictionaryOnly) {
        const expectedStatus =
          failure === "already-exact" || failure === "no-dictionary" ? "unchanged" : "applied";
        assert.equal(payload?.status, expectedStatus, failure);
        assert.deepEqual(storage, before);
        const rows = db.query("SELECT * FROM custom_dictionary ORDER BY rowid").all();
        if (["add-and-remove", "remove-only", "empty-clear"].includes(failure)) {
          assert.equal(payload?.dictionaryRemoved, failure === "empty-clear" ? 4 : 3);
          const expectedRows =
            failure === "empty-clear"
              ? []
              : [
                  { word: "Unmanaged", attributes: "preserve-unmanaged" },
                  ...(failure === "add-and-remove" ? [{ word: "Added", attributes: "new" }] : []),
                ];
          assert.deepEqual(rows, expectedRows);
          await runFixture();
          assert.equal(payload?.status, "unchanged");
          assert.deepEqual(db.query("SELECT * FROM custom_dictionary ORDER BY rowid").all(), rows);
        } else {
          assert.deepEqual(rows, initialRows);
          assert.equal(databaseOpens, failure === "no-dictionary" ? 0 : 1);
        }
      } else {
        assert.equal(payload?.status, "applied");
        assert.deepEqual(
          [...storage.entries()],
          [
            ["first", "new-first"],
            ["second", "new-second"],
            ["new-key", "new-value"],
          ],
        );
        assert.deepEqual(closedWords, [
          { word: "Unmanaged", attributes: "preserve-unmanaged" },
          { word: "Added", attributes: "new" },
        ]);
        assert.equal(flushCount, 1);
        if (failure === "database-close")
          assert.match(payload.detail ?? "", /fixture database close failure/);
        if (failure === "window-destroy" || failure === "app-quit")
          assert.match(payload.detail ?? "", /harness shutdown failed/);
      }
    } finally {
      clearTimeout(timeout);
      databaseClose();
    }
  }
}

function buildAsarFixture(packageName: string): Buffer {
  const packageJson = Buffer.from(JSON.stringify({ name: packageName, version: "9.9.9" }), "utf8");
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

function verifyAsarIdentity(): void {
  // extracts the package name from an asar archive
  {
    const asar = buildAsarFixture("open-whispr-fixture");
    assert.equal(parseAsarPackageName(asar), "open-whispr-fixture");
  }
  // rejects malformed asar bytes
  assert.throws(
    () => parseAsarPackageName(Buffer.from([1, 2, 3])),
    (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
  );
  // rejects an asar without a package.json entry
  {
    const json = Buffer.from(JSON.stringify({ files: {} }), "utf8");
    const header = Buffer.alloc(16 + json.length);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(8 + json.length, 4);
    header.writeUInt32LE(4 + json.length, 8);
    header.writeUInt32LE(json.length, 12);
    header.write(JSON.stringify({ files: {} }), 16, "utf8");
    assert.throws(
      () => parseAsarPackageName(Buffer.concat([header, json])),
      (error: unknown) => error instanceof HookError && error.code === "INVALID_INPUT",
    );
  }
}

async function verifyHookLockAndRecovery(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "openwhispr-checks-"));
  try {
    // excludes concurrent registration runs for the same profile
    {
      const profileDir = join(fixtureRoot, "lock");
      const release = await acquireHookLock(profileDir, 300);
      try {
        await assert.rejects(
          acquireHookLock(profileDir, 300),
          (error: unknown) => error instanceof HookError && error.code === "LOCKED",
        );
      } finally {
        await release();
      }
      const releaseAgain = await acquireHookLock(profileDir, 300);
      await releaseAgain();
    }
    // writes and clears a recovery record
    {
      const profileDir = join(fixtureRoot, "recovery");

      const { writeRecoveryRecord } = await import("./manage-config.apply.ts");
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
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

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

async function verifyUninitializedProfiles(): Promise<void> {
  const cacheDir = mkdtempSync(join(tmpdir(), "openwhispr-check-cache-"));
  const fixtureRoots = [cacheDir];
  const fixtureYaml = [
    "keys:",
    "  - key: customPrompt.cleanup",
    "    value: |",
    "      Remove only fillers. Keep 来週、いや、再来週.",
    "  - key: notifyMeetingDetection",
    '    value: "false"',
    "  - key: useDictationAgent",
    '    value: "false"',
    "",
  ].join("\n");
  function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "openwhispr-uninitialized-"));
    fixtureRoots.push(root);
    const appDir = join(root, "app");
    mkdirSync(join(appDir, "resources"), { recursive: true });
    writeFileSync(join(appDir, "resources", "app.asar"), buildAsarFixture("open-whispr"));
    const platform = process.platform === "win32" ? ("win32" as const) : ("linux" as const);
    const binaryName = platform === "win32" ? "OpenWhispr.exe" : "open-whispr-app";
    writeFileSync(join(appDir, binaryName), `unused fixture binary: ${root}`);
    const profileDir = join(root, "profile");
    const keysDir = join(root, "keys");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, MANAGED_KEYS_FILE), fixtureYaml, "utf8");
    const env = {
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
      HOME: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      BUN_INSTALL_CACHE_DIR: cacheDir,
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
        return [entry, statSync(path).isDirectory() ? null : readFileSync(path).toString("hex")];
      });
  }
  function runtimeEntries() {
    return readdirSync(tmpdir())
      .filter((entry) =>
        /^(openwhispr-register-runtime-|openwhispr-runtime-|openwhispr-harness-home-)/.test(entry),
      )
      .sort();
  }

  try {
    for (const profileState of ["missing", "unrecognized-files"] as const) {
      // skips a ${profileState} profile without creating runtime or changing files
      const fixture = createFixture();
      if (profileState === "unrecognized-files") {
        mkdirSync(fixture.profileDir);
        writeFileSync(join(fixture.profileDir, ".env"), "preserve-fixture-settings\n");
      }
      const before = snapshot(fixture.root);
      const runtimesBefore = runtimeEntries();
      const expectedKeysSha256 = managedKeysSha256(loadManagedKeys(fixture.keysDir));
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "skipped");
      assert.equal(outcome.code, "OK");
      assert.equal(outcome.keysSha256, expectedKeysSha256);
      assert.match(outcome.detail ?? "", /launch and quit OpenWhispr, then run apply again/);
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
    }
    // validates and hashes dictionary declarations before an unchanged-profile skip
    {
      const fixture = createFixture();
      const declaration = join(fixture.keysDir, MANAGED_KEYS_FILE);
      writeFileSync(declaration, fixtureYaml + '\ndictionary: ["Bun", "日本語句"]\n');
      const before = snapshot(fixture.root);
      const config = loadManagedConfig(fixture.keysDir);
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "skipped");
      assert.equal(outcome.keysSha256, managedKeysSha256(config.keys, config.dictionary));
      assert.deepEqual(snapshot(fixture.root), before);
    }
    // rejects invalid dictionary data even when the profile is unrecognized
    {
      const fixture = createFixture();
      writeFileSync(
        join(fixture.keysDir, MANAGED_KEYS_FILE),
        fixtureYaml + "\ndictionary: [123]\n",
      );
      const before = snapshot(fixture.root);
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.equal(outcome.keysSha256, null);
      assert.deepEqual(snapshot(fixture.root), before);
    }
    // skips without waiting for or releasing an existing hook lock
    {
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
    }
    for (const invalidDeclaration of ["missing", "blank-value", "nul-value", "badyaml"] as const) {
      // rejects a ${invalidDeclaration} managed keys file before skipping
      const fixture = createFixture();
      const invalidYaml = {
        "blank-value": 'keys:\n  - key: a\n    value: " \\n"\n',
        "nul-value": 'keys:\n  - key: "a"\n    value: "a\\0b"\n',
        badyaml: "keys: [broken",
      };
      if (invalidDeclaration === "missing") rmSync(join(fixture.keysDir, MANAGED_KEYS_FILE));
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
    }
    for (const invalidApp of ["missing", "malformed", "wrong-name"] as const) {
      // rejects a ${invalidApp} app before skipping
      const fixture = createFixture();
      const asarPath = join(fixture.appDir, "resources", "app.asar");
      if (invalidApp === "missing") rmSync(fixture.appDir, { recursive: true });
      else
        writeFileSync(
          asarPath,
          invalidApp === "malformed" ? Buffer.from([1, 2, 3]) : buildAsarFixture("other-app"),
        );
      const before = snapshot(fixture.root);
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.equal(outcome.keysSha256, managedKeysSha256(loadManagedKeys(fixture.keysDir)));
      assert.match(outcome.detail ?? "", /installed app/);
      assert.deepEqual(snapshot(fixture.root), before);
    }
    for (const marker of ["Preferences", "Local Storage"] as const) {
      // does not skip a profile recognized by ${marker}
      const fixture = createFixture();
      mkdirSync(fixture.profileDir);
      if (marker === "Preferences") writeFileSync(join(fixture.profileDir, marker), "{}");
      else mkdirSync(join(fixture.profileDir, marker));
      rmSync(
        join(fixture.appDir, fixture.platform === "linux" ? "open-whispr-app" : "OpenWhispr.exe"),
      );
      const before = snapshot(fixture.root);
      const outcome = await manageConfig(fixture);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.code, "INVALID_INPUT");
      assert.match(outcome.detail ?? "", /installed app binary is missing/);
      assert.deepEqual(snapshot(fixture.root), before);
    }
    // returns CLI exit 0 with plain stdout detail and empty stderr
    {
      const fixture = createFixture();
      const before = snapshot(fixture.root);
      const runtimesBefore = runtimeEntries();
      const child = Bun.spawn([process.execPath, hookScriptPath], {
        env: fixture.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: fixtureTimeoutMs,
        killSignal: "SIGKILL",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(exitCode, 0, stderr);
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
    }
    // keeps CLI input errors on stderr with exit 2
    {
      const fixture = createFixture();
      rmSync(join(fixture.keysDir, MANAGED_KEYS_FILE));
      const before = snapshot(fixture.root);
      const child = Bun.spawn([process.execPath, hookScriptPath], {
        env: fixture.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: fixtureTimeoutMs,
        killSignal: "SIGKILL",
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
    }
  } finally {
    for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  }
}

async function verifyInstalledRuntime(): Promise<void> {
  const e2ePlatform = process.platform === "win32" ? ("win32" as const) : ("linux" as const);
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
    "  - key: notifyMeetingDetection",
    '    value: "false"',
    "  - key: useDictationAgent",
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
  function harnessEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    return env;
  }
  function hookEnv(overrides: Record<string, string>): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "",
      NODE_PATH: process.env.NODE_PATH ?? "",
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
    };
  }
  function hookOverrides(extra: Record<string, string>): Record<string, string> {
    return {
      OPENWHISPR_E2E_APP_DIR: e2eAppDir,
      ...extra,
    };
  }
  async function runHookScript(
    overrides: Record<string, string>,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const child = spawn("bun", [hookScriptPath], {
        env: hookEnv(overrides),
        timeout: e2eHookTimeoutMs,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => resolve({ exitCode: null, stdout, stderr: String(error) }));
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }
  async function startHoldHelper(): Promise<ChildProcess | null> {
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
    return run.child;
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
    assert.equal(run.outcome.kind, "ok", `seed run failed: ${JSON.stringify(run.outcome)}`);
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
    assert.equal(run.outcome.kind, "ok", `dump run failed: ${JSON.stringify(run.outcome)}`);
    return run.outcome.kind === "ok" ? (run.outcome.payload.storage ?? {}) : {};
  }
  try {
    e2eRoot = mkdtempSync(join(tmpdir(), "openwhispr-hook-e2e-"));
    keysDir = join(e2eRoot, "keys");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, MANAGED_KEYS_FILE), e2eYaml, "utf8");
    profileDir = join(e2eRoot, "profile");
    const { ensureShadowRuntime } = await import("./manage-config.apply.ts");
    runtimeDir = await ensureShadowRuntime(e2eAppDir, e2ePlatform);
    await seedProfile();

    // applies the managed keys with unicode fidelity and preserves unrelated keys
    {
      await seedProfile();
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
          OPENWHISPR_E2E_PROFILE: profileDir,
        }),
      );
      const status = parseStatusLine(result.stdout);
      assert.deepEqual([status.status, status.code], ["applied", "OK"], result.stderr);
      assert.equal(result.exitCode, 0);
      const storage = await dumpStorage();
      assert.equal(storage["customPrompt.cleanup"], promptText);
      assert.equal(storage.notifyMeetingDetection, "false");
      assert.equal(storage.useDictationAgent, "false");
      assert.equal(storage.model, "preserve-fixture-model");
      assert.equal(storage.otherPrompt, "preserve-fixture-prompt");
    }
    // is unchanged on an idempotent second run
    {
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
          OPENWHISPR_E2E_PROFILE: profileDir,
        }),
      );
      const status = parseStatusLine(result.stdout);
      assert.deepEqual([status.status, status.code], ["unchanged", "OK"], result.stderr);
      assert.equal(result.exitCode, 0);
    }
    // aborts with LOCKED before writing when the singleton lock is held
    {
      await seedProfile();
      const holdChild = await startHoldHelper();
      try {
        const result = await runHookScript(
          hookOverrides({
            OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
            OPENWHISPR_E2E_PROFILE: profileDir,
          }),
        );
        const status = parseStatusLine(result.stdout);
        assert.deepEqual([status.status, status.code], ["error", "LOCKED"], result.stderr);
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
    }
    function declareDictionary(words: string[]): void {
      writeFileSync(
        join(keysDir, MANAGED_KEYS_FILE),
        e2eYaml + "\ndictionary: " + JSON.stringify(words),
      );
    }
    function createDictionaryFixture(): void {
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(join(profileDir, "transcriptions.db" + suffix), { force: true });
      const db = new FixtureDatabase(join(profileDir, "transcriptions.db"));
      try {
        db.exec(`
        CREATE TABLE custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          client_dict_id TEXT,
          cloud_id TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          sync_status TEXT DEFAULT 'pending',
          deleted_at TEXT,
          updated_at TEXT,
          shared_at TEXT,
          shared_at_dirty INTEGER NOT NULL DEFAULT 0,
          fallback_retired INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO custom_dictionary
          (word, client_dict_id, cloud_id, source, sync_status, shared_at, updated_at)
        VALUES ('PI', 'owner-pi', 'cloud-pi', 'learned', 'synced', '2026-01-01', '2026-01-01'),
               ('owner-only', 'owner-word', 'cloud-word', 'manual', 'synced', NULL, '2026-01-02');
        INSERT INTO custom_dictionary
          (word, client_dict_id, cloud_id, source, sync_status, deleted_at, shared_at, fallback_retired)
        VALUES ('Godot', 'retired-godot', 'cloud-godot', 'learned', 'synced', '2026-01-03', '2026-01-02', 1);
        CREATE TABLE snippets (trigger TEXT, replacement TEXT);
        INSERT INTO snippets VALUES ('owner snippet', 'preserve me');
      `);
      } finally {
        db.close();
      }
    }
    function createLegacyDictionaryFixture(): void {
      createDictionaryFixture();
      const db = new FixtureDatabase(join(profileDir, "transcriptions.db"));
      try {
        db.exec(`
        ALTER TABLE custom_dictionary DROP COLUMN shared_at;
        ALTER TABLE custom_dictionary DROP COLUMN shared_at_dirty;
        ALTER TABLE custom_dictionary DROP COLUMN fallback_retired;
        DROP TABLE snippets;
        CREATE TABLE snippets (
          id INTEGER PRIMARY KEY,
          trigger TEXT NOT NULL,
          replacement TEXT NOT NULL,
          client_snippet_id TEXT,
          cloud_id TEXT,
          sync_status TEXT DEFAULT 'pending',
          deleted_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO snippets (trigger, replacement, client_snippet_id)
        VALUES ('owner snippet', 'preserve me', 'owner-snippet');
      `);
      } finally {
        db.close();
      }
    }
    function dictionarySnapshot() {
      const db = new FixtureDatabase(join(profileDir, "transcriptions.db"), { readonly: true });
      try {
        return {
          rows: db.query("SELECT * FROM custom_dictionary ORDER BY id").all() as Array<{
            word: string;
            deleted_at: string | null;
            source: string;
            sync_status: string;
            client_dict_id: string;
            cloud_id: string | null;
            shared_at: string | null;
            shared_at_dirty: number;
            fallback_retired: number;
          }>,
          schema: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
          snippets: db.query("SELECT * FROM snippets").all(),
        };
      } finally {
        db.close();
      }
    }
    async function runDeclaredHook() {
      return await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_MANAGED_KEYS: keysDir,
          OPENWHISPR_E2E_PROFILE: profileDir,
        }),
      );
    }
    // Dictionary reconciliation
    {
      await seedProfile();
      createDictionaryFixture();
      const words = loadManagedConfig(import.meta.dir).dictionary!;
      declareDictionary(words);
      const before = dictionarySnapshot();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(parseStatusLine(result.stdout).status, "applied");
      const after = dictionarySnapshot();
      const active = after.rows.filter((row) => row.deleted_at === null);
      assert.equal(active.length, words.length);
      const keys = active.map((row) => row.word.trim().toLowerCase());
      assert.equal(new Set(keys).size, active.length);
      assert.ok(words.every((word) => keys.includes(word.toLowerCase())));
      assert.deepEqual(after.rows[0], before.rows[0]);
      assert.ok(after.rows.find((row) => row.word === "owner-only")?.deleted_at);
      assert.deepEqual(after.schema, before.schema);
      assert.deepEqual(after.snippets, before.snippets);
      const restored = after.rows.find((row) => row.word === "Godot");
      assert.ok(restored);
      assert.deepEqual(
        [
          restored.deleted_at,
          restored.cloud_id,
          restored.source,
          restored.shared_at,
          restored.shared_at_dirty,
          restored.fallback_retired,
          restored.sync_status,
        ],
        [null, "cloud-godot", "manual", null, 1, 0, "pending"],
      );
      for (const row of after.rows.slice(3)) {
        assert.equal(row.sync_status, "pending");
        assert.equal(row.source, "manual");
        assert.match(row.client_dict_id, /^[0-9a-f-]{36}$/);
        assert.equal(row.cloud_id, null);
        assert.equal(
          row.word,
          words.find((word) => word.toLowerCase() === row.word.toLowerCase()),
        );
      }
      const storage = await dumpStorage();
      assert.equal(storage["customPrompt.cleanup"], promptText);
      assert.equal(storage.model, "preserve-fixture-model");
      const second = await runDeclaredHook();
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(parseStatusLine(second.stdout).status, "unchanged");
      assert.deepEqual(dictionarySnapshot(), after);
    }
    // Dictionary-only updates
    {
      createDictionaryFixture();
      declareDictionary(["pi", "日本語句", " 日本語句 "]);
      const storageBefore = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(parseStatusLine(result.stdout).status, "applied");
      assert.deepEqual(await dumpStorage(), storageBefore);
      assert.deepEqual(
        dictionarySnapshot()
          .rows.filter((row) => row.deleted_at === null)
          .map((row) => row.word),
        ["PI", "日本語句"],
      );
    }
    for (const legacy of [false, true]) {
      if (legacy) createLegacyDictionaryFixture();
      else createDictionaryFixture();
      const db = new FixtureDatabase(join(profileDir, "transcriptions.db"));
      try {
        db.exec(
          "INSERT INTO custom_dictionary (word, source, client_dict_id) VALUES ('local-only', 'manual', 'local-only-id'), (' PI ', 'learned', 'padded-pi-id'), ('pi', 'manual', 'lowercase-pi-id'), ('OWNER-ONLY', 'learned', 'uppercase-owner-id'), (' owner-only ', 'manual', 'padded-owner-id')",
        );
      } finally {
        db.close();
      }
      declareDictionary(["owner-only"]);
      const before = dictionarySnapshot();
      const storageBefore = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(parseStatusLine(result.stdout).status, "applied");
      const after = dictionarySnapshot();
      assert.deepEqual(
        after.rows.filter((row) => row.deleted_at === null).map((row) => row.word),
        ["owner-only", "OWNER-ONLY", " owner-only "],
      );
      assert.equal(
        after.rows.some((row) => ["local-only", " PI ", "pi"].includes(row.word)),
        false,
      );
      const removed = after.rows.find((row) => row.word === "PI");
      assert.ok(removed?.deleted_at);
      assert.equal(removed.sync_status, "pending");
      for (const field of ["word", "source", "client_dict_id", "cloud_id"] as const)
        assert.equal(removed[field], before.rows[0]![field]);
      for (const row of before.rows.filter((row) =>
        ["owner-only", "OWNER-ONLY", " owner-only ", "Godot"].includes(row.word),
      )) {
        const preserved = after.rows.find((entry) => entry.word === row.word)!;
        for (const [key, value] of Object.entries(row))
          assert.equal(preserved[key as keyof typeof row], value, key);
      }
      assert.deepEqual(after.snippets, before.snippets);
      assert.deepEqual(await dumpStorage(), storageBefore);
      const second = await runDeclaredHook();
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(parseStatusLine(second.stdout).status, "unchanged");
      assert.deepEqual(dictionarySnapshot(), after);
    }
    {
      createDictionaryFixture();
      declareDictionary(["pi", "owner-only"]);
      const before = dictionarySnapshot();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(parseStatusLine(result.stdout).status, "unchanged");
      assert.deepEqual(dictionarySnapshot(), before);
    }
    {
      const before = dictionarySnapshot();
      const storageBefore = await dumpStorage();
      writeFileSync(join(keysDir, MANAGED_KEYS_FILE), e2eYaml);
      const omitted = await runDeclaredHook();
      assert.equal(omitted.exitCode, 0, omitted.stderr);
      assert.equal(parseStatusLine(omitted.stdout).status, "unchanged");
      assert.deepEqual(dictionarySnapshot(), before);
      declareDictionary([]);
      const cleared = await runDeclaredHook();
      assert.equal(cleared.exitCode, 0, cleared.stderr);
      assert.equal(parseStatusLine(cleared.stdout).status, "applied");
      const after = dictionarySnapshot();
      assert.deepEqual(
        after.rows.filter((row) => row.deleted_at === null),
        [],
      );
      assert.deepEqual(after.snippets, before.snippets);
      assert.deepEqual(await dumpStorage(), storageBefore);
      const second = await runDeclaredHook();
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(parseStatusLine(second.stdout).status, "unchanged");
      assert.deepEqual(dictionarySnapshot(), after);
    }
    // keeps the legacy dictionary and storage unchanged while the app singleton is locked
    {
      await seedProfile();
      createLegacyDictionaryFixture();
      declareDictionary(["new-locked-word"]);
      const before = dictionarySnapshot();
      const holdChild = await startHoldHelper();
      try {
        const result = await runDeclaredHook();
        assert.equal(result.exitCode, 3, result.stderr);
        assert.equal(parseStatusLine(result.stdout).code, "LOCKED");
        assert.deepEqual(dictionarySnapshot(), before);
        assert.equal(holdChild?.exitCode, null);
      } finally {
        await stopHoldHelper();
      }
      assert.equal(
        (await dumpStorage())["customPrompt.cleanup"],
        seededValues["customPrompt.cleanup"],
      );
    }
    for (const failure of ["registration", "verification"] as const) {
      // restores all changed storage and dictionary rows after a ${failure} failure
      await seedProfile();
      createDictionaryFixture();
      declareDictionary(["first-added-word", "failed-word"]);
      const db = new FixtureDatabase(join(profileDir, "transcriptions.db"));
      try {
        db.exec(
          "INSERT INTO custom_dictionary (word, source) VALUES (' PI ', 'learned'), ('pi', 'manual')",
        );
        db.exec(
          failure === "registration"
            ? "CREATE TRIGGER fail_registration BEFORE INSERT ON custom_dictionary WHEN NEW.word = 'failed-word' BEGIN SELECT RAISE(ABORT, 'fixture registration failure'); END"
            : "CREATE TRIGGER fail_verification BEFORE INSERT ON custom_dictionary WHEN NEW.word = 'failed-word' BEGIN SELECT RAISE(IGNORE); END",
        );
      } finally {
        db.close();
      }
      const before = dictionarySnapshot();
      const storageBefore = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 5, result.stderr);
      assert.equal(parseStatusLine(result.stdout).code, "APPLY_FAILED");
      assert.match(
        result.stderr,
        failure === "registration"
          ? /fixture registration failure/
          : /dictionary verification failed/,
      );
      assert.deepEqual(dictionarySnapshot(), before);
      assert.deepEqual(await dumpStorage(), storageBefore);
      assert.equal(existsSync(recoveryRecordPath(profileDir)), false);
    }
    // fails without initializing a missing dictionary DB or changing storage
    {
      await seedProfile();
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(join(profileDir, "transcriptions.db" + suffix), { force: true });
      declareDictionary(["requires-db"]);
      const before = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 5, result.stderr);
      assert.equal(parseStatusLine(result.stdout).code, "APPLY_FAILED");
      assert.match(result.stderr, /database|SQLITE|open/i);
      assert.equal(existsSync(join(profileDir, "transcriptions.db")), false);
      assert.deepEqual(await dumpStorage(), before);
    }
    // migrates a legacy dictionary DB with the installed app and remains idempotent
    {
      await seedProfile();
      createLegacyDictionaryFixture();
      declareDictionary(["pi", "owner-only", "new-migrated-word"]);
      const before = dictionarySnapshot();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(parseStatusLine(result.stdout).status, "applied");
      const after = dictionarySnapshot();
      for (const [index, row] of before.rows.entries()) {
        for (const [key, value] of Object.entries(row))
          assert.equal(after.rows[index]![key as keyof typeof row], value, key);
      }
      assert.ok(after.rows.some((row) => row.word === "new-migrated-word"));
      assert.ok(after.schema.some((row) => (row as { name: string }).name === "notes"));
      assert.deepEqual(after.snippets, before.snippets);
      assert.deepEqual(
        readdirSync(profileDir).filter((name) => name.startsWith(".openwhispr-db-migration-")),
        [],
      );
      const second = await runDeclaredHook();
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(parseStatusLine(second.stdout).status, "unchanged");
      assert.deepEqual(dictionarySnapshot(), after);
    }
    // preserves the existing DB inode and access controls during legacy migration
    {
      await seedProfile();
      createLegacyDictionaryFixture();
      const dbPath = join(profileDir, "transcriptions.db");
      const hasAclTools =
        process.platform === "linux" &&
        spawnSync("setfacl", ["--version"]).status === 0 &&
        spawnSync("getfacl", ["--version"]).status === 0;
      if (hasAclTools) {
        const acl = spawnSync("setfacl", ["-m", `u:${process.getuid!()}:---`, dbPath], {
          encoding: "utf8",
        });
        assert.equal(acl.status, 0, acl.stderr);
      }
      const aclBefore = hasAclTools
        ? spawnSync("getfacl", ["-cpn", dbPath], { encoding: "utf8" }).stdout
        : undefined;
      const before = statSync(dbPath);
      declareDictionary(["preserve-access-controls"]);
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      if (hasAclTools) {
        const aclAfter = spawnSync("getfacl", ["-cpn", dbPath], { encoding: "utf8" });
        assert.equal(aclAfter.status, 0, aclAfter.stderr);
        assert.equal(aclAfter.stdout, aclBefore);
      }
      const after = statSync(dbPath);
      assert.deepEqual(
        [after.dev, after.ino, after.uid, after.gid, after.mode],
        [before.dev, before.ino, before.uid, before.gid, before.mode],
      );
      assert.ok(dictionarySnapshot().rows.some((row) => row.word === "preserve-access-controls"));
    }
    for (const journalMode of ["DELETE", "WAL"]) {
      // rolls back an interrupted SQLite backup into an existing ${journalMode} DB
      const backupDir = mkdtempSync(join(e2eRoot, "backup-interruption-"));
      const script = `
          const assert = require("node:assert/strict");
          const path = require("node:path");
          const SQLite = require(process.argv[1]);
          (async () => {
            const source = new SQLite(path.join(process.argv[2], "source.db"));
            const destination = new SQLite(path.join(process.argv[2], "destination.db"));
            try {
              source.exec("CREATE TABLE payload (value BLOB); INSERT INTO payload VALUES (zeroblob(1048576))");
              destination.pragma("journal_mode = " + process.argv[3]);
              destination.exec("CREATE TABLE owner_data (value TEXT); INSERT INTO owner_data VALUES ('preserve me')");
              const before = destination.serialize();
              let transferredPages = 0;
              await assert.rejects(source.backup(destination.name, {
                progress({ totalPages, remainingPages }) {
                  transferredPages = totalPages - remainingPages;
                  if (transferredPages > 0 && remainingPages > 0)
                    throw new Error("fixture interrupted backup");
                  return 1;
                },
              }), /fixture interrupted backup/);
              assert.ok(transferredPages > 0);
              const restored = new SQLite(destination.name, { readonly: true });
              try { assert.deepEqual(restored.serialize(), before); }
              finally { restored.close(); }
              console.log(JSON.stringify({ journalMode: process.argv[3], transferredPages }));
            } finally {
              source.close();
              destination.close();
            }
          })().catch((error) => { console.error(error); process.exitCode = 1; });
        `;
      const result = spawnSync(
        join(runtimeDir, e2ePlatform === "win32" ? "electron.exe" : "electron"),
        [
          "-e",
          script,
          join(e2eAppDir, "resources", "app.asar", "node_modules", "better-sqlite3"),
          backupDir,
          journalMode,
        ],
        {
          env: { ...hookEnv({}), ELECTRON_RUN_AS_NODE: "1", DISPLAY: "", WAYLAND_DISPLAY: "" },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok((JSON.parse(result.stdout) as { transferredPages: number }).transferredPages > 0);
    }
    // includes uncheckpointed WAL rows in legacy DB migration
    {
      await seedProfile();
      createLegacyDictionaryFixture();
      const dbPath = join(profileDir, "transcriptions.db");
      const writer = spawnSync(
        "bun",
        [
          "-e",
          'const { Database } = require("bun:sqlite"); const db = new Database(process.argv[1]); db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0"); db.query("INSERT INTO custom_dictionary (word) VALUES (?)").run("wal-only-word"); process.kill(process.pid, "SIGKILL");',
          dbPath,
        ],
        { env: hookEnv({}), encoding: "utf8" },
      );
      assert.equal(writer.signal, "SIGKILL", writer.stderr);
      assert.ok(statSync(dbPath + "-wal").size > 32);
      declareDictionary(["wal-only-word", "after-wal-migration"]);
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      const words = dictionarySnapshot().rows.map((row) => row.word);
      assert.ok(words.includes("wal-only-word"));
      assert.ok(words.includes("after-wal-migration"));
    }
    for (const failure of ["migration", "registration", "verification"] as const) {
      // keeps the entire legacy DB and storage unchanged after a ${failure} failure
      await seedProfile();
      createLegacyDictionaryFixture();
      const dbPath = join(profileDir, "transcriptions.db");
      const db = new FixtureDatabase(dbPath);
      try {
        if (failure === "migration")
          db.exec("DROP TABLE snippets; CREATE TABLE snippets (trigger TEXT, replacement TEXT)");
        else
          db.exec(
            failure === "registration"
              ? "CREATE TRIGGER fail_registration BEFORE INSERT ON custom_dictionary WHEN NEW.word = 'failed-word' BEGIN SELECT RAISE(ABORT, 'fixture registration failure'); END"
              : "CREATE TRIGGER fail_verification BEFORE INSERT ON custom_dictionary WHEN NEW.word = 'failed-word' BEGIN SELECT RAISE(IGNORE); END",
          );
      } finally {
        db.close();
      }
      declareDictionary(["failed-word"]);
      const before = readFileSync(dbPath);
      const storageBefore = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 5, result.stderr);
      assert.match(
        result.stderr,
        failure === "migration"
          ? /no such column: id/
          : failure === "registration"
            ? /fixture registration failure/
            : /dictionary verification failed/,
      );
      assert.deepEqual(readFileSync(dbPath), before);
      assert.deepEqual(await dumpStorage(), storageBefore);
      assert.deepEqual(
        readdirSync(profileDir).filter((name) => name.startsWith(".openwhispr-db-migration-")),
        [],
      );
    }
    // reports applied when migration is the only required change
    {
      await seedProfile();
      writeFileSync(join(keysDir, MANAGED_KEYS_FILE), e2eYaml);
      assert.equal((await runDeclaredHook()).exitCode, 0);
      createLegacyDictionaryFixture();
      declareDictionary(["pi", "owner-only"]);
      const storageBefore = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(parseStatusLine(result.stdout).status, "applied");
      assert.deepEqual(await dumpStorage(), storageBefore);
      assert.equal(dictionarySnapshot().rows.length, 3);
    }
    // refuses DB replacement while another SQLite connection keeps source sidecars
    {
      await seedProfile();
      createLegacyDictionaryFixture();
      const dbPath = join(profileDir, "transcriptions.db");
      const reader = new FixtureDatabase(dbPath);
      try {
        reader.exec("PRAGMA journal_mode = WAL; BEGIN");
        reader.query("SELECT word FROM custom_dictionary").all();
        declareDictionary(["must-not-replace"]);
        const before = dictionarySnapshot();
        const storageBefore = await dumpStorage();
        const result = await runDeclaredHook();
        assert.equal(result.exitCode, 5, result.stderr);
        assert.match(result.stderr, /profile database still has SQLite sidecar files/);
        assert.deepEqual(dictionarySnapshot(), before);
        assert.deepEqual(await dumpStorage(), storageBefore);
        assert.equal(existsSync(dbPath + "-shm"), true);
      } finally {
        reader.close();
      }
    }
    // fails without reporting success when a rollback-mode reader blocks DB promotion
    {
      await seedProfile();
      createLegacyDictionaryFixture();
      const dbPath = join(profileDir, "transcriptions.db");
      const reader = new FixtureDatabase(dbPath);
      try {
        reader.exec("BEGIN");
        reader.query("SELECT word FROM custom_dictionary").all();
        declareDictionary(["must-not-report-success"]);
        const before = dictionarySnapshot();
        const storageBefore = await dumpStorage();
        const result = await runDeclaredHook();
        assert.equal(result.exitCode, 5, result.stderr);
        assert.match(result.stderr, /database backup did not transfer any pages/);
        assert.deepEqual(dictionarySnapshot(), before);
        assert.deepEqual(await dumpStorage(), storageBefore);
      } finally {
        reader.close();
      }
    }
    // does not initialize an existing empty DB
    {
      await seedProfile();
      createDictionaryFixture();
      const dbPath = join(profileDir, "transcriptions.db");
      writeFileSync(dbPath, "");
      declareDictionary(["requires-existing-dictionary"]);
      const storageBefore = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, 5, result.stderr);
      assert.equal(statSync(dbPath).size, 0);
      assert.deepEqual(await dumpStorage(), storageBefore);
    }
    for (const declaration of [undefined, [], ["", " ", "\t"]]) {
      await seedProfile();
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(join(profileDir, "transcriptions.db" + suffix), { force: true });
      if (declaration === undefined) writeFileSync(join(keysDir, MANAGED_KEYS_FILE), e2eYaml);
      else declareDictionary(declaration);
      const storageBefore = await dumpStorage();
      const result = await runDeclaredHook();
      assert.equal(result.exitCode, declaration === undefined ? 0 : 5, result.stderr);
      assert.equal(
        parseStatusLine(result.stdout).status,
        declaration === undefined ? "applied" : "error",
      );
      if (declaration !== undefined) assert.deepEqual(await dumpStorage(), storageBefore);
      assert.equal(existsSync(join(profileDir, "transcriptions.db")), false);
    }
    // rejects an invalid declaration without touching the profile
    {
      const brokenKeysDir = join(e2eRoot, "broken-keys");
      mkdirSync(brokenKeysDir, { recursive: true });
      writeFileSync(join(brokenKeysDir, MANAGED_KEYS_FILE), "keys: [broken", "utf8");
      const result = await runHookScript(
        hookOverrides({
          OPENWHISPR_E2E_MANAGED_KEYS: brokenKeysDir,
          OPENWHISPR_E2E_PROFILE: profileDir,
        }),
      );
      const status = parseStatusLine(result.stdout);
      assert.deepEqual([status.status, status.code], ["error", "INVALID_INPUT"], result.stderr);
      assert.equal(result.exitCode, 2);
    }
  } finally {
    await stopHoldHelper();
    if (e2eRoot) rmSync(e2eRoot, { recursive: true, force: true });
  }
}

verifyPaths();
verifyManagedKeys();
verifyDictionaryDeclarations();
verifyStatusLines();
verifyHarnessGuards();
await verifyStorageRecovery();
verifyAsarIdentity();
await verifyHookLockAndRecovery();
await verifyUninitializedProfiles();
console.log("OpenWhispr config checks passed");
if (process.env.OPENWHISPR_E2E === "1") {
  await verifyInstalledRuntime();
  console.log("OpenWhispr E2E checks passed");
} else {
  console.log("OpenWhispr E2E checks skipped (OPENWHISPR_E2E is not 1)");
}
