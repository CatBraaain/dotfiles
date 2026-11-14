import { join } from "node:path";

export interface PiPathEnv {
  PI_CODING_AGENT_DIR?: string | undefined;
  PI_CODING_AGENT_SESSION_DIR?: string | undefined;
}

/** Falls back for an empty string too, matching pi's own truthiness check. */
export function resolveAgentDir(env: PiPathEnv, homeDir: string): string {
  return env.PI_CODING_AGENT_DIR || join(homeDir, ".pi", "agent");
}

export function resolveSessionDir(env: PiPathEnv, homeDir: string): string {
  return env.PI_CODING_AGENT_SESSION_DIR || join(resolveAgentDir(env, homeDir), "sessions");
}

export function sessionStatePath(agentDir: string): string {
  return join(agentDir, "session-state.json");
}
