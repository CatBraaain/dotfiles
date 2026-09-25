// @ts-ignore Bun provides the Shell API at runtime.
import { $ } from "bun";

await $`bunx @biomejs/biome@2.5.14 format --write settings.json \
  --json-formatter-trailing-commas=all \
  --json-parse-allow-comments=true \
  --json-parse-allow-trailing-commas=true \
  --indent-style=space \
  --indent-width=2`;
