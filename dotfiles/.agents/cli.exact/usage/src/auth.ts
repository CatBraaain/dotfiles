import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedAuth } from "./types";

export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
  zai: "ZAI_API_KEY",
};

export type AuthResolution =
  | { status: "resolved"; type: "oauth" | "api_key"; auth: ResolvedAuth }
  | { status: "unavailable"; message: string };

export interface AuthOptions {
  homeDir?: string;
  variables?: Record<string, string | undefined>;
  now?: () => number;
}

export interface AuthContext {
  credentials: Record<string, unknown>;
  variables: Record<string, string | undefined>;
  defaultProvider?: string;
  now: () => number;
}

export async function loadAuthContext(options: AuthOptions = {}): Promise<AuthContext> {
  const variables = options.variables ?? process.env;
  const agentDir = join(options.homeDir ?? variables.HOME ?? homedir(), ".pi", "agent");
  const [credentials, settings] = await Promise.all([
    readJsonObject(join(agentDir, "auth.json"), "auth.json"),
    readJsonObject(join(agentDir, "settings.json"), "settings.json"),
  ]);
  return {
    credentials,
    variables,
    defaultProvider:
      typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
    now: options.now ?? Date.now,
  };
}

export function canonicalProviderId(providerId: string): string {
  return providerId === "commandcode" ? "command-code" : providerId;
}

function credentialIds(providerId: string): string[] {
  if (providerId === "commandcode") return ["commandcode", "command-code"];
  if (providerId === "command-code") return ["command-code", "commandcode"];
  return [providerId];
}

export function hasConfiguredAuth(providerId: string, context: AuthContext): boolean {
  if (credentialIds(providerId).some((id) => Object.hasOwn(context.credentials, id))) return true;
  const variable = PROVIDER_ENV_VARS[providerId];
  return Boolean(variable && context.variables[variable]?.trim());
}

export function resolveAuth(providerId: string, context: AuthContext): AuthResolution {
  const storedId = credentialIds(providerId).find((id) => Object.hasOwn(context.credentials, id));
  if (storedId !== undefined) {
    return resolveStoredCredential(
      canonicalProviderId(providerId),
      context.credentials[storedId],
      context.now(),
    );
  }

  const variable = Object.hasOwn(PROVIDER_ENV_VARS, providerId)
    ? PROVIDER_ENV_VARS[providerId]
    : undefined;
  const key = variable ? context.variables[variable] : undefined;
  return key?.trim()
    ? apiKeyAuth(key)
    : { status: "unavailable", message: "No authentication configured." };
}

function resolveStoredCredential(
  providerId: string,
  credential: unknown,
  nowMs: number,
): AuthResolution {
  if (!isObject(credential)) return invalidCredential();
  if (credential.type === "oauth") {
    const { access, refresh, expires } = credential;
    if (
      typeof access !== "string" ||
      !access.trim() ||
      typeof refresh !== "string" ||
      typeof expires !== "number" ||
      !Number.isFinite(expires)
    )
      return invalidCredential();
    if (expires <= nowMs) {
      return {
        status: "unavailable",
        message: "OAuth credential has expired. Sign in again with pi.",
      };
    }
    const headers: Record<string, string> = {};
    if (providerId === "openai-codex") {
      if (
        typeof credential.accountId !== "string" ||
        !credential.accountId.trim() ||
        Array.from(credential.accountId).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || (code >= 127 && code <= 159);
        })
      ) {
        return {
          status: "unavailable",
          message: "Codex OAuth credential requires a valid accountId.",
        };
      }
      headers["ChatGPT-Account-Id"] = credential.accountId;
    }
    const authorization = `Bearer ${access}`;
    headers.Authorization = authorization;
    return {
      status: "resolved",
      type: "oauth",
      auth: {
        headers,
        secrets: [access, refresh, authorization, headers["ChatGPT-Account-Id"] ?? ""].filter(
          Boolean,
        ),
      },
    };
  }
  if (
    credential.type === "api_key" &&
    typeof credential.key === "string" &&
    credential.key.trim()
  ) {
    if (credential.key.startsWith("!")) {
      return { status: "unavailable", message: "Command-based API keys are not supported." };
    }
    return apiKeyAuth(credential.key);
  }
  return invalidCredential();
}

function apiKeyAuth(key: string): AuthResolution {
  const authorization = `Bearer ${key}`;
  return {
    status: "resolved",
    type: "api_key",
    auth: { apiKey: key, headers: { Authorization: authorization }, secrets: [key, authorization] },
  };
}

function invalidCredential(): AuthResolution {
  return { status: "unavailable", message: "Invalid stored credential." };
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new Error(`Unable to read ${label}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error(`Invalid ${label}: expected a JSON object.`);
  }
  if (!isObject(parsed)) throw new Error(`Invalid ${label}: expected a JSON object.`);
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
