import { existsSync } from "node:fs";
import { readFile, writeFile, rm, rename, mkdir, lstat, cp } from "node:fs/promises";
import { join, dirname, basename } from "node:path";

const pathDepth = (p: string) => p.split(/[/\\]/).length;

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
await cp("dotfiles", "dist", { recursive: true });

for (const [src, dst] of Object.entries(pathMaps)) {
  const srcPath = join("dist", src);
  if (existsSync(srcPath)) {
    const dstPath = join("dist", dst);
    await mkdir(dirname(dstPath), { recursive: true });
    await rm(dstPath, { recursive: true, force: true });
    await rename(srcPath, dstPath);
  }
}

// xxx.merge.{json,yaml} -> modify_xxx.{json,yaml} (chezmoi modify template)
const modifyTemplates = {
  json: (repoContent: string) => `{{- /* chezmoi:modify-template */ -}}
{{-
  mergeOverwrite
    ((or .chezmoi.stdin "{}") | fromJson)
    (fromJsonc \`
${repoContent}
\`)
  | toPrettyJson
  | println
-}}`,
  yaml: (repoContent: string) => `{{- /* chezmoi:modify-template */ -}}
{{-
  mergeOverwrite
    ((or .chezmoi.stdin "{}") | fromYaml)
    (fromYaml \`
${repoContent}
\`)
  | toYaml
-}}`,
};

for await (const entry of new Bun.Glob("dist/**/*.merge.{json,yaml}").scan({ dot: true })) {
  const format = entry.endsWith(".yaml") ? "yaml" : "json";
  const content = await readFile(entry, "utf-8");
  const baseName = basename(entry).replace(/\.merge\./, ".");
  const modifyFile = join(dirname(entry), `modify_${baseName}`);
  await writeFile(modifyFile, modifyTemplates[format](content));
  await rm(entry);
}

// .xxx -> dot_xxx (deepest first: renaming a parent orphans its children's paths)
const dotEntries: string[] = [];
for await (const entry of new Bun.Glob("dist/**/.*").scan({ dot: true, onlyFiles: false })) {
  if (entry.includes(".chezmoi")) continue;
  dotEntries.push(entry);
}
dotEntries.sort((a, b) => pathDepth(b) - pathDepth(a));
for (const entry of dotEntries) {
  const name = basename(entry);
  const dstPath = join(dirname(entry), `dot_${name.slice(1)}`);
  await rename(entry, dstPath);
}

// directory xxx.exact -> exact_xxx (run after dot-rename so .xxx.exact -> exact_dot_xxx)
const exactEntries: string[] = [];
for await (const entry of new Bun.Glob("dist/**/*.exact").scan({ dot: true, onlyFiles: false })) {
  if ((await lstat(entry)).isDirectory()) exactEntries.push(entry);
}
exactEntries.sort((a, b) => pathDepth(b) - pathDepth(a));
for (const entry of exactEntries) {
  const name = basename(entry);
  const dstPath = join(dirname(entry), `exact_${name.replace(/\.exact$/, "")}`);
  await rename(entry, dstPath);
}
