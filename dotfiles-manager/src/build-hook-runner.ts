// Child-process runner for local build hooks (spec: SPEC.md §build: ローカルフック).
import { dirname, resolve } from "node:path";
import { resolvePaths } from "./home-path.ts";

const [hookPath, distDir, homeRoot] = process.argv.slice(2) as [string, string, string];
// The hook path is resolved from the command line at runtime.
const hook = await import(hookPath);
await hook.default({
  resolvePaths: (path: string) => resolvePaths(dirname(hookPath), distDir, homeRoot, path),
  distDir: resolve(distDir),
});
