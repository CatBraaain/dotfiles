import { $ } from "bun";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { readdir, stat } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

declare const process: { cwd(): string };

type FileEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};
type FileStat = { mtimeMs: number; isDirectory(): boolean; isFile(): boolean };

async function main(): Promise<void> {
  const pluginsDirectory = process.cwd();
  const pluginDirectories = (await readdir(pluginsDirectory, { withFileTypes: true }))
    .filter((entry: FileEntry) => entry.isDirectory())
    .map((entry: FileEntry) => entry.name)
    .sort();

  for (const name of pluginDirectories) {
    const pluginDirectory = join(pluginsDirectory, name);
    if (existsSync(join(pluginDirectory, "package.json"))) {
      const stamp = join(pluginDirectory, "node_modules/.bun-install-stamp");
      if (await needsInstall(pluginDirectory, stamp)) {
        await $`bun install --silent`.cwd(pluginDirectory);
        await $`touch ${stamp}`.cwd(pluginDirectory);
      }
    }

    const sourceEntry = join(pluginDirectory, "src/index.ts");
    if (!existsSync(sourceEntry)) continue;

    const output = join(pluginDirectory, "dist/index.js");
    if (!(await needsBuild(pluginDirectory, output))) continue;

    const entries = ["src/index.ts"];
    if (existsSync(join(pluginDirectory, "src/runner.ts"))) entries.push("src/runner.ts");
    await $`bun build ${entries} --outdir dist --target node \
      --external yaml --external shell-quote --external @vscode/ripgrep \
      --external zod --external '@deepseek-ai/*' --external '@earendil-works/*'`.cwd(
      pluginDirectory,
    );
  }
}

export async function needsInstall(pluginDirectory: string, stamp: string): Promise<boolean> {
  if (!existsSync(stamp)) return true;
  const stampTime = ((await stat(stamp)) as FileStat).mtimeMs;
  for (const name of ["package.json", "bun.lock", "bun.lockb"]) {
    const path = join(pluginDirectory, name);
    if (existsSync(path) && ((await stat(path)) as FileStat).mtimeMs > stampTime) return true;
  }
  return false;
}

export async function needsBuild(pluginDirectory: string, output: string): Promise<boolean> {
  if (!existsSync(output)) return true;
  const outputTime = ((await stat(output)) as FileStat).mtimeMs;
  const sourceFiles = (await filesIn(join(pluginDirectory, "src"), false)).filter(
    (path) => !path.endsWith(".test.ts"),
  );
  for (const path of sourceFiles) {
    if (((await stat(path)) as FileStat).mtimeMs > outputTime) return true;
  }
  return false;
}

async function filesIn(directory: string, followSymbolicLinks: boolean): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, {
    withFileTypes: true,
  })) as unknown as FileEntry[]) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesIn(path, followSymbolicLinks)));
    } else if (entry.isFile()) {
      files.push(path);
    } else if (followSymbolicLinks && entry.isSymbolicLink()) {
      const target = (await stat(path)) as FileStat;
      if (target.isDirectory()) files.push(...(await filesIn(path, true)));
      else if (target.isFile()) files.push(path);
    }
  }
  return files;
}

if (import.meta.main) await main();
