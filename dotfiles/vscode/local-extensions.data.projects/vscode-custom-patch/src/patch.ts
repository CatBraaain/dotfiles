// Marker format, backup naming, and CSP removal follow the layout that
// previous be5invis/vscode-custom-css patches used, so installs patched by
// the Loader migrate without a manual reset.
// https://github.com/be5invis/vscode-custom-css
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  ensureWorkbenchBundle,
  isWorkbenchWriteUnavailable,
  replaceWorkbenchFile,
} from "./workbench-bundle.ts";

export type PluginEntry = { name: string; content: string };
export type ReadFile = (filePath: string) => string;
export type EnsureMode = "ensure" | "remove";
export type EnsureResult =
  | "patched"
  | "unpatched"
  | "fresh"
  | "no-workbench"
  | "unwritable"
  | "backup-missing"
  | "bundle-unwritable"
  | "bundle-invalid";

const SESSION_ID_PATTERN = /<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ([0-9a-fA-F-]+) !! -->/;
const PATCH_SEGMENT_PATTERN =
  /<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n([\s\S]*?)<!-- !! VSCODE-CUSTOM-CSS-END !! -->/;
const CSP_META_PATTERN = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/;
const BACKUP_SUFFIX = ".bak-custom-css";
const WORKBENCH_DIR_CANDIDATES = [
  join("vs", "code", "electron-browser", "workbench"),
  join("vs", "code", "electron-browser"),
  join("vs", "code", "electron-sandbox", "workbench"),
  join("vs", "code", "electron-sandbox"),
];
const HTML_FILE_CANDIDATES = ["workbench-dev.html", "workbench.esm.html", "workbench.html"];

// Reads the plugins folder. Returns null when the folder is missing or
// unreadable; the caller treats that as "no plugins".
export function pluginEntries(
  pluginsDir: string,
  readFile: ReadFile = (filePath) => readFileSync(filePath, "utf-8"),
): PluginEntry[] | null {
  let names: string[];
  try {
    names = readdirSync(pluginsDir)
      .filter((name) => extname(name) === ".js" || extname(name) === ".css")
      .sort();
  } catch {
    return null;
  }
  return names.map((name) => ({ name, content: readFile(join(pluginsDir, name)) }));
}

export function segmentFromPlugins(entries: PluginEntry[]): string {
  return entries
    .map((entry) =>
      extname(entry.name) === ".css"
        ? `<style>${entry.content}</style>`
        : `<script>${entry.content}</script>`,
    )
    .join("");
}

export function installRoots(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && localAppData !== undefined) {
    return [join(localAppData, "Programs", "Microsoft VS Code")];
  }
  return ["/usr/share/code", "/usr/share/code-insiders", "/snap/code/current/usr/share/code"];
}

// The active extension host runs inside the VS Code installation that must be
// patched. Layouts covered here:
//   <install>/Code.exe + <install>/resources/app/out/...
//   <install>/Code.exe + <install>/<commit>/resources/app/out/...  (self-update)
//   <install>/<commit>/Code.exe + <install>/<commit>/out/...
// extraRoots are scanned one child level deep so apply-time and CLI runs
// without an execPath also reach the self-update commit layout.
export function workbenchSearchDirs({
  execPath,
  mainFilename,
  extraRoots,
}: {
  execPath?: string;
  mainFilename?: string;
  extraRoots?: string[];
} = {}): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  let dir = execPath ? dirname(execPath) : null;
  for (let depth = 0; dir && depth < 3; depth += 1) {
    pushAppOutBases(dirs, seen, dir);
    for (const child of listDirectories(dir)) pushAppOutBases(dirs, seen, child);
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }

  if (mainFilename) {
    pushAppOutBases(dirs, seen, dirname(mainFilename));
    pushAppOutBases(dirs, seen, dirname(dirname(mainFilename)));
  }

  for (const root of extraRoots ?? []) {
    pushAppOutBases(dirs, seen, root);
    for (const child of listDirectories(root)) pushAppOutBases(dirs, seen, child);
  }

  return dirs;
}

export function findWorkbenchHtml(searchDirs: string[]): string | null {
  return findWorkbench(searchDirs)?.htmlPath ?? null;
}

function findWorkbench(searchDirs: string[]): { appOut: string; htmlPath: string } | null {
  for (const appOut of searchDirs) {
    for (const workbench of WORKBENCH_DIR_CANDIDATES) {
      for (const html of HTML_FILE_CANDIDATES) {
        const htmlPath = join(appOut, workbench, html);
        if (existsSync(htmlPath)) return { appOut, htmlPath };
      }
    }
  }
  return null;
}

export function hasPatchMarker(html: string): boolean {
  return SESSION_ID_PATTERN.test(html);
}

export function extractPatchSegment(html: string): string | null {
  return html.match(PATCH_SEGMENT_PATTERN)?.[1] ?? null;
}

// Makes the workbench patch match the plugins folder: bakes missing or stale
// scripts, and removes the patch when the folder holds no plugins. Throws on
// plugin read errors so callers can report them.
export function ensurePatched(
  options: {
    searchDirs: string[];
    mode?: EnsureMode;
    scmSelectionSource?: string;
    sortExplorer?: boolean;
  } & ({ pluginsDir: string } | { plugins: PluginEntry[] }),
): EnsureResult {
  const { searchDirs, mode = "ensure" } = options;
  const entries =
    mode === "remove"
      ? []
      : "plugins" in options
        ? options.plugins
        : (pluginEntries(options.pluginsDir) ?? []);
  const workbench = findWorkbench(searchDirs);
  if (!workbench) return "no-workbench";
  const htmlResult = ensureHtmlPatched(workbench.htmlPath, entries);
  if (htmlResult === "unwritable" || htmlResult === "backup-missing") return htmlResult;

  const bundleResult = ensureWorkbenchBundle(
    workbench.appOut,
    mode === "ensure" ? options : undefined,
  );
  return bundleResult === "fresh" ? htmlResult : bundleResult;
}

function ensureHtmlPatched(htmlPath: string, entries: PluginEntry[]): EnsureResult {
  const workbenchDir = dirname(htmlPath);
  const currentHtml = readFileSync(htmlPath, "utf-8");
  const segment = segmentFromPlugins(entries);
  if (extractPatchSegment(currentHtml) === segment) return "fresh";
  if (entries.length === 0 && !hasPatchMarker(currentHtml)) return "fresh";
  if (!isWritable(htmlPath) || !isWritable(workbenchDir)) return "unwritable";

  try {
    const target = realpathSync(htmlPath);
    const originalHtml = readOriginalFromBackup(currentHtml, workbenchDir);
    if (entries.length === 0) {
      if (originalHtml === currentHtml) return "backup-missing";
      replaceWorkbenchFile(target, originalHtml, statSync(target).mode);
      removeHtmlBackups(workbenchDir);
      return "unpatched";
    }

    const clearedHtml = clearExistingPatchMarkers(originalHtml);
    const sessionUuid = randomUUID();
    const nextBackup = backupPath(workbenchDir, sessionUuid);
    writeFileSync(nextBackup, clearedHtml);
    replaceWorkbenchFile(
      target,
      insertPatchSegment(removeContentSecurityPolicy(clearedHtml), segment, sessionUuid),
      statSync(target).mode,
    );
    removeHtmlBackups(workbenchDir, nextBackup);
    return "patched";
  } catch (error) {
    if (isWorkbenchWriteUnavailable(error)) return "unwritable";
    throw error;
  }
}

export function clearExistingPatchMarkers(html: string): string {
  let cleared = html.replace(
    /<!-- !! VSCODE-CUSTOM-CSS-START !! -->[\s\S]*?<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n*/,
    "",
  );
  cleared = cleared.replace(/<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID [\w-]+ !! -->\n*/g, "");
  cleared = cleared.replace(
    /<script>\/\* eslint-env browser \*\/[\s\S]*?__CUSTOM_CSS_JS_INDICATOR_CLS[\s\S]*?<\/script>\n*/g,
    "",
  );
  return cleared;
}

export function removeContentSecurityPolicy(html: string): string {
  return html.replace(CSP_META_PATTERN, "");
}

export function insertPatchSegment(html: string, segment: string, sessionUuid: string): string {
  return html.replace(
    /(<\/head>)/,
    `<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ${sessionUuid} !! -->\n` +
      "<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n" +
      segment +
      "<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n</head>",
  );
}

export function backupPath(workbenchDir: string, sessionUuid: string): string {
  return join(workbenchDir, `workbench.${sessionUuid}${BACKUP_SUFFIX}`);
}

export function readOriginalFromBackup(html: string, workbenchDir: string): string {
  const sessionId = SESSION_ID_PATTERN.exec(html)?.[1];
  const backup = sessionId !== undefined ? backupPath(workbenchDir, sessionId) : undefined;
  return backup !== undefined && existsSync(backup) ? readFileSync(backup, "utf-8") : html;
}

function removeHtmlBackups(workbenchDir: string, keep?: string): void {
  for (const item of readdirSync(workbenchDir)) {
    const path = join(workbenchDir, item);
    if (item.endsWith(BACKUP_SUFFIX) && path !== keep) rmSync(path);
  }
}

function pushAppOutBases(dirs: string[], seen: Set<string>, root: string): void {
  for (const base of [join(root, "out"), join(root, "resources", "app", "out")]) {
    if (seen.has(base)) continue;
    seen.add(base);
    dirs.push(base);
  }
}

function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
