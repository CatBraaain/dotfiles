// Dist-to-home path resolution for build hooks (spec: SPEC.md
// §build: ローカルフック context.resolvePaths). Reuses the same segment
// mapping as diff detection so paths stay consistent across stages.
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapSegment } from "./path-mapping.ts";

export function homeRelPath(distRelPath: string): string {
  const segments = distRelPath.split("/");
  return segments
    .map((segment, index) => {
      const isLastSegment = index === segments.length - 1;
      return mapSegment(segment, !isLastSegment).homeName;
    })
    .join("/");
}

export function resolvePaths(
  hookDistDir: string,
  distDir: string,
  homeRoot: string,
  path: string,
): { distPath: string; homePath: string } {
  if (!isRelativeFilePath(path)) {
    throw new Error(`build hook path must be a relative file path inside dist: ${path}`);
  }
  const distPath = resolve(hookDistDir, path);
  const distRelPath = relative(resolve(distDir), distPath);
  if (!isInsideDist(distRelPath)) {
    throw new Error(`build hook path must be a relative file path inside dist: ${path}`);
  }
  const homePath = join(resolve(homeRoot), homeRelPath(distRelPath.split(sep).join("/")));
  return { distPath, homePath };
}

function isRelativeFilePath(path: string): boolean {
  const lastSegment = path.split(/[\\/]/).at(-1);
  return (
    path !== "" &&
    !isAbsolute(path) &&
    lastSegment !== undefined &&
    lastSegment !== "" &&
    lastSegment !== "." &&
    lastSegment !== ".."
  );
}

function isInsideDist(distRelPath: string): boolean {
  return (
    distRelPath !== "" &&
    distRelPath !== ".." &&
    !distRelPath.startsWith(`..${sep}`) &&
    !isAbsolute(distRelPath)
  );
}
