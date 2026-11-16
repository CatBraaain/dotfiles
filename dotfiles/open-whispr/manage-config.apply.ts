#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { cp, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";

export const MANAGED_KEYS_FILE = "managed-keys.data.yaml";

export type ManagedStorageTarget = { key: string; value: string };

export type HookErrorCode = "INVALID_INPUT" | "LOCKED" | "APPLY_FAILED";

const exitCodeByError: Record<HookErrorCode, number> = {
  INVALID_INPUT: 2,
  LOCKED: 3,
  APPLY_FAILED: 5,
};

const harnessExitLocked = 23;
const harnessExitInvalidArguments = 90;

export class HookError extends Error {
  constructor(
    readonly code: HookErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type PlatformName = "linux" | "win32";
export type PathEnv = Record<string, string | undefined>;

const linuxAppDir = "/opt/OpenWhispr";
const linuxProfileSuffix = join(".config", "open-whispr");
const windowsAppDirSuffix = join("Programs", "OpenWhispr");
const windowsProfileSuffix = "open-whispr";
const expectedAsarPackageName = "open-whispr";
const linuxAppBinaryName = "open-whispr-app";
const windowsAppBinaryName = "OpenWhispr.exe";
const defaultHarnessTimeoutMs = 90_000;
const defaultHookLockWaitMs = 20_000;
const hookLockStaleMs = 30 * 60_000;

export type ResolvedPaths = {
  platform: PlatformName;
  managedKeysDir: string;
  profileDir: string;
  appDir: string;
  appBinaryName: string;
  timeouts: { harnessMs: number; lockWaitMs: number };
  isE2E: boolean;
};

function resolveManagedKeysDir(env: PathEnv, isE2E: boolean): string {
  if (!isE2E) return import.meta.dir;
  const dir = env.OPENWHISPR_E2E_MANAGED_KEYS ?? "";
  if (!isAbsolute(dir) || !isAbsoluteTmpPath(dir))
    throw new HookError(
      "INVALID_INPUT",
      "e2e managed keys dir must be an absolute path under tmpdir",
    );
  return dir;
}

function isAbsoluteTmpPath(path: string): boolean {
  const tempRoot = tmpdir();
  return path === tempRoot || path.startsWith(tempRoot + "/") || path.startsWith(tempRoot + "\\");
}

function linuxPaths(platform: PlatformName, env: PathEnv, isE2E: boolean): ResolvedPaths {
  const timeouts = {
    harnessMs: defaultHarnessTimeoutMs,
    lockWaitMs: defaultHookLockWaitMs,
  };
  const homeDir = env.HOME ?? "";
  const productionProfileDir = homeDir ? join(homeDir, linuxProfileSuffix) : null;
  const managedKeysDir = resolveManagedKeysDir(env, isE2E);
  if (!isE2E) {
    if (!homeDir) throw new HookError("INVALID_INPUT", "HOME is not set");
    return {
      platform,
      managedKeysDir,
      profileDir: productionProfileDir!,
      appDir: linuxAppDir,
      appBinaryName: linuxAppBinaryName,
      timeouts,
      isE2E,
    };
  }
  if (!env.OPENWHISPR_E2E_PROFILE && !productionProfileDir)
    throw new HookError("INVALID_INPUT", "HOME is not set");
  const e2eProfile = env.OPENWHISPR_E2E_PROFILE ?? productionProfileDir!;
  const e2eAppDir = env.OPENWHISPR_E2E_APP_DIR ?? linuxAppDir;
  if (!isAbsolute(e2eProfile) || !isAbsoluteTmpPath(e2eProfile))
    throw new HookError("INVALID_INPUT", "e2e profile must be an absolute path under tmpdir");
  return {
    platform,
    managedKeysDir,
    profileDir: e2eProfile,
    appDir: e2eAppDir,
    appBinaryName: linuxAppBinaryName,
    timeouts,
    isE2E,
  };
}

function windowsPaths(platform: PlatformName, env: PathEnv, isE2E: boolean): ResolvedPaths {
  const appData = env.APPDATA ?? "";
  if (!appData) throw new HookError("INVALID_INPUT", "APPDATA is not set");
  const localAppData = env.LOCALAPPDATA ?? "";
  if (!localAppData) throw new HookError("INVALID_INPUT", "LOCALAPPDATA is not set");
  const timeouts = {
    harnessMs: defaultHarnessTimeoutMs,
    lockWaitMs: defaultHookLockWaitMs,
  };
  const productionProfileDir = join(appData, windowsProfileSuffix);
  const productionAppDir = join(localAppData, windowsAppDirSuffix);
  const managedKeysDir = resolveManagedKeysDir(env, isE2E);
  if (!isE2E)
    return {
      platform,
      managedKeysDir,
      profileDir: productionProfileDir,
      appDir: productionAppDir,
      appBinaryName: windowsAppBinaryName,
      timeouts,
      isE2E,
    };
  const e2eProfile = env.OPENWHISPR_E2E_PROFILE ?? productionProfileDir;
  const e2eAppDir = env.OPENWHISPR_E2E_APP_DIR ?? productionAppDir;
  if (!isAbsolute(e2eProfile) || !isAbsoluteTmpPath(e2eProfile))
    throw new HookError("INVALID_INPUT", "e2e profile must be an absolute path under tmpdir");
  return {
    platform,
    managedKeysDir,
    profileDir: e2eProfile,
    appDir: e2eAppDir,
    appBinaryName: windowsAppBinaryName,
    timeouts,
    isE2E,
  };
}

export function resolvePaths(platform: string, env: PathEnv): ResolvedPaths {
  if (platform === "linux") return linuxPaths("linux", env, env.OPENWHISPR_E2E === "1");
  if (platform === "win32") return windowsPaths("win32", env, env.OPENWHISPR_E2E === "1");
  throw new HookError("INVALID_INPUT", `unsupported platform: ${platform}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function validateManagedKeys(raw: unknown): ManagedStorageTarget[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new HookError("INVALID_INPUT", "managed keys file must be a mapping with a keys array");
  const keys = (raw as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0)
    throw new HookError("INVALID_INPUT", "managed keys file must list a non-empty keys array");
  const declared = new Set<string>();
  const targets: ManagedStorageTarget[] = [];
  for (const entry of keys) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new HookError("INVALID_INPUT", "managed keys entries must be mappings");
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || key === "")
      throw new HookError("INVALID_INPUT", "managed key must be a non-empty string");
    if (declared.has(key))
      throw new HookError("INVALID_INPUT", `managed key is duplicated: ${key}`);
    declared.add(key);
    if (typeof value !== "string")
      throw new HookError("INVALID_INPUT", `managed key must declare a string value: ${key}`);
    if (value.includes("\0"))
      throw new HookError("INVALID_INPUT", `managed key value contains NUL: ${key}`);
    if (value.trim() === "")
      throw new HookError("INVALID_INPUT", `managed key value is blank: ${key}`);
    targets.push({ key, value });
  }
  return targets;
}

export function validateDictionary(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new HookError("INVALID_INPUT", "dictionary must be a string array");
  const words = new Map<string, string>();
  for (const word of raw) {
    if (typeof word !== "string" || word.includes("\0"))
      throw new HookError("INVALID_INPUT", "dictionary words must be strings without NUL");
    const trimmed = word.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !words.has(key)) words.set(key, trimmed);
  }
  return [...words.values()];
}

export type ManagedConfig = { keys: ManagedStorageTarget[]; dictionary: string[] };

export function loadManagedConfig(baseDir: string): ManagedConfig {
  const declarationPath = join(baseDir, MANAGED_KEYS_FILE);
  let text: string;
  try {
    text = readFileSync(declarationPath, "utf8");
  } catch {
    throw new HookError("INVALID_INPUT", `managed keys file is missing: ${declarationPath}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    if (error instanceof HookError) throw error;
    throw new HookError("INVALID_INPUT", `managed keys file is not valid YAML: ${declarationPath}`);
  }
  const keys = validateManagedKeys(raw);
  const dictionary = validateDictionary((raw as { dictionary?: unknown }).dictionary);
  return { keys, dictionary };
}

export function loadManagedKeys(baseDir: string): ManagedStorageTarget[] {
  return loadManagedConfig(baseDir).keys;
}

export function managedKeysSha256(
  targets: ManagedStorageTarget[],
  dictionary: string[] = [],
): string {
  const storage = targets.map((target) => `${target.key}\0${target.value}`).join("\0");
  return sha256Hex(dictionary.length === 0 ? storage : JSON.stringify({ storage, dictionary }));
}

export type RegistrationOutcome = {
  status: "applied" | "unchanged" | "skipped" | "error";
  code: "OK" | HookErrorCode;
  keysSha256: string | null;
  detail?: string;
};

export function formatStatusLine(outcome: RegistrationOutcome): string {
  return [
    `status=${outcome.status}`,
    `code=${outcome.code}`,
    `keys_sha256=${outcome.keysSha256 ?? "-"}`,
  ].join(" ");
}

// ---------------------------------------------------------------- app identity

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    (bytes[offset + 1]! << 8) +
    (bytes[offset + 2]! << 16) +
    (bytes[offset + 3]! << 24)
  );
}

export function parseAsarPackageName(asarBytes: Uint8Array): string {
  const fail = () => new HookError("INVALID_INPUT", "installed app.asar has an unexpected format");
  if (asarBytes.length < 16 || readUInt32LE(asarBytes, 0) !== 4) throw fail();
  const headerPickleLength = readUInt32LE(asarBytes, 4);
  const headerPayloadLength = readUInt32LE(asarBytes, 8);
  const jsonLength = readUInt32LE(asarBytes, 12);
  if (headerPickleLength !== headerPayloadLength + 4) throw fail();
  if (16 + jsonLength > asarBytes.length) throw fail();
  let header: { files?: Record<string, { offset?: string; size?: number }> };
  try {
    header = JSON.parse(new TextDecoder().decode(asarBytes.subarray(16, 16 + jsonLength)));
  } catch {
    throw fail();
  }
  const packageEntry = header.files?.["package.json"];
  if (packageEntry?.offset === undefined || packageEntry.size === undefined) throw fail();
  const dataStart = 8 + headerPickleLength;
  const packageStart = dataStart + Number(packageEntry.offset);
  const packageEnd = packageStart + packageEntry.size;
  if (packageStart < dataStart || packageEnd > asarBytes.length || packageEnd < packageStart)
    throw fail();
  try {
    const packageJson = JSON.parse(
      new TextDecoder().decode(asarBytes.subarray(packageStart, packageEnd)),
    );
    if (typeof packageJson.name !== "string") throw fail();
    return packageJson.name;
  } catch (error) {
    if (error instanceof HookError) throw error;
    throw fail();
  }
}

export function verifyAppIdentity(appDir: string): void {
  const asarPath = join(appDir, "resources", "app.asar");
  let asarBytes: Buffer;
  try {
    asarBytes = readFileSync(asarPath);
  } catch {
    throw new HookError("INVALID_INPUT", `installed app package is missing: ${asarPath}`);
  }
  const packageName = parseAsarPackageName(asarBytes);
  if (packageName !== expectedAsarPackageName)
    throw new HookError(
      "INVALID_INPUT",
      `installed app has unexpected package name: ${packageName}`,
    );
}

export function isRecognizedProfile(profileDir: string): boolean {
  try {
    if (statSync(profileDir).isDirectory())
      return (
        existsSync(join(profileDir, "Preferences")) || existsSync(join(profileDir, "Local Storage"))
      );
  } catch {
    return false;
  }
  return false;
}

// ------------------------------------------------------------ command lookup

async function runCommandDefault(
  command: string[],
): Promise<{ exitCode: number | null; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.on("error", () => resolve({ exitCode: null, stdout }));
    child.on("close", (exitCode) => resolve({ exitCode, stdout }));
  });
}

const executablePathCache = new Map<string, string | null>();

async function findExecutable(name: string): Promise<string | null> {
  if (executablePathCache.has(name)) return executablePathCache.get(name) ?? null;
  const which = process.platform === "win32" ? "where" : "which";
  const { stdout } = await runCommandDefault([which, name]);
  const resolved = stdout.trim().split("\n")[0]?.trim() || null;
  executablePathCache.set(name, resolved);
  return resolved;
}

// ------------------------------------------------------------ shadow runtime

export function buildHarnessPackageJson(): string {
  return (
    JSON.stringify(
      {
        name: "open-whispr-config-harness",
        version: "1.0.0",
        main: "main.js",
      },
      null,
      2,
    ) + "\n"
  );
}

export function buildHarnessSource(): string {
  return (
    [
      'const { app, BrowserWindow, session } = require("electron");',
      'const nodeCrypto = require("node:crypto");',
      'const nodeFs = require("node:fs");',
      'const nodePath = require("node:path");',
      'const nodeUrl = require("node:url");',
      "",
      "const profile = process.env.OW_HARNESS_PROFILE;",
      "const mode = process.env.OW_HARNESS_MODE;",
      'const targets = JSON.parse(process.env.OW_HARNESS_TARGETS_JSON || "[]");',
      'const words = JSON.parse(process.env.OW_HARNESS_DICTIONARY_JSON || "[]");',
      `if (!profile || !nodePath.isAbsolute(profile)) process.exit(${harnessExitInvalidArguments});`,
      'if ((mode === "read" || mode === "apply") && targets.length === 0) process.exit(90);',
      "",
      'app.setPath("userData", profile);',
      'app.setPath("sessionData", profile);',
      "",
      "const emit = (payload) => console.log(JSON.stringify(Object.assign({ mode: mode }, payload)));",
      'const sha256 = (value) => nodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");',
      "",
      "if (!app.requestSingleInstanceLock()) {",
      '  emit({ status: "locked" });',
      `  app.exit(${harnessExitLocked});`,
      "} else {",
      'app.on("second-instance", () => {});',
      "app.whenReady().then(async () => {",
      "  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>",
      '    callback({ cancel: !details.url.startsWith("file:") }));',
      '  session.defaultSession.protocol.handle("file", () =>',
      '    new Response("<!doctype html><title>open-whispr cleanup registration harness</title>"));',
      "  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));",
      "  const window = new BrowserWindow({",
      "    show: false,",
      "    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },",
      "  });",
      '  const inertPageUrl = nodeUrl.pathToFileURL(nodePath.join(profile, "ow-harness-inert.html")).href;',
      "  await window.loadURL(inertPageUrl);",
      "  const readStorageMap = () => window.webContents.executeJavaScript(",
      '    "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))");',
      "  const readKey = (key) => window.webContents.executeJavaScript(",
      '    "(function () { const value = localStorage.getItem(" + JSON.stringify(key) + "); return value === null ? null : String(value); })()"',
      "  );",
      "  const setKey = (key, value) => window.webContents.executeJavaScript(",
      '    "localStorage.setItem(" + JSON.stringify(key) + ", " + JSON.stringify(value) + ")"',
      "  );",
      "  const removeKey = (key) => window.webContents.executeJavaScript(",
      '    "localStorage.removeItem(" + JSON.stringify(key) + ")"',
      "  );",
      "",
      '  if (mode === "hold") {',
      '    emit({ status: "hold-ready" });',
      '    setTimeout(() => app.quit(), Number(process.env.OW_HARNESS_HOLD_MS || "60000"));',
      "    return;",
      "  }",
      '  if (mode === "seed") {',
      '    const seedMap = JSON.parse(process.env.OW_HARNESS_SEED_JSON || "{}");',
      "    const before = JSON.parse(await readStorageMap());",
      "    for (const entry of Object.entries(seedMap)) await setKey(entry[0], entry[1]);",
      "    session.defaultSession.flushStorageData();",
      "    const after = JSON.parse(await readStorageMap());",
      '    emit({ status: "seeded", before: before, after: after });',
      '  } else if (mode === "dump") {',
      '    if (process.env.OW_HARNESS_ALLOW_DUMP !== "1") process.exit(' +
        harnessExitInvalidArguments +
        ");",
      "    const storage = JSON.parse(await readStorageMap());",
      '    emit({ status: "dump", storage: storage });',
      '  } else if (mode === "read") {',
      "    const current = {};",
      "    for (const target of targets) {",
      "      const value = await readKey(target.key);",
      "      current[target.key] = { value: value, sha256: value === null ? null : sha256(value), equals: value === target.value };",
      "    }",
      '    emit({ status: "ok", current: current });',
      `  } else if (mode === "apply") {
    const before = Object.create(null);
    const applied = [];
    const restoreFailed = [];
    let database = null;
    let dictionary = null;
    let missing = [];
    let migrationDir = null;
    let migrated = false;
    const databasePath = nodePath.join(profile, "transcriptions.db");
    let result;
    function wordKey(word) { return word.trim().toLowerCase(); }
    async function backupDatabase(source, destination) {
      const backup = await source.backup(destination);
      if (backup.totalPages === 0) throw new Error("database backup did not transfer any pages");
    }
    try {
      for (const target of targets) before[target.key] = await readKey(target.key);
      if (words.length > 0) {
        const asar = process.env.OW_HARNESS_APP_ASAR;
        if (!asar || !nodePath.isAbsolute(asar)) throw new Error("installed app.asar path is missing");
        const DatabaseManager = require(nodePath.join(asar, "src", "helpers", "database.js"));
        const SQLite = require(nodePath.join(asar, "node_modules", "better-sqlite3"));
        if (typeof DatabaseManager.prototype.getDictionary !== "function" ||
            typeof DatabaseManager.prototype.applyDictionaryChanges !== "function")
          throw new Error("installed app does not support dictionary delta registration");
        database = new SQLite(databasePath, { fileMustExist: true });
        dictionary = Object.create(DatabaseManager.prototype);
        dictionary.db = database;
        try {
          dictionary._dictionaryWriteStatements();
        } catch (error) {
          if (error.code !== "SQLITE_ERROR" || !error.message.startsWith("no such column:")) throw error;
          if (typeof dictionary.initDatabase !== "function")
            throw new Error("installed app does not support database migration: " + error.message);
          migrationDir = nodeFs.mkdtempSync(nodePath.join(profile, ".openwhispr-db-migration-"));
          await backupDatabase(database, nodePath.join(migrationDir, "transcriptions.db"));
          database.close();
          database = null;
          dictionary.db = null;
          dictionary.activeAccountId = null;
          const userDataPath = app.getPath("userData");
          try {
            app.setPath("userData", migrationDir);
            dictionary.initDatabase();
          } finally {
            database = dictionary.db;
            app.setPath("userData", userDataPath);
          }
          dictionary._dictionaryWriteStatements();
          migrated = true;
        }
        const existing = new Set(dictionary.getDictionary().map(wordKey));
        missing = words.filter((word) => !existing.has(wordKey(word)));
      }
      const changedTargets = targets.filter((target) => before[target.key] !== target.value);
      if (changedTargets.length === 0 && missing.length === 0 && !migrated) {
        result = { status: "unchanged" };
      } else {
        if (missing.length > 0) database.exec("BEGIN IMMEDIATE");
        for (const target of changedTargets) {
          applied.push(target.key);
          await setKey(target.key, target.value);
        }
        if (missing.length > 0) {
          const delta = dictionary.applyDictionaryChanges({ add: missing });
          if (delta.success !== true) throw new Error("dictionary delta registration failed");
        }
        session.defaultSession.flushStorageData();
        for (const target of targets) {
          if (await readKey(target.key) !== target.value)
            throw new Error("storage verification failed for " + target.key);
        }
        if (dictionary) {
          const registered = new Set(dictionary.getDictionary().map(wordKey));
          if (!words.every((word) => registered.has(wordKey(word))))
            throw new Error("dictionary verification failed");
        }
        if (database && database.inTransaction) database.exec("COMMIT");
        if (migrated) {
          if (["-wal", "-shm", "-journal"].some((suffix) => nodeFs.existsSync(databasePath + suffix)))
            throw new Error("profile database still has SQLite sidecar files; close all database connections");
          if (!nodeFs.statSync(databasePath).isFile()) throw new Error("existing database file is missing");
          await backupDatabase(database, databasePath);
        }
        result = { status: "applied", applied: applied, dictionaryAdded: missing.length };
      }
    } catch (error) {
      if (database && database.inTransaction) {
        try { database.exec("ROLLBACK"); }
        catch (rollbackError) { if (!migrationDir) restoreFailed.push("dictionary"); }
      }
      for (const key of applied) {
        try {
          if (before[key] === null) await removeKey(key);
          else await setKey(key, before[key]);
          if (await readKey(key) !== before[key]) restoreFailed.push(key);
        } catch (restoreError) { restoreFailed.push(key); }
      }
      try { session.defaultSession.flushStorageData(); }
      catch (flushError) { restoreFailed.push("storage"); }
      result = {
        status: restoreFailed.length > 0 ? "restore-failed" : "error",
        detail: "config registration failed: " + String(error && error.message || error),
        before: before,
        restoreFailed: restoreFailed,
      };
    } finally {
      if (database) {
        try { database.close(); }
        catch (closeError) {
          if (!result) throw closeError;
          result.detail = [result.detail, "database close failed: " + String(closeError && closeError.message || closeError)].filter(Boolean).join("; ");
        }
      }
      if (migrationDir) {
        try {
          if (database && database.open)
            result.detail = [result.detail, "staged database retained at " + migrationDir + ": connection is still open"].filter(Boolean).join("; ");
          else nodeFs.rmSync(migrationDir, { recursive: true, force: true });
        } catch (cleanupError) {
          result.detail = [result.detail, "staged database retained at " + migrationDir + ": " + String(cleanupError && cleanupError.message || cleanupError)].filter(Boolean).join("; ");
        }
      }
    }
    emit(result);
    try {
      window.destroy();
      app.quit();
    } catch (shutdownError) {
      result.detail = [result.detail, "harness shutdown failed: " + String(shutdownError && shutdownError.message || shutdownError)].filter(Boolean).join("; ");
      emit(result);
      app.exit(0);
    }
    return;`,
      "  } else {",
      `    process.exit(${harnessExitInvalidArguments});`,
      "  }",
      "  session.defaultSession.flushStorageData();",
      "  window.destroy();",
      "  app.quit();",
      "}).catch((error) => { console.error(String((error && error.stack) || error)); app.exit(1); });",
      "}",
    ].join("\n") + "\n"
  );
}

function isUninstallerEntry(name: string): boolean {
  return /^uninstall/i.test(name);
}

export async function ensureShadowRuntime(appDir: string, platform: PlatformName): Promise<string> {
  const appBinaryName = platform === "linux" ? linuxAppBinaryName : windowsAppBinaryName;
  const electronBinaryName = platform === "linux" ? "electron" : "electron.exe";
  const sourceBinary = join(appDir, appBinaryName);
  let binaryStat;
  try {
    binaryStat = statSync(sourceBinary);
  } catch {
    throw new HookError("INVALID_INPUT", `installed app binary is missing: ${sourceBinary}`);
  }
  const binaryHash = sha256Hex(readFileSync(sourceBinary));
  const runtimeDir = join(
    tmpdir(),
    `openwhispr-register-runtime-${platform}-${binaryHash.slice(0, 16)}-${binaryStat.size}`,
  );
  const manifest = JSON.stringify({
    version: 2,
    sha256: binaryHash,
    size: binaryStat.size,
    harness: sha256Hex(buildHarnessSource()),
  });
  const manifestPath = join(runtimeDir, ".runtime-manifest.json");
  if (
    existsSync(manifestPath) &&
    readFileSync(manifestPath, "utf8") === manifest &&
    existsSync(join(runtimeDir, electronBinaryName))
  )
    return runtimeDir;

  const stagingDir = await mkdtemp(join(tmpdir(), "openwhispr-runtime-"));
  try {
    for (const entry of readdirSync(appDir, { withFileTypes: true })) {
      if (entry.name === "resources" || entry.name === appBinaryName) continue;
      if (isUninstallerEntry(entry.name)) continue;
      if (platform === "linux" && entry.name === "open-whispr") continue;
      const source = join(appDir, entry.name);
      const destination = join(stagingDir, entry.name);
      if (entry.isDirectory()) await cp(source, destination, { recursive: true });
      else await cp(source, destination);
    }
    copyFileSync(sourceBinary, join(stagingDir, electronBinaryName));
    if (platform === "linux") chmodSync(join(stagingDir, electronBinaryName), 0o755);
    const appOverlayDir = join(stagingDir, "resources", "app");
    await mkdir(appOverlayDir, { recursive: true });
    await writeFile(join(appOverlayDir, "package.json"), buildHarnessPackageJson());
    await writeFile(join(appOverlayDir, "main.js"), buildHarnessSource());
    await writeFile(join(stagingDir, ".runtime-manifest.json"), manifest);
    await rm(runtimeDir, { recursive: true, force: true });
    await rename(stagingDir, runtimeDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return runtimeDir;
}

// ------------------------------------------------------------- harness runner

export type HarnessMode = "read" | "apply" | "seed" | "dump" | "hold";

export type HarnessPayload = {
  status: string;
  detail?: string;
  dictionaryAdded?: number;
  current?: Record<string, { value: string | null; sha256: string | null; equals: boolean }>;
  applied?: string[];
  restoreFailed?: string[];
  before?: Record<string, string | null>;
  after?: Record<string, string | null>;
  storage?: Record<string, string>;
};

export type HarnessOutcome =
  | { kind: "ok"; payload: HarnessPayload }
  | { kind: "locked" }
  | {
      kind: "error";
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
    };

export type HarnessRun = {
  outcome: HarnessOutcome;
  child: ChildProcess | null;
  cleanup: () => Promise<void>;
};

function killProcessTree(child: ChildProcess, platform: PlatformName): void {
  if (!child.pid) return;
  try {
    if (platform === "linux") process.kill(-child.pid, "SIGKILL");
    else
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        windowsHide: true,
      });
  } catch {}
}

export async function runHarnessMode(options: {
  mode: HarnessMode;
  runtimeDir: string;
  profileDir: string;
  platform: PlatformName;
  targets?: ManagedStorageTarget[];
  dictionary?: string[];
  appDir?: string;
  seedJson?: string;
  allowDump?: boolean;
  holdMs?: number;
  env: PathEnv;
  timeoutMs?: number;
  keepAlive?: boolean;
}): Promise<HarnessRun> {
  const electronName = options.platform === "linux" ? "electron" : "electron.exe";
  const electronPath = join(options.runtimeDir, electronName);
  const electronArgs =
    options.platform === "linux"
      ? ["--disable-gpu", "--disable-setuid-sandbox", `--user-data-dir=${options.profileDir}`]
      : ["--disable-gpu", `--user-data-dir=${options.profileDir}`];
  let command: string[] = [electronPath, ...electronArgs];
  let useSessionDisplay = false;
  if (options.platform === "linux") {
    const unsharePath = await findExecutable("unshare");
    const xvfbRunPath = await findExecutable("xvfb-run");
    if (xvfbRunPath) {
      command = [
        ...(unsharePath ? [unsharePath, "--user", "--map-current-user", "--net"] : []),
        xvfbRunPath,
        "-a",
        "--server-args=-screen 0 800x600x24 -nolisten tcp",
        electronPath,
        ...electronArgs,
      ];
    } else if (options.env.DISPLAY) {
      useSessionDisplay = true;
    } else {
      throw new HookError(
        "APPLY_FAILED",
        "no display server and no xvfb-run for the storage helper",
      );
    }
  }
  const isolatedHome = await mkdtemp(join(tmpdir(), "openwhispr-harness-home-"));
  const childEnv: Record<string, string> = {
    PATH: options.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, "config"),
    XDG_CACHE_HOME: join(isolatedHome, "cache"),
    LANG: options.env.LANG ?? "C.UTF-8",
    OW_HARNESS_PROFILE: options.profileDir,
    OW_HARNESS_MODE: options.mode,
  };
  if (options.platform === "win32") {
    childEnv.SystemRoot = options.env.SystemRoot ?? "C:\\Windows";
    childEnv.USERPROFILE = isolatedHome;
    const isolatedTemp = join(isolatedHome, "temp");
    await mkdir(isolatedTemp, { recursive: true });
    childEnv.TEMP = isolatedTemp;
    childEnv.TMP = isolatedTemp;
  }
  if (useSessionDisplay) childEnv.DISPLAY = options.env.DISPLAY!;
  if (options.targets !== undefined)
    childEnv.OW_HARNESS_TARGETS_JSON = JSON.stringify(options.targets);
  if (options.dictionary !== undefined)
    childEnv.OW_HARNESS_DICTIONARY_JSON = JSON.stringify(options.dictionary);
  if (options.appDir !== undefined)
    childEnv.OW_HARNESS_APP_ASAR = join(options.appDir, "resources", "app.asar");
  if (options.seedJson !== undefined) childEnv.OW_HARNESS_SEED_JSON = options.seedJson;
  if (options.allowDump) childEnv.OW_HARNESS_ALLOW_DUMP = "1";
  if (options.holdMs !== undefined) childEnv.OW_HARNESS_HOLD_MS = String(options.holdMs);

  const child = spawn(command[0]!, command.slice(1), {
    env: childEnv,
    windowsHide: true,
    detached: options.platform === "linux",
  });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child, options.platform);
  }, options.timeoutMs ?? defaultHarnessTimeoutMs);

  const cleanup = async () => {
    clearTimeout(timer);
    try {
      await rm(isolatedHome, { recursive: true, force: true });
    } catch (error) {
      console.error("harness temporary cleanup failed:", error);
    }
  };
  const parseLastLine = (): (HarnessPayload & { mode: string }) | null => {
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    try {
      return JSON.parse(lastLine) as HarnessPayload & { mode: string };
    } catch {
      return null;
    }
  };
  const waitForFirstLine = options.keepAlive === true;

  const outcome = await new Promise<HarnessOutcome>((resolve) => {
    let settled = false;
    const settle = (result: HarnessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", () => {
      if (!waitForFirstLine || settled) return;
      const payload = parseLastLine();
      if (payload) settle({ kind: "ok", payload });
    });
    child.on("error", (error) =>
      settle({
        kind: "error",
        exitCode: null,
        timedOut: false,
        stdout: `spawn error: ${String(error)}`,
      }),
    );
    child.on("close", (exitCode, signal) => {
      const payload = parseLastLine();
      if (payload?.status === "locked") return settle({ kind: "locked" });
      if (
        payload &&
        (exitCode === 0 || payload.status === "restore-failed" || payload.status === "error")
      )
        return settle({ kind: "ok", payload });
      settle({
        kind: "error",
        exitCode,
        timedOut,
        stdout: `${stdout}\nstderr: ${stderr}\nsignal: ${String(signal)}`,
      });
    });
  });
  if (options.keepAlive !== true) await cleanup();
  return { outcome, child: options.keepAlive === true ? child : null, cleanup };
}

// ----------------------------------------------------------------- lock files

export async function acquireHookLock(
  profileDir: string,
  waitMs = defaultHookLockWaitMs,
): Promise<() => Promise<void>> {
  const lockPath = join(
    tmpdir(),
    `openwhispr-manage-config-${sha256Hex(profileDir).slice(0, 16)}.lock`,
  );
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let lockAgeMs = 0;
      try {
        lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (lockAgeMs > hookLockStaleMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline)
        throw new HookError("LOCKED", "another config registration run is in progress");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return async () => {
    await rm(lockPath, { force: true });
  };
}

export function recoveryRecordPath(profileDir: string): string {
  return join(
    tmpdir(),
    `openwhispr-manage-config-recovery-${sha256Hex(profileDir).slice(0, 16)}.json`,
  );
}

export type RecoveryRecord = {
  phase: string;
  keys: Array<{
    key: string;
    previousValue: string | null;
    previousSha256: string | null;
  }>;
  keysSha256: string | null;
  recordedAt: string;
};

export async function writeRecoveryRecord(
  profileDir: string,
  record: Omit<RecoveryRecord, "recordedAt">,
): Promise<void> {
  const fullRecord: RecoveryRecord = {
    ...record,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(recoveryRecordPath(profileDir), JSON.stringify(fullRecord, null, 2) + "\n", {
    mode: 0o600,
  });
}

export async function clearRecoveryRecord(profileDir: string): Promise<void> {
  await rm(recoveryRecordPath(profileDir), { force: true });
}

// ------------------------------------------------------------- orchestration

export async function manageConfig(options: {
  platform: PlatformName;
  env: PathEnv;
}): Promise<RegistrationOutcome> {
  let releaseHookLock: (() => Promise<void>) | null = null;
  let keysSha256: string | null = null;
  try {
    const paths = resolvePaths(options.platform, options.env);
    const { keys: targets, dictionary } = loadManagedConfig(paths.managedKeysDir);
    keysSha256 = managedKeysSha256(targets, dictionary);
    const recognizedProfile = isRecognizedProfile(paths.profileDir);
    if (recognizedProfile)
      releaseHookLock = await acquireHookLock(paths.profileDir, paths.timeouts.lockWaitMs);
    verifyAppIdentity(paths.appDir);
    if (!recognizedProfile)
      return {
        status: "skipped",
        code: "OK",
        keysSha256,
        detail: `OpenWhispr userData is not initialized: ${paths.profileDir}; launch and quit OpenWhispr, then run apply again`,
      };
    const runtimeDir = await ensureShadowRuntime(paths.appDir, paths.platform);
    const run = await runHarnessMode({
      mode: "apply",
      targets,
      dictionary,
      appDir: paths.appDir,
      runtimeDir,
      profileDir: paths.profileDir,
      platform: paths.platform,
      env: options.env,
      timeoutMs: paths.timeouts.harnessMs,
    });
    if (run.outcome.kind === "locked")
      throw new HookError(
        "LOCKED",
        "the profile singleton lock is held by another process; OpenWhispr is likely running — quit it and run apply again",
      );
    if (run.outcome.kind === "error")
      throw new HookError(
        "APPLY_FAILED",
        `config registration harness failed: ${run.outcome.stdout}`,
      );
    const payload = run.outcome.payload;
    if (payload.status === "restore-failed") {
      await writeRecoveryRecord(paths.profileDir, {
        phase: "apply",
        keys: Object.entries(payload.before ?? {}).map(([key, previousValue]) => ({
          key,
          previousValue,
          previousSha256: previousValue === null ? null : sha256Hex(previousValue),
        })),
        keysSha256,
      });
    }
    if (payload.status !== "applied" && payload.status !== "unchanged")
      throw new HookError("APPLY_FAILED", payload.detail ?? "config registration failed");
    try {
      await clearRecoveryRecord(paths.profileDir);
    } catch (error) {
      console.error("recovery record cleanup failed:", error);
    }
    return { status: payload.status, code: "OK", keysSha256, detail: payload.detail };
  } catch (error) {
    const hookError =
      error instanceof HookError ? error : new HookError("APPLY_FAILED", String(error));
    return {
      status: "error",
      code: hookError.code,
      keysSha256,
      detail: hookError.message,
    };
  } finally {
    try {
      await releaseHookLock?.();
    } catch (error) {
      console.error("hook lock cleanup failed:", error);
    }
  }
}

async function main(): Promise<void> {
  const platform: PlatformName | null =
    process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : null;
  if (!platform) {
    const unsupported: RegistrationOutcome = {
      status: "error",
      code: "INVALID_INPUT",
      keysSha256: null,
      detail: `unsupported platform: ${process.platform}`,
    };
    console.log(formatStatusLine(unsupported));
    process.exit(exitCodeByError.INVALID_INPUT);
  }
  const outcome = await manageConfig({ platform, env: process.env });
  if (outcome.detail && outcome.status !== "error") console.log(outcome.detail);
  console.log(formatStatusLine(outcome));
  if (outcome.detail && outcome.status === "error") console.error(outcome.detail);
  if (outcome.status === "error") process.exit(exitCodeByError[outcome.code as HookErrorCode]);
}

if (import.meta.main) await main();
