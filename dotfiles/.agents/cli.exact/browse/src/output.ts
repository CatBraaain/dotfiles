// Output shaping: rank search results and shape the Markdown / JSON payloads
// for the search and fetch commands.
import type { FetchOutcome } from "./fetch";
import { parseArxivUrl } from "./arxiv";
import { parseGitHubUrl } from "./github";
import { parseHackerNewsUrl } from "./hackernews";
import { parseRedditPostUrl } from "./reddit";
import type { SearchOutcome } from "./search";
import type { OpenserpSearchResult } from "./serp";
import { parseStackOverflowQuestionUrl } from "./stackoverflow";
import { parseTweetUrl } from "./twitter";
import { parseWikipediaUrl } from "./wikipedia";
import { parseYouTubeUrl } from "./youtube";

const SEARCH_RESULT_LIMIT = 10;

function rankedSearchResults(
  results: readonly OpenserpSearchResult[],
  limit: number = SEARCH_RESULT_LIMIT,
): OpenserpSearchResult[] {
  return [...results].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, limit);
}

// Spec: 結果ごとに `### <番号>. <title>`、`**<display_url>** - <type>`、
// スニペット、`-> <url>` の順のブロック。欠損フィールドの行は省略し、
// タイトル欠損は URL、それも無ければ (no title) とする。
function formatOpenserpResults(results: readonly OpenserpSearchResult[]): string {
  return rankedSearchResults(results)
    .map((entry, index) => {
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
    })
    .join("\n\n");
}

// Spec: 1 行目に `**Query:** "<query>" - **Engines:** <engine> - **Took:** <秒>s`。
export function formatSearchMarkdown(query: string, outcome: SearchOutcome): string {
  const tookSeconds = (outcome.tookMs / 1000).toFixed(1);
  const metaLine = `**Query:** ${JSON.stringify(query)} - **Engines:** ${outcome.engine} - **Took:** ${tookSeconds}s`;
  return `${metaLine}\n\n${formatOpenserpResults(outcome.results)}`;
}

// Spec: `--json` のフィールド: query、engine、tookMs、results（各要素は rank、
// title、url、display_url、type、snippet。欠損フィールドは省略）。
export function searchJson(query: string, outcome: SearchOutcome): Record<string, unknown> {
  const results = rankedSearchResults(outcome.results).map((entry) => {
    const item: Record<string, unknown> = {};
    if (typeof entry.rank === "number") item.rank = entry.rank;
    if (entry.title?.trim()) item.title = entry.title.trim();
    if (entry.url?.trim()) item.url = entry.url.trim();
    if (entry.display_url?.trim()) item.display_url = entry.display_url.trim();
    if (entry.type?.trim()) item.type = entry.type.trim();
    if (entry.snippet?.trim()) item.snippet = entry.snippet.trim();
    return item;
  });
  return { query, engine: outcome.engine, tookMs: outcome.tookMs, results };
}

const H1_TITLE = /^# (.+)$/m;
const NUMBERED_HEADING_TITLE = /^#{2,3} \d+\. (.+)$/m;

// Spec: fetch の title は取得済み本文（Markdown）の見出しからのみ取り出す。
// h1 に加えて `## <数字>. <タイトル>` / `### <数字>. <タイトル>` も扱う。
function titleFromMarkdown(markdown: string): string | null {
  const match = H1_TITLE.exec(markdown) ?? NUMBERED_HEADING_TITLE.exec(markdown);
  return match?.[1]?.trim() || null;
}

// Spec: `--json` の url は専用 backend の permalink に正規化。
function normalizedFetchUrl(rawUrl: string): string {
  return (
    parseRedditPostUrl(rawUrl)?.permalink ??
    parseStackOverflowQuestionUrl(rawUrl)?.permalink ??
    parseYouTubeUrl(rawUrl)?.permalink ??
    parseTweetUrl(rawUrl)?.permalink ??
    parseGitHubUrl(rawUrl)?.permalink ??
    parseHackerNewsUrl(rawUrl)?.permalink ??
    parseWikipediaUrl(rawUrl)?.permalink ??
    parseArxivUrl(rawUrl)?.permalink ??
    rawUrl
  );
}

// Spec: `--json` のフィールド: url、backend、title、body、tookMs、fallbacks。
export function fetchJson(url: string, outcome: FetchOutcome): Record<string, unknown> {
  const title = titleFromMarkdown(outcome.markdown);
  return {
    url: normalizedFetchUrl(url),
    backend: outcome.backend,
    ...(title ? { title } : {}),
    body: outcome.markdown,
    tookMs: outcome.tookMs,
    ...(outcome.fallbacks.length > 0 ? { fallbacks: outcome.fallbacks } : {}),
  };
}


