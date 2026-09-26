// @ts-ignore Bun provides the Shell API at runtime.
import { $ } from "bun";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

export default async function build(): Promise<void> {
  const settingsPath = existsSync("settings.json")
    ? "settings.json"
    : join("..", "AppData", "Roaming", "Code", "User", "settings.json");

  if (existsSync(settingsPath)) {
    await $`bunx @biomejs/biome@2.5.14 format --write ${settingsPath} \
      --json-formatter-trailing-commas=all \
      --json-parse-allow-comments=true \
      --json-parse-allow-trailing-commas=true \
      --indent-style=space \
      --indent-width=2`;
  }
}
