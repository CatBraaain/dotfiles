// Internal command entry point for the dotfiles manager.
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join, resolve } from "node:path";
import { main as apply } from "./apply.ts";
import { run as build } from "./build.ts";
import { main as diff } from "./diff.ts";

declare const process: { argv: string[]; exitCode: number };
declare const console: { error(...data: unknown[]): void };
declare global {
  interface ImportMeta {
    readonly main: boolean;
    readonly dir: string;
  }
}

const usage = "usage: bun dotfiles-manager/cli.ts <apply|diff|managed>";

export async function main(
  args: readonly string[],
  root = resolve(import.meta.dir, ".."),
  homeRoot = homedir(),
): Promise<number> {
  const [command] = args;
  if (args.length !== 1 || !["apply", "diff", "managed"].includes(command ?? ""))
    throw new Error(usage);

  await build(root, undefined, homeRoot);
  const distRoot = join(root, "dist");
  if (command === "apply") return apply([distRoot, homeRoot]);
  return diff(command === "managed" ? ["--managed", distRoot, homeRoot] : [distRoot, homeRoot]);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
