import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_LAUNCHER_NAME = "dotfiles Windows pi launcher";

class PiNotFoundError extends Error {}

function piEntry(prefix: string): string {
  const packageDirectory = join(prefix, "node_modules", PI_PACKAGE);
  const manifestPath = join(packageDirectory, "package.json");
  if (!isFile(manifestPath)) throw new PiNotFoundError(`Cannot find ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: unknown;
    bin?: { pi?: unknown };
  } | null;
  const entry = manifest?.bin?.pi;
  if (manifest?.name !== PI_PACKAGE || typeof entry !== "string" || extname(entry) !== ".js") {
    throw new Error(`Invalid Pi package entry: ${manifestPath}`);
  }
  if (isAbsolute(entry) || entry.includes(":")) {
    throw new Error(`Pi entry is outside its package: ${entry}`);
  }
  const entryPath = resolve(packageDirectory, entry);
  assertWithinPackage(packageDirectory, entryPath);
  if (!isFile(entryPath)) throw new PiNotFoundError(`Cannot find ${entryPath}`);
  const canonicalEntry = realpathSync(entryPath);
  assertWithinPackage(realpathSync(packageDirectory), canonicalEntry);
  return canonicalEntry;
}

function assertWithinPackage(packageDirectory: string, entryPath: string): void {
  const entryRelative = relative(packageDirectory, entryPath);
  if (
    !entryRelative ||
    entryRelative === ".." ||
    entryRelative.startsWith(`..${sep}`) ||
    isAbsolute(entryRelative)
  ) {
    throw new Error(`Pi entry is outside its package: ${entryPath}`);
  }
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

async function run(args: string[]): Promise<number> {
  const prefix = dirname(process.execPath);
  const adjacentNode = join(prefix, "node.exe");
  const node = isFile(adjacentNode) ? adjacentNode : Bun.which("node.exe");
  if (!node) throw new PiNotFoundError("Cannot find node.exe");
  const entry = piEntry(prefix);

  const ignoreConsoleInterrupt = () => {};
  process.on("SIGINT", ignoreConsoleInterrupt);
  try {
    const child = Bun.spawn([node, entry, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } finally {
    process.off("SIGINT", ignoreConsoleInterrupt);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(`${PI_LAUNCHER_NAME}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof PiNotFoundError ? 127 : 1;
  }
}
