// Build stage of the dotfiles manager (spec: SPEC.md
// §ライフサイクル): regenerates dist from dotfiles/ — local hooks,
// path maps, externals, merge composition, replace sidecars.
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyPathMap, createCopyRouter, type CopyRouter } from "./build-path-map.ts";
import { applyExternals } from "./build-external.ts";
import { composeMergeTargets } from "./build-merge.ts";
import { applyReplaceSidecars } from "./build-replace.ts";
import { collectHooks, runHooks, type HookEvent } from "./build-hooks.ts";

export type Platform = "windows" | "linux" | "darwin";

export type BuildPhase = "rebuild dist" | "path map" | "externals" | "merge" | "replace";
export type PhaseEvent = (phase: BuildPhase, elapsedSeconds: number) => void;

export async function main(
  root = process.cwd(),
  platform: Platform = currentPlatform(),
  homeRoot = homedir(),
  onHookEvent?: HookEvent,
  onPhase?: PhaseEvent,
): Promise<void> {
  assertPlatform(platform);
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  await timed("rebuild dist", onPhase, async () => {
    await rm(distDir, { recursive: true, force: true });
    await copyDir(sourceDir, distDir, await createCopyRouter(platform));
  });
  // Capture hooks once so earlier hooks cannot remove later scripts from the event queue.
  await runHooks(await collectHooks(distDir), distDir, homeRoot, onHookEvent);
  await timed("path map", onPhase, () => applyPathMap(distDir, platform));
  await timed("externals", onPhase, () => applyExternals(distDir));
  await timed("merge", onPhase, () => composeMergeTargets(distDir, homeRoot));
  await timed("replace", onPhase, () => applyReplaceSidecars(distDir, homeRoot));
}

async function copyDir(
  sourceDir: string,
  destinationDir: string,
  router: CopyRouter,
): Promise<void> {
  await router.enter(sourceDir, destinationDir);
  await mkdir(destinationDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".ignore") || (entry.isDirectory() && entry.name === "node_modules"))
      continue;

    const route = await router.route(entry.name, entry.isFile());
    if (route.kind === "skip") continue;
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath =
      route.kind === "copy-to" ? route.destination : join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      // A moved destination replaces any existing entry (spec: 置き換える).
      if (route.kind === "copy-to") await rm(destinationPath, { recursive: true, force: true });
      await copyDir(sourcePath, destinationPath, router);
    } else {
      if (route.kind === "copy-to") await mkdir(dirname(destinationPath), { recursive: true });
      await cp(sourcePath, destinationPath);
    }
  }
  router.exit();
}

async function timed(
  phase: BuildPhase,
  onPhase: PhaseEvent | undefined,
  action: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  await action();
  onPhase?.(phase, (performance.now() - started) / 1000);
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
