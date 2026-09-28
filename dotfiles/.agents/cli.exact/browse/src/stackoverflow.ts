// StackOverflow-only parsing and rendering: permalink detection, StackExchange
// feed parsing and Markdown shaping for the fetch pipeline.
import { atomText, htmlFragmentToMarkdown, unescapeEntities } from "./html";

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

export function parseStackOverflowQuestionUrl(rawUrl: string): StackOverflowQuestionUrl | undefined {
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

function answerHeading(index: number, answer: StackOverflowAnswer): string {
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

