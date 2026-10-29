import { writeSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTEXT_FILES = new Set([
  "agents.override.md",
  "agents.md",
  "skill.md",
  "claude.md",
  "system.md",
  "append_system.md",
]);
const CONTEXT_DIRECTORIES = new Set([
  ".pi",
  ".agents",
  ".claude",
  ".cursor",
  ".codex",
  ".gemini",
  ".opencode",
]);
const ERROR_EXIT_CODE = 1;

type DownloadsLocation = {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export default function downloadsGuard(
  pi: ExtensionAPI,
  resolveRoot: () => Promise<string> = resolveDownloadsRoot,
): void {
  pi.on("session_start", async (_event, ctx) => {
    const downloadsRoot = await resolveRoot();
    const directories = await downloadsAncestors(ctx.cwd, downloadsRoot);
    if (directories.length === 0) return;

    const warning = `Downloads guard: cwd ${JSON.stringify(ctx.cwd)} is inside Downloads ${JSON.stringify(downloadsRoot)}.`;
    if (ctx.mode === "tui") {
      ctx.ui.notify(warning, "warning");
    } else {
      writeSync(2, `${warning}\n`);
    }

    try {
      const detectedPaths = await findContextPaths(directories);
      if (detectedPaths.length === 0) return;
      await stopWithError(
        ctx,
        `Downloads guard: refusing cwd ${JSON.stringify(ctx.cwd)}; agent context found: ${detectedPaths.map((entry) => JSON.stringify(entry)).join(", ")}.`,
      );
    } catch (error) {
      await stopWithError(
        ctx,
        `Downloads guard: refusing cwd ${JSON.stringify(ctx.cwd)}; cannot inspect Downloads ancestors: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  });
}

export async function resolveDownloadsRoot({
  home = homedir(),
  platform = process.platform,
  env = process.env,
}: DownloadsLocation = {}): Promise<string> {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const defaultRoot = paths.join(home, "Downloads");
  if (platform !== "linux") return defaultRoot;

  const configHome = env.XDG_CONFIG_HOME;
  const configDirectory =
    configHome && paths.isAbsolute(configHome) ? configHome : paths.join(home, ".config");
  let configuration: string;
  try {
    configuration = await readFile(paths.join(configDirectory, "user-dirs.dirs"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error) return defaultRoot;
    throw error;
  }
  const setting = configuration.match(/^\s*XDG_DOWNLOAD_DIR="((?:\\.|[^"\\])*)"\s*(?:#.*)?$/m)?.[1];
  if (!setting) return defaultRoot;

  const expandedHome = setting.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, () => home);
  if (/(?<!\\)[`$]/.test(expandedHome)) return defaultRoot;
  const directory = expandedHome.replace(/\\([\\$`"])/g, "$1");
  return paths.isAbsolute(directory) ? paths.normalize(directory) : defaultRoot;
}

export function isWithinDirectory(
  root: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(paths.resolve(root), paths.resolve(cwd));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
}

export async function downloadsAncestors(cwd: string, downloadsRoot: string): Promise<string[]> {
  const lexicalRoot = path.resolve(downloadsRoot);
  const lexicalCwd = path.resolve(cwd);
  const [canonicalRoot, canonicalCwd] = await Promise.all([
    realpathOrOriginal(lexicalRoot),
    realpathOrOriginal(lexicalCwd),
  ]);
  const directories = [
    ...ancestorDirectories(lexicalRoot, lexicalCwd),
    ...ancestorDirectories(canonicalRoot, canonicalCwd),
  ];
  return [...new Set(directories)];
}

export function ancestorDirectories(
  root: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!isWithinDirectory(root, cwd, platform)) return [];
  const paths = platform === "win32" ? path.win32 : path.posix;
  const ancestors = [paths.resolve(cwd)];
  while (paths.relative(root, ancestors[ancestors.length - 1]!) !== "") {
    ancestors.push(paths.dirname(ancestors[ancestors.length - 1]!));
  }
  return ancestors.reverse();
}

export async function findContextPaths(directories: readonly string[]): Promise<string[]> {
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = entries.filter((entry) => {
      const name = entry.name.toLowerCase();
      return CONTEXT_FILES.has(name) || CONTEXT_DIRECTORIES.has(name);
    });
    const matches = await Promise.all(
      candidates.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        const metadata = entry.isSymbolicLink() ? await statOrMissing(entryPath) : entry;
        const name = entry.name.toLowerCase();
        const isContextFile = CONTEXT_FILES.has(name) && metadata?.isFile();
        const isContextDirectory = CONTEXT_DIRECTORIES.has(name) && metadata?.isDirectory();
        return isContextFile || isContextDirectory ? entryPath : undefined;
      }),
    );
    const detectedPaths = matches.filter((entry): entry is string => entry !== undefined).sort();
    if (detectedPaths.length > 0) return detectedPaths;
  }
  return [];
}

async function realpathOrOriginal(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error) return directory;
    throw error;
  }
}

async function statOrMissing(entryPath: string) {
  try {
    return await stat(entryPath);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function stopWithError(ctx: ExtensionContext, message: string): Promise<never> {
  if (ctx.mode !== "tui") {
    writeSync(2, `${message}\n`);
    process.exit(ERROR_EXIT_CODE);
  }

  // TUI shutdown fixes the exit code at zero: https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4260-L4299
  process.once("exit", () => {
    process.exitCode = ERROR_EXIT_CODE;
    writeSync(2, `${message}\n`);
  });
  ctx.shutdown();
  return new Promise<never>(() => {});
}
