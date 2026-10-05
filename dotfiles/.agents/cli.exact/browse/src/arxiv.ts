// arXiv-only parsing and fetching: abs URL detection, arXiv API retrieval
// (title / authors / categories / abstract) and Markdown shaping.
import { PARSE_TIMEOUT_MS } from "./config";
import { atomText, unescapeEntities } from "./html";

export interface ArxivAbsUrl {
  arxivId: string;
  permalink: string;
}

// Spec: `arxiv.org/abs/<id>`（www 含む）。新形式 2401.12345 と旧形式
// math.GT/0309136 の両方を扱い、version suffix (v2) は正規化で落とす。
export function parseArxivUrl(rawUrl: string): ArxivAbsUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "arxiv.org" && hostname !== "www.arxiv.org") return undefined;
  const rawId = /^\/abs\/(.+)$/.exec(url.pathname)?.[1];
  if (!rawId) return undefined;
  const arxivId = rawId.replace(/v\d+$/i, "");
  if (!/^\d{4}\.\d{4,5}$/.test(arxivId) && !/^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/.test(arxivId)) {
    return undefined;
  }
  return { arxivId, permalink: `https://arxiv.org/abs/${arxivId}` };
}

export interface ArxivArticle {
  title: string;
  authors: string[];
  published?: string;
  updated?: string;
  categories: string[];
  comment?: string;
  abstract: string;
}

export function parseArxivAtom(xml: string): ArxivArticle | undefined {
  const entryMatch = /<entry\b[^>]*>([\s\S]*?)<\/entry>/.exec(xml);
  if (!entryMatch) return undefined;
  const entry = entryMatch[1] ?? "";
  const title = unescapeEntities(atomText(entry, "title") ?? "").replaceAll(/\s+/g, " ").trim();
  const abstract = unescapeEntities(atomText(entry, "summary") ?? "").replaceAll(/\s+/g, " ").trim();
  if (!title && !abstract) return undefined;
  const authors: string[] = [];
  for (const match of entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)) {
    const name = unescapeEntities(atomText(match[1] ?? "", "name") ?? "").trim();
    if (name) authors.push(name);
  }
  const categories = [...entry.matchAll(/<category\b[^>]*term="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  const comment = atomText(entry, "arxiv:comment");
  return {
    title,
    authors,
    published: atomText(entry, "published"),
    updated: atomText(entry, "updated"),
    categories,
    comment: comment ? unescapeEntities(comment).trim() : undefined,
    abstract,
  };
}

// Spec: arXiv API でタイトル・著者・カテゴリ・abstract を markdown で出力する。
export function renderArxivMarkdown(article: ArxivArticle, permalink: string): string {
  const lines = [
    `# ${article.title || "arXiv article"}`,
    "",
    `- Authors: ${article.authors.join(", ") || "unknown"}`,
    `- URL: ${permalink}`,
  ];
  if (article.published) lines.push(`- Published: ${article.published}`);
  if (article.updated) lines.push(`- Updated: ${article.updated}`);
  if (article.categories.length > 0) lines.push(`- Categories: ${article.categories.join(", ")}`);
  if (article.comment) lines.push(`- Comments: ${article.comment}`);
  lines.push("", "## Abstract", "", article.abstract || "(no abstract)");
  return lines.join("\n").trim();
}

export async function fetchArxivMarkdown(rawUrl: string): Promise<string> {
  const target = parseArxivUrl(rawUrl);
  if (!target) throw new Error(`Not a supported arXiv abs URL: ${rawUrl}`);
  const response = await fetch(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(target.arxivId)}`,
    { signal: AbortSignal.timeout(PARSE_TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error(`arXiv API ${response.status} ${response.statusText}`);
  const article = parseArxivAtom(await response.text());
  if (!article) throw new Error(`arXiv API returned no entry for ${target.arxivId}`);
  return renderArxivMarkdown(article, target.permalink);
}
