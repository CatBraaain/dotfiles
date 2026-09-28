// Replace sidecar stage of the build (spec: SPEC.md
// §build: 置換 sidecar): for each <name>.replace.yaml, writes dist/<name>
// from home's current <name> content with regex replacements applied.
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { homeRelPath } from "./home-path.ts";

export type Replacement = { pattern: string; replacement: string };

const sidecarSuffix = ".replace.yaml";

export function parseReplaceSidecar(content: string, sidecarPath: string): Replacement[] {
  const doc: unknown = parseYaml(content);
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
      const groups = args
        .slice(0, args.length - 2)
        .map((group) => (typeof group === "string" ? group : ""));
      return replacement.replace(/\$\{(\d+)\}/g, (_, index) => groups[Number(index)] ?? "");
    });
  }
  return result;
}

export async function applyReplaceSidecars(distDir: string, homeRoot: string): Promise<void> {
  for (const sidecarRel of await collectReplaceSidecars(distDir, "")) {
    // <dir>/<name>.replace.yaml renders <dir>/<name>.
    const nameRel = sidecarRel.slice(0, -sidecarSuffix.length);
    const homeRelativePath = homeRelPath(nameRel);
    try {
      const homeAbs = join(homeRoot, homeRelativePath);
      const current = existsSync(homeAbs) ? await readFile(homeAbs, "utf8") : "";
      const replacements = parseReplaceSidecar(
        await readFile(join(distDir, sidecarRel), "utf8"),
        sidecarRel,
      );
      await writeFile(join(distDir, nameRel), applyReplacements(current, replacements));
      await rm(join(distDir, sidecarRel));
    } catch (error) {
      throw new Error(
        `replace target failed: ${homeRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

async function collectReplaceSidecars(dirAbs: string, dirRel: string): Promise<string[]> {
  const sidecars: string[] = [];
  for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
    const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    if (entry.isDirectory())
      sidecars.push(...(await collectReplaceSidecars(join(dirAbs, entry.name), childRel)));
    else if (entry.isFile() && entry.name.endsWith(sidecarSuffix)) sidecars.push(childRel);
  }
  return sidecars.sort();
}
