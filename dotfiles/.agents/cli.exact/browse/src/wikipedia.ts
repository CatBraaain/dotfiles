// Wikipedia-only parsing and fetching: article URL detection, MediaWiki
// action API retrieval (plain text extract) and Markdown shaping.
import { PARSE_TIMEOUT_MS } from "./config";

export interface WikipediaArticleUrl {
  lang: string;
  title: string;
  permalink: string;
}

// Spec: `<lang>.wikipedia.org/wiki/<title>` を記事 URL として扱う（www / m を
// strip）。名前空間付きのタイトル（File:, Talk: など）は extract 対象外とし
// 判別しない。
export function parseWikipediaUrl(rawUrl: string): WikipediaArticleUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const labels = url.hostname.toLowerCase().split(".");
  if (labels.length < 3) return undefined;
  if (labels[labels.length - 2] !== "wikipedia" || labels[labels.length - 1] !== "org") {
    return undefined;
  }
  const lang = labels.slice(0, -2).filter((label) => label !== "www" && label !== "m")[0];
  if (!lang) return undefined;
  const match = /^\/wiki\/([^/:]+)$/.exec(url.pathname);
  if (!match) return undefined;
  const title = decodeURIComponent(match[1]!);
  if (!title) return undefined;
  return {
    lang,
    title,
    permalink: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title).replaceAll("%2F", "/")}`,
  };
}

interface ExtractsResponse {
  query?: {
    pages?: Record<string, { title?: string; extract?: string }>;
  };
}

export function renderWikipediaMarkdown(
  title: string,
  permalink: string,
  extract: string,
): string {
  const paragraphs = extract.split(/\n\n+/).map((part) => part.trim()).filter(Boolean);
  const lines = [
    `# ${title}`,
    "",
    `- URL: ${permalink}`,
  ];
  if (paragraphs[0]) lines.push(`- Summary: ${paragraphs[0]}`);
  lines.push("", "## Article", "", extract.trim());
  return lines.join("\n").trim();
}

// Spec: MediaWiki action API で plain text の本文を出力する。
export async function fetchWikipediaMarkdown(rawUrl: string): Promise<string> {
  const target = parseWikipediaUrl(rawUrl);
  if (!target) throw new Error(`Not a supported Wikipedia article URL: ${rawUrl}`);
  const api = new URL(`https://${target.lang}.wikipedia.org/w/api.php`);
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("prop", "extracts");
  api.searchParams.set("explaintext", "1");
  api.searchParams.set("redirects", "1");
  api.searchParams.set("titles", target.title);
  const response = await fetch(api, {
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`MediaWiki API ${response.status} ${response.statusText}`);
  const payload = (await response.json()) as ExtractsResponse;
  const page = Object.values(payload.query?.pages ?? {})[0];
  const extract = page?.extract;
  if (!extract || !extract.trim()) {
    throw new Error(`no plain text extract for ${target.title}`);
  }
  return renderWikipediaMarkdown(page?.title ?? target.title, target.permalink, extract);
}
