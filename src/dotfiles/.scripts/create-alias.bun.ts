import { $ } from "bun";
import { join } from "path";

const aliasDir = "dist/dotfiles/exact_alias";

const aliases = [
  { aliasName: "mr", commandName: "mise run %*" },
  {
    aliasName: "uv-python-update",
    commandName: "uv python install --reinstall 3.11 3.12 3.13",
  },
  { aliasName: "uv-init", commandName: "uv init --bare & uv venv" },
  { aliasName: "mise-init", commandName: "mise gen config -o mise.toml" },
  { aliasName: "venv", commandName: ".venv\\Scripts\\activate" },
  { aliasName: "j", commandName: "just %*" },
  { aliasName: "jg", commandName: "just -g %*" },
  { aliasName: "dc", commandName: "docker compose %*" },
  {
    aliasName: "just-init",
    commandName: "(echo _:& echo.  @just --list --unsorted) > justfile",
  },
  { aliasName: "docker-inspect", commandName: "docker exec -it %* /bin/sh" },
];

await $`rm -rf ${aliasDir}`;
await $`mkdir -p ${aliasDir}`;

aliases.forEach(async ({ aliasName, commandName }) => {
  const filePath = join(aliasDir, `${aliasName}.cmd`);
  await $`echo ${commandName} > ${filePath}`;
});
