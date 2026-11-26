// Build stage of the dotfiles manager (spec: SPEC.md
// §ライフサイクル): regenerates dist from dotfiles/ — path maps,
// externals, merge composition, replace sidecars, local hooks.
import { cp, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import type { ApplyHookLog } from "./apply-log.ts";
import { applyPathMap, createCopyRouter, type CopyRouter } from "./build-path-map.ts";
import { currentPlatform, mapSegment, type Platform } from "./path-mapping.ts";
import { applyExternals } from "./build-external.ts";
import { composeMergeTargets, mergeMachineData } from "./build-merge.ts";
import { applyReplaceSidecars } from "./build-replace.ts";
import { collectHooks, runHooks, type HookEvent } from "./build-hooks.ts";
import { adoptHomeLnkBytes, convertLnkDeclarations } from "./lnk.ts";
import { resolveGuestPath, resolveWsl, runWsl, uncDistro, type WslConnection } from "./wsl.ts";

export type { Platform };

export type BuildPhase = "rebuild dist" | "path map" | "externals" | "merge" | "replace";
export type PhaseEvent = (phase: BuildPhase, elapsedSeconds: number) => void;

type BuildOptions = {
  onHookEvent?: HookEvent;
  hookLog?: ApplyHookLog;
  onPhase?: PhaseEvent;
  connection?: WslConnection;
};

export async function main(
  root = process.cwd(),
  platform: Platform = currentPlatform(),
  homeRoot = homedir(),
  options: BuildOptions = {},
): Promise<ReadonlySet<string>> {
  assertPlatform(platform);
  const { onHookEvent, onPhase, connection } = options;
  const wsl = connection ?? (await resolveWsl(root));
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  await timed("rebuild dist", onPhase, async () => {
    await removeDist(distDir, wsl);
    await copyDir(sourceDir, distDir, {
      sourceRoot: sourceDir,
      distRoot: distDir,
      router: await createCopyRouter(platform, distDir),
      platform,
      remappedPaths: new Set(),
    });
  });
  await timed("path map", onPhase, () => applyPathMap(distDir, platform));
  const hooks = await collectHooks(distDir, platform);
  const sidecarPlatform = platform === "darwin" ? "macos" : platform;
  await timed("externals", onPhase, async () => {
    await mergeMachineData(distDir);
    await applyExternals(distDir, wsl, sidecarPlatform);
  });
  await timed("merge", onPhase, () => composeMergeTargets(distDir, homeRoot, sidecarPlatform));
  await timed("replace", onPhase, () => applyReplaceSidecars(distDir, homeRoot));
  await runHooks(hooks, distDir, homeRoot, onHookEvent, options.hookLog);
  const generatedLinks = await convertLnkDeclarations(distDir, platform);
  if (platform === "windows") await adoptHomeLnkBytes(distDir, homeRoot, generatedLinks);
  return generatedLinks;
}

async function removeDist(distDir: string, wsl: WslConnection | undefined): Promise<void> {
  const absoluteDistDir = resolve(distDir);
  if (process.platform !== "win32" || !uncDistro(absoluteDistDir)) {
    await rm(distDir, { recursive: true, force: true });
    return;
  }

  if (!wsl) throw new Error(`WSL connection required to remove dist: ${absoluteDistDir}`);
  const guestDistDir = await resolveGuestPath(wsl, absoluteDistDir);
  const result = await runWsl(wsl, ["rm", "-rf", "--", guestDistDir]);
  if (!result.ok)
    throw new Error(`Failed to remove dist in WSL: ${absoluteDistDir}: ${result.stderr}`);
}

type CopyContext = {
  sourceRoot: string;
  distRoot: string;
  router: CopyRouter;
  platform: Platform;
  remappedPaths: Set<string>;
};

const platformFilePattern = /^(.+)\.(linux|windows|macos)\.([^.]+)$/;

function selectPlatformFileName(name: string, platform: Platform): string | undefined {
  const match = platformFilePattern.exec(name);
  if (!match) return name;
  const [, stem, filePlatform, extension] = match;
  const targetPlatform = platform === "darwin" ? "macos" : platform;
  return filePlatform === targetPlatform ? `${stem}.${extension}` : undefined;
}

async function copyDir(
  sourceDir: string,
  destinationDir: string,
  context: CopyContext,
): Promise<void> {
  const { router } = context;
  await router.enter(sourceDir, destinationDir);
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const copies = entries.flatMap((entry) => {
    if (entry.name.endsWith(".ignore")) return [];
    const outputName = entry.isFile()
      ? selectPlatformFileName(entry.name, context.platform)
      : entry.name;
    return outputName === undefined ? [] : [{ entry, outputName }];
  });
  const platformFiles = new Map(
    copies
      .filter(({ entry, outputName }) => entry.name !== outputName)
      .map(({ entry, outputName }) => [outputName, entry.name] as const),
  );

  for (const { entry, outputName } of copies) {
    const route = await router.route(entry.name, entry.isFile());
    if (route.kind === "skip") continue;
    if (route.kind === "copy" && entry.isFile() && entry.name === outputName) {
      const platformFile = platformFiles.get(outputName);
      if (platformFile && (await router.route(platformFile, true)).kind === "copy") continue;
    }
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath =
      route.kind === "copy-to" ? route.destination : join(destinationDir, outputName);
    if (
      route.kind === "copy" &&
      entry.name !== outputName &&
      context.remappedPaths.has(destinationPath)
    )
      continue;
    if (entry.isDirectory()) {
      // A moved destination replaces any existing entry (spec: 置き換える).
      if (route.kind === "copy-to") {
        await rm(destinationPath, { recursive: true, force: true });
        for (const path of context.remappedPaths) {
          if (path === destinationPath || path.startsWith(`${destinationPath}${sep}`)) {
            context.remappedPaths.delete(path);
          }
        }
      }
      await copyDir(sourcePath, destinationPath, context);
    } else {
      if (route.kind === "copy-to") await mkdir(dirname(destinationPath), { recursive: true });
      if (
        entry.isFile() &&
        isSymlinkDeclaration(context.sourceRoot, sourcePath) &&
        isSymlinkDeclaration(context.distRoot, destinationPath) &&
        (await hasDistParent(context.distRoot, destinationPath))
      ) {
        await copySymlinkDeclaration(sourcePath, destinationPath, context.platform);
      } else {
        await cp(sourcePath, destinationPath);
      }
    }
    if (route.kind === "copy-to") context.remappedPaths.add(destinationPath);
    else if (!entry.isDirectory()) context.remappedPaths.delete(destinationPath);
  }
  router.exit();
}

function isSymlinkDeclaration(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  if (!isWithinRoot(relativePath)) return false;

  const segments = relativePath.split(sep);
  const name = segments.pop();
  return (
    name !== undefined &&
    mapSegment(name, false).kind === "symlink" &&
    segments.every((directory) => !mapSegment(directory, true).isExcluded)
  );
}

async function hasDistParent(distRoot: string, destination: string): Promise<boolean> {
  const [root, parent] = await Promise.all([realpath(distRoot), realpath(dirname(destination))]);
  return parent === root || parent.startsWith(`${root}${sep}`);
}

function isWithinRoot(relativePath: string): boolean {
  return !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

async function copySymlinkDeclaration(
  source: string,
  destination: string,
  platform: Platform,
): Promise<void> {
  const target = await readFile(source, "latin1");
  const separator = platform === "windows" ? win32.sep : posix.sep;
  const normalizedTarget = target.replaceAll(/[\\/]/g, separator);
  if (target === normalizedTarget) {
    await cp(source, destination);
    return;
  }

  const { mode } = await stat(source);
  await rm(destination, { force: true });
  const file = await open(destination, "wx", mode);
  try {
    await file.writeFile(normalizedTarget, "latin1");
    await file.chmod(mode);
  } finally {
    await file.close();
  }
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
