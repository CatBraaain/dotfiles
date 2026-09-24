// Thin pi extension wrapping the `browse` CLI (dotfiles/.agents/cli/, spec:
// browse.spec.md). The tools spawn the CLI's search / fetch subcommands as a
// child process, turn its --json stdout into tool text + details, and
// propagate non-zero exits as tool errors. All search/fetch behavior
// (backends, challenge handling, server bootstrap, flock serialization)
// lives in the CLI.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

// --- CLI path resolution ---

// Four levels up reaches .agents/cli in both layouts: the source tree has
// .pi/agent/extensions.exact/web-search -> dotfiles/.agents/cli, the deployed
// tree has .pi/agent/extensions/web-search -> ~/.agents/cli. BROWSE_CLI_DIR
// overrides both for tests and manual development.
export function browseCliDir(env: Record<string, string | undefined> = process.env): string {
  return env.BROWSE_CLI_DIR ?? join(EXTENSION_DIR, "..", "..", "..", "..", ".agents", "cli");
}

// The source tree keeps the ".executable" suffix; the deployed copy
// is a plain "browse" with the exec bit set. The CLI is spawned through
// `bun <script>`, so only the file has to exist.
export function browseScript(env: Record<string, string | undefined> = process.env): string {
  const sourceName = join(browseCliDir(env), "browse.executable");
  return existsSync(sourceName) ? sourceName : join(browseCliDir(env), "browse");
}

// --- child process execution ---

export type WebCliResult = { stdout: string; stderr: string; code: number | null };

export type RunWebCli = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<WebCliResult>;

export async function runWebCli(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<WebCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    const killChild = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", killChild, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", killChild);
      resolve({ stdout, stderr, code });
    });
  });
}

export type WebCliDeps = {
  runCli?: RunWebCli;
  env?: Record<string, string | undefined>;
};

// Spec (browse.spec.md "--json のフィールド"): search returns query, engine,
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
): Promise<T> {
  const run = deps.runCli ?? runWebCli;
  const subcommand = kind === "web-search" ? "search" : "fetch";
  const script = browseScript(deps.env ?? process.env);
  let result: WebCliResult;
  try {
    result = await run("bun", [script, subcommand, ...args], signal);
  } catch (error) {
    throw new Error(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.code !== 0) {
    // The CLI reports failures as a single stderr line (plus an optional
    // recovery hint on the next line), so stderr is the error message.
    const message =
      result.stderr.trim() ||
      (result.code === null
        ? `${kind} terminated by signal`
        : `${kind} exited with code ${result.code}`);
    throw new Error(message);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${kind}: CLI stdout is not JSON`);
  }
}

// --- tool output shaping ---

// Spec (browse.spec.md "markdown 出力の構造"): a meta line, then one block per
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

export type WebToolDetails = {
  engine?: string;
  backend?: string;
  title?: string;
  tookMs?: number;
  fallback?: string;
  error?: string;
};

// --- TUI rendering ---

// pi may render a result whose details only arrived through onUpdate (e.g.
// the error path throws before a final result), so mirror the last seen
// details into the render state. Thrown tool results have an empty details
// object, which must not replace the error details from onUpdate.
type WebRenderState = { details?: WebToolDetails };

function detailsForRender(
  result: { details?: unknown },
  state?: WebRenderState,
): WebToolDetails | undefined {
  const details = result.details as WebToolDetails | undefined;
  const hasDetails = details !== undefined && Object.keys(details).length > 0;
  if (hasDetails && state) state.details = details;
  return hasDetails ? details : state?.details;
}

function resultText(result: {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}): string | undefined {
  return result.content?.find((block) => block.type === "text")?.text?.trim() || undefined;
}

function tookSuffix(tookMs: number | undefined): string {
  return typeof tookMs === "number" ? ` (${(tookMs / 1000).toFixed(1)}s)` : "";
}

function fallbackSuffix(fallback: string | undefined): string {
  return fallback ? ` (fallback: ${fallback})` : "";
}

// Spec (SPEC.md §表示): `✓ <engine/backend> [- "<title>"] (1.2s)` on success,
// `✗ <cli> - "<message>"` on failure.
function successLine(name: string, details: WebToolDetails): string {
  const title = details.title ? ` - "${details.title}"` : "";
  return `✓ ${name}${title}${fallbackSuffix(details.fallback)}${tookSuffix(details.tookMs)}`;
}

function errorLine(kind: "web-search" | "web-fetch", message: string): string {
  return `✗ ${kind} - "${message}"`;
}

function failureLine(
  kind: "web-search" | "web-fetch",
  result: { content?: ReadonlyArray<{ type: string; text?: string }> },
  details: WebToolDetails | undefined,
  isError: boolean,
): string | undefined {
  if (!isError && !details?.error) return undefined;
  return errorLine(kind, details?.error ?? resultText(result) ?? "Error");
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
    description: "Search the web with a single query.",
    parameters: searchParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      const args = [params.query, ...(params.lang ? ["--lang", params.lang] : []), "--json"];
      try {
        const json = await runCliJson<SearchCliJson>("web-search", args, deps, signal);
        const text = formatSearchText(json);
        return {
          content: [{ type: "text", text }],
          details: { engine: json.engine, tookMs: json.tookMs } satisfies WebToolDetails,
        };
      } catch (error) {
        onUpdate?.({ content: [], details: { error: errorMessage(error) } });
        throw error;
      }
    },
    renderCall(args, theme) {
      const langSuffix = args.lang ? ` [lang=${args.lang}]` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`web_search - "${args.query ?? ""}"${langSuffix}`)),
        0,
        0,
      );
    },
    renderResult(result, _options, _theme, context) {
      const details = detailsForRender(result, context?.state as WebRenderState | undefined);
      const failure = failureLine("web-search", result, details, context?.isError ?? false);
      if (failure) return new Text(failure, 0, 0);
      if (!details) return new Text("", 0, 0);
      return new Text(successLine(details.engine ?? "", details), 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a single URL as Markdown.",
    parameters: fetchParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        const json = await runCliJson<FetchCliJson>(
          "web-fetch",
          [params.url, "--json"],
          deps,
          signal,
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
        onUpdate?.({ content: [], details: { error: errorMessage(error) } });
        throw error;
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(`web_fetch - "${args.url ?? ""}"`)), 0, 0);
    },
    renderResult(result, _options, _theme, context) {
      const details = detailsForRender(result, context?.state as WebRenderState | undefined);
      const failure = failureLine("web-fetch", result, details, context?.isError ?? false);
      if (failure) return new Text(failure, 0, 0);
      if (!details) return new Text("", 0, 0);
      return new Text(successLine(details.backend ?? "", details), 0, 0);
    },
  });
}
