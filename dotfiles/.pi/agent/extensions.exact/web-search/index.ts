// Thin pi wrapper that adapts tool input and output to the `browse` CLI.

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliExecutableName, CliFailure, runCliViaBash } from "../tools/cli.ts";
import type { CliResult, CliResponse } from "../tools/cli.ts";
export type WebToolDetails = {
  engine?: string;
  backend?: string;
  title?: string;
  tookMs?: number;
  fallback?: string;
  error?: string;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

// --- CLI path resolution ---

// Four levels up reaches .agents in both layouts. The source tree uses
// cli.exact, while the deployed tree uses cli. BROWSE_CLI_DIR overrides both.
export function browseCliDir(
  env: Record<string, string | undefined> = process.env,
  extensionDir = EXTENSION_DIR,
): string {
  const cliName = basename(dirname(extensionDir)) === "extensions.exact" ? "cli.exact" : "cli";
  return env.BROWSE_CLI_DIR ?? join(extensionDir, "..", "..", "..", "..", ".agents", cliName);
}

export function browseScript(env: Record<string, string | undefined> = process.env): string {
  return join(browseCliDir(env), cliExecutableName("browse"));
}

// --- registered bash execution ---

export type WebCliResult = CliResult & { bash: CliResponse };

export const WEB_CLI_TIMEOUT_MS = 300_000;

type WebCliContext = Pick<ExtensionToolContext, "executeTool">;

export async function runWebCli(
  ctx: WebCliContext,
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<WebCliResult> {
  const outcome = await runCliViaBash({
    context: ctx,
    params: { executable, args, timeout: WEB_CLI_TIMEOUT_MS / 1000 },
    signal,
  });
  if (outcome.status !== "completed") {
    const error =
      outcome.status === "aborted"
        ? new Error(`Registered bash aborted: ${String(outcome.reason)}`, { cause: outcome.reason })
        : outcome.error;
    if (outcome.result && outcome.isError !== undefined)
      throw new CliFailure(
        error instanceof Error ? error.message : String(error),
        { result: outcome.result, isError: outcome.isError },
        outcome.status === "aborted" ? { reason: outcome.reason } : { error: outcome.error },
      );
    if (outcome.status === "aborted")
      throw new CliFailure(`Registered bash aborted: ${String(outcome.reason)}`, undefined, {
        reason: outcome.reason,
      });
    throw error;
  }
  return { ...outcome.cli, bash: { result: outcome.result, isError: outcome.isError } };
}

export type WebCliDeps = {
  env?: Record<string, string | undefined>;
};

// Spec (browse/SPEC.md "--json のフィールド"): search returns query, engine,
// tookMs and results; fetch returns url, backend, title (optional), body,
// tookMs and fallbacks (optional). Fields absent from the CLI output stay
// undefined.
interface SearchCliJson {
  readonly query: string;
  readonly engine: string;
  readonly tookMs: number;
  readonly results: ReadonlyArray<{
    readonly title?: string;
    readonly url?: string;
    readonly display_url?: string;
    readonly type?: string;
    readonly snippet?: string;
  }>;
}

interface FetchCliJson {
  readonly backend: string;
  readonly title?: string;
  readonly body: string;
  readonly tookMs: number;
  readonly fallbacks?: ReadonlyArray<{
    readonly backend: string;
    readonly error: string;
  }>;
}

async function runCliJson<T>(
  kind: "web-search" | "web-fetch",
  args: readonly string[],
  deps: WebCliDeps,
  signal: AbortSignal | undefined,
  ctx: WebCliContext,
): Promise<T> {
  const subcommand = kind === "web-search" ? "search" : "fetch";
  const executable = browseScript(deps.env ?? process.env);
  let result: WebCliResult;
  try {
    result = await runWebCli(ctx, executable, [subcommand, ...args], signal);
  } catch (error) {
    if (error instanceof CliFailure) error.message = `${kind}: ${error.message}`;
    throw error;
  }
  if (result.code !== 0) {
    // The CLI reports failures as a single stderr line (plus an optional
    // recovery hint on the next line), so stderr is the error message.
    const message =
      result.stderr.trim() ||
      (result.code === null
        ? `${kind} terminated by signal`
        : `${kind} exited with code ${result.code}`);
    throw new CliFailure(message, result.bash);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new CliFailure(`${kind}: CLI stdout is not JSON`, result.bash);
  }
}

// --- tool output shaping ---

// Spec (browse/SPEC.md "markdown 出力の構造"): a meta line, then one block per
// result. Missing fields drop their line; a missing title falls back to the
// URL, then "(no title)". The CLI already ranks and limits results to 10.
export function formatSearchText(json: SearchCliJson): string {
  const tookSeconds = (json.tookMs / 1000).toFixed(1);
  const metaLine = `**Query:** ${JSON.stringify(json.query)} - **Engines:** ${json.engine} - **Took:** ${tookSeconds}s`;
  const blocks = json.results.map((entry, index) => {
    const title = entry.title?.trim() || entry.url?.trim() || "(no title)";
    const source = entry.display_url?.trim();
    const type = entry.type?.trim() || "organic";
    const url = entry.url?.trim();
    return [
      `### ${index + 1}. ${title}`,
      source ? `**${source}** - ${type}` : undefined,
      entry.snippet?.trim() || undefined,
      url ? `-> ${url}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
  });
  return [metaLine, ...blocks].join("\n\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const searchParameters = Type.Object({
  query: Type.String({ description: "Single search query" }),
  lang: Type.Optional(
    Type.String({
      description: "Language hint reflected in the search engine locale (e.g. EN, DE, JA).",
    }),
  ),
});
const fetchParameters = Type.Object({ url: Type.String({ description: "Absolute URL to fetch" }) });

export default function (pi: ExtensionAPI, deps: WebCliDeps = {}) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "1つの検索クエリでウェブを検索する。",
    parameters: searchParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const args = [params.query, ...(params.lang ? ["--lang", params.lang] : []), "--json"];
      try {
        const json = await runCliJson<SearchCliJson>("web-search", args, deps, signal, ctx);
        const text = formatSearchText(json);
        return {
          content: [{ type: "text", text }],
          details: { engine: json.engine, tookMs: json.tookMs } satisfies WebToolDetails,
        };
      } catch (error) {
        if (error instanceof CliFailure) {
          const failure = error.toolResult;
          onUpdate?.({
            ...failure,
            details: { ...(failure.details as object), error: errorMessage(error) },
          });
          return failure;
        }
        onUpdate?.({ content: [], details: { error: errorMessage(error) } });
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "1つの URL の内容を Markdown 形式で取得する。",
    parameters: fetchParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const json = await runCliJson<FetchCliJson>(
          "web-fetch",
          [params.url, "--json"],
          deps,
          signal,
          ctx,
        );
        const details: WebToolDetails = { backend: json.backend, tookMs: json.tookMs };
        if (json.title) details.title = json.title;
        if (json.fallbacks?.length) {
          details.fallback = json.fallbacks
            .map((attempt) => `${attempt.backend}: ${attempt.error}`.replace(/\s+/g, " "))
            .join("; ");
        }
        return { content: [{ type: "text", text: json.body }], details };
      } catch (error) {
        if (error instanceof CliFailure) {
          const failure = error.toolResult;
          onUpdate?.({
            ...failure,
            details: { ...(failure.details as object), error: errorMessage(error) },
          });
          return failure;
        }
        onUpdate?.({ content: [], details: { error: errorMessage(error) } });
        throw error;
      }
    },
  });
}
