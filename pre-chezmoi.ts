import { $ } from "bun";
import { existsSync } from "node:fs";
import { readFile, writeFile, rm, rename, mkdir, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";

const pathMaps =
  process.platform === "win32"
    ? {
        docker: "AppData/Roaming/Docker",
        erdtree: "AppData/Roaming/erdtree",
        gemini: ".gemini",
        "git-cliff": "AppData/Roaming/git-cliff",
        mise: ".config/mise",
        nushell: "AppData/Roaming/nushell",
        "obs-studio": "AppData/Roaming/obs-studio",
        powershell: "Documents/PowerShell",
        "windows-terminal":
          "AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState",
        roo: ".roo",
        sharex: "Documents/ShareX",
        vscode: "AppData/Roaming/Code/User",
      }
    : {
        docker: ".docker/desktop",
        erdtree: ".config/erdtree",
        "git-cliff": ".config/git-cliff",
      };

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await $`cp -a dotfiles/. dist/`;

for (const [src, dst] of Object.entries(pathMaps)) {
  const srcPath = join("dist", src);
  if (existsSync(srcPath)) {
    const dstPath = join("dist", dst);
    await mkdir(dirname(dstPath), { recursive: true });
    await rm(dstPath, { recursive: true, force: true });
    await rename(srcPath, dstPath);
  }
}

// merge_*.json -> modify_*.json (chezmoi modify template)
for await (const entry of new Bun.Glob("dist/**/merge_*.json").scan({ dot: true })) {
  const content = await readFile(entry, "utf-8");
  const modifyFile = entry.replace(/merge_([^/]+)$/, "modify_$1");
  const template = `{{- /* chezmoi:modify-template */ -}}
{{-
  mergeOverwrite
    ((or .chezmoi.stdin "{}") | fromJson)
    (fromJsonc \`
${content}
\`)
  | toPrettyJson
  | println
-}}`;
  await writeFile(modifyFile, template);
  await rm(entry);
}

// .xxx -> dot_xxx (deepest first: renaming a parent orphans its children's paths)
const dotEntries: string[] = [];
for await (const entry of new Bun.Glob("dist/**/.*").scan({ dot: true, onlyFiles: false })) {
  if (entry.includes(".chezmoi")) continue;
  dotEntries.push(entry);
}
dotEntries.sort((a, b) => b.split("/").length - a.split("/").length);
for (const entry of dotEntries) {
  const name = entry.split("/").pop();
  const dstPath = join(dirname(entry), `dot_${name.slice(1)}`);
  await rename(entry, dstPath);
}

// directory xxx.exact -> exact_xxx (run after dot-rename so .xxx.exact -> exact_dot_xxx)
const exactEntries: string[] = [];
for await (const entry of new Bun.Glob("dist/**/*.exact").scan({ dot: true, onlyFiles: false })) {
  if ((await lstat(entry)).isDirectory()) exactEntries.push(entry);
}
exactEntries.sort((a, b) => b.split("/").length - a.split("/").length);
for (const entry of exactEntries) {
  const name = entry.split("/").pop()!;
  const dstPath = join(dirname(entry), `exact_${name.replace(/\.exact$/, "")}`);
  await rename(entry, dstPath);
}
