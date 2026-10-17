// Shared context for build and apply hooks run as standalone bun processes
// (spec: SPEC.md §フックシステム). Resolves the manager-injected environment
// into the path and mirror helpers hooks share with the engine.
import { resolve } from "node:path";
import { resolvePaths } from "./home-path.ts";

export type HookContext = {
  distDir: string;
  resolvePaths(path: string): { distPath: string; homePath: string };
  syncGithubMirror(repo: string): Promise<string>;
};

function hookEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`hook environment variable is not set: ${name}`);
  return value;
}

export async function buildHookContext(): Promise<HookContext> {
  const distDir = resolve(hookEnv("DOTFILES_DIST_DIR"));
  const homeRoot = resolve(hookEnv("DOTFILES_HOME_ROOT"));
  return {
    distDir,
    resolvePaths: (path: string) => resolvePaths(process.cwd(), distDir, homeRoot, path),
    syncGithubMirror: (repo: string) =>
      import(resolve(hookEnv("DOTFILES_MANAGER_SRC"), "build-external.ts")).then(
        (external) => external.syncGithubMirror(repo),
      ),
  };
}
