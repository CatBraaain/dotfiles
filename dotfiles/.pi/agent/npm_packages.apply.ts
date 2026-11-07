import { $ } from "bun";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync, readFileSync, realpathSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

declare const process: { cwd(): string };

const npmSpecPattern = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/;

type PackageManager = "bun" | "npm";

export function extractNpmPackageNames(packages: unknown): string[] {
  if (!Array.isArray(packages)) return [];
  const names = packages
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => entry.startsWith("npm:"))
    .map((entry) => npmSpecPattern.exec(entry.slice("npm:".length))?.[1])
    .filter((name): name is string => name !== undefined && name !== "");
  return [...new Set(names)];
}

export function staleDependencies(
  wanted: string[],
  dependencies: Record<string, unknown>,
): string[] {
  return Object.keys(dependencies)
    .filter((name) => !wanted.includes(name))
    .sort();
}

export function resolvePackageManager(npmCommand: unknown): PackageManager {
  if (!Array.isArray(npmCommand) || npmCommand.length === 0) return "npm";
  const normalize = (command: unknown): string =>
    typeof command === "string"
      ? (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe)$/i, "")
      : "";
  const separatorIndex = npmCommand.lastIndexOf("--");
  const wrappedCommand = separatorIndex >= 0 ? npmCommand[separatorIndex + 1] : undefined;
  if (normalize(wrappedCommand) === "bun") return "bun";
  if (normalize(npmCommand[0]) === "bun") return "bun";
  return "npm";
}

export function uninstallArguments(
  names: string[],
  npmRoot: string,
  packageManager: PackageManager,
): { command: string; args: string[] } {
  if (packageManager === "bun")
    return { command: "bun", args: ["uninstall", ...names, "--cwd", npmRoot] };
  return {
    command: "npm",
    args: [
      "uninstall",
      ...names,
      "--prefix",
      npmRoot,
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
    ],
  };
}

function readJsonFile(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

async function main(): Promise<void> {
  const agentDir = process.cwd();
  const manifestPath = join(agentDir, "npm", "package.json");
  if (!existsSync(manifestPath)) return;

  const settings = readJsonFile(join(agentDir, "settings.json"));
  const wanted = extractNpmPackageNames(propertyOf(settings, "packages"));
  const dependencies = propertyOf(readJsonFile(manifestPath), "dependencies");
  const stale = staleDependencies(
    wanted,
    typeof dependencies === "object" && dependencies !== null
      ? (dependencies as Record<string, unknown>)
      : {},
  );
  if (stale.length === 0) return;

  const npmRoot = realpathSync(join(agentDir, "npm"));
  const { command, args } = uninstallArguments(
    stale,
    npmRoot,
    resolvePackageManager(propertyOf(settings, "npmCommand")),
  );
  await $`${command} ${args}`;
}

if (import.meta.main) await main();
