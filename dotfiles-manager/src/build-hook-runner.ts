// Child-process runner for local build hooks (spec: SPEC.md §build: ローカルフック).
import { dirname, resolve } from "node:path";
import { resolvePaths } from "./home-path.ts";
import { syncGithubMirror } from "./build-external.ts";
import type { WslConnection } from "./wsl.ts";

const [hookPath, distDir, homeRoot, encodedWsl] = process.argv.slice(2) as [
  string,
  string,
  string,
  string?,
];
const wsl: WslConnection | undefined = encodedWsl
  ? (JSON.parse(encodedWsl) ?? undefined)
  : undefined;
// The hook path is resolved from the command line at runtime.
const hook = await import(hookPath);
await hook.default({
  resolvePaths: (path: string) => resolvePaths(dirname(hookPath), distDir, homeRoot, path),
  distDir: resolve(distDir),
  syncGithubMirror: (repo: string) => syncGithubMirror(repo, wsl),
});
