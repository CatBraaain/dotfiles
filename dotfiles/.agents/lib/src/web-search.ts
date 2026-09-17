export const REDDIT_USER_AGENT = "Mozilla/5.0 (compatible; pi-web-search/1.0)";
export const SE_API_BASE_URL = "https://api.stackexchange.com/2.3";
export const STACKOVERFLOW_MAX_ANSWERS = 500;

export interface RedditPostUrl {
  postId: string;
  permalink: string;
  rssUrl: string;
  embedUrl: string;
  oembedUrl: string;
}

export interface RedditEntry {
  id: string;
  title: string;
  author?: string;
  bodyMarkdown: string;
  permalink: string;
  updated?: string;
}

export interface RedditFeed {
  post: RedditEntry;
  comments: RedditEntry[];
}

export interface RedditEmbed {
  title?: string;
  displayedCommentCount?: number;
}

export interface RedditOEmbed {
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

export function unescapeEntities(text: string): string {
  let previous = "";
  let current = text;
  while (current !== previous) {
    previous = current;
    current = current
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&(?:#x([0-9a-f]+)|#(\d+));/gi, (_, hex, dec) =>
        String.fromCodePoint(Number.parseInt(hex ?? dec, hex ? 16 : 10)),
      );
  }
  return current;
}

export function htmlFragmentToMarkdown(fragment: string): string {
  let text = fragment.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const quoted = htmlFragmentToMarkdown(inner).replace(/^/gm, "> ");
    return `\n\n${quoted}\n\n`;
  });
  text = text
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => `[${label.trim()}](${href})`,
    )
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*>/gi, (_, src) => `![](${src})`)
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*")
    .replace(/<(?:del|s|strike)\b[^>]*>/gi, "~~")
    .replace(/<\/(?:del|s|strike)>/gi, "~~")
    .replace(/<(?:code|kbd)\b[^>]*>/gi, "`")
    .replace(/<\/(?:code|kbd)>/gi, "`")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(li|p|div|h[1-6]|ul|ol|pre|tr)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function atomText(entryXml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(entryXml);
  return match?.[1]?.trim() || undefined;
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

export interface StackOverflowQuestionUrl {
  questionId: string;
  permalink: string;
  feedUrl: string;
}

export interface SeApiResponse {
  items?: {
    title?: string;
    body?: string;
    score?: number;
    answer_count?: number;
    tags?: string[];
    is_accepted?: boolean;
    owner?: { display_name?: string };
  }[];
  has_more?: boolean;
  backoff?: number;
}

export interface StackOverflowQuestion {
  title: string;
  author?: string;
  score?: number;
  answerCount?: number;
  tags?: string[];
  bodyMarkdown: string;
}

export interface StackOverflowAnswer {
  author?: string;
  score?: number;
  accepted: boolean;
  bodyMarkdown: string;
}

export interface StackOverflowFeedEntry {
  title: string;
  author?: string;
  bodyMarkdown: string;
  link: string;
}

export function parseStackOverflowQuestionUrl(
  rawUrl: string,
): StackOverflowQuestionUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "stackoverflow.com" && hostname !== "www.stackoverflow.com") return undefined;
  const questionId = /^\/questions\/(\d+)(?:\/[^/]+)?\/?$/.exec(url.pathname)?.[1];
  if (!questionId) return undefined;
  return {
    questionId,
    permalink: `https://stackoverflow.com/questions/${questionId}`,
    feedUrl: `https://stackoverflow.com/feeds/question/${questionId}`,
  };
}

export function parseStackOverflowAtom(xml: string): StackOverflowFeedEntry[] {
  const entries: StackOverflowFeedEntry[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entryXml = match[1] ?? "";
    const body = atomText(entryXml, "summary") ?? atomText(entryXml, "content");
    if (!body) continue;
    entries.push({
      title: unescapeEntities(atomText(entryXml, "title") ?? "Untitled"),
      author: atomText(entryXml, "name") || undefined,
      bodyMarkdown: htmlFragmentToMarkdown(unescapeEntities(body)),
      link: /<link\b[^>]*href="([^"]*)"/.exec(entryXml)?.[1] ?? "",
    });
  }
  return entries;
}

export function answerHeading(index: number, answer: StackOverflowAnswer): string {
  const parts: string[] = [];
  if (answer.accepted) parts.push("accepted");
  if (typeof answer.score === "number") parts.push(`score ${answer.score}`);
  return `### ${index + 1}. ${answer.author ?? "unknown"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

export function renderStackOverflowMarkdown(
  url: StackOverflowQuestionUrl,
  apiResult: { question: StackOverflowQuestion; answers: StackOverflowAnswer[] } | undefined,
  feed: StackOverflowFeedEntry[] | undefined,
): string {
  const question = apiResult?.question;
  const feedPost = feed?.[0];
  const title = question?.title ?? feedPost?.title ?? `StackOverflow question ${url.questionId}`;
  const answers: StackOverflowAnswer[] =
    apiResult?.answers ??
    (feed ?? []).slice(1).map((entry) => ({
      author: entry.author,
      score: undefined,
      accepted: false,
      bodyMarkdown: entry.bodyMarkdown,
    }));
  const lines = [
    `# ${title}`,
    "",
    `- Author: ${question?.author ?? feedPost?.author ?? "unknown"}`,
    `- Permalink: ${url.permalink}`,
  ];
  if (question) {
    lines.push(`- Score: ${question.score ?? "unknown"}`);
    lines.push(
      `- Answers: ${answers.length} retrieved${typeof question.answerCount === "number" ? ` / ${question.answerCount} total` : ""}`,
    );
    if (question.tags?.length) lines.push(`- Tags: ${question.tags.join(", ")}`);
  } else {
    lines.push("", "Note: score, accepted and vote order are unavailable from the question feed.");
  }
  lines.push(
    "",
    "## Question",
    "",
    question?.bodyMarkdown || feedPost?.bodyMarkdown || "(question body unavailable)",
  );
  lines.push("", `## Answers (${answers.length} retrieved)`, "");
  for (const [index, answer] of answers.entries()) {
    lines.push(answerHeading(index, answer), "", answer.bodyMarkdown || "(no answer body)", "");
  }
  return lines.join("\n").trim();
}

export const CHALLENGE_SIGNALS: readonly RegExp[] = [
  /cdn-cgi\/challenge-platform\//,
  /id="challenge-(?:running|form|stage|error-text)"/,
  /<title[^>]*>\s*Just a moment\.\.\.\s*<\/title>/i,
  /\bcf-turnstile\b/,
  /<form[^>]*\bid="captcha-form"/,
  /<form[^>]*\baction="[^"]*\/sorry\//,
  /<body[^>]*\bonload="[^"]*captcha/i,
  /^(?![\s\S]*(?:class="tF2Cxc"|data-hveid=))[\s\S]*httpservice\/retry\/enablejs/,
];

export function detectChallengePage(html: string): boolean {
  return CHALLENGE_SIGNALS.some((signal) => signal.test(html));
}

const CHALLENGE_POLL_INTERVAL_MS = 250;
const NETWORK_IDLE_WAIT_MS = 5_000;

export function challengeWaitSnippet(): string {
  const signals = CHALLENGE_SIGNALS.map((signal) => [signal.source, signal.flags]);
  return `async page => {
  const challengeSignals = ${JSON.stringify(signals)}.map(([source, flags]) => new RegExp(source, flags));
  const grab = () => page.evaluate(() => document.documentElement.outerHTML);
  let settled = false;
  const idle = page.waitForLoadState('networkidle', { timeout: ${NETWORK_IDLE_WAIT_MS} }).catch(() => {}).then(() => { settled = true; });
  const deadline = Date.now() + ${NETWORK_IDLE_WAIT_MS};
  while (!settled && Date.now() < deadline) {
    const html = await grab();
    if (challengeSignals.some((signal) => signal.test(html))) return { mode: 'challenge', html };
    await page.waitForTimeout(${CHALLENGE_POLL_INTERVAL_MS});
  }
  await idle;
  return { mode: 'settled', html: await grab() };
}`;
}

export function parseRenderedPage(output: string): string {
  const lines = output.split("\n");
  const resultIndex = lines.indexOf("### Result");
  const literal = resultIndex === -1 ? undefined : lines[resultIndex + 1];
  if (!literal || (!literal.startsWith('"') && !literal.startsWith("{"))) {
    throw new Error("playwright-cli run-code output has no result");
  }
  const { mode, html } = JSON.parse(literal) as { mode?: string; html?: string };
  if (mode === "challenge") throw new Error("challenge detected");
  if (typeof html !== "string" || !html) {
    throw new Error("playwright-cli run-code returned no HTML");
  }
  return html;
}

export function playwrightCliConfigJson(baseUrl: string): string {
  return `${JSON.stringify({ browser: { browserName: "firefox", remoteEndpoint: baseUrl } }, null, 2)}\n`;
}

export function buildPlaywrightCliEnv(
  base: Record<string, string | undefined>,
  configPath: string,
): Record<string, string | undefined> {
  return { ...base, PLAYWRIGHT_MCP_CONFIG: configPath };
}

export function buildPlaywrightCliArgs(sessionKey: string, args: readonly string[]): string[] {
  return [`-s=${sessionKey}`, ...args];
}

export type Attempt =
  | { readonly backend: string; readonly ok: true; readonly durationMs?: number }
  | {
      readonly backend: string;
      readonly ok: false;
      readonly error: string;
      readonly durationMs?: number;
    };

export type BackendEntry<T = string> = readonly [name: string, run: () => Promise<T>];
export type BackendOperation = "web search" | "web fetch";

export function renderAbortHint(attempts: readonly Attempt[]): string {
  const renderAborted = attempts.some(
    (attempt) =>
      !attempt.ok && attempt.error.startsWith("render:") && /aborted/i.test(attempt.error),
  );
  return renderAborted
    ? `\nHint: renders aborted while the servers looked healthy, so the camoufox server is likely hung. Kill it to recover (it respawns automatically on the next request): pkill -f "bun server.mjs"`
    : "";
}

export class AllBackendsFailedError extends Error {
  constructor(
    readonly operation: BackendOperation,
    readonly attempts: Attempt[],
  ) {
    super(
      `All ${operation} backends failed: ${attempts
        .filter((attempt) => !attempt.ok)
        .map((attempt) => `${attempt.backend}: ${attempt.error}`)
        .join("; ")}${renderAbortHint(attempts)}`,
    );
  }
}

export function isCaptchaParseError(error: unknown): boolean {
  return error instanceof Error && error.message === "parse: captcha detected";
}

export function isChallengeRenderError(error: unknown): boolean {
  return error instanceof Error && error.message === "render: challenge detected";
}

export async function tryBackends<T>(
  operation: BackendOperation,
  backends: readonly BackendEntry<T>[],
  isEmpty: (payload: T) => boolean,
  shouldRetry?: (error: unknown) => boolean,
): Promise<{ payload: T; backend: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  for (const [name, run] of backends) {
    let retried = false;
    while (true) {
      const startedAt = Date.now();
      try {
        const payload = await run();
        if (isEmpty(payload)) throw new Error("empty response");
        attempts.push({ backend: name, ok: true, durationMs: Date.now() - startedAt });
        return { payload, backend: name, attempts };
      } catch (error) {
        attempts.push({
          backend: name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
        if (retried || !shouldRetry?.(error)) break;
        retried = true;
      }
    }
  }
  throw new AllBackendsFailedError(operation, attempts);
}

export class SerialTaskQueue {
  private previousTask = Promise.resolve();

  async run<Result>(task: () => Promise<Result>): Promise<Result> {
    const taskBefore = this.previousTask;
    let completeCurrentTask!: () => void;
    this.previousTask = new Promise((resolve) => {
      completeCurrentTask = resolve;
    });
    await taskBefore;
    try {
      return await task();
    } finally {
      completeCurrentTask();
    }
  }
}

export type SearchEngine = "bing" | "duckduckgo" | "google";

export const SERP_BASE_URL: Record<SearchEngine, string> = {
  bing: "https://www.bing.com/search",
  duckduckgo: "https://duckduckgo.com/",
  google: "https://www.google.com/search",
};

export function buildSerpUrl(
  engine: SearchEngine,
  query: string,
  parameters: Readonly<Record<string, string | undefined>> = {},
): string {
  const params = new URLSearchParams({ q: query });
  for (const [name, value] of Object.entries(parameters)) {
    if (value) params.set(name, value);
  }
  const base = SERP_BASE_URL[engine];
  return `${base}${base.includes("?") ? "&" : "?"}${params}`;
}

export interface OpenserpSearchResult {
  rank?: number;
  type?: string;
  title?: string;
  url?: string;
  display_url?: string;
  snippet?: string;
}

export function parseOpenserpResponse(body: string): OpenserpSearchResult[] {
  let payload: { results?: OpenserpSearchResult[] };
  try {
    payload = JSON.parse(body) as { results?: OpenserpSearchResult[] };
  } catch {
    throw new Error("parse: response is not valid JSON");
  }
  const results = payload.results ?? [];
  if (results.length === 0) throw new Error("parse: empty response");
  return results;
}
