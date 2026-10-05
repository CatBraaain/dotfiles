// Twitter URL parsing and the login-free fxtwitter path: permalink detection
// for tweets, user pages and search URLs, plus fxtwitter JSON parsing and
// Markdown shaping. The cookie-based twikit path lives in twitter-auth.ts.
import { PARSE_TIMEOUT_MS } from "./config";

export interface TweetUrl {
  tweetId: string;
  permalink: string;
}

// A tweet permalink: /<user>/status/<id> on x.com / twitter.com (www/mobile
// variants included). Early snowflake ids are short, so the id is just digits.
export function parseTweetUrl(rawUrl: string): TweetUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!isTwitterHost(url.hostname)) return undefined;
  const match = /^\/([A-Za-z0-9_]{1,20})\/status(?:es)?\/(\d+)(?:\/|$)/.exec(
    url.pathname,
  );
  if (!match) return undefined;
  const tweetId = match[2]!;
  return { tweetId, permalink: `https://x.com/${match[1]}/status/${tweetId}` };
}

export interface TwitterListUrl {
  kind: "user" | "search";
  user?: string;
  query?: string;
  latest: boolean;
}

const NON_USER_PATHS = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "settings",
  "search",
  "i",
  "compose",
  "intent",
  "hashtag",
  "about",
  "privacy",
  "tos",
  "login",
  "signup",
  "logout",
]);

// A user page (/<user>) or search URL (/search?q=<query>[&f=live]) that needs
// the cookie-based twikit backend.
export function parseTwitterListUrl(rawUrl: string): TwitterListUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!isTwitterHost(url.hostname)) return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/search" || (segments[0] === "search" && segments.length === 1)) {
    const query = url.searchParams.get("q")?.trim();
    if (!query) return undefined;
    return { kind: "search", query, latest: url.searchParams.get("f") === "live" };
  }
  if (segments.length === 1) {
    const user = segments[0]!;
    if (NON_USER_PATHS.has(user.toLowerCase())) return undefined;
    return { kind: "user", user, latest: false };
  }
  return undefined;
}

function isTwitterHost(hostname: string): boolean {
  const bare = hostname.replace(/^www\./, "").replace(/^mobile\./, "");
  return bare === "x.com" || bare === "twitter.com";
}

// --- fxtwitter (login-free single-tweet backend) ---

interface FxTweet {
  text?: string;
  author?: { name?: string; screen_name?: string };
  created_at?: string;
  created_timestamp?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
  media?: { all?: { type?: string; url?: string }[] };
  poll?: { options?: { label?: string; votes?: number }[] };
  quote?: FxTweet;
}

interface FxResponse {
  code?: number;
  tweet?: FxTweet;
}

export function parseFxTwitterResponse(json: string): FxTweet {
  const value = JSON.parse(json) as FxResponse;
  if (!value.tweet || typeof value.tweet !== "object") {
    const code = value.code === undefined ? "" : ` (code ${value.code})`;
    throw new Error(`fxtwitter returned no tweet${code}`);
  }
  return value.tweet;
}

export function fetchTweetViaFxTwitterMarkdown(tweet: FxTweet, permalink: string): string {
  const name = tweet.author?.name?.trim() || "unknown";
  const screen = tweet.author?.screen_name?.trim() || "unknown";
  const lines = [`# ${name} (@${screen})`, ""];
  if (tweet.created_at) lines.push(`- Posted: ${tweet.created_at}`);
  lines.push(`- URL: ${permalink}`);
  const stats = [
    typeof tweet.likes === "number" ? `${tweet.likes} likes` : undefined,
    typeof tweet.retweets === "number" ? `${tweet.retweets} retweets` : undefined,
    typeof tweet.replies === "number" ? `${tweet.replies} replies` : undefined,
    typeof tweet.views === "number" ? `${tweet.views} views` : undefined,
  ].filter(Boolean);
  if (stats.length > 0) lines.push(`- Stats: ${stats.join(", ")}`);
  lines.push("", "## Tweet", "", tweet.text?.trim() || "(no tweet text)");
  for (const media of tweet.media?.all ?? []) {
    if (media.url) lines.push(`- Media: ${media.url}`);
  }
  if (tweet.poll?.options?.length) {
    lines.push("", "## Poll", "");
    for (const option of tweet.poll.options) {
      lines.push(`- ${option.label ?? "(no label)"}: ${option.votes ?? "?"}`);
    }
  }
  if (tweet.quote) {
    lines.push(
      "",
      "## Quoted tweet",
      "",
      `- Author: ${tweet.quote.author?.name?.trim() || "unknown"} (@${tweet.quote.author?.screen_name?.trim() || "unknown"})`,
      "",
      tweet.quote.text?.trim() || "(no quoted tweet text)",
    );
  }
  return lines.join("\n").trim();
}

export async function fetchTweetViaFxTwitter(rawUrl: string): Promise<string> {
  const tweetUrl = parseTweetUrl(rawUrl);
  if (!tweetUrl) throw new Error(`Not a supported tweet URL: ${rawUrl}`);
  const response = await fetch(`https://api.fxtwitter.com/status/${tweetUrl.tweetId}`, {
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`fxtwitter ${response.status} ${response.statusText}`);
  const tweet = parseFxTwitterResponse(await response.text());
  return fetchTweetViaFxTwitterMarkdown(tweet, tweetUrl.permalink);
}
