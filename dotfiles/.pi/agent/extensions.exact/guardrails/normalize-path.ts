import { homedir } from "node:os";
import { join } from "node:path";

export function normalizeToolPath(path: string): string {
  const withoutAtPrefix = path.startsWith("@") ? path.slice(1) : path;
  const expanded = withoutAtPrefix.replace(
    /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g,
    (reference) => {
      const name = reference.startsWith("${") ? reference.slice(2, -1) : reference.slice(1);
      const value = process.env[name];
      if (value === undefined || value === "") {
        throw new Error(`Cannot expand path: environment variable ${name} is undefined or empty`);
      }
      return value;
    },
  );
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/")) return join(homedir(), expanded.slice(2));
  return expanded;
}

/**
 * Apply SPEC §3 path normalization to a tool-call `path` argument and return
 * params carrying the normalized path, so authorize and run-tools receive the
 * identical value (the reviewed path is the executed path). Params without a
 * usable path string are returned unchanged.
 */
export function withNormalizedPath(params: { path?: unknown }): { path?: unknown } {
  if (typeof params.path !== "string" || params.path === "") return params;
  const normalized = normalizeToolPath(params.path);
  return normalized === params.path ? params : { ...params, path: normalized };
}
