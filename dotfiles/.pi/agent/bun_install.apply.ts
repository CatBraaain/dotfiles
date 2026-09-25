import { $ } from "bun";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync, statSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

declare const process: { cwd(): string };

type FileStat = { mtimeMs: number };

export function needsInstall(directory: string): boolean {
  const stamp = join(directory, "node_modules/.bun-install-stamp");
  if (!existsSync(stamp)) return true;

  const stampTime = (statSync(stamp) as FileStat).mtimeMs;
  return ["package.json", "bun.lock", "bun.lockb"].some((name) => {
    const path = join(directory, name);
    return existsSync(path) && (statSync(path) as FileStat).mtimeMs > stampTime;
  });
}

async function main(): Promise<void> {
  const directory = process.cwd();
  if (!needsInstall(directory)) return;

  await $`bun install --silent`;
  await $`touch node_modules/.bun-install-stamp`;
}

if (import.meta.main) await main();
