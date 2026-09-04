import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Normalize a tool-call path argument before authorization (SPEC §3):
 * strip a leading `@` prefix and expand `~` / `~/...` to the home directory.
 * The same normalized value must be used for both the authorization dialog and
 * the params passed to run-tools, so the reviewed path and the executed path
 * always match. Anything else is returned unchanged for the caller to resolve
 * against the session cwd.
 */
export function normalizeToolPath(path: string): string {
  const withoutAtPrefix = path.startsWith("@") ? path.slice(1) : path;
  if (withoutAtPrefix === "~") return homedir();
  if (withoutAtPrefix.startsWith("~/")) return join(homedir(), withoutAtPrefix.slice(2));
  return withoutAtPrefix;
}
