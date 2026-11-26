import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { prepareAgentWorktreeVisibility, prepareScmBridge } from "./scm-bridge.ts";
import { prepareExplorerSort } from "./sort-explorer.ts";

type BundleResult = "patched" | "unpatched" | "fresh" | "bundle-unwritable" | "bundle-invalid";
type BundleOptions = { scmSelectionSource?: string; sortExplorer?: boolean };

const scmBridge = sectionMarkers("SCM bridge");
const explorerSort = sectionMarkers("sort-explorer");
const agentWorktrees = sectionMarkers("agent worktree visibility");

export function ensureWorkbenchBundle(appOut: string, options: BundleOptions = {}): BundleResult {
  const bundlePath = join(appOut, "vs", "workbench", "workbench.desktop.main.js");
  try {
    const stats = lstatSync(bundlePath, { throwIfNoEntry: false });
    if (!stats?.isFile()) return "fresh";
    const bytes = readFileSync(bundlePath);
    const current = bytes.toString("utf8");
    let original = current;
    for (const markers of [scmBridge, explorerSort, agentWorktrees]) {
      const unpatched = stripSection(original, markers);
      if (unpatched === null) return "bundle-invalid";
      original = unpatched;
    }

    const sort = options.sortExplorer ? prepareExplorerSort(original) : undefined;
    const bridge = options.scmSelectionSource
      ? prepareScmBridge(original, options.scmSelectionSource)
      : undefined;
    const visibility = options.scmSelectionSource
      ? prepareAgentWorktreeVisibility(original)
      : undefined;
    const updated =
      original +
      wrapSection(agentWorktrees, visibility) +
      wrapSection(explorerSort, sort) +
      wrapSection(scmBridge, bridge);
    if (updated === current) return "fresh";
    if (!bytes.equals(Buffer.from(current))) return "bundle-invalid";

    replaceWorkbenchFile(bundlePath, updated, stats.mode);
    return sort || bridge || visibility ? "patched" : "unpatched";
  } catch (error) {
    if (isWorkbenchWriteUnavailable(error)) return "bundle-unwritable";
    throw error;
  }
}

function sectionMarkers(name: string) {
  return {
    start: `\n// vscode-custom-patch: ${name} start\n`,
    end: `\n// vscode-custom-patch: ${name} end\n`,
  };
}

type SectionMarkers = ReturnType<typeof sectionMarkers>;

function stripSection(bundle: string, markers: SectionMarkers): string | null {
  const start = bundle.indexOf(markers.start);
  const end = bundle.indexOf(markers.end);
  if (start === -1 && end === -1) return bundle;
  if (
    start === -1 ||
    end <= start ||
    end + markers.end.length !== bundle.length ||
    bundle.lastIndexOf(markers.start) !== start
  ) {
    return null;
  }
  return bundle.slice(0, start);
}

function wrapSection(markers: SectionMarkers, source: string | undefined): string {
  return source === undefined ? "" : markers.start + source + markers.end;
}

export function isWorkbenchWriteUnavailable(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException;
  return code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EBUSY";
}

export function replaceWorkbenchFile(path: string, contents: string, mode: number): void {
  const directory = dirname(path);
  accessSync(path, constants.W_OK);
  const stage = mkdtempSync(join(directory, ".workbench-stage-"));
  try {
    const stagedFile = join(stage, "replacement");
    writeFileSync(stagedFile, contents);
    chmodSync(stagedFile, mode);
    renameSync(stagedFile, path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
