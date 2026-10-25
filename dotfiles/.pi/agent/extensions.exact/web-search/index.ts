// Thin pi wrapper that adapts tool input and output to the `browse` CLI.

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  return join(browseCliDir(env), "browse");
}

// --- registered bash execution ---

export type WebCliResult = { stdout: string; stderr: string; code: number };

export const WEB_CLI_TIMEOUT_MS = 300_000;

type WebCliContext = Pick<ExtensionToolContext, "executeTool">;

function quoteShell(argument: string): string {
  if (argument.includes("\0")) throw new Error("CLI argument contains a NUL byte");
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}

export async function runWebCli(
  ctx: WebCliContext,
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<WebCliResult> {
  if (signal?.aborted) throw new Error(`${executable} aborted`);
  const invocation = [executable, ...args].map(quoteShell).join(" ");
  const command = [
    "set -o pipefail",
    "web_cli_tmp=$(mktemp -d /tmp/pi-web-cli.XXXXXXXXXX) || exit",
    "trap 'rm -rf -- \"$web_cli_tmp\"' EXIT",
    "web_cli_code=0",
    `${invocation} >"$web_cli_tmp/stdout" 2>"$web_cli_tmp/stderr" || web_cli_code=$?`,
    "printf 'PI_WEB_CLI_V1:%s\\n' \"$web_cli_code\"",
    "base64 <\"$web_cli_tmp/stdout\" | tr -d '\\n' || exit",
    "printf '\\n'",
    "base64 <\"$web_cli_tmp/stderr\" | tr -d '\\n' || exit",
    "printf '\\nPI_WEB_CLI_END\\n'",
  ].join("\n");
  const bash = await executeRegisteredBash(ctx, command, signal);
  const output = bash.truncated
    ? await recoverBashOutput(ctx, bash.full_output_path, signal)
    : bash.output;
  const frame =
    /^PI_WEB_CLI_V1:(\d+)\n([A-Za-z0-9+/=]*)\n([A-Za-z0-9+/=]*)\nPI_WEB_CLI_END\n$/.exec(output);
  if (!frame) throw new Error("Registered bash returned an invalid CLI output frame");
  const code = Number(frame[1]);
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Error("Registered bash returned an invalid CLI exit code");
  }
  return { code, stdout: decodeStream(frame[2]!), stderr: decodeStream(frame[3]!) };
}

type BashOutput = { output: string; truncated: boolean; full_output_path?: unknown };

async function executeRegisteredBash(
  ctx: WebCliContext,
  command: string,
  signal?: AbortSignal,
): Promise<BashOutput> {
  if (signal?.aborted) throw new Error("Registered bash aborted");
  const outcome = await ctx.executeTool(
    "bash",
    { command, timeout: WEB_CLI_TIMEOUT_MS / 1000 },
    { signal },
  );
  if (signal?.aborted) throw new Error("Registered bash aborted");
  if (outcome.isError) {
    throw new Error(resultText(outcome.result) ?? "Registered bash failed");
  }
  const bash = outcome.result.structuredContent as
    | { output?: unknown; truncated?: unknown; exit_code?: unknown; full_output_path?: unknown }
    | undefined;
  if (!bash || typeof bash.output !== "string" || typeof bash.truncated !== "boolean") {
    throw new Error("Registered bash returned invalid structured output");
  }
  if (bash.exit_code !== 0) throw new Error(`Registered bash exited with code ${bash.exit_code}`);
  return {
    output: bash.output,
    truncated: bash.truncated,
    full_output_path: bash.full_output_path,
  };
}

async function recoverBashOutput(
  ctx: WebCliContext,
  path: unknown,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw new Error("Truncated registered bash output has no valid full_output_path");
  }
  const quotedPath = quoteShell(path);
  const sizeResult = await executeRegisteredBash(ctx, `wc -c < ${quotedPath}`, signal);
  const sizeText = sizeResult.output.trim();
  const sizeBytes = Number(sizeText);
  if (
    sizeResult.truncated ||
    !/^\d+$/.test(sizeText) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    throw new Error("Registered bash returned an invalid full output size");
  }

  const chunkBytes = 524_288;
  const chunks: string[] = [];
  for (let offsetBytes = 0; offsetBytes < sizeBytes; offsetBytes += chunkBytes) {
    const chunk = await executeRegisteredBash(
      ctx,
      `dd if=${quotedPath} bs=${chunkBytes} skip=${offsetBytes / chunkBytes} count=1 status=none`,
      signal,
    );
    const expectedBytes = Math.min(chunkBytes, sizeBytes - offsetBytes);
    if (chunk.truncated || Buffer.byteLength(chunk.output, "utf8") !== expectedBytes) {
      throw new Error("Registered bash full output recovery was truncated or incomplete");
    }
    chunks.push(chunk.output);
  }
  return chunks.join("");
}

function decodeStream(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Invalid CLI stream encoding");
  return bytes.toString("utf8");
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

function resultText(result: {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}): string | undefined {
  return result.content?.find((block) => block.type === "text")?.text?.trim() || undefined;
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
        onUpdate?.({ content: [], details: { error: errorMessage(error) } });
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a single URL as Markdown.",
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
        onUpdate?.({ content: [], details: { error: errorMessage(error) } });
        throw error;
      }
    },
  });
}
