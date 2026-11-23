import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { isAlias, isMap, isScalar, parseDocument } from "yaml";
import { lstatOrNull } from "./compare.ts";
import { mapSegment, type Platform } from "./path-mapping.ts";

const LINK_NAME_SUFFIX = ".lnk";
const LINK_CLSID = Buffer.from("0114020000000000c000000000000046", "hex");
const LINK_HEADER_SIZE = 0x4c;
const LINK_CLSID_OFFSET = 4;
const LINK_TIMES_START = 0x1c;
const LINK_TIMES_END = 0x34;
const TEXT_RUN_PATTERN = /(?:[\x20-\x7e]\x00){4,}/g;
const WINDOW_STYLE = { normal: 1, minimized: 7 } as const;
const WINDOWS_POWERSHELL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CREATE_SHORTCUT_SCRIPT = Buffer.from(
  String.raw`
$ErrorActionPreference = 'Stop'
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$shortcut = ConvertFrom-Json -InputObject ($reader.ReadToEnd())
$target = $shortcut.target
if ($target -ceq 'powershell') {
  $pwsh = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh) { $target = $pwsh.Source }
  else { $target = Join-Path $env:SystemRoot '${WINDOWS_POWERSHELL}' }
}
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut.path)
$link.TargetPath = $target
$link.Arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($shortcut.argumentsBase64))
$link.WindowStyle = $shortcut.windowStyle
$link.Save()
`,
  "utf16le",
).toString("base64");

type ManagedEntry = { distRelPath: string; homeRelPath: string; isLink: boolean };
type LnkDeclaration = { target: string; arguments: string; windowStyle: keyof typeof WINDOW_STYLE };

export async function convertLnkDeclarations(
  distDir: string,
  platform: Platform,
): Promise<Set<string>> {
  const distRoot = await resolveDistRoot(distDir);
  const entries = await collectManagedEntries(distRoot);
  const generatedLinks = new Set<string>();
  const entriesByHomePath =
    platform === "windows" ? Map.groupBy(entries, windowsHomeKey) : undefined;

  for (const entry of entries) {
    if (!entry.isLink) continue;
    const { distRelPath } = entry;
    try {
      const distPath = await checkedDistLinkPath(distRoot, distRelPath);
      const bytes = await readFile(distPath);
      if (isShellLink(bytes)) continue;
      if (platform !== "windows") {
        await unlink(distPath);
        continue;
      }

      const conflictingEntry = entriesByHomePath
        ?.get(windowsHomeKey(entry))
        ?.find((other) => other !== entry);
      if (conflictingEntry) {
        throw new Error(
          `home path collision with ${conflictingEntry.distRelPath}: ${entry.homeRelPath}`,
        );
      }

      const declaration = parseDeclaration(bytes);
      if (process.platform !== "win32")
        throw new Error("a Windows host is required to generate a shortcut");
      await replaceDistLink(distRoot, distRelPath, (temporaryPath) =>
        createShortcut(temporaryPath, declaration),
      );
      generatedLinks.add(distRelPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`lnk ${distRelPath}: ${reason}`, { cause: error });
    }
  }
  return generatedLinks;
}

export async function adoptHomeLnkBytes(
  distDir: string,
  homeRoot: string,
  generatedLinks: ReadonlySet<string>,
): Promise<void> {
  const distRoot = await resolveDistRoot(distDir);
  const entries = await collectManagedEntries(distRoot);
  for (const entry of entries) {
    if (!entry.isLink) continue;
    const { distRelPath, homeRelPath } = entry;
    const homePath = await findHomeLinkPath(homeRoot, homeRelPath);
    if (homePath === null) continue;
    const distPath = await checkedDistLinkPath(distRoot, distRelPath);
    const [distBytes, homeBytes] = await Promise.all([readFile(distPath), readFile(homePath)]);
    if (distBytes.equals(homeBytes)) continue;
    const canAdopt = generatedLinks.has(distRelPath)
      ? matchesExceptLinkTimes(distBytes, homeBytes)
      : matchesLinkText(distBytes, homeBytes);
    if (!canAdopt) continue;
    await replaceDistLink(distRoot, distRelPath, (temporaryPath) =>
      writeFile(temporaryPath, homeBytes, { flag: "wx" }),
    );
  }
}

async function collectManagedEntries(
  directory: string,
  distPrefix = "",
  homePrefix = "",
  entries: ManagedEntry[] = [],
): Promise<ManagedEntry[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const mapping = mapSegment(entry.name, entry.isDirectory());
    if (mapping.isExcluded) continue;
    const distRelPath = `${distPrefix}${entry.name}`;
    const homeRelPath = `${homePrefix}${mapping.homeName}`;
    const isLink = entry.isFile() && entry.name.toLowerCase().endsWith(LINK_NAME_SUFFIX);
    entries.push({ distRelPath, homeRelPath, isLink });
    if (entry.isDirectory()) {
      await collectManagedEntries(
        join(directory, entry.name),
        `${distRelPath}/`,
        `${homeRelPath}/`,
        entries,
      );
    }
  }
  return entries;
}

function windowsHomeKey(entry: ManagedEntry): string {
  return win32
    .normalize(entry.homeRelPath)
    .split("\\")
    .map((segment) => foldWindowsPathCase(stripWindowsTrailingDotsAndSpaces(segment)))
    .join("\\");
}

function foldWindowsPathCase(segment: string): string {
  return segment
    .split("")
    .map((unit) => {
      const uppercase = unit.toUpperCase();
      return uppercase.length === 1 ? uppercase : unit;
    })
    .join("");
}

function stripWindowsTrailingDotsAndSpaces(segment: string): string {
  return segment.replace(/[. ]+$/, "");
}

async function findHomeLinkPath(homeRoot: string, homeRelPath: string): Promise<string | null> {
  const segments = homeRelPath.split("/");
  if (
    segments.some((segment) => !stripWindowsTrailingDotsAndSpaces(segment) || /[\\:]/.test(segment))
  ) {
    return null;
  }
  const fileName = segments.pop();
  if (fileName === undefined) return null;

  let directory = homeRoot;
  for (const segment of segments) {
    directory = join(directory, segment);
    if (!(await lstatOrNull(directory))?.isDirectory()) return null;
  }
  const filePath = join(directory, fileName);
  return (await lstatOrNull(filePath))?.isFile() ? filePath : null;
}

function isShellLink(bytes: Buffer): boolean {
  const clsidEnd = LINK_CLSID_OFFSET + LINK_CLSID.length;
  return (
    bytes.length >= clsidEnd &&
    bytes.readUInt32LE(0) === LINK_HEADER_SIZE &&
    bytes.subarray(LINK_CLSID_OFFSET, clsidEnd).equals(LINK_CLSID)
  );
}

function matchesExceptLinkTimes(distBytes: Buffer, homeBytes: Buffer): boolean {
  return (
    homeBytes.length === distBytes.length &&
    isShellLink(homeBytes) &&
    distBytes.subarray(0, LINK_TIMES_START).equals(homeBytes.subarray(0, LINK_TIMES_START)) &&
    distBytes.subarray(LINK_TIMES_END).equals(homeBytes.subarray(LINK_TIMES_END))
  );
}

function matchesLinkText(distBytes: Buffer, homeBytes: Buffer): boolean {
  const distText = lnkText(distBytes);
  return distText !== "" && distText === lnkText(homeBytes);
}

export function lnkText(bytes: Uint8Array): string {
  const latin = new TextDecoder("latin1").decode(bytes);
  const runs = latin.match(TEXT_RUN_PATTERN);
  if (!runs) return "";
  return runs
    .map((run) =>
      new TextDecoder("utf-16le").decode(Uint8Array.from(run, (char) => char.charCodeAt(0))),
    )
    .join("\n");
}

function parseDeclaration(bytes: Buffer): LnkDeclaration {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document = parseDocument(source, { merge: false });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  if (!isMap(document.contents)) throw new Error("expected a YAML mapping");

  const fields = new Map<string, unknown>();
  for (const pair of document.contents.items) {
    const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
    const name = isScalar(key) ? key.value : undefined;
    if (name !== "target" && name !== "arguments" && name !== "windowStyle") {
      throw new Error(`unknown shortcut key: ${String(name)}`);
    }
    if (fields.has(name)) throw new Error(`duplicate shortcut key: ${name}`);
    const node = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
    if (!isScalar(node)) throw new Error(`${name} must be a scalar`);
    fields.set(name, node.value);
  }

  const target = fields.get("target");
  const args = fields.has("arguments") ? fields.get("arguments") : "";
  const windowStyle = fields.has("windowStyle") ? fields.get("windowStyle") : "normal";
  if (typeof target !== "string" || !isShortcutTarget(target)) {
    throw new Error("target must be a Windows absolute path or the powershell preset");
  }
  if (typeof args !== "string" || args.includes("\0")) {
    throw new Error("arguments must be a string without NUL characters");
  }
  if (windowStyle !== "normal" && windowStyle !== "minimized") {
    throw new Error("windowStyle must be normal or minimized");
  }
  return { target, arguments: args, windowStyle };
}

function isShortcutTarget(target: string): boolean {
  if (target === "powershell") return true;
  if (target.includes("\0")) return false;
  const { root } = win32.parse(target);
  if (/^[a-z]:[\\/]$/i.test(root)) return true;
  const uncShare = /^[\\/]{2}([^\\/?]+)[\\/][^\\/]+[\\/]?$/.exec(root);
  return uncShare !== null && uncShare[1] !== ".";
}

async function createShortcut(path: string, declaration: LnkDeclaration): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw new Error("SystemRoot is not an absolute path");
  const result = spawnSync(
    join(systemRoot, WINDOWS_POWERSHELL),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", CREATE_SHORTCUT_SCRIPT],
    {
      input: JSON.stringify({
        path,
        target: declaration.target,
        argumentsBase64: Buffer.from(declaration.arguments, "utf8").toString("base64"),
        windowStyle: WINDOW_STYLE[declaration.windowStyle],
      }),
      windowsHide: true,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const status = result.signal ?? result.status;
    const details = result.stderr.trim();
    throw new Error(`powershell.exe failed (${status})${details ? `: ${details}` : ""}`);
  }
  const bytes = await readFile(path);
  if (bytes.length < LINK_HEADER_SIZE || !isShellLink(bytes)) {
    throw new Error("powershell.exe did not create a binary shortcut");
  }
}

async function resolveDistRoot(distDir: string): Promise<string> {
  const absoluteDir = resolve(distDir);
  if (!(await lstat(absoluteDir)).isDirectory())
    throw new Error(`dist is not a directory: ${distDir}`);
  return realpath(absoluteDir);
}

async function checkedDistLinkPath(distRoot: string, distRelPath: string): Promise<string> {
  const distPath = join(distRoot, distRelPath);
  const parent = await realpath(dirname(distPath));
  const parentFromRoot = relative(distRoot, parent);
  const insideDist =
    !isAbsolute(parentFromRoot) &&
    parentFromRoot !== ".." &&
    !parentFromRoot.startsWith(`..${sep}`);
  if (!insideDist || !(await lstat(distPath)).isFile()) {
    throw new Error("expected a regular file inside dist");
  }
  return distPath;
}

async function replaceDistLink(
  distRoot: string,
  distRelPath: string,
  prepare: (temporaryPath: string) => Promise<void>,
): Promise<void> {
  const distPath = await checkedDistLinkPath(distRoot, distRelPath);
  const temporaryPath = join(dirname(distPath), `.build-${randomUUID()}.lnk`);
  if (await lstatOrNull(temporaryPath)) throw new Error("temporary shortcut path already exists");
  try {
    await prepare(temporaryPath);
    await rename(temporaryPath, distPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
