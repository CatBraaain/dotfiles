// Snapshot file management for build and apply hooks run as standalone bun
// processes (spec: SPEC.md §フックシステム).
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function hookCommand(scriptPath: string): string[] {
  return [process.execPath, "--preload", join(import.meta.dir, "hook-context.ts"), scriptPath];
}

export async function forwardHookOutput(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  path: string,
): Promise<number> {
  const pending = [
    proc.exited,
    forwardLines(proc.stdout, Bun.stdout, path),
    forwardLines(proc.stderr, Bun.stderr, path),
  ] as const;
  try {
    const [exitCode] = await Promise.all(pending);
    return exitCode;
  } catch (error) {
    proc.kill();
    await Promise.allSettled(pending);
    throw error;
  }
}

async function forwardLines(
  stream: AsyncIterable<Uint8Array>,
  destination: Bun.BunFile,
  path: string,
): Promise<void> {
  const prefix = Buffer.from(`  [${path}] `);
  const newline = 10;
  let atLineStart = true;
  for await (const chunk of stream) {
    const parts: Uint8Array[] = [];
    let start = 0;
    while (start < chunk.length) {
      if (atLineStart) parts.push(prefix);
      const newlineIndex = chunk.indexOf(newline, start);
      const end = newlineIndex === -1 ? chunk.length : newlineIndex + 1;
      parts.push(chunk.subarray(start, end));
      atLineStart = newlineIndex !== -1;
      start = end;
    }
    if (parts.length > 0) await Bun.write(destination, Buffer.concat(parts));
  }
  if (!atLineStart) await Bun.write(destination, "\n");
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
