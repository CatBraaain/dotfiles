// Child-process runner for local build hooks (spec: SPEC.md §build: ローカルフック).
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { dirname } from "node:path";
import { resolvePaths } from "./home-path.ts";

declare const process: { argv: string[] };

const [hookPath, distDir, homeRoot] = process.argv.slice(2) as [string, string, string];
// @ts-ignore The hook path is resolved at runtime.
const hook = await import(hookPath);
await hook.default({
  resolvePaths: (path: string) => resolvePaths(dirname(hookPath), distDir, homeRoot, path),
});
