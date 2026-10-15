export type Violation = { kind: "script" | "external-ref"; line: number; snippet: string };

const SCRIPT_PATTERN = /<script\b/gi;
const ATTRIBUTE_PATTERN = /\b(?:src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_PATTERN = /url\(\s*([^)]*?)\s*\)/gi;
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*([^)]*?)\s*\)|(?:"([^"]*)"|'([^']*)'))/gi;
const EXTERNAL_PREFIX = /^(?:https?:|\/\/|file:)/i;
const SNIPPET_MAX_LENGTH = 120;

export function scanViolations(html: string): Violation[] {
  const found: Violation[] = [];
  for (const match of html.matchAll(SCRIPT_PATTERN)) {
    found.push(violation("script", html, match.index ?? 0));
  }
  for (const match of html.matchAll(ATTRIBUTE_PATTERN)) {
    for (const url of urlTokens(match[1] ?? match[2] ?? "")) {
      if (EXTERNAL_PREFIX.test(url)) found.push(violation("external-ref", html, match.index ?? 0));
    }
  }
  for (const match of html.matchAll(CSS_URL_PATTERN)) {
    if (EXTERNAL_PREFIX.test(stripQuotes(match[1] ?? "").trim())) {
      found.push(violation("external-ref", html, match.index ?? 0));
    }
  }
  for (const match of html.matchAll(CSS_IMPORT_PATTERN)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (EXTERNAL_PREFIX.test(target)) found.push(violation("external-ref", html, match.index ?? 0));
  }
  return dedupe(found).sort((a, b) => a.line - b.line);
}

function violation(kind: Violation["kind"], html: string, index: number): Violation {
  return { kind, line: lineAt(html, index), snippet: snippetAt(html, index) };
}

function dedupe(violations: Violation[]): Violation[] {
  return [...new Map(violations.map((v) => [`${v.kind}:${v.line}:${v.snippet}`, v])).values()];
}

function urlTokens(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((token) => token.length > 0);
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function lineAt(html: string, index: number): number {
  return html.slice(0, index).split("\n").length;
}

function snippetAt(html: string, index: number): string {
  const lineStart = html.lastIndexOf("\n", index) + 1;
  const nextBreak = html.indexOf("\n", index);
  const lineEnd = nextBreak === -1 ? html.length : nextBreak;
  return html.slice(lineStart, lineEnd).trim().slice(0, SNIPPET_MAX_LENGTH);
}
