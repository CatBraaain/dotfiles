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
import { registerScmSelection } from "./scm-selection.ts";

type BridgeResult = "patched" | "unpatched" | "fresh" | "bridge-unwritable" | "bridge-invalid";
const BRIDGE_START = "\n// vscode-custom-patch: SCM bridge start\n";
const BRIDGE_END = "\n// vscode-custom-patch: SCM bridge end\n";
const IDENTIFIER = "[$A-Za-z_][$\\w]*";

export function ensureScmBridge(appOut: string, enabled: boolean): BridgeResult {
  const bundlePath = join(appOut, "vs", "workbench", "workbench.desktop.main.js");
  try {
    const stats = lstatSync(bundlePath, { throwIfNoEntry: false });
    if (!stats?.isFile()) return "fresh";
    const bytes = readFileSync(bundlePath);
    const current = bytes.toString("utf8");
    const bridgeStart = current.indexOf(BRIDGE_START);
    const bridgeEnd = current.indexOf(BRIDGE_END);
    const hasBridge = bridgeStart !== -1 || bridgeEnd !== -1;
    if (hasBridge && !hasValidBridgeBoundary(current, bridgeStart, bridgeEnd))
      return "bridge-invalid";

    const original = hasBridge ? current.slice(0, bridgeStart) : current;
    const bridge = enabled ? prepareScmBridge(original) : undefined;
    const updated = bridge ? `${original}${BRIDGE_START}${bridge}${BRIDGE_END}` : original;
    if (updated === current) return "fresh";
    if (!bytes.equals(Buffer.from(current))) return "bridge-invalid";

    replaceBundle(bundlePath, updated, stats.mode);
    return bridge ? "patched" : "unpatched";
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EBUSY") {
      return "bridge-unwritable";
    }
    throw error;
  }
}

function prepareScmBridge(bundle: string): string | undefined {
  if (!/\bset\s+visibleRepositories\s*\(/.test(bundle)) return;
  if (
    !/\bselectionModeConfig\s*=\s*[$\w]+\(\s*["']scm\.repositories\.selectionMode["']/.test(bundle)
  )
    return;

  const viewServiceDeclaration = new RegExp(
    `\\b(?:var|let|const)\\s+(${IDENTIFIER})\\s*=\\s*${IDENTIFIER}\\(\\s*["']scmView["']\\s*\\)`,
    "g",
  );
  const [viewService] = uniqueMatch(bundle, viewServiceDeclaration)?.slice(1) ?? [];
  if (!viewService) return;

  const activeProviderRegistration = new RegExp(
    `(?<![$\\w])(${IDENTIFIER})\\.registerCommand\\(\\s*["']scm\\.setActiveProvider["']\\s*,[^{};]*\\{([^{};]*)`,
    "g",
  );
  const [, registry, handlerStart] = uniqueMatch(bundle, activeProviderRegistration) ?? [];
  if (!registry || !handlerStart?.replaceAll(/\s/g, "").includes(`.get(${viewService})`)) return;

  return `;(() => {
  try {
    if (typeof ${registry} !== "undefined" && typeof ${viewService} === "function" && ${viewService}.toString() === "scmView") {
      (${registerScmSelection.toString()})(${registry}, ${viewService});
    }
  } catch (error) {
    console.warn("Agent Kit SCM bridge could not register", error);
  }
})();`;
}

function uniqueMatch(source: string, pattern: RegExp): RegExpExecArray | undefined {
  const match = pattern.exec(source);
  if (match && !pattern.exec(source)) return match;
}

function hasValidBridgeBoundary(bundle: string, start: number, end: number): boolean {
  return (
    start !== -1 &&
    end > start &&
    end + BRIDGE_END.length === bundle.length &&
    bundle.lastIndexOf(BRIDGE_START) === start
  );
}

function replaceBundle(path: string, contents: string, mode: number): void {
  const directory = dirname(path);
  accessSync(path, constants.W_OK);
  const stage = mkdtempSync(join(directory, ".scm-bridge-"));
  try {
    const tempBundle = join(stage, "workbench.desktop.main.js");
    writeFileSync(tempBundle, contents);
    chmodSync(tempBundle, mode);
    renameSync(tempBundle, path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
