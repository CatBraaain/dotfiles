// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapSegment } from "./diff.ts";

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
