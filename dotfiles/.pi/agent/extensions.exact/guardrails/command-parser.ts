import { createRequire } from "node:module";
import { parse as parseShell } from "shell-quote";
import { Language, Parser, type Node } from "web-tree-sitter";

export type TokenRange = { index: number; length: number };
export type CommandSegment = { tokens: string[]; ranges: TokenRange[] };
type MappedSource = { text: string; offsets: number[] };
type SourceRange = { startIndex: number; endIndex: number };

const require = createRequire(import.meta.url);
const parser = await loadParser().catch((error: unknown) =>
  error instanceof Error ? error : new Error(String(error)),
);
const EXPANSIONS = new Set([
  "simple_expansion",
  "expansion",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

async function loadParser(): Promise<Parser> {
  await Parser.init();
  const language = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
  const instance = new Parser();
  instance.setLanguage(language);
  return instance;
}

export function parseCommandSegments(command: string): CommandSegment[] {
  return parseSource({
    text: command,
    offsets: Array.from({ length: command.length }, (_, i) => i),
  });
}

function parseSource(source: MappedSource): CommandSegment[] {
  if (parser instanceof Error)
    throw new Error("Unable to initialize Bash parser", { cause: parser });
  const tree = parser.parse(source.text);
  if (tree === null) throw new Error("Unable to parse Bash command");
  try {
    if (tree.rootNode.hasError) throw new Error("Unable to parse Bash command: invalid syntax");
    const segments: CommandSegment[] = [];
    visit(tree.rootNode, source, segments);
    return segments.sort((left, right) => left.ranges[0]!.index - right.ranges[0]!.index);
  } finally {
    tree.delete();
  }
}

function visit(
  node: Node,
  source: MappedSource,
  segments: CommandSegment[],
  excluded: SourceRange[] = [],
  doubleQuoted = false,
): void {
  if (
    excluded.some((range) => node.startIndex >= range.startIndex && node.endIndex <= range.endIndex)
  )
    return;
  if (node.isMissing || node.isError)
    throw new Error("Unable to parse Bash command: missing syntax");
  if (node.type === "regex" && /`|\$\(/.test(removeLineContinuations(node.text)))
    throw new Error("Unable to parse Bash command: ambiguous pattern substitution");
  if (node.type === "expansion" && doubleQuoted) validateExpansionQuotes(node, excluded);
  if (node.type === "command_substitution" && node.text.startsWith("$(("))
    throw new Error("Unable to parse Bash command: ambiguous arithmetic substitution");
  if (node.type === "command_substitution" && node.text.startsWith("`")) {
    segments.push(...parseSource(decodeBacktick(source, node.startIndex + 1, node.endIndex - 1)));
    return;
  }
  if (node.type === "heredoc_redirect") {
    validateHeredocEnd(node, source.text);
    heredocOpeningArguments(node, source.text);
    const delimiter = node.namedChildren.find((child) => child.type === "heredoc_start");
    const quoted = delimiter !== undefined && /['"\\]/.test(delimiter.text);
    for (const child of node.namedChildren) {
      if (child.type !== "heredoc_body") visit(child, source, segments, excluded);
      else if (!quoted) {
        const backticks = heredocBackticks(child, source.text);
        validateHeredocBody(child, node, backticks);
        visit(child, source, segments, backticks);
        for (const range of backticks) {
          segments.push(
            ...parseSource(decodeBacktick(source, range.startIndex + 1, range.endIndex - 1)),
          );
        }
      }
    }
    return;
  }
  if (["command", "declaration_command", "unset_command", "test_command"].includes(node.type)) {
    const words = commandWords(node);
    rejectLineContinuations(
      node,
      words.filter((word): word is Node => word !== null),
    );
    const argumentsAfterHeredoc =
      node.parent?.type === "redirected_statement"
        ? node.parent.namedChildren
            .filter((child) => child.type === "heredoc_redirect")
            .flatMap((child) => heredocOpeningArguments(child, source.text))
        : [];
    const tokens: string[] = [];
    const ranges: TokenRange[] = [];
    for (const word of [...words, ...argumentsAfterHeredoc]) {
      if (word === null || word.type === "comment") continue;
      const normalized = normalizeWord(word);
      if (normalized === undefined) continue;
      if (tokens.length === 0 && (normalized === "env" || ENV_ASSIGNMENT.test(normalized)))
        continue;
      tokens.push(normalized);
      ranges.push(originalRange(source, word.startIndex, word.endIndex));
    }
    if (tokens.length > 0) segments.push({ tokens, ranges });
  }
  const childDoubleQuoted = ["command_substitution", "process_substitution"].includes(node.type)
    ? false
    : doubleQuoted || node.type === "string";
  for (const child of node.namedChildren)
    visit(child, source, segments, excluded, childDoubleQuoted);
}

function commandWords(node: Node): (Node | null)[] {
  if (node.type === "command")
    return [node.childForFieldName("name"), ...node.childrenForFieldName("argument")];
  if (
    ["test_command", "unary_expression", "binary_expression", "parenthesized_expression"].includes(
      node.type,
    )
  )
    return node.children.flatMap(commandWords);
  return node.type === "declaration_command" || node.type === "unset_command"
    ? node.children
    : [node];
}

function normalizeWord(node: Node): string | undefined {
  const text = withoutExpansions(node);
  const words = parseShell(text) as (string | { pattern?: string })[];
  return (
    words.map((word) => (typeof word === "string" ? word : (word.pattern ?? ""))).join("") ||
    (words.length > 0 ? "" : undefined)
  );
}

function withoutExpansions(node: Node): string {
  if (EXPANSIONS.has(node.type)) return "";
  if (node.type === "raw_string") return node.text;
  let text = "";
  let index = node.startIndex;
  for (const child of node.namedChildren) {
    text += removeLineContinuations(
      node.text.slice(index - node.startIndex, child.startIndex - node.startIndex),
    );
    text += withoutExpansions(child);
    index = child.endIndex;
  }
  return text + removeLineContinuations(node.text.slice(index - node.startIndex));
}

function removeLineContinuations(text: string): string {
  return text.replace(/\\[\s\S]/g, (escaped) => (escaped === "\\\n" ? "" : escaped));
}

function originalRange(source: MappedSource, start: number, end: number): TokenRange {
  const index = source.offsets[start]!;
  return { index, length: source.offsets[end - 1]! + 1 - index };
}

function validateHeredocEnd(node: Node, source: string): void {
  const end = node.namedChildren.find((child) => child.type === "heredoc_end");
  if (end === undefined) throw new Error("Unable to parse Bash command: missing heredoc end");
  const lineStart = source.lastIndexOf("\n", end.startIndex - 1) + 1;
  const newline = source.indexOf("\n", end.endIndex);
  const lineEnd = newline === -1 ? source.length : newline;
  const line = source.slice(lineStart, lineEnd);
  const stripTabs = node.children.some((child) => child.type === "<<-");
  if ((stripTabs ? line.replace(/^\t+/, "") : line) !== end.text)
    throw new Error("Unable to parse Bash command: ambiguous heredoc end");
}

function heredocOpeningArguments(node: Node, source: string): Node[] {
  const delimiter = node.namedChildren.find((child) => child.type === "heredoc_start");
  const newline = delimiter === undefined ? -1 : source.indexOf("\n", delimiter.endIndex);
  const openingParts = node.namedChildren.filter(
    (child) => !["heredoc_start", "heredoc_body", "heredoc_end"].includes(child.type),
  );
  if (newline === -1 || openingParts.some((child) => child.startIndex >= newline))
    throw new Error("Unable to parse Bash command: ambiguous heredoc opening arguments");
  return node.childrenForFieldName("argument");
}

function rejectLineContinuations(node: Node, excluded: SourceRange[]): void {
  for (const match of node.text.matchAll(/\\[\s\S]/g)) {
    if (match[0] !== "\\\n") continue;
    const index = node.startIndex + match.index;
    if (!excluded.some((range) => index >= range.startIndex && index + 2 <= range.endIndex))
      throw new Error("Unable to parse Bash command: unsupported line continuation");
  }
}

function validateHeredocBody(body: Node, redirect: Node, backticks: SourceRange[]): void {
  const end = redirect.namedChildren.find((child) => child.type === "heredoc_end")!;
  const stripTabs = redirect.children.some((child) => child.type === "<<-");
  const logicalLines = removeLineContinuations(body.text).split("\n");
  if (logicalLines.some((line) => (stripTabs ? line.replace(/^\t+/, "") : line) === end.text))
    throw new Error("Unable to parse Bash command: ambiguous continued heredoc end");
  rejectLineContinuations(body, [...backticks, ...body.descendantsOfType("command_substitution")]);
  validateExpansionQuotes(body, backticks);
}

function validateExpansionQuotes(node: Node, excluded: SourceRange[], inExpansion = false): void {
  if (
    ["command_substitution", "process_substitution"].includes(node.type) ||
    excluded.some((range) => node.startIndex >= range.startIndex && node.endIndex <= range.endIndex)
  )
    return;
  if (inExpansion && node.type === "raw_string")
    throw new Error("Unable to parse Bash command: ambiguous parameter quoting");
  for (const child of node.namedChildren)
    validateExpansionQuotes(child, excluded, inExpansion || node.type === "expansion");
}

function heredocBackticks(body: Node, source: string): SourceRange[] {
  const substitutions = body.descendantsOfType("command_substitution");
  const ranges: SourceRange[] = [];
  let opening: number | undefined;
  for (let index = body.startIndex; index < body.endIndex; index++) {
    const substitution = substitutions.find((node) => node.startIndex === index);
    if (opening === undefined && substitution !== undefined) {
      index = substitution.endIndex - 1;
      continue;
    }
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] !== "`") continue;
    if (opening === undefined) opening = index;
    else {
      ranges.push({ startIndex: opening, endIndex: index + 1 });
      opening = undefined;
    }
  }
  if (opening !== undefined)
    throw new Error("Unable to parse Bash command: unclosed heredoc backtick");
  return ranges;
}

function decodeBacktick(source: MappedSource, start: number, end: number): MappedSource {
  let text = "";
  const offsets: number[] = [];
  for (let index = start; index < end; index++) {
    if (source.text[index] === "\\" && /[$`\\\n]/.test(source.text[index + 1] ?? "")) {
      index++;
      if (source.text[index] === "\n") continue;
    }
    text += source.text[index];
    offsets.push(source.offsets[index]!);
  }
  return { text, offsets };
}
