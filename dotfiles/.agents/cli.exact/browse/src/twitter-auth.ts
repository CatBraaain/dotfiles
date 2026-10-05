// Twitter backend needing an account: the `browse login twitter` flow opens
// x.com/login in the shared camoufox browser, lets the human log in and
// persists x.com cookies as the flat {name: value} JSON twifork's
// load_cookies accepts; the fetch backends then call the twikit_client.py
// wrapper (twifork) for tweets, user timelines and search.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseRunCodeResult,
  runPlaywrightCli,
  syncPlaywrightCliConfig,
} from "./camoufox";
import {
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_WAIT_TIMEOUT_MS,
  PARSE_TIMEOUT_MS,
  SERVER_WAIT_TIMEOUT_MS,
  stateDir,
  TWIKIT_TIMEOUT_MS,
  TWITTER_COOKIE_FILE,
  TWITTER_LOGIN_SESSION_KEY,
} from "./config";
import { openVncQuietly } from "./display";
import { ensureCamoufoxServer } from "./server";
import { delay, runWithStdin } from "./util";
import { parseTwitterListUrl, parseTweetUrl, type TweetUrl } from "./twitter";

interface LoginCookie {
  name?: string;
  value?: string;
}

// Spec: 実行の冒頭と終了に session を閉じ、x.com/login を開き、VNC 受付を開き
// （失敗時は無視）、auth_token の出現を poll する。poll 間隔 5 秒・上限 10 分。
export async function loginTwitter(): Promise<void> {
  await ensureCamoufoxServer(AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
  syncPlaywrightCliConfig();
  const session = TWITTER_LOGIN_SESSION_KEY;
  const closePage = (): Promise<void> =>
    runPlaywrightCli(session, ["close"], AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
  await closePage().catch(() => {});
  try {
    await runPlaywrightCli(
      session,
      ["open", "https://x.com/login"],
      AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS),
    );
    if (openVncQuietly()) {
      console.error(
        "VNC access is open. If you don't see a browser window, connect a VNC client to 127.0.0.1:5900.",
      );
    } else {
      console.error(
        "Could not open VNC access; use the local browser window if one is visible.",
      );
    }
    console.error(
      `Waiting for you to log in to x.com in the camoufox browser (Ctrl+C to abort, ${LOGIN_WAIT_TIMEOUT_MS / 60_000} min timeout).`,
    );
    const cookies = await pollForAuthCookies(session);
    const cookiePath = saveTwitterCookies(cookies);
    console.log(`Logged in. Cookies saved to ${cookiePath}`);
  } finally {
    await closePage().catch(() => {});
  }
}

function cookieSnippet(): string {
  return `async page => {
  const cookies = await page.context().cookies(['https://x.com', 'https://twitter.com']);
  return { cookies };
}`;
}

async function pollForAuthCookies(session: string): Promise<LoginCookie[]> {
  const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
  const signal = () => AbortSignal.timeout(PARSE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const output = await runPlaywrightCli(session, ["run-code", cookieSnippet()], signal());
    const { cookies } = parseRunCodeResult<{ cookies?: LoginCookie[] }>(output);
    const list = cookies ?? [];
    if (list.some((cookie) => cookie?.name === "auth_token")) return list;
    await delay(LOGIN_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for x.com login (${LOGIN_WAIT_TIMEOUT_MS / 60_000} min)`,
  );
}

export function twitterCookiePath(): string {
  return join(stateDir(), TWITTER_COOKIE_FILE);
}

function saveTwitterCookies(cookies: LoginCookie[]): string {
  const path = twitterCookiePath();
  mkdirSync(stateDir(), { recursive: true });
  const flat: Record<string, string> = {};
  for (const cookie of cookies) {
    if (cookie.name !== undefined && cookie.value !== undefined) flat[cookie.name] = cookie.value;
  }
  writeFileSync(path, JSON.stringify(flat));
  return path;
}

// --- twikit (twifork) fetch backends ---

interface TwikitTweet {
  id?: string;
  text?: string;
  author?: string;
  screenName?: string;
  createdAt?: string;
  likes?: number;
  retweets?: number;
  replies?: number;
  mediaUrls?: string[];
}

interface TwikitTweetResult {
  tweet?: TwikitTweet;
  replies?: TwikitTweet[];
}

interface TwikitListResult {
  userInfo?: { name?: string; screenName?: string };
  tweets?: TwikitTweet[];
}

function assertTwitterCookies(): void {
  if (!existsSync(twitterCookiePath())) {
    throw new Error("No Twitter cookies found. Run: browse login twitter");
  }
}

// The wrapper ships under scripts/ next to package.json (the CLI project
// directory); bun resolves the CLI entry the same way for the deployed
// ~/.agents/cli/browse.
const twikitClientScript = join(
  dirname(import.meta.dir),
  "scripts",
  "twikit_client.py",
);

async function runTwikitClient(args: string[]): Promise<string> {
  return runWithStdin(
    "uv",
    ["run", "--no-project", twikitClientScript, ...args],
    "",
    TWIKIT_TIMEOUT_MS,
  ).catch((error: unknown) => {
    throw new Error(
      `twifork wrapper failed (uv): ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function renderTwikitTweetBody(tweet: TwikitTweet, permalink: string): string[] {
  const name = tweet.author?.trim() || "unknown";
  const screen = tweet.screenName?.trim() || "unknown";
  const lines = [`# ${name} (@${screen})`, ""];
  if (tweet.createdAt) lines.push(`- Posted: ${tweet.createdAt}`);
  lines.push(`- URL: ${permalink}`);
  const stats = [
    typeof tweet.likes === "number" ? `${tweet.likes} likes` : undefined,
    typeof tweet.retweets === "number" ? `${tweet.retweets} retweets` : undefined,
    typeof tweet.replies === "number" ? `${tweet.replies} replies` : undefined,
  ].filter(Boolean);
  if (stats.length > 0) lines.push(`- Stats: ${stats.join(", ")}`);
  lines.push("", "## Tweet", "", tweet.text?.trim() || "(no tweet text)");
  for (const url of tweet.mediaUrls ?? []) lines.push(`- Media: ${url}`);
  return lines;
}

// Spec: twikit backend は本文とリプライを markdown で出力する。
export function renderTwikitTweetMarkdown(
  tweet: TwikitTweet,
  replies: readonly TwikitTweet[],
  permalink: string,
): string {
  const lines = renderTwikitTweetBody(tweet, permalink);
  if (replies.length > 0) {
    lines.push("", `## Replies (${replies.length} retrieved)`, "");
    for (const [index, reply] of replies.entries()) {
      lines.push(
        `### ${index + 1}. ${reply.author ?? "unknown"} (@${reply.screenName ?? "unknown"})`,
        "",
        reply.text?.trim() || "(no reply body)",
        "",
      );
    }
  }
  return lines.join("\n").trim();
}

export async function fetchTweetViaTwikit(rawUrl: string): Promise<string> {
  const tweetUrl: TweetUrl | undefined = parseTweetUrl(rawUrl);
  if (!tweetUrl) throw new Error(`Not a supported tweet URL: ${rawUrl}`);
  assertTwitterCookies();
  const output = await runTwikitClient([
    "tweet",
    tweetUrl.tweetId,
    "--cookie-file",
    twitterCookiePath(),
  ]);
  const result = JSON.parse(output) as TwikitTweetResult;
  if (!result.tweet) throw new Error("twifork wrapper returned no tweet");
  return renderTwikitTweetMarkdown(result.tweet, result.replies ?? [], tweetUrl.permalink);
}

// Spec: ユーザーページは `# <name> (@<screen_name>)`、検索は
// `# Twitter search: <query>`、続けて `## Tweets (<n> retrieved)`。
export function renderTwitterTweets(
  header: { title: string; url: string },
  tweets: readonly TwikitTweet[],
): string {
  const lines = [`# ${header.title}`, "", `- URL: ${header.url}`, ""];
  lines.push(`## Tweets (${tweets.length} retrieved)`, "");
  for (const [index, tweet] of tweets.entries()) {
    lines.push(
      `### ${index + 1}. ${tweet.author ?? "unknown"} (@${tweet.screenName ?? "unknown"})`,
      "",
      tweet.text?.trim() || "(no tweet text)",
    );
    for (const url of tweet.mediaUrls ?? []) lines.push(`- Media: ${url}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function fetchTwitterListViaTwikit(rawUrl: string): Promise<string> {
  const listUrl = parseTwitterListUrl(rawUrl);
  if (!listUrl) throw new Error(`Not a supported Twitter list URL: ${rawUrl}`);
  assertTwitterCookies();
  if (listUrl.kind === "user") {
    const output = await runTwikitClient([
      "user",
      listUrl.user!,
      "--count",
      "40",
      "--cookie-file",
      twitterCookiePath(),
    ]);
    const result = JSON.parse(output) as TwikitListResult;
    const info = result.userInfo;
    const title = info?.name
      ? `${info.name} (@${info.screenName ?? listUrl.user})`
      : `@${listUrl.user}`;
    return renderTwitterTweets({ title, url: rawUrl }, result.tweets ?? []);
  }
  const args = ["search", listUrl.query!, "--count", "20", "--cookie-file", twitterCookiePath()];
  if (listUrl.latest) args.push("--latest");
  const output = await runTwikitClient(args);
  const result = JSON.parse(output) as TwikitListResult;
  return renderTwitterTweets(
    { title: `Twitter search: ${listUrl.query}`, url: rawUrl },
    result.tweets ?? [],
  );
}
