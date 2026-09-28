// Dist-to-home path resolution for build hooks (spec: SPEC.md
// §build: ローカルフック context.resolvePaths). Reuses the same segment
// mapping as diff detection so paths stay consistent across stages.
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapSegment } from "./path-mapping.ts";

export function homeRelPath(distRelPath: string): string {
  const segments = distRelPath.split("/");
  return segments
    .map((segment, index) => mapSegment(segment, index < segments.length - 1).homeName)
    .join("/");
}

export function resolvePaths(
  hookDistDir: string,
  distDir: string,
  homeRoot: string,
  path: string,
): { distPath: string; homePath: string } {
  const lastSegment = path.split(/[\\/]/).at(-1);
  if (
    path === "" ||
    isAbsolute(path) ||
    !lastSegment ||
    lastSegment === "." ||
    lastSegment === ".."
  ) {
    throw new Error(`build hook path must be a relative file path inside dist: ${path}`);
  }
  const distPath = resolve(hookDistDir, path);
  const distRelPath = relative(resolve(distDir), distPath);
  if (
    distRelPath === "" ||
    distRelPath === ".." ||
    distRelPath.startsWith(`..${sep}`) ||
    isAbsolute(distRelPath)
  ) {
    throw new Error(`build hook path must be a relative file path inside dist: ${path}`);
  }
  const homePath = join(resolve(homeRoot), homeRelPath(distRelPath.split(sep).join("/")));
  return { distPath, homePath };
}
