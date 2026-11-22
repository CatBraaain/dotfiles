import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveWindowsPlaywrightCli(): { entry: string; prefix: string } {
  const shim = Bun.which("playwright-cli.cmd", { PATH: process.env.PATH });
  if (!shim) throw new Error("playwright-cli.cmd not found on PATH");

  const prefix = dirname(shim);
  const packageDir = join(prefix, "node_modules", "@playwright", "cli");
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: Record<string, unknown>;
  } | null;
  const bin = manifest?.bin?.["playwright-cli"];
  if (typeof bin !== "string" || !bin || isAbsolute(bin)) {
    throw new Error(`Invalid playwright-cli bin in ${manifestPath}`);
  }

  const entry = resolve(packageDir, bin);
  const entryRelative = relative(packageDir, entry);
  if (entryRelative === ".." || entryRelative.startsWith(`..${sep}`) || isAbsolute(entryRelative)) {
    throw new Error(`playwright-cli bin is outside its package: ${entry}`);
  }
  if (!statSync(entry, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`playwright-cli bin not found: ${entry}`);
  }
  return { entry, prefix };
}

export function resolveWindowsNode(prefix: string): string {
  const adjacentNode = join(prefix, "node.exe");
  if (statSync(adjacentNode, { throwIfNoEntry: false })?.isFile()) return adjacentNode;

  const node = Bun.which("node.exe", { PATH: process.env.PATH });
  if (!node) throw new Error("node.exe not found on PATH");
  return node;
}
