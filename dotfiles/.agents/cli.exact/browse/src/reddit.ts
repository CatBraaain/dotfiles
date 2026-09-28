// Reddit-only parsing and rendering: permalink detection, Atom feed / embed /
// oEmbed parsing and Markdown shaping for the fetch pipeline.
import { atomText, htmlFragmentToMarkdown, unescapeEntities } from "./html";

export const REDDIT_USER_AGENT = "Mozilla/5.0 (compatible; pi-web-search/1.0)";

interface RedditPostUrl {
  postId: string;
  permalink: string;
  rssUrl: string;
  embedUrl: string;
  oembedUrl: string;
}

interface RedditEntry {
  id: string;
  title: string;
  author?: string;
  bodyMarkdown: string;
  permalink: string;
  updated?: string;
}

interface RedditFeed {
  post: RedditEntry;
  comments: RedditEntry[];
}

interface RedditEmbed {
  title?: string;
  displayedCommentCount?: number;
}

interface RedditOEmbed {
  title?: string;
}

export function parseRedditPostUrl(rawUrl: string): RedditPostUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "reddit.com" && !hostname.endsWith(".reddit.com")) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length < 4 ||
    parts[0]?.toLowerCase() !== "r" ||
    parts[2]?.toLowerCase() !== "comments"
  ) {
    return undefined;
  }
  const subreddit = parts[1];
  const postId = parts[3]?.toLowerCase();
  if (!subreddit || !postId || !/^[a-z0-9]+$/.test(postId)) return undefined;
  const slug = parts[4] && parts[4] !== ".rss" ? parts[4] : undefined;
  const rootPath = `/r/${subreddit}/comments/${postId}/${slug ? `${slug}/` : ""}`;
  const permalink = `https://www.reddit.com${rootPath}`;
  const oembedUrl = new URL("https://www.reddit.com/oembed");
  oembedUrl.searchParams.set("url", permalink);
  return {
    postId,
    permalink,
    rssUrl: `${permalink}.rss?limit=500&sort=top`,
    embedUrl: `https://embed.reddit.com${rootPath}?ref_source=embed&ref=share&embed=true`,
    oembedUrl: oembedUrl.toString(),
  };
}

function cleanAuthor(name: string | undefined): string | undefined {
  return name?.replace(/^\/u\//, "u/");
}

export function parseRedditAtom(xml: string): RedditFeed | undefined {
  const entries: RedditEntry[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entryXml = match[1] ?? "";
    const id = atomText(entryXml, "id");
    if (!id || (!id.startsWith("t3_") && !id.startsWith("t1_"))) continue;
    const linkHref = /<link\b[^>]*href="([^"]*)"/.exec(entryXml)?.[1];
    entries.push({
      id,
      title: unescapeEntities(atomText(entryXml, "title") ?? "Untitled"),
      author: cleanAuthor(atomText(entryXml, "name")),
      bodyMarkdown: htmlFragmentToMarkdown(unescapeEntities(atomText(entryXml, "content") ?? "")),
      permalink: linkHref ?? "",
      updated: atomText(entryXml, "updated"),
    });
  }
  const post = entries.find((entry) => entry.id.startsWith("t3_"));
  if (!post) return undefined;
  return { post, comments: entries.filter((entry) => entry.id.startsWith("t1_")) };
}

export function parseRedditEmbed(html: string): RedditEmbed | undefined {
  const title = /id="embed-title"[^>]*>([^<]+)/.exec(html)?.[1]?.trim() || undefined;
  const countText = /(\d[\d,]*)\s+comments?/i.exec(html)?.[1];
  const displayedCommentCount =
    countText === undefined ? undefined : Number.parseInt(countText.replaceAll(",", ""), 10);
  if (!title && displayedCommentCount === undefined) return undefined;
  return { title, displayedCommentCount };
}

export function parseRedditOEmbed(json: string): RedditOEmbed | undefined {
  try {
    const value = JSON.parse(json) as { title?: unknown };
    const title =
      typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined;
    return title ? { title } : undefined;
  } catch {
    return undefined;
  }
}

export function renderRedditMarkdown(
  url: RedditPostUrl,
  feed: RedditFeed | undefined,
  embed: RedditEmbed | undefined,
  oembed: RedditOEmbed | undefined,
): string {
  const post = feed?.post;
  const title = post?.title ?? embed?.title ?? oembed?.title ?? `Reddit post ${url.postId}`;
  const comments = feed?.comments ?? [];
  const displayed = embed?.displayedCommentCount;
  const lines = [
    `# ${title}`,
    "",
    `- Author: ${post?.author ?? "unknown"}`,
    `- Permalink: ${post?.permalink || url.permalink}`,
  ];
  if (post?.updated) lines.push(`- Updated: ${post.updated}`);
  if (feed) {
    const count =
      displayed === undefined
        ? `${comments.length} fetched`
        : `${comments.length} fetched / ${displayed} displayed`;
    lines.push(`- Comments: ${count}`);
  } else {
    lines.push(
      `- Comments: unavailable${displayed === undefined ? "" : ` (Reddit displays ${displayed})`}`,
    );
  }
  lines.push(
    "",
    "## Post",
    "",
    post?.bodyMarkdown || "(post body unavailable from accessible Reddit endpoints)",
  );
  if (feed) {
    lines.push(
      "",
      `## Comments (${comments.length} retrieved)`,
      "",
      "Scores and reply hierarchy are not exposed by Reddit RSS.",
      "",
    );
    for (const [index, comment] of comments.entries()) {
      lines.push(
        `### ${index + 1}. ${comment.author ?? "unknown"}`,
        "",
        comment.bodyMarkdown || "(no comment body)",
        "",
      );
    }
  }
  return lines.join("\n").trim();
}

