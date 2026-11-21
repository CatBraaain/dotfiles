// Build-stage adoption of home-side .lnk bytes (spec: SPEC.md
// §build: lnk の home 採用). Regenerated shortcuts embed fresh target
// timestamps, so dist bytes always drift; equal readable text means the home
// copy is the same shortcut, and its bytes replace dist's.
import { copyFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { lstatOrNull } from "./compare.ts";
import { homeRelPath } from "./home-path.ts";
import { mapSegment } from "./path-mapping.ts";

const LINK_NAME_SUFFIX = ".lnk";
const TEXT_RUN_PATTERN = /(?:[\x20-\x7e]\x00){4,}/g;

export function lnkText(bytes: Uint8Array): string {
  const latin = new TextDecoder("latin1").decode(bytes);
  const runs = latin.match(TEXT_RUN_PATTERN);
  if (!runs) return "";
  return runs
    .map((run) =>
      new TextDecoder("utf-16le").decode(Uint8Array.from(run, (char) => char.charCodeAt(0))),
    )
    .join("\n");
}

export async function adoptHomeLnkBytes(distDir: string, homeRoot: string): Promise<void> {
  const links: string[] = [];
  await collectLinkPaths(distDir, "", links);
  for (const distRelPath of links) {
    const distPath = join(distDir, distRelPath);
    const homePath = join(homeRoot, homeRelPath(distRelPath));
    const homeStat = await lstatOrNull(homePath);
    if (!homeStat?.isFile()) continue;
    const [distBytes, homeBytes] = await Promise.all([readFile(distPath), readFile(homePath)]);
    if (distBytes.equals(homeBytes)) continue;
    const homeLinkText = lnkText(homeBytes);
    const distLinkText = lnkText(distBytes);
    if (homeLinkText === "" || distLinkText === "" || homeLinkText !== distLinkText) continue;
    await copyFile(homePath, distPath);
  }
}

async function collectLinkPaths(
  directory: string,
  relativePrefix: string,
  links: string[],
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const mapping = mapSegment(entry.name, entry.isDirectory());
    if (mapping.isExcluded) continue;
    const childRelPath = relativePrefix === "" ? entry.name : `${relativePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectLinkPaths(join(directory, entry.name), childRelPath, links);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(LINK_NAME_SUFFIX)) {
      links.push(childRelPath);
    }
  }
}
