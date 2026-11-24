// Shared context for build and apply hooks run as standalone bun processes
// (spec: SPEC.md §フックシステム). Resolves the manager-injected environment
// into the path and mirror helpers hooks share with the engine.
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolvePaths } from "./home-path.ts";

type HookContext = {
  distDir: string;
  resolvePaths(path: string): { distPath: string; homePath: string };
  syncGithubMirror(repo: string): Promise<string>;
  transform(path: string, edit: (content: string) => string | Promise<string>): Promise<void>;
  merge(path: string, patch: Record<string, unknown>): Promise<void>;
};

// Reads the dist-side file resolved from path, passes its content to edit,
// and writes the returned content back. Missing files are skipped so hooks
// like minifiers stay silent on platforms where the target does not exist.
// Both the passed content and the written content keep exactly one trailing
// newline, so hooks never deal with newline bookkeeping.
async function transformFile(
  path: string,
  edit: (content: string) => string | Promise<string>,
  resolvePath: (path: string) => { distPath: string; homePath: string },
): Promise<void> {
  const { distPath } = resolvePath(path);
  let content: string;
  try {
    content = withSingleTrailingNewline(await readFile(distPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  await writeFile(distPath, withSingleTrailingNewline(await edit(content)));
}

function withSingleTrailingNewline(content: string): string {
  return content === "" || content.endsWith("\n") ? content : `${content}\n`;
}

async function mergeHookFile(
  path: string,
  patch: Record<string, unknown>,
  hookDir: string,
  distPath: string,
): Promise<void> {
  function assertInsideHookDir(root: string, directory: string): void {
    const fromHook = relative(root, directory);
    if (fromHook === ".." || fromHook.startsWith(`..${sep}`) || isAbsolute(fromHook)) {
      throw new Error(`merge target is outside the hook directory: ${path}`);
    }
  }

  const parent = dirname(distPath);
  assertInsideHookDir(hookDir, parent);
  assertInsideHookDir(await realpath(hookDir), await realpath(parent));
  const { mergeFile } = await import("./build-merge.ts");
  await mergeFile(distPath, patch);
}

function hookEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`hook environment variable is not set: ${name}`);
  return value;
}

declare global {
  function loadHookContext(): Promise<HookContext>;
}

async function createHookContext(): Promise<HookContext> {
  const distDir = resolve(hookEnv("DOTFILES_DIST_DIR"));
  const homeRoot = resolve(hookEnv("DOTFILES_HOME_ROOT"));
  return {
    distDir,
    resolvePaths: (path: string) => resolvePaths(process.cwd(), distDir, homeRoot, path),
    syncGithubMirror: (repo: string) =>
      import(resolve(hookEnv("DOTFILES_MANAGER_SRC"), "build-external.ts")).then((external) =>
        external.syncGithubMirror(repo),
      ),
    transform: (path, edit) =>
      transformFile(path, edit, (target) => resolvePaths(process.cwd(), distDir, homeRoot, target)),
    merge: (path, patch) => {
      const hookDir = process.cwd();
      const { distPath } = resolvePaths(hookDir, distDir, homeRoot, path);
      return mergeHookFile(path, patch, hookDir, distPath);
    },
  };
}

globalThis.loadHookContext = createHookContext;
