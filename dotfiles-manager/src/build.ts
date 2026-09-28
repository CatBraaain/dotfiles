// Build stage of the dotfiles manager (spec: SPEC.md
// §ライフサイクル): regenerates dist from dotfiles/ — local hooks
// (including the standard path-map and external fetch hooks), merge
// composition, replace sidecars.
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { composeMergeTargets } from "./build-merge.ts";
import { applyReplaceSidecars } from "./build-replace.ts";
import { collectHooks, runHooks, type HookEvent } from "./build-hooks.ts";

export type Platform = "windows" | "linux" | "darwin";

export async function main(
  root = process.cwd(),
  platform: Platform = currentPlatform(),
  homeRoot = homedir(),
  onHookEvent?: HookEvent,
): Promise<void> {
  assertPlatform(platform);
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  await rm(distDir, { recursive: true, force: true });
  await copyDir(sourceDir, distDir);
  // Capture hooks once so earlier hooks cannot remove later scripts from the event queue.
  await runHooks(await collectHooks(distDir), distDir, homeRoot, onHookEvent);
  await composeMergeTargets(distDir, homeRoot);
  await applyReplaceSidecars(distDir, homeRoot);
}

async function copyDir(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".ignore")) continue;

    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) await copyDir(sourcePath, destinationPath);
    else await cp(sourcePath, destinationPath);
  }
}

const platformNames = ["windows", "linux", "darwin"] as const;

function currentPlatform(): Platform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function assertPlatform(platform: string): asserts platform is Platform {
  if (!platformNames.includes(platform as Platform))
    throw new Error(`Unsupported platform: ${platform}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
