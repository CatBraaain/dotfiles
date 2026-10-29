import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function catalogRoot(rootDir) {
  const root = realpathSync(rootDir);
  if (!statSync(root).isDirectory()) {
    throw new Error(`${rootDir}: catalog root must be a directory.`);
  }
  return root;
}

export function catalogFile(root, relativePath) {
  const file = resolve(root, relativePath);
  requireContained(root, file);
  const realFile = realpathSync(file);
  requireContained(root, realFile);
  if (!statSync(realFile).isFile()) {
    throw new Error(`${relativePath}: expected a regular file.`);
  }
  return realFile;
}

function requireContained(root, file) {
  const fromRoot = relative(root, file);
  const isOutside =
    fromRoot === ".." ||
    fromRoot.startsWith("../") ||
    fromRoot.startsWith("..\\") ||
    isAbsolute(fromRoot);
  if (isOutside) {
    const error = new Error(`${file}: file must stay inside the catalog root.`);
    error.code = "OUTSIDE_ROOT";
    throw error;
  }
}
