// @ts-ignore Bun provides the Shell API at runtime.
import { $ } from "bun";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";

// Runs in the original dist/vscode folder before the path map moves or removes it.
export default async function build(): Promise<void> {
  if (!existsSync("settings.json")) return;
  await $`bunx @biomejs/biome@2.5.14 format --write settings.json \
    --json-formatter-trailing-commas=all \
    --json-parse-allow-comments=true \
    --json-parse-allow-trailing-commas=true \
    --indent-style=space \
    --indent-width=2`;
}
