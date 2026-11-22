import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function subagentSessionDir(cwd: string): string {
  const cwdKey = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", cwdKey, "subagents");
}
