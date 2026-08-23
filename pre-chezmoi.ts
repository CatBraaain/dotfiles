import { existsSync, readdirSync, lstatSync } from "node:fs";
import { readFile, writeFile, rm, rename, mkdir, lstat, cp } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const pathDepth = (p: string) => p.split(/[/\\]/).length;

async function copyDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === "node_modules") continue;
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (lstatSync(srcPath).isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else {
      await cp(srcPath, dstPath);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, overwrite: T): T {
  if (isPlainObject(base) && isPlainObject(overwrite)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, overwriteValue] of Object.entries(overwrite)) {
      merged[key] = deepMerge(merged[key], overwriteValue);
    }
    return merged as T;
  }
  return overwrite;
}

const fileFormats = {
  json: {
    parse: JSON.parse,
    stringify: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`,
  },
  yaml: {
    parse: parseYaml,
    stringify: (value: unknown) => stringifyYaml(value),
  },
} as const;

type FileFormat = keyof typeof fileFormats;

const formatOf = (path: string): FileFormat => (path.endsWith(".yaml") ? "yaml" : "json");

// xxx.overwrite.{json,yaml}: deep-merge into sibling base xxx.{json,yaml}, then delete the overwrite file.
async function mergeOverwriteFiles(): Promise<void> {
  for await (const entry of new Bun.Glob("dist/**/*.overwrite.{json,yaml}").scan({ dot: true })) {
    const format = formatOf(entry);
    const baseFile = entry.replace(/\.overwrite\.\w+$/, `.${format}`);
    if (!existsSync(baseFile)) throw new Error(`overwrite target not found: ${baseFile}`);
    const { parse, stringify } = fileFormats[format];
    const baseContent = parse(await readFile(baseFile, "utf-8"));
    const overwriteContent = parse(await readFile(entry, "utf-8"));
    await writeFile(baseFile, stringify(deepMerge(baseContent, overwriteContent)));
    await rm(entry);
  }
}

// xxx.merge.{json,yaml} -> modify_xxx.{json,yaml} (chezmoi modify template)
const modifyTemplate = (format: FileFormat, repoContent: string) =>
  format === "json"
    ? `{{- /* chezmoi:modify-template */ -}}
{{
  mergeOverwrite
    ((or .chezmoi.stdin "{}") | fromJson)
    (fromJsonc \`
${repoContent}
\`)
  | toPrettyJson
  | println
-}}`
    : `{{- /* chezmoi:modify-template */ -}}
{{
  mergeOverwrite
    ((or .chezmoi.stdin "{}") | fromYaml)
    (fromYaml \`
${repoContent}
\`)
  | toYaml
-}}`;

async function convertMergeFiles(): Promise<void> {
  for await (const entry of new Bun.Glob("dist/**/*.merge.{json,yaml}").scan({ dot: true })) {
    const format = formatOf(entry);
    const content = await readFile(entry, "utf-8");
    const baseName = basename(entry).replace(/\.merge\./, ".");
    const modifyFile = join(dirname(entry), `modify_${baseName}`);
    await writeFile(modifyFile, modifyTemplate(format, content));
    await rm(entry);
  }
}

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
        zed: "AppData/Roaming/Zed",
      }
    : {
        docker: ".docker/desktop",
        erdtree: ".config/erdtree",
        "git-cliff": ".config/git-cliff",
        zed: ".config/zed",
      };

await rm("dist", { recursive: true, force: true });
await copyDir("dotfiles", "dist");

for (const [src, dst] of Object.entries(pathMaps)) {
  const srcPath = join("dist", src);
  if (existsSync(srcPath)) {
    const dstPath = join("dist", dst);
    await mkdir(dirname(dstPath), { recursive: true });
    await rm(dstPath, { recursive: true, force: true });
    await rename(srcPath, dstPath);
  }
}

await mergeOverwriteFiles();
await convertMergeFiles();

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

// file xxx.executable -> executable_xxx (chezmoi derives the exec bit from the
// name prefix, not from the source file's mode)
for await (const entry of new Bun.Glob("dist/**/*.executable").scan({ dot: true })) {
  const name = basename(entry);
  const dstPath = join(dirname(entry), `executable_${name.replace(/\.executable$/, "")}`);
  await rename(entry, dstPath);
}
