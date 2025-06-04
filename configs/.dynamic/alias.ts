import { promises as fs } from "fs";
import path from "path";
import { dirname } from "path";

const aliasDir = "./dotfiles/exact_alias";

const aliases = [
  { aliasName: "npm", commandName: "pnpm" },
  { aliasName: "rnpm", commandName: "C:\\Program Files\\nodejs\\npm" },
];

async function setupAliases() {
  await fs.mkdir(aliasDir, { recursive: true });
  const files = await fs.readdir(aliasDir);
  await Promise.all(files.map((file) => fs.unlink(path.join(aliasDir, file))));
  await Promise.all(
    aliases.map(({ aliasName, commandName }) => {
      const filePath = path.join(aliasDir, `${aliasName}.cmd`);
      return fs.writeFile(filePath, commandName, { encoding: "utf8" });
    })
  );
}

setupAliases();
