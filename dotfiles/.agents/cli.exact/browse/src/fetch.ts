// Fetch pipeline: pick backends by URL (YouTube / Twitter / GitHub / Hacker
// News / Wikipedia / arXiv / Reddit / StackOverflow / RSS / camoufox +
// trafilatura), fetch with retry and return the best Markdown payload.
import {
  camoufoxFailureKind,
  recoveryAttemptDuration,
  tryRecoveryBackends,
  type Attempt,
  type BackendEntry,
} from "./backends";
import {
  camoufoxRender,
  camoufoxServerResponsive,
  recoverCamoufoxBeforeRetry,
  shouldRetryCamoufox,
} from "./camoufox";
import {
  CAMOUFOX_FETCH_SESSION_KEY,
  camoufoxSessionKey,
  REDDIT_TIMEOUT_MS,
  STACKOVERFLOW_TIMEOUT_MS,
} from "./config";
import {
  fetchArxivMarkdown,
  parseArxivUrl,
} from "./arxiv";
import {
  fetchGitHubMarkdown,
  parseGitHubUrl,
} from "./github";
import { htmlFragmentToMarkdown, unescapeEntities } from "./html";
import {
  fetchHackerNewsMarkdown,
  parseHackerNewsUrl,
} from "./hackernews";
import { fetchFeedMarkdown } from "./rss";
import {
  parseRedditAtom,
  parseRedditEmbed,
  parseRedditOEmbed,
  parseRedditPostUrl,
  REDDIT_USER_AGENT,
  renderRedditMarkdown,
} from "./reddit";
import {
  parseStackOverflowAtom,
  parseStackOverflowQuestionUrl,
  renderStackOverflowMarkdown,
  type SeApiResponse,
  type StackOverflowAnswer,
  type StackOverflowFeedEntry,
  type StackOverflowQuestion,
  type StackOverflowQuestionUrl,
} from "./stackoverflow";
import {
  fetchTweetViaFxTwitter,
  parseTweetUrl,
  parseTwitterListUrl,
} from "./twitter";
import {
  fetchTweetViaTwikit,
  fetchTwitterListViaTwikit,
} from "./twitter-auth";
import {
  fetchWikipediaMarkdown,
  parseWikipediaUrl,
} from "./wikipedia";
import { fetchYouTubeMarkdown, parseYouTubeUrl } from "./youtube";
import { delay, runWithStdin } from "./util";

const SE_API_BASE_URL = "https://api.stackexchange.com/2.3";
const STACKOVERFLOW_MAX_ANSWERS = 500;

type FetchRoute =
  | "reddit"
  | "stackoverflow"
  | "youtube"
  | "twitter"
  | "twitter-list"
  | "github"
  | "hackernews"
  | "wikipedia"
  | "arxiv"
  | "camoufox";

// Single source of the fetch routing so main.ts can skip the render slot for
// the camoufox-free dedicated paths (spec: Reddit / StackOverflow / YouTube /
// Twitter / Hacker News / Wikipedia / arXiv は render スロットを取得しない。
// GitHub は camoufox へのフォールバックを持つため取得する).
export function fetchRoute(url: string): FetchRoute {
  if (parseRedditPostUrl(url)) return "reddit";
  if (parseStackOverflowQuestionUrl(url)) return "stackoverflow";
  if (parseYouTubeUrl(url)) return "youtube";
  if (parseTweetUrl(url)) return "twitter";
  if (parseTwitterListUrl(url)) return "twitter-list";
  if (parseGitHubUrl(url)) return "github";
  if (parseHackerNewsUrl(url)) return "hackernews";
  if (parseWikipediaUrl(url)) return "wikipedia";
  if (parseArxivUrl(url)) return "arxiv";
  return "camoufox";
}

function defaultFetchBackends(url: string): BackendEntry<string>[] {
  switch (fetchRoute(url)) {
    case "reddit":
      return [["Reddit", () => fetchRedditMarkdown(url)]];
    case "stackoverflow":
      return [["StackOverflow", () => fetchStackOverflowMarkdown(url)]];
    case "youtube":
      return [["YouTube", () => fetchYouTubeMarkdown(url)]];
    case "twitter":
      return [
        ["Twitter", () => fetchTweetViaFxTwitter(url)],
        ["Twitter-twikit", () => fetchTweetViaTwikit(url)],
      ];
    case "twitter-list":
      return [["Twitter-twikit", () => fetchTwitterListViaTwikit(url)]];
    case "github":
      return [
        ["GitHub", () => fetchGitHubMarkdown(url)],
        ["camoufox+trafilatura", () => camoufoxFetch(url)],
      ];
    case "hackernews":
      return [["HackerNews", () => fetchHackerNewsMarkdown(url)]];
    case "wikipedia":
      return [["Wikipedia", () => fetchWikipediaMarkdown(url)]];
    case "arxiv":
      return [["arXiv", () => fetchArxivMarkdown(url)]];
    case "camoufox":
      // Spec: 未知の URL は RSS → camoufox の順に試す。
      return [
        ["RSS", () => fetchFeedMarkdown(url)],
        ["camoufox+trafilatura", () => camoufoxFetch(url)],
      ];
  }
}

interface FetchFallback {
  readonly backend: string;
  readonly error: string;
}

export interface FetchOutcome {
  readonly backend: string;
  readonly markdown: string;
  readonly tookMs: number;
  readonly fallbacks: readonly FetchFallback[];
}

export async function fetchOne(url: string): Promise<FetchOutcome> {
  const { payload, backend, attempts } = await tryRecoveryBackends(
    "web fetch",
    defaultFetchBackends(url),
    (markdown) => !markdown.trim(),
    shouldRetryCamoufox,
    recoverCamoufoxBeforeRetry,
  );
  const fallbacks = attempts
    .filter((attempt): attempt is Extract<Attempt, { readonly ok: false }> => !attempt.ok)
    .map(({ backend: failedBackend, error }) => ({ backend: failedBackend, error }));
  return {
    backend,
    markdown: payload,
    tookMs: recoveryAttemptDuration(attempts),
    fallbacks,
  };
}


async function camoufoxFetch(url: string): Promise<string> {
  const html = await camoufoxRender(url, camoufoxSessionKey(CAMOUFOX_FETCH_SESSION_KEY));
  return runWithStdin("trafilatura", ["--markdown"], html);
}

// Spec: Reddit 投稿パーマリンク → RSS（コメント上限 500）→ embed → oEmbed の順。
// 各要求に独立した 15 秒（前の要求の消費時間は引き継がない）。
interface RedditFetchAttempt {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

async function fetchRedditText(url: string): Promise<RedditFetchAttempt> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REDDIT_TIMEOUT_MS),
      headers: {
        Accept:
          "application/atom+xml, application/xml, application/json, text/html;q=0.9, */*;q=0.1",
        "User-Agent": REDDIT_USER_AGENT,
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : String(error),
      body: "",
    };
  }
}

async function fetchRedditMarkdown(rawUrl: string): Promise<string> {
  const url = parseRedditPostUrl(rawUrl);
  if (!url) throw new Error(`Not a supported Reddit post URL: ${rawUrl}`);
  const rssAttempt = await fetchRedditText(url.rssUrl);
  const feed = rssAttempt.ok ? parseRedditAtom(rssAttempt.body) : undefined;
  let embed: ReturnType<typeof parseRedditEmbed>;
  if (!feed) {
    const embedAttempt = await fetchRedditText(url.embedUrl);
    embed = embedAttempt.ok ? parseRedditEmbed(embedAttempt.body) : undefined;
  }
  let oembed: ReturnType<typeof parseRedditOEmbed>;
  if (!feed && !embed) {
    const oembedAttempt = await fetchRedditText(url.oembedUrl);
    oembed = oembedAttempt.ok ? parseRedditOEmbed(oembedAttempt.body) : undefined;
  }
  if (!feed && !embed && !oembed) {
    throw new Error(
      `Unable to fetch Reddit post ${url.postId} (RSS ${rssAttempt.status || rssAttempt.statusText})`,
    );
  }
  return renderRedditMarkdown(url, feed, embed, oembed);
}

// Spec: StackOverflow 質問パーマリンク → StackExchange API（投票順・1 ページ
// 100 件で最大 500 件・backoff 指定時は指定秒待機）→ 質問フィードの順。
async function fetchStackExchangeApi(path: string): Promise<SeApiResponse> {
  const response = await fetch(`${SE_API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(STACKOVERFLOW_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => undefined)) as SeApiResponse | undefined;
  if (!response.ok || json === undefined) {
    throw new Error(`SE API ${response.status} ${response.statusText}`);
  }
  return json;
}

async function fetchStackOverflowFromApi(
  url: StackOverflowQuestionUrl,
): Promise<{ question: StackOverflowQuestion; answers: StackOverflowAnswer[] }> {
  const request = async (path: string): Promise<SeApiResponse> => {
    const response = await fetchStackExchangeApi(path);
    if (typeof response.backoff === "number" && response.backoff > 0) {
      await delay(response.backoff * 1000);
    }
    return response;
  };

  const questionItem = (
    await request(`/questions/${url.questionId}?site=stackoverflow&filter=withbody`)
  ).items?.[0];
  if (!questionItem?.body) {
    throw new Error(`SE API returned no question ${url.questionId}`);
  }

  const answers: StackOverflowAnswer[] = [];
  for (let page = 1; answers.length < STACKOVERFLOW_MAX_ANSWERS; page++) {
    const answerResponse = await request(
      `/questions/${url.questionId}/answers?site=stackoverflow&filter=withbody&order=desc&sort=votes&pagesize=100&page=${page}`,
    );
    for (const item of answerResponse.items ?? []) {
      answers.push({
        author: item.owner?.display_name,
        score: typeof item.score === "number" ? item.score : undefined,
        accepted: item.is_accepted === true,
        bodyMarkdown: htmlFragmentToMarkdown(item.body ?? ""),
      });
    }
    if (!answerResponse.has_more) break;
  }

  return {
    question: {
      // SE API の title は HTML エスケープされて返るためデコードする
      title: unescapeEntities(questionItem.title ?? `StackOverflow question ${url.questionId}`),
      author: questionItem.owner?.display_name,
      score: typeof questionItem.score === "number" ? questionItem.score : undefined,
      answerCount:
        typeof questionItem.answer_count === "number" ? questionItem.answer_count : undefined,
      tags: questionItem.tags,
      bodyMarkdown: htmlFragmentToMarkdown(questionItem.body),
    },
    answers: answers.slice(0, STACKOVERFLOW_MAX_ANSWERS),
  };
}

async function fetchStackOverflowMarkdown(rawUrl: string): Promise<string> {
  const url = parseStackOverflowQuestionUrl(rawUrl);
  if (!url) throw new Error(`Not a supported StackOverflow question URL: ${rawUrl}`);

  let apiResult: Awaited<ReturnType<typeof fetchStackOverflowFromApi>> | undefined;
  try {
    apiResult = await fetchStackOverflowFromApi(url);
  } catch {
    apiResult = undefined;
  }

  let feed: StackOverflowFeedEntry[] | undefined;
  if (!apiResult) {
    try {
      const response = await fetch(url.feedUrl, {
        signal: AbortSignal.timeout(STACKOVERFLOW_TIMEOUT_MS),
        headers: { Accept: "application/atom+xml, application/xml, */*" },
      });
      if (response.ok) {
        const entries = parseStackOverflowAtom(await response.text());
        if (entries.length > 0) feed = entries;
      }
    } catch {
      feed = undefined;
    }
  }

  if (!apiResult && !feed) {
    throw new Error(`Unable to fetch StackOverflow question ${url.questionId}`);
  }
  return renderStackOverflowMarkdown(url, apiResult, feed);
}


