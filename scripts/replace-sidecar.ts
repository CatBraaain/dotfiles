// Replace sidecar stage of the build (spec: dotfiles-manager.spec.md
// §build: 置換 sidecar): for each <name>.replace.yaml, writes dist/<name>
// from home's current <name> content with regex replacements applied.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import yaml from "yaml";
import { homeRelPath } from "./home-paths.ts";

export type Replacement = { pattern: string; replacement: string };

const sidecarSuffix = ".replace.yaml";

export function parseReplaceSidecar(
  content: string,
  sidecarPath: string,
): Replacement[] {
  const doc: unknown = yaml.parse(content);
  const replacements = (doc as { replacements?: unknown })?.replacements;
  if (!Array.isArray(replacements))
    throw new Error(`replace sidecar must have a replacements array: ${sidecarPath}`);
  return replacements.map((raw, index) => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as { pattern?: unknown }).pattern !== "string" ||
      typeof (raw as { replacement?: unknown }).replacement !== "string"
    ) {
      throw new Error(
        `replace sidecar entry ${index} must map pattern and replacement to strings: ${sidecarPath}`,
      );
    }
    return {
      pattern: (raw as { pattern: string }).pattern,
      replacement: (raw as { replacement: string }).replacement,
    };
  });
}

// Replacements apply top to bottom; every match of each pattern is replaced
// and ${1}-style capture references resolve to the matched groups.
export function applyReplacements(content: string, replacements: Replacement[]): string {
  let result = content;
  for (const { pattern, replacement } of replacements) {
    result = result.replace(new RegExp(pattern, "g"), (...args) => {
      // match, capture groups..., offset, string
      const groups = args.slice(0, args.length - 2).map((group) =>
        typeof group === "string" ? group : "",
      );
      return replacement.replace(/\$\{(\d+)\}/g, (_, index) => groups[Number(index)] ?? "");
    });
  }
  return result;
}

export async function applyReplaceSidecars(
  distDir: string,
  homeRoot: string,
): Promise<void> {
  for (const sidecarRel of await collectSidecars(distDir, "")) {
    // <dir>/<name>.replace.yaml renders <dir>/<name>.
    const nameRel = sidecarRel.slice(0, -sidecarSuffix.length);
    const homeAbs = join(homeRoot, homeRelPath(nameRel));
    const current = existsSync(homeAbs) ? await readFile(homeAbs, "utf8") : "";
    const replacements = parseReplaceSidecar(
      await readFile(join(distDir, sidecarRel), "utf8"),
      sidecarRel,
    );
    await writeFile(join(distDir, nameRel), applyReplacements(current, replacements));
    await rm(join(distDir, sidecarRel));
  }
}

async function collectSidecars(dirAbs: string, dirRel: string): Promise<string[]> {
  const sidecars: string[] = [];
  for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
    const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    if (entry.isDirectory())
      sidecars.push(...(await collectSidecars(join(dirAbs, entry.name), childRel)));
    else if (entry.isFile() && entry.name.endsWith(sidecarSuffix))
      sidecars.push(childRel);
  }
  return sidecars.sort();
}
