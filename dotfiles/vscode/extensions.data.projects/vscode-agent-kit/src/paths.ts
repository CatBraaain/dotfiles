import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./guards";

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

export async function resolveConfiguredSessionRoot(
  env: PiPathEnv,
  homeDir: string,
  cwd: string,
): Promise<string> {
  if (env.PI_CODING_AGENT_SESSION_DIR) {
    return expandSessionPath(env.PI_CODING_AGENT_SESSION_DIR, homeDir, cwd);
  }
  const agentSettings = await readSessionDirSetting(
    join(resolveAgentDir(env, homeDir), "settings.json"),
    homeDir,
    cwd,
  );
  const projectSettings = await readSessionDirSetting(
    join(cwd, ".pi", "settings.json"),
    homeDir,
    cwd,
  );
  return projectSettings ?? agentSettings ?? resolveSessionDir(env, homeDir);
}

async function readSessionDirSetting(
  settingsPath: string,
  homeDir: string,
  cwd: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    throw new Error(`Invalid settings in ${settingsPath}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid settings in ${settingsPath}`);
  if (!("sessionDir" in parsed)) return undefined;
  const { sessionDir } = parsed;
  if (typeof sessionDir !== "string") throw new Error(`Invalid sessionDir in ${settingsPath}`);
  return expandSessionPath(sessionDir, homeDir, cwd);
}

function expandSessionPath(path: string, homeDir: string, cwd: string): string {
  if (path.startsWith("file://")) return fileURLToPath(path);
  const expanded =
    path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
  return resolve(cwd, expanded);
}

function parseJsonc(text: string): unknown {
  const tokens: string[] = [];
  let previousToken = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") end += 2;
        else if (text[end++] === '"') break;
      }
      tokens.push(text.slice(index, end));
      previousToken = tokens.length - 1;
      index = end - 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      tokens.push("\n");
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      if (index >= text.length) throw new SyntaxError("Unterminated JSONC comment");
      index += 1;
      tokens.push(" ");
      continue;
    }
    if ((character === "}" || character === "]") && tokens[previousToken] === ",") {
      tokens[previousToken] = "";
    }
    tokens.push(character);
    if (!/\s/.test(character)) previousToken = tokens.length - 1;
  }
  return JSON.parse(tokens.join(""));
}
