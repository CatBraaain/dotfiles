// GitHub-only parsing and fetching: repository / issue / pull request /
// discussion URL detection, REST + GraphQL retrieval and Markdown shaping.
import { PARSE_TIMEOUT_MS } from "./config";

const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubContentUrl {
  kind: "repo" | "issue" | "pull" | "discussion";
  owner: string;
  repo: string;
  number?: number;
  permalink: string;
}

// Repo roots (/o/r), issues, pull requests and discussions. Any other GitHub
// path (code trees, releases, ...) is not claimed: the parser returns
// undefined and the URL falls through to camoufox.
export function parseGitHubUrl(rawUrl: string): GitHubContentUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const [owner, repo, third, fourth] = segments as [string, string, string?, string?];
  if (third === undefined) {
    return {
      kind: "repo",
      owner,
      repo,
      permalink: `https://github.com/${owner}/${repo}`,
    };
  }
  if (fourth === undefined) return undefined;
  const number = Number.parseInt(fourth, 10);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  const kinds: Record<string, GitHubContentUrl["kind"] | undefined> = {
    issues: "issue",
    pull: "pull",
    discussions: "discussion",
  };
  const kind = kinds[third];
  if (!kind) return undefined;
  return {
    kind,
    owner,
    repo,
    number,
    permalink: `https://github.com/${owner}/${repo}/${third}/${number}`,
  };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pi-web-search",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubApi(path: string): Promise<unknown> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    headers: githubHeaders(),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);
  return response.json();
}

async function githubApiAllPages(path: string, limit: number): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; items.length < limit; page++) {
    const response = await fetch(
      `${GITHUB_API_BASE}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      { signal: AbortSignal.timeout(PARSE_TIMEOUT_MS), headers: githubHeaders() },
    );
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);
    const batch = (await response.json()) as unknown[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items.slice(0, limit);
}

async function githubGraphQL(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GitHub discussions require a GITHUB_TOKEN (or GH_TOKEN)");
  }
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    headers: { ...githubHeaders(), Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL ${response.status} ${response.statusText}`);
  const payload = (await response.json()) as { data?: unknown; errors?: { message?: string }[] };
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL: ${payload.errors[0]?.message ?? "unknown error"}`);
  }
  return payload.data;
}

// --- renders ---

interface GhIssue {
  title?: string;
  body?: string;
  state?: string;
  html_url?: string;
  user?: { login?: string };
  labels?: { name?: string }[];
  merged?: boolean;
}

interface GhComment {
  body?: string;
  user?: { login?: string };
}

interface GhRepo {
  full_name?: string;
  owner?: { login?: string };
  description?: string;
  html_url?: string;
  stargazers_count?: number;
  language?: string;
}

function renderComments(comments: readonly GhComment[]): string[] {
  const lines: string[] = [];
  if (comments.length > 0) {
    lines.push("", `## Comments (${comments.length} retrieved)`, "");
    for (const [index, comment] of comments.entries()) {
      lines.push(`### ${index + 1}. ${comment.user?.login ?? "unknown"}`, "", comment.body?.trim() || "(no comment body)", "");
    }
  }
  return lines;
}

function renderIssueMarkdown(issue: GhIssue, comments: readonly GhComment[]): string {
  const lines = [
    `# ${issue.title || "GitHub issue"}`,
    "",
    `- Author: ${issue.user?.login ?? "unknown"}`,
    `- URL: ${issue.html_url || ""}`,
    `- State: ${issue.state ?? "unknown"}`,
  ];
  if (issue.labels?.length) {
    lines.push(`- Labels: ${issue.labels.map((label) => label.name).filter(Boolean).join(", ")}`);
  }
  lines.push("", "## Body", "", issue.body?.trim() || "(no body)");
  lines.push(...renderComments(comments));
  return lines.join("\n").trim();
}

function renderRepoMarkdown(repo: GhRepo, readme: string): string {
  const lines = [
    `# ${repo.full_name || "GitHub repository"}`,
    "",
    `- Author: ${repo.owner?.login ?? "unknown"}`,
    `- URL: ${repo.html_url || ""}`,
  ];
  if (repo.description) lines.push(`- Description: ${repo.description}`);
  if (typeof repo.stargazers_count === "number") lines.push(`- Stars: ${repo.stargazers_count}`);
  if (repo.language) lines.push(`- Language: ${repo.language}`);
  lines.push("", "## README", "", readme.trim() || "No README found");
  return lines.join("\n").trim();
}

async function fetchRepoMarkdown(target: GitHubContentUrl): Promise<string> {
  const repo = (await githubApi(`/repos/${target.owner}/${target.repo}`)) as GhRepo;
  let readme = "";
  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/readme`, {
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
      headers: githubHeaders(),
    });
    if (response.ok) {
      const payload = (await response.json()) as { content?: string; encoding?: string };
      if (payload.encoding === "base64" && payload.content) {
        readme = Buffer.from(payload.content, "base64").toString("utf8");
      }
    }
  } catch {
    readme = "";
  }
  return renderRepoMarkdown(repo, readme);
}

async function fetchIssueMarkdown(target: GitHubContentUrl): Promise<string> {
  const basePath = `/repos/${target.owner}/${target.repo}/${target.kind === "pull" ? "pulls" : "issues"}/${target.number}`;
  const issue = (await githubApi(basePath)) as GhIssue;
  if (target.kind === "pull" && issue.merged) issue.state = "merged";
  const comments = (await githubApiAllPages(
    `/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
    500,
  )) as GhComment[];
  const allComments = [...comments];
  if (target.kind === "pull") {
    const reviewComments = (await githubApiAllPages(
      `/repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`,
      500,
    )) as GhComment[];
    allComments.push(...reviewComments);
  }
  return renderIssueMarkdown(issue, allComments);
}

interface GhDiscussion {
  title?: string;
  body?: string;
  author?: { login?: string };
  comments?: { nodes?: { body?: string; author?: { login?: string } }[] };
}

async function fetchDiscussionMarkdown(target: GitHubContentUrl): Promise<string> {
  const data = (await githubGraphQL(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) {
          title
          body
          author { login }
          comments(first: 50) { nodes { body author { login } } }
        }
      }
    }`,
    { owner: target.owner, name: target.repo, number: target.number },
  )) as { repository?: { discussion?: GhDiscussion } };
  const discussion = data.repository?.discussion;
  if (!discussion) throw new Error(`GitHub discussion ${target.number} not found`);
  const comments = (discussion.comments?.nodes ?? []).map((node) => ({
    body: node.body,
    user: { login: node.author?.login },
  }));
  const lines = [
    `# ${discussion.title || "GitHub discussion"}`,
    "",
    `- Author: ${discussion.author?.login ?? "unknown"}`,
    `- URL: ${target.permalink}`,
    "- State: discussion",
    "",
    "## Body",
    "",
    discussion.body?.trim() || "(no body)",
  ];
  lines.push(...renderComments(comments));
  return lines.join("\n").trim();
}

export async function fetchGitHubMarkdown(rawUrl: string): Promise<string> {
  const target = parseGitHubUrl(rawUrl);
  if (!target) throw new Error(`Not a supported GitHub URL: ${rawUrl}`);
  switch (target.kind) {
    case "repo":
      return fetchRepoMarkdown(target);
    case "issue":
    case "pull":
      return fetchIssueMarkdown(target);
    case "discussion":
      return fetchDiscussionMarkdown(target);
  }
}
