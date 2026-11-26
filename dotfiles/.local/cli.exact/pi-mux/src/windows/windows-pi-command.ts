import { readFileSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { errorMessage, isRecord } from "../session-model";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const NPM_QUERY_TIMEOUT_MS = 5_000;

export function isUncPath(path: string): boolean {
  const normalized = win32.normalize(path);
  const root = win32.parse(normalized).root;
  if (/^\\\\\?\\unc\\/i.test(normalized)) return true;
  if (root.startsWith("\\\\?\\")) return false;
  return root.startsWith("\\\\") && root !== "\\\\.\\";
}

export function windowsNpmPiCommand(): string[] {
  try {
    const node = Bun.which("node.exe");
    if (!node) throw new Error("Cannot find node.exe on PATH");
    const npmShim = Bun.which("npm.cmd");
    if (!npmShim) throw new Error("Cannot locate the npm installation on PATH");
    const npmDirectory = win32.dirname(npmShim);
    const npm = win32.join(npmDirectory, "node_modules", "npm", "bin", "npm-cli.js");
    if (!statSync(npm, { throwIfNoEntry: false })?.isFile())
      throw new Error(`Cannot find the npm CLI: ${npm}`);
    const result = Bun.spawnSync([node, npm, "root", "--global"], {
      cwd: npmDirectory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: NPM_QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.exitCode !== 0)
      throw new Error(`npm root --global failed: ${result.stderr.toString().trim()}`);
    const npmRoot = result.stdout.toString().trimEnd();
    if (!win32.isAbsolute(npmRoot) || /[\r\n\0]/.test(npmRoot))
      throw new Error("npm root --global did not return an absolute directory");

    const packageRoot = win32.join(npmRoot, PI_PACKAGE);
    const manifest: unknown = JSON.parse(
      readFileSync(win32.join(packageRoot, "package.json"), "utf8"),
    );
    if (!isRecord(manifest) || manifest.name !== PI_PACKAGE || !isRecord(manifest.bin))
      throw new Error("Invalid pi package manifest");
    const bin = manifest.bin.pi;
    if (typeof bin !== "string" || win32.isAbsolute(bin) || !/^[\w./-]+\.js$/.test(bin))
      throw new Error("Invalid pi package entry point");
    const entryPoint = win32.resolve(packageRoot, bin);
    const relative = win32.relative(packageRoot, entryPoint);
    if (!relative || relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative))
      throw new Error("Pi entry point is outside its package");
    const canonicalEntry = realpathSync(entryPoint);
    const canonicalRelative = win32.relative(realpathSync(packageRoot), canonicalEntry);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith("..\\") ||
      win32.isAbsolute(canonicalRelative)
    )
      throw new Error("Pi entry point resolves outside its package");
    if (!statSync(canonicalEntry).isFile())
      throw new Error(`Pi entry point is not a file: ${entryPoint}`);
    return [node, canonicalEntry];
  } catch (error) {
    throw new Error(
      `Cannot resolve npm-installed Windows pi (${PI_PACKAGE}): ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function assertWindowsPiWorkingDirectory(expected: string, actual: string): void {
  if (expected === actual) return;
  if (
    (isUncPath(expected) && !isUncPath(actual)) ||
    realpathSync(expected) !== realpathSync(actual)
  )
    throw new Error(
      `Windows pi working directory differs from the requested directory: expected ${expected}; got ${actual}`,
    );
}
