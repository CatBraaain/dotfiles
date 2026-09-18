/**
 * dotfiles-dsh-web-search — host providers for the dsh web seam (`ctx.web`).
 *
 * Thin wrapper over the `browse` CLI (`dotfiles/.agents/cli`, deployed to
 * `~/.agents/cli/`): each provider call spawns the CLI's search / fetch
 * subcommand with `--json`, assembles the contract result from the stdout
 * JSON, and propagates CLI failures as `WebError`. The exploration chain
 * (engine order, challenge detection, Reddit / StackOverflow routes, server
 * bootstrap, timeouts) is owned by the CLI — its behavior contract is
 * `dotfiles/.agents/cli/browse.spec.md`; this plugin's contract is SPEC.md.
 *
 * `run_after_build.sh` bundles this entry: relative imports are inlined and only
 * the script's explicit bare-specifier externals stay external. The shared
 * machine-scoped camoufox server lives inside the CLI; `browse start` (spawned
 * by the CLI itself and by the shared startup script) brings it up.
 */
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import type { Context } from "@deepseek-ai/cordis";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// --- plugin entry ---

export const name = "dsh-web-search";
export const inject = ["web"];

export interface WebSearchPluginConfig {
  readonly camoufoxBaseUrl?: string;
  readonly openserpBaseUrl?: string;
}

export const Config = z.object({
  camoufoxBaseUrl: z.string(),
  openserpBaseUrl: z.string(),
});

export const CAMOUFOX_DEFAULT_BASE_URL = "ws://127.0.0.1:9378/camoufox";
export const OPENSERP_DEFAULT_BASE_URL = "http://127.0.0.1:7000";

export interface ServerEndpoints {
  readonly camoufoxBaseUrl: string;
  readonly openserpBaseUrl: string;
}

// SPEC §"設定": priority is config value > environment variable > default.
export function resolveEndpoints(
  config: WebSearchPluginConfig = {},
  env: Record<string, string | undefined> = process.env,
): ServerEndpoints {
  return {
    camoufoxBaseUrl: config.camoufoxBaseUrl ?? env.CAMOUFOX_BASE_URL ?? CAMOUFOX_DEFAULT_BASE_URL,
    openserpBaseUrl: config.openserpBaseUrl ?? env.OPENSERP_BASE_URL ?? OPENSERP_DEFAULT_BASE_URL,
  };
}

// SPEC §"提供する plugin": register both providers. Server priming moved to the
// shared `~/.agents/scripts/startup` script
// (dotfiles/.agents/scripts/startup.spec.md).
export function apply(ctx: Context): void {
  const endpoints = resolveEndpoints();
  ctx.web.registerSearchProvider(new CamoufoxOpenserpSearchProvider(endpoints));
  ctx.web.registerFetchProvider(new CamoufoxTrafilaturaFetchProvider(endpoints));
}

// --- providers (contract layer) ---

export const SEARCH_PROVIDER_ID = "camoufox-openserp";
export const FETCH_PROVIDER_ID = "camoufox-trafilatura";

export type ProviderDeps = {
  /** Override for the local availability check used by `available()`. */
  prerequisitesMet?: () => boolean;
  /** Override for the CLI subprocess execution (tests). */
  exec?: CliExec;
};

// Convert any CLI-subprocess failure into the seam's WebError. The CLI's
// stderr message (per-engine failure lines, kill hint) is carried over
// verbatim; `cause` keeps the original error for inspection.
export function toWebError(error: unknown): WebError {
  if (error instanceof WebError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WebError(message, "WEB_PROVIDER_ERROR", { cause: error });
}

export class CamoufoxOpenserpSearchProvider implements WebSearchProvider {
  readonly id = SEARCH_PROVIDER_ID;

  constructor(
    private readonly endpoints: ServerEndpoints,
    private readonly deps: ProviderDeps = {},
  ) {}

  // SPEC §"search provider": PATH binaries + camoufox executable, no network.
  available(): boolean {
    return (this.deps.prerequisitesMet ?? hostPrerequisitesMet)();
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    try {
      // SPEC §"search provider": spawn the CLI with the query and --json; the
      // engine chain, serialization, and server bootstrap live in the CLI.
      const json = await runWebCli(
        "search",
        [request.query, "--json"],
        this.endpoints,
        signal,
        this.deps.exec,
      );
      return { sources: toSearchSources(json), truncated: false };
    } catch (error) {
      throw toWebError(error);
    }
  }
}

export class CamoufoxTrafilaturaFetchProvider implements WebFetchProvider {
  readonly id = FETCH_PROVIDER_ID;

  constructor(
    private readonly endpoints: ServerEndpoints,
    private readonly deps: ProviderDeps = {},
  ) {}

  // SPEC §"fetch provider": same condition as the search provider.
  available(): boolean {
    return (this.deps.prerequisitesMet ?? hostPrerequisitesMet)();
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    try {
      // SPEC §"fetch provider": the URL fixes the route (Reddit /
      // StackOverflow / camoufox+trafilatura) inside the CLI.
      const json = await runWebCli(
        "fetch",
        [request.url, "--json"],
        this.endpoints,
        signal,
        this.deps.exec,
      );
      return toFetchResult(json);
    } catch (error) {
      throw toWebError(error);
    }
  }
}

// --- CLI subprocess wiring ---

export type BrowseSubcommand = "search" | "fetch";

// SPEC §"提供する plugin": the browse CLI lives in ~/.agents/cli (deployed
// from dotfiles/.agents/cli by chezmoi). BROWSE_CLI_DIR overrides the
// directory for tests and manual development (same convention as the pi
// wrapper). Unlike the pi extension, the bundle always runs from the deployed
// plugin directory, so the default resolves from the home directory rather
// than relative to this module.
export function browseCliDir(env: Record<string, string | undefined> = process.env): string {
  return env.BROWSE_CLI_DIR ?? join(homedir(), ".agents", "cli");
}

// The source tree keeps the chezmoi ".executable" suffix; the deployed copy
// is a plain "browse" with the exec bit set. The CLI is spawned through
// `bun <script>`, so only the file has to exist.
export function browseScript(env: Record<string, string | undefined> = process.env): string {
  const sourceName = join(browseCliDir(env), "browse.executable");
  return existsSync(sourceName) ? sourceName : join(browseCliDir(env), "browse");
}

// The CLI reads its connect targets from these env vars; the plugin's resolved
// config (config value > env > default) always wins in the child.
export function buildCliEnv(
  endpoints: ServerEndpoints,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...env,
    CAMOUFOX_BASE_URL: endpoints.camoufoxBaseUrl,
    OPENSERP_BASE_URL: endpoints.openserpBaseUrl,
  };
}

export interface CliSpawnOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliSpawnOptions {
  readonly signal?: AbortSignal;
  readonly env: Record<string, string | undefined>;
  readonly maxBuffer: number;
}

export type CliExec = (
  command: string,
  args: readonly string[],
  options: CliSpawnOptions,
) => Promise<CliSpawnOutput>;

// JSON bodies can reach markdown sizes; match the CLI's own generous stdout cap.
export const CLI_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

export function execCli(
  command: string,
  args: readonly string[],
  options: CliSpawnOptions,
): Promise<CliSpawnOutput> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error: Error | null, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

// SPEC §"エラー伝播": a non-zero CLI exit reports one stderr line (the
// AllBackendsFailedError message); prefer it over the bare spawn error text.
export function cliErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { stderr?: unknown }).stderr === "string"
  ) {
    const stderr = (error as { stderr: string }).stderr.trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

// Spawn the CLI (bun <resolved script> <subcommand> <args...>) and parse its
// --json stdout. Rejects on spawn failure, abort, non-zero exit, or
// unparsable output.
export async function runWebCli(
  subcommand: BrowseSubcommand,
  args: readonly string[],
  endpoints: ServerEndpoints,
  signal?: AbortSignal,
  exec: CliExec = execCli,
): Promise<unknown> {
  const output = await exec("bun", [browseScript(), subcommand, ...args], {
    signal,
    env: buildCliEnv(endpoints),
    maxBuffer: CLI_OUTPUT_MAX_BUFFER,
  }).catch((error: unknown) => {
    throw new Error(cliErrorMessage(error));
  });
  try {
    return JSON.parse(output.stdout);
  } catch (error) {
    throw new Error(
      `browse ${subcommand} CLI emitted unparsable output: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// --- CLI JSON -> seam result mapping ---

// `browse search --json` output (browse.spec.md §`browse search`): query,
// engine, tookMs, results[] whose entries omit missing fields. urls arrive
// raw from openserp.
export interface CliSearchResult {
  readonly rank?: number;
  readonly title?: string;
  readonly url?: string;
  readonly display_url?: string;
  readonly type?: string;
  readonly snippet?: string;
}

export interface CliSearchJson {
  readonly query: string;
  readonly engine: string;
  readonly tookMs: number;
  readonly results: readonly CliSearchResult[];
}

// `browse fetch --json` output (browse.spec.md §`browse fetch`): url is
// already normalized (Reddit / StackOverflow permalinks), body is markdown,
// and fallbacks records failed attempts before the successful backend.
export interface CliFetchJson {
  readonly url: string;
  readonly backend: string;
  readonly title?: string;
  readonly body: string;
  readonly tookMs: number;
  readonly fallbacks?: readonly {
    readonly backend: string;
    readonly error: string;
  }[];
}

// openserp passes raw SERP hrefs through unmodified, and engines serve some of
// them relative to their origin (google: `/goto?url=...`, also
// protocol-relative), so each URL resolves against the engine origin.
const SERP_ORIGIN_BY_ENGINE: Readonly<Record<string, string>> = {
  google: "https://www.google.com",
  duckduckgo: "https://duckduckgo.com",
  bing: "https://www.bing.com",
};

// Map the CLI search JSON to seam sources: URL required (entries without one
// are unusable as citation sources and dropped, like entries whose URL cannot
// parse against the engine origin), title and snippet omitted when blank — the
// seam forbids inventing them. The CLI already caps and rank-orders results.
export function toSearchSources(json: unknown): WebSearchSource[] {
  if (
    typeof json !== "object" ||
    json === null ||
    !Array.isArray((json as CliSearchJson).results)
  ) {
    throw new Error(`unexpected browse search CLI output: ${describeJson(json)}`);
  }
  const { engine, results } = json as CliSearchJson;
  const origin = typeof engine === "string" ? SERP_ORIGIN_BY_ENGINE[engine] : undefined;
  const sources: WebSearchSource[] = [];
  for (const entry of results) {
    const rawUrl = entry?.url?.trim();
    if (!rawUrl) continue;
    let url: string;
    try {
      url = new URL(rawUrl, origin).toString();
    } catch {
      continue;
    }
    const title = entry.title?.trim();
    const snippet = entry.snippet?.trim();
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return sources;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Format the successful fetch line when the CLI had to use a fallback. */
export function formatFetchFallbackLine(json: CliFetchJson): string | undefined {
  if (!json.fallbacks?.length) return undefined;
  const title = json.title ? ` - "${json.title}"` : "";
  const fallback = json.fallbacks
    .map((attempt) => `${attempt.backend}: ${oneLine(attempt.error)}`)
    .join("; ");
  return `✓ ${json.backend}${title} (fallback: ${fallback}) (${(json.tookMs / 1000).toFixed(1)}s)`;
}

// SPEC §"fetch provider": statusCode is fixed at 200 (the CLI reports fetch
// failures as errors, not as result bodies) and the result URL is the CLI
// JSON's normalized url.
export function toFetchResult(json: unknown): WebFetchResult {
  if (typeof json !== "object" || json === null) {
    throw new Error(`unexpected browse fetch CLI output: ${describeJson(json)}`);
  }
  const { url, body } = json as CliFetchJson;
  if (typeof url !== "string" || !url) {
    throw new Error(`unexpected browse fetch CLI output: ${describeJson(json)}`);
  }
  if (typeof body !== "string") {
    throw new Error(`unexpected browse fetch CLI output: ${describeJson(json)}`);
  }
  const fallbackLine = formatFetchFallbackLine(json as CliFetchJson);
  return {
    url,
    statusCode: 200,
    body: { kind: "text", content: fallbackLine ? `${fallbackLine}\n\n${body}` : body },
    truncated: false,
  };
}

function describeJson(json: unknown): string {
  return JSON.stringify(json)?.slice(0, 200) ?? String(json);
}

// --- local availability check (SPEC §"search provider" available()) ---

export const REQUIRED_BINARIES = ["bun", "openserp", "playwright-cli"] as const;

// SPEC §"search provider": camoufox browser executable location (env override,
// default ~/.cache/camoufox/camoufox-bin).
export function camoufoxExecutablePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CAMOUFOX_EXECUTABLE_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox-bin");
}

// Locate a binary by scanning PATH directories locally; no subprocess, no
// network. Windows resolves through PATHEXT extension candidates.
export function binaryOnPath(
  binaryName: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const pathDirectories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidateNames =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((ext) => `${binaryName}${ext.toLowerCase()}`)
      : [binaryName];
  return pathDirectories.some((directory) =>
    candidateNames.some((candidate) => {
      try {
        accessSync(join(directory, candidate), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

// The CLI drives openserp, playwright-cli, and the camoufox browser itself,
// so the host prerequisites stay the same as before the browse conversion.
export function hostPrerequisitesMet(
  env: Record<string, string | undefined> = process.env,
  deps: { binaryOnPath?: typeof binaryOnPath; fileExists?: (path: string) => boolean } = {},
): boolean {
  const findBinary = deps.binaryOnPath ?? binaryOnPath;
  const fileExists = deps.fileExists ?? existsSync;
  return (
    REQUIRED_BINARIES.every((binaryName) => findBinary(binaryName, env)) &&
    fileExists(camoufoxExecutablePath(env))
  );
}
