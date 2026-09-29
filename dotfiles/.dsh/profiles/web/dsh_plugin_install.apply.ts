import { $ } from "bun";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync, statSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

declare const process: { cwd(): string };

type FileStat = { mtimeMs: number };

function needsInstall(directory: string): boolean {
  const stamp = join(directory, "node_modules/.dsh-plugin-install-stamp");
  if (!existsSync(stamp)) return true;

  const stampTime = (statSync(stamp) as FileStat).mtimeMs;
  return ["package.json", "pnpm-lock.yaml"].some((name) => {
    const path = join(directory, name);
    return existsSync(path) && (statSync(path) as FileStat).mtimeMs > stampTime;
  });
}

function needsCleanInstall(directory: string): boolean {
  const stamp = join(directory, "node_modules/.dsh-plugin-install-stamp");
  if (!existsSync(stamp)) return true;

  const stampTime = (statSync(stamp) as FileStat).mtimeMs;
  const manifest = join(directory, "package.json");
  return existsSync(manifest) && (statSync(manifest) as FileStat).mtimeMs > stampTime;
}

async function main(): Promise<void> {
  const directory = process.cwd();
  if (!needsInstall(directory)) return;

  if (needsCleanInstall(directory)) await $`rm -rf node_modules`;
  await $`dsh plugin --profile web install --ignore-scripts`;
  await $`touch node_modules/.dsh-plugin-install-stamp`;
}

if (import.meta.main) await main();
