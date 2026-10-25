import THIRD_PARTY_LICENSE from "../LICENSE" with { type: "text" };
import { ADAPTERS, adapterForProvider } from "./adapters";
import {
  canonicalProviderId,
  hasConfiguredAuth,
  loadAuthContext,
  resolveAuth,
  type AuthOptions,
} from "./auth";
import { renderUsageTable } from "./format";
import { summarizeProviderUsage } from "./summary";
import { queryProviders } from "./query";
import type { ProviderUsageState, UsageProviderAdapter } from "./types";
import { errorMessage, redactUsageError } from "./util";

export { THIRD_PARTY_LICENSE };

const USAGE = `usage: usage [<provider> ...] [--json]
       usage list [--json]`;

export interface RunEnv extends AuthOptions {
  adapters?: readonly UsageProviderAdapter[];
  renderProviderState?: (state: ProviderUsageState) => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface Options {
  positional: string[];
  json: boolean;
}

export async function run(argv: string[], env: RunEnv = {}): Promise<number> {
  const stdout = env.stdout ?? console.log;
  const stderr = env.stderr ?? console.error;
  const adapters = env.adapters ?? ADAPTERS;
  let options: Options;
  try {
    options = parseArgs(argv);
    validateProviders(options, adapters, env.adapters === undefined);
  } catch (error) {
    stderr(`usage: ${errorMessage(error)}`);
    stderr(USAGE);
    return 2;
  }
  try {
    const context = await loadAuthContext(env);
    if (options.positional[0] === "list") {
      const rows = adapters.map((adapter) => {
        const resolution = resolveAuth(adapter.id, context);
        return {
          id: adapter.id,
          displayName: adapter.displayName,
          semantics: adapter.semantics.kind,
          authenticated: resolution.status === "resolved",
          authType: resolution.status === "resolved" ? resolution.type : null,
        };
      });
      const output = options.json
        ? JSON.stringify(rows, null, 2)
        : rows
            .map(
              (row) =>
                `${row.id}\t${row.displayName}\t${row.semantics}\t${row.authenticated ? row.authType : "unavailable"}`,
            )
            .join("\n");
      if (output) stdout(output);
      return 0;
    }

    const requested = new Map<string, string>();
    for (const providerId of options.positional) {
      const canonicalId = canonicalProviderId(providerId);
      if (!requested.has(canonicalId) || providerId === canonicalId)
        requested.set(canonicalId, providerId);
    }
    const selected = adapters.filter((adapter) =>
      requested.size > 0 ? requested.has(adapter.id) : hasConfiguredAuth(adapter.id, context),
    );
    const states = await queryProviders(selected, {
      resolveAuth: (providerId) => resolveAuth(requested.get(providerId) ?? providerId, context),
      displayState: (providerId) =>
        providerId === canonicalProviderId(context.defaultProvider ?? "")
          ? "current"
          : "configured",
    });
    const output = options.json
      ? JSON.stringify(states.map(summarizeProviderUsage), null, 2)
      : renderUsageTable(states, env.renderProviderState);
    if (output) stdout(output);
    return states.length > 0 && states.every((state) => state.status !== "ready") ? 1 : 0;
  } catch (error) {
    stderr(`usage: ${redactUsageError(errorMessage(error))}`);
    return 1;
  }
}

function parseArgs(argv: string[]): Options {
  const options: Options = { positional: [], json: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function validateProviders(
  options: Options,
  adapters: readonly UsageProviderAdapter[],
  useRegistry: boolean,
): void {
  if (options.positional[0] === "list") {
    if (options.positional.length !== 1) throw new Error("list does not accept provider arguments");
    return;
  }
  for (const providerId of options.positional) {
    const adapter = useRegistry
      ? adapterForProvider(canonicalProviderId(providerId))
      : adapters.find((candidate) => candidate.id === canonicalProviderId(providerId));
    if (!adapter) throw new Error(`unknown provider: ${providerId}`);
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
