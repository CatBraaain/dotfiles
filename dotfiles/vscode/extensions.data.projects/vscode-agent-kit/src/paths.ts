import { join, resolve } from "node:path";

/** Environment variables used to locate Pi's agent and session directories. */
export interface PiPathEnv {
  PI_CODING_AGENT_DIR?: string | undefined;
  PI_CODING_AGENT_SESSION_DIR?: string | undefined;
}

/**
 * Resolve Pi's agent directory: `PI_CODING_AGENT_DIR` when set (non-empty),
 * otherwise `~/.pi/agent` (homeDir + ".pi/agent"). Empty string falls back,
 * matching pi's own truthiness check.
 */
export function resolveAgentDir(env: PiPathEnv, homeDir: string): string {
  return env.PI_CODING_AGENT_DIR || join(homeDir, ".pi", "agent");
}

/** Resolve Pi's session directory: `PI_CODING_AGENT_SESSION_DIR` when set, otherwise `<agentDir>/sessions`. */
export function resolveSessionDir(env: PiPathEnv, homeDir: string): string {
  return env.PI_CODING_AGENT_SESSION_DIR || join(resolveAgentDir(env, homeDir), "sessions");
}

/** Path of the session state store inside the agent directory. The store is
 * shared with the pi extension `session-state`, which writes it on every
 * sent message and phase change. */
export function sessionStatePath(agentDir: string): string {
  return join(agentDir, "session-state.json");
}

/**
 * Encode a cwd into Pi's session group directory name:
 * leading separator stripped, then every `/`, `\`, and `:` replaced with `-`,
 * wrapped in `--`/`--`. Mirrors pi's getDefaultSessionDirPath.
 * e.g. "/home/username" -> "--home-username--".
 */
export function encodeCwdDirName(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
