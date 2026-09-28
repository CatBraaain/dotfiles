// Shared hook execution helpers for build and apply hooks: command
// resolution for child processes and snapshot file management.
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function resolveHookCommand(
  source: string,
  displayPath: string,
  hookType: "build" | "apply",
  cwdOverride?: string,
): string[] {
  if (!displayPath.endsWith(".ts")) {
    throw new Error(`${hookType} hook has unsupported extension: ${displayPath}`);
  }
  const executableSource = source.replace(/^#![^\r\n]*/, "");
  const body = cwdOverride
    ? `process.chdir(${JSON.stringify(cwdOverride)});${executableSource}`
    : executableSource;
  return [process.execPath, "-e", body];
}

export async function ensureHookDirectory(directory: string, rootDir: string): Promise<string[]> {
  const createdDirectories: string[] = [];
  for (
    let current = directory;
    current !== rootDir && !existsSync(current);
    current = dirname(current)
  )
    createdDirectories.push(current);
  await mkdir(directory, { recursive: true });
  return createdDirectories;
}

export async function writeHookSnapshot(
  directory: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const snapshotPath = join(directory, `.hook-${randomUUID()}-${fileName}`);
  await writeFile(snapshotPath, contents, { flag: "wx" });
  return snapshotPath;
}

export async function removeHookSnapshot(snapshotPath: string, rootDir: string): Promise<void> {
  if (existsSync(snapshotPath)) {
    await rm(snapshotPath, { force: true });
    return;
  }

  const snapshotName = basename(snapshotPath);
  async function walk(directory: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await walk(entryPath)) return true;
      } else if (entry.isFile() && entry.name === snapshotName) {
        await rm(entryPath, { force: true });
        return true;
      }
    }
    return false;
  }
  await walk(rootDir);
}

export async function removeEmptyHookDirectories(directories: string[]): Promise<void> {
  for (const directory of directories) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
  }
}
