import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseCommandSegments, type CommandSegment, type TokenRange } from "./command-parser.ts";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isDrivePath, WindowsPathLookup, type PathCoverage } from "./windows-path-identity.ts";

export type PathAction = "allow" | "deny" | "ask";

export type MatchSpan = { ranges: { index: number; length: number }[] };

/** Action resolution result together with the pattern that caused it (§2.3). */
export type PathActionMatch = { action: PathAction; matched?: string };
export type CommandActionMatch = {
  action: CommandAction;
  matched?: string;
  matchSpan?: MatchSpan;
  ordered?: true;
  compoundPatterns?: string[];
};

/** Commands add the reason-gated action: the call is returned to the agent,
 * which must obtain a one-shot approval via ask_permission (SPEC §3・§4). */
export type CommandAction = PathAction | "ask_with_reason";

export type ToolName = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";

/** Session metadata forwarded to the worker so the sandboxed bash tool can expose PI_* env vars. */
export type ToolSession = {
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
};

export type ExecutorDescriptor = { entrypoint: string; data?: Record<string, unknown> };

export type ToolRequest = {
  toolCallId?: string;
  params: unknown;
  session?: ToolSession;
  executorData?: Record<string, unknown>;
  cwd?: string;
};

export type WorkerRequestMessage = { id: number; tool: ToolName; request: ToolRequest };
export type WorkerCancelMessage = { id: number; cancel: true };
export type WorkerResponseMessage =
  | { id: number; ok: true; result: AgentToolResult<unknown> }
  | { id: number; ok: false; error: string };
export type WorkerProgressMessage = { id: number; stderr: string };
export type ExtensionToWorkerMessage = WorkerRequestMessage | WorkerCancelMessage;
export type WorkerToExtensionMessage = WorkerResponseMessage | WorkerProgressMessage;

/** One `{action: pattern(s)}` element of the flat rule lists (SPEC §6). */
type PathRuleEntry = { action: PathAction; patterns: string[] };
const OrderedArgumentsSchema = Type.Array(Type.String(), { minItems: 1 });
const CommandArgumentsSchema = Type.Array(Type.Union([Type.String(), OrderedArgumentsSchema]), {
  contains: OrderedArgumentsSchema,
  minContains: 0,
  maxContains: 1,
});

type CommandArguments = Static<typeof CommandArgumentsSchema>;
export type CommandRuleEntry = { action: CommandAction; pattern: string; args: CommandArguments };

/** One `{action: argPatterns}` rule item of a command family (SPEC §6). */
const CommandRuleItemSchema = Type.Object(
  {
    allow: Type.Optional(CommandArgumentsSchema),
    ask: Type.Optional(CommandArgumentsSchema),
    ask_with_reason: Type.Optional(CommandArgumentsSchema),
    deny: Type.Optional(CommandArgumentsSchema),
  },
  { additionalProperties: false, minProperties: 1, maxProperties: 1 },
);

/** Command family: exactly one command-pattern key mapped to its rule items (SPEC §6). */
const CommandFamilySchema = Type.Record(
  Type.String(),
  Type.Array(CommandRuleItemSchema, { minItems: 1 }),
  { minProperties: 1, maxProperties: 1 },
);

export type CompiledCommandPattern = {
  source: string;
  command: RegExp;
  unorderedArgs: RegExp[];
  orderedSequence: RegExp[];
};
export type CompiledCommandRuleEntry = {
  action: CommandAction;
  patterns: CompiledCommandPattern[];
};

export type GuardrailConfig = {
  read?: PathRuleEntry[];
  write?: PathRuleEntry[];
  credentials?: string[];
  commands?: CommandRuleEntry[];
};

const PathPatternSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

const PathEntrySchema = Type.Object(
  {
    allow: Type.Optional(PathPatternSchema),
    ask: Type.Optional(PathPatternSchema),
    deny: Type.Optional(PathPatternSchema),
  },
  { additionalProperties: false, minProperties: 1, maxProperties: 1 },
);

const GuardrailConfigSchema = Type.Object(
  {
    read: Type.Optional(Type.Array(PathEntrySchema)),
    write: Type.Optional(Type.Array(PathEntrySchema)),
    credentials: Type.Optional(Type.Array(Type.String())),
    commands: Type.Optional(Type.Array(CommandFamilySchema)),
  },
  { additionalProperties: false },
);

const validateConfig = Compile(GuardrailConfigSchema);

function toPathEntry(entry: Static<typeof PathEntrySchema>): PathRuleEntry {
  const [action, pattern] = Object.entries(entry)[0] as [PathAction, string | string[]];
  return { action, patterns: typeof pattern === "string" ? [pattern] : pattern };
}

function toCommandEntries(family: Static<typeof CommandFamilySchema>): CommandRuleEntry[] {
  const [pattern, items] = Object.entries(family)[0] as [
    string,
    Static<typeof CommandRuleItemSchema>[],
  ];
  return items.map((item) => {
    const [action, args] = Object.entries(item)[0] as [CommandAction, CommandArguments];
    return { action, pattern, args };
  });
}

export function parseGuardrailConfig(source: string): GuardrailConfig {
  const parsed = parseYaml(source) as unknown;
  if (!validateConfig.Check(parsed)) {
    const details = [...validateConfig.Errors(parsed)]
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`guardrail config schema violation: ${details}`);
  }
  const config = parsed as Static<typeof GuardrailConfigSchema>;
  return {
    read: config.read?.map(toPathEntry),
    write: config.write && expandWriteRules(config.write.map(toPathEntry)),
    credentials: config.credentials,
    commands: config.commands?.flatMap(toCommandEntries),
  };
}

export function expandBraces(pattern: string): string[] {
  const braceStart = pattern.indexOf("{");
  if (braceStart === -1) return [pattern];
  const braceEnd = pattern.indexOf("}", braceStart);
  if (braceEnd === -1) return [pattern];
  const choices = pattern.slice(braceStart + 1, braceEnd).split(",");
  return choices.flatMap((choice) =>
    expandBraces(`${pattern.slice(0, braceStart)}${choice}${pattern.slice(braceEnd + 1)}`),
  );
}

export function globToRegExp(pattern: string, name: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern.charAt(index);
    const literalToken = /^\0(?:repo|[0-9a-f]+);/.exec(pattern.slice(index));
    if (literalToken) {
      source += restoreRepositoryName(literalToken[0], name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += literalToken[0].length - 1;
    } else if (character === "*") {
      if (pattern[index + 1] === "*") {
        const hasFollowingSlash = pattern[index + 2] === "/";
        source += hasFollowingSlash ? "(?:.*/)?" : ".*";
        index += hasFollowingSlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) source += "\\[";
      else {
        const characterClass = pattern.slice(index, end + 1);
        source += characterClass.replace(
          /(\\*)\0(?:repo|[0-9a-f]+);/g,
          (token, backslashes: string) => {
            const literal = restoreRepositoryName(token.slice(backslashes.length), name);
            const escaped = literal
              .split("")
              .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
              .join("");
            return backslashes.slice(0, backslashes.length - (backslashes.length % 2)) + escaped;
          },
        );
        index = end;
      }
    } else {
      source += character.replace(/[\\^$+.()|{}]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export const GIT_MAIN_WORKTREE_PATH = "${GIT_MAIN_WORKTREE_PATH}";
export const REPOSITORY_NAME = "${REPOSITORY_NAME}";

export function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/**
 * Absolute path of the main worktree of the repository containing cwd.
 * `undefined` outside a Git repository. The main worktree is always the
 * first entry in `git worktree list --porcelain` output.
 */
export function resolveGitMainWorktreePath(cwd: string): string | undefined {
  try {
    const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const mainLine = worktrees.split("\n").find((line) => line.startsWith("worktree "));
    return mainLine === undefined ? undefined : resolve(mainLine.slice("worktree ".length));
  } catch {
    return undefined;
  }
}

const XDG_RUNTIME_DIR = "${XDG_RUNTIME_DIR}";
const LITERAL_REPOSITORY_NAME = "\0repo;";
const PATH_VARIABLE_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isComputedPathVariable(reference: string): boolean {
  return reference === REPOSITORY_NAME || reference === GIT_MAIN_WORKTREE_PATH;
}

function expandWriteRules(rules: PathRuleEntry[]): PathRuleEntry[] {
  return rules.map((rule) => {
    if (rule.action !== "allow") return rule;
    const patterns = rule.patterns
      .map(expandWriteAllowEnvironment)
      .filter((path) => path !== undefined);
    return { ...rule, patterns };
  });
}

function expandWriteAllowEnvironment(pattern: string): string | undefined {
  let hasMissingEnvironmentVariable = false;
  const expanded = pattern.replace(PATH_VARIABLE_REFERENCE, (reference, name: string) => {
    if (isComputedPathVariable(reference)) return reference;
    const pathValue = Object.hasOwn(process.env, name) ? process.env[name] : undefined;
    if (!pathValue) {
      hasMissingEnvironmentVariable = true;
      return "";
    }
    return pathValue.replace(/[^/~.:]/g, maskPatternCharacter);
  });
  return hasMissingEnvironmentVariable ? undefined : expanded;
}

export function expandRuntimeVariables(
  pattern: string,
  mainWorktree: string | undefined,
  cwd: string,
): string[] {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir && pattern.includes(XDG_RUNTIME_DIR)) return [];
  if (pattern.includes(REPOSITORY_NAME) && repositoryName(cwd, mainWorktree) === "") return [];

  return [
    pattern.replace(PATH_VARIABLE_REFERENCE, (reference) => {
      if (reference === REPOSITORY_NAME) return LITERAL_REPOSITORY_NAME;
      if (reference === GIT_MAIN_WORKTREE_PATH) return mainWorktree ?? resolve(cwd);
      if (reference === XDG_RUNTIME_DIR && runtimeDir) return runtimeDir;
      return reference;
    }),
  ];
}

function maskPatternCharacter(character: string): string {
  return character === sep ? character : `\0${character.charCodeAt(0).toString(16)};`;
}

export function repositoryName(cwd: string, mainWorktree: string | undefined): string {
  return basename(mainWorktree ?? resolve(cwd));
}

export function restoreRepositoryName(pattern: string, name: string): string {
  return pattern.replace(/\0(repo|[0-9a-f]+);/g, (_, token: string) =>
    token === "repo" ? name : String.fromCodePoint(Number.parseInt(token, 16)),
  );
}

export function resolvePattern(pattern: string, cwd: string): string {
  const globCharacters = /[*?[\]{}]/g;
  const homeExpanded =
    pattern === "~" || pattern.startsWith("~/")
      ? join(homedir().replace(globCharacters, maskPatternCharacter), pattern.slice(2))
      : pattern;
  const withDrivePrefix =
    sep === "\\"
      ? homeExpanded.replace(/^\0[0-9a-f]+;(?=:)/, (token) => restoreRepositoryName(token, ""))
      : homeExpanded;
  return isAbsolute(withDrivePrefix)
    ? resolve(withDrivePrefix)
    : resolve(cwd.replace(globCharacters, maskPatternCharacter), withDrivePrefix);
}

export function splitCommandSegments(command: string): string[][] {
  return parseCommandSegments(command).map((segment) => segment.tokens);
}

export function commandOnceApprovalKey(command: string, orderedPattern?: string): string {
  if (orderedPattern === undefined) return JSON.stringify(splitCommandSegments(command));
  const segments = parseCommandSegments(command).map((segment) => ({
    command: segment.tokens[0],
    args:
      segment.orderedArguments?.map((argument) =>
        "token" in argument ? argument.token : argument,
      ) ?? segment.tokens.slice(1),
  }));
  return JSON.stringify({ orderedPattern, segments });
}

export function commandPatternApprovalKey(match: CommandActionMatch): string | undefined {
  return match.compoundPatterns === undefined
    ? match.matched
    : JSON.stringify({ segments: match.compoundPatterns });
}

export function compileCommandRuleEntries(entries: CommandRuleEntry[] | undefined): {
  entries: CompiledCommandRuleEntry[];
  invalidPatterns: string[];
} {
  const compiled: CompiledCommandRuleEntry[] = [];
  const invalidPatterns: string[] = [];
  for (const entry of entries ?? []) {
    const orderedSequence = entry.args.find(Array.isArray);
    const unorderedArgs = entry.args.filter((arg) => typeof arg === "string");
    const args =
      orderedSequence === undefined ? unorderedArgs : [orderedSequence, ...unorderedArgs];
    const source = JSON.stringify({ command: entry.pattern, args });
    try {
      compiled.push({
        action: entry.action,
        patterns: [
          {
            source,
            command: compileTokenPattern(entry.pattern),
            unorderedArgs: unorderedArgs.map(compileTokenPattern),
            orderedSequence: (orderedSequence ?? []).map(compileTokenPattern),
          },
        ],
      });
    } catch {
      invalidPatterns.push(source);
    }
  }
  return { entries: compiled, invalidPatterns };
}

function compileTokenPattern(source: string): RegExp {
  new RegExp(source);
  return new RegExp("^(?:" + source + ")(?![\\s\\S])");
}

function findCommandPattern(
  patterns: CompiledCommandPattern[],
  candidate: CommandSegment,
): { pattern: CompiledCommandPattern; ranges: TokenRange[] } | undefined {
  const [command, ...flatArgs] = candidate.tokens;
  const flatArguments = flatArgs.map((token, index) => ({
    token,
    range: candidate.ranges[index + 1]!,
  }));
  for (const pattern of patterns) {
    if (!pattern.command.test(command!)) continue;
    const sequence = pattern.orderedSequence;
    const args =
      sequence.length > 0 ? (candidate.orderedArguments ?? flatArguments) : flatArguments;
    const matchedRanges = [candidate.ranges[0]!];
    const matchedUnordered = new Set<RegExp>();
    let sequenceIndex = 0;

    for (const argument of args) {
      if (!("token" in argument)) continue;
      if (sequence[sequenceIndex]?.test(argument.token)) {
        sequenceIndex++;
        matchedRanges.push(argument.range);
        continue;
      }
      let matchesUnordered = false;
      for (const regex of pattern.unorderedArgs) {
        if (!regex.test(argument.token)) continue;
        matchedUnordered.add(regex);
        matchesUnordered = true;
      }
      if (matchesUnordered) matchedRanges.push(argument.range);
    }

    if (
      sequenceIndex === sequence.length &&
      pattern.unorderedArgs.every((regex) => matchedUnordered.has(regex))
    )
      return { pattern, ranges: matchedRanges };
  }
  return undefined;
}

export function resolveCommandActionMatch(
  entries: CompiledCommandRuleEntry[] | undefined,
  command: string,
): CommandActionMatch {
  if (!entries) return { action: "deny" };
  const results = parseCommandSegments(command).map((candidate): CommandActionMatch => {
    let resolved: CommandActionMatch = { action: "deny" };
    for (const entry of entries) {
      const match = findCommandPattern(entry.patterns, candidate);
      if (match !== undefined)
        resolved = {
          action: entry.action,
          matched: match.pattern.source,
          matchSpan: { ranges: match.ranges },
          ...(match.pattern.orderedSequence.length > 0 ? { ordered: true } : {}),
        };
    }
    return resolved;
  });
  const representative = results.find((result) => result.action === "deny") ??
    results.find((result) => result.action === "ask_with_reason") ??
    results.find((result) => result.action === "ask") ??
    results.find((result) => result.action === "allow") ?? { action: "deny" };
  if (results.length < 2 || !["ask", "ask_with_reason"].includes(representative.action))
    return representative;

  const highestMatches = results.filter((result) => result.action === representative.action);
  if (!highestMatches.some((result) => result.ordered)) return representative;
  return {
    ...representative,
    ordered: true,
    compoundPatterns: highestMatches.map(({ matched }) => matched!),
  };
}

export function resolveCommandAction(
  entries: CompiledCommandRuleEntry[] | undefined,
  command: string,
): CommandAction {
  return resolveCommandActionMatch(entries, command).action;
}

/** All patterns declared with `action` across the flat entries, in list order. */
export function actionPatterns(entries: PathRuleEntry[] | undefined, action: PathAction): string[] {
  return (entries ?? [])
    .filter((entry) => entry.action === action)
    .flatMap((entry) => entry.patterns);
}

// bun's globSync silently drops dotfiles, so expand by walking the static prefix
// and testing each path with globToRegExp (same semantics as command matching).
// Walks the whole prefix subtree; add per-segment matching if large trees get slow.
function expandGlobPattern(absolutePattern: string, name: string): PathSnapshot {
  if (process.platform === "win32" && isDrivePath(absolutePattern))
    return expandWindowsDriveGlob(absolutePattern, name);
  const directory = legacyGlobPrefix(absolutePattern, name);
  const regexes = expandBraces(absolutePattern).map((pattern) => globToRegExp(pattern, name));
  return scanGlob(directory, (path) => regexes.some((regex) => regex.test(path)));
}

type GlobEntry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };

export function expandWindowsDriveGlob(
  pattern: string,
  name: string,
  lookup = new WindowsPathLookup(),
  listDirectory?: (path: string) => GlobEntry[],
): PathSnapshot {
  const glob = windowsDriveGlob(pattern, name);
  const prefix = lookup.inspect(glob.prefix);
  const suffix = globToRegExp(glob.suffixPattern, name);
  const maxDepth = maxGlobDepth(glob.suffixPattern, name);
  const uncertainty = {
    prefixDepth: drivePathDepth(prefix.spelling),
    maxDepth,
    asciiCaseMatcher:
      !glob.suffixPattern.includes("[^") && isAscii(restoreRepositoryName(glob.suffixPattern, name))
        ? new RegExp(suffix.source, "i")
        : undefined,
  };
  if (prefix.state === "unverified")
    return { paths: [], uncertainSubtrees: [{ ...uncertainty, directory: prefix.spelling }] };
  if (prefix.state === "missing" || !prefix.directory) return { paths: [] };
  return scanGlob(
    prefix.spelling,
    (path) => suffix.test(relativeToGlobPrefix(path.replaceAll("\\", "/"), prefix.spelling)),
    { uncertainty, listDirectory },
  );
}

function scanGlob(
  root: string,
  matchesPath: (path: string) => boolean,
  windows?: {
    uncertainty: Omit<UncertainGlobBranch, "directory">;
    listDirectory?: (path: string) => GlobEntry[];
  },
): PathSnapshot {
  const paths: string[] = [];
  const uncertainSubtrees: UncertainGlobBranch[] = [];
  walk(root, 0);
  return uncertainSubtrees.length === 0 ? { paths } : { paths, uncertainSubtrees };

  function walk(directory: string, depth: number): void {
    if (windows && depth >= windows.uncertainty.maxDepth) return;
    let entries: GlobEntry[];
    try {
      entries = windows?.listDirectory
        ? windows.listDirectory(directory)
        : readdirSync(directory, { withFileTypes: true });
    } catch {
      if (windows) uncertainSubtrees.push({ ...windows.uncertainty, directory });
      return;
    }
    for (const entry of entries) {
      if (windows && entry.isSymbolicLink()) continue;
      const path = windows ? win32.join(directory, entry.name) : join(directory, entry.name);
      if (matchesPath(path)) paths.push(path);
      if (entry.isDirectory()) walk(path, depth + 1);
    }
  }
}

function legacyGlobPrefix(absolutePattern: string, name: string): string {
  let staticPrefix = "";
  for (const segment of absolutePattern.split("/")) {
    if (hasGlob(segment) || segment.includes("{")) break;
    staticPrefix = staticPrefix ? join(staticPrefix, segment) : segment || "/";
  }
  return restoreRepositoryName(staticPrefix, name);
}

function windowsDriveGlob(absolutePattern: string, name: string) {
  const pattern = absolutePattern.replaceAll("\\", "/");
  const segments = pattern.split("/");
  const firstGlob = segments.findIndex(hasGlob);
  const prefix = restoreRepositoryName(`${segments.slice(0, firstGlob).join("/")}/`, name);
  const suffixPattern = segments.slice(firstGlob).join("/");
  return { prefix, suffixPattern };
}

function maxGlobDepth(pattern: string, name: string): number {
  let depth = 1;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") return Infinity;
    if (character === "/") depth++;
    if (character !== "[") continue;
    const end = pattern.indexOf("]", index + 1);
    if (end === -1) continue;
    if (globToRegExp(pattern.slice(index, end + 1), name).test("/")) depth++;
    index = end;
  }
  return depth;
}

function drivePathDepth(path: string): number {
  return path.split(/[/\\]/).filter(Boolean).length;
}

function isAscii(value: string): boolean {
  return /^[ -~]*$/.test(value);
}

function relativeToGlobPrefix(path: string, prefix: string): string {
  return path.slice(prefix.length + (prefix.endsWith("/") ? 0 : 1));
}

/**
 * Expand config path patterns into absolute paths. `gitMainWorktreePath` is
 * re-resolved by the caller on every access, so Git-variable entries track
 * the repository state during the session. Globs, in contrast,
 * keep the startup-expansion semantics (§3): pass a `globCache` to reuse the
 * first expansion per resolved pattern instead of picking up paths created
 * later in the session.
 */
type UncertainGlobBranch = {
  directory: string;
  prefixDepth: number;
  maxDepth: number;
  asciiCaseMatcher?: RegExp;
};

export type PathSnapshot = { paths: string[]; uncertainSubtrees?: UncertainGlobBranch[] };
export type GlobCache = Map<string, PathSnapshot>;

export function expandPathPatterns(
  patterns: string[] | undefined,
  cwd: string,
  gitMainWorktreePath: string | undefined,
  allowAllPaths = false,
  globCache?: GlobCache,
): string[] {
  return expandPathSnapshot(patterns, cwd, gitMainWorktreePath, allowAllPaths, globCache).paths;
}

export function expandPathSnapshot(
  patterns: string[] | undefined,
  cwd: string,
  gitMainWorktreePath: string | undefined,
  allowAllPaths = false,
  globCache?: GlobCache,
): PathSnapshot {
  const name = repositoryName(cwd, gitMainWorktreePath);
  const uncertainSubtrees: UncertainGlobBranch[] = [];
  const paths = (patterns ?? []).flatMap((pattern) =>
    expandRuntimeVariables(pattern, gitMainWorktreePath, cwd).flatMap((variableExpanded) =>
      expandBraces(variableExpanded).flatMap((expandedPattern) => {
        if (allowAllPaths && expandedPattern === "*") return ["/"];
        const resolvedPattern = resolvePattern(expandedPattern, cwd);
        if (!hasGlob(resolvedPattern)) return [restoreRepositoryName(resolvedPattern, name)];
        const cacheKey = JSON.stringify([resolvedPattern, name]);
        let expanded = globCache?.get(cacheKey);
        if (expanded === undefined) {
          expanded = expandGlobPattern(resolvedPattern, name);
          globCache?.set(cacheKey, expanded);
        }
        if (expanded.uncertainSubtrees) uncertainSubtrees.push(...expanded.uncertainSubtrees);
        return expanded.paths;
      }),
    ),
  );
  return uncertainSubtrees.length === 0 ? { paths } : { paths, uncertainSubtrees };
}

export type ExpandedPathSection = ({ action: PathAction } & PathSnapshot)[];

export function expandPathSection(
  entries: PathRuleEntry[] | undefined,
  cwd: string,
  allowAllPaths = false,
  gitMainWorktreePath = resolveGitMainWorktreePath(cwd),
  globCache?: GlobCache,
): ExpandedPathSection {
  return (entries ?? []).map((entry) => ({
    action: entry.action,
    ...expandPathSnapshot(
      entry.patterns,
      cwd,
      gitMainWorktreePath,
      allowAllPaths && entry.action === "allow",
      globCache,
    ),
  }));
}

export function pathCovers(grantedPath: string, candidatePath: string): boolean {
  const normalizedCandidate = resolve(candidatePath);
  return (
    grantedPath === "/" ||
    normalizedCandidate === grantedPath ||
    normalizedCandidate.startsWith(`${grantedPath}${sep}`)
  );
}

export function pathsMatchCandidate(paths: string[], candidatePath: string): boolean {
  return paths.some((path) => pathCovers(path, candidatePath));
}

export class AuthorizationPath {
  readonly windows;

  constructor(
    readonly absolutePath: string,
    lookup?: WindowsPathLookup,
  ) {
    if ((lookup || process.platform === "win32") && isDrivePath(absolutePath)) {
      lookup ??= new WindowsPathLookup();
      this.windows = { lookup, candidate: lookup.inspect(absolutePath) };
    }
  }

  coverageOf(path: string): PathCoverage {
    if (!this.windows) return pathCovers(path, this.absolutePath) ? "match" : "none";
    const { lookup, candidate } = this.windows;
    if (!isDrivePath(path)) {
      if (!pathCovers(path, this.absolutePath)) return "none";
      return candidate.state === "unverified" ? "possible" : "match";
    }
    if (!lookup.couldCover(path, candidate)) return "none";
    const rule = lookup.inspect(path);
    return lookup.coverage(rule, candidate);
  }

  matchesRestriction({ paths, uncertainSubtrees }: PathSnapshot): boolean {
    return (
      paths.some((path) => this.coverageOf(path) !== "none") ||
      (uncertainSubtrees?.some((branch) => this.mayContainGlobMatch(branch)) ?? false)
    );
  }

  matchRule({
    action,
    paths,
    uncertainSubtrees,
  }: ExpandedPathSection[number]): PathActionMatch | undefined {
    let uncertainPath: string | undefined;
    for (const path of paths) {
      const coverage = this.coverageOf(path);
      if (coverage === "match") return { action, matched: path };
      if (coverage === "possible" && action !== "allow") uncertainPath ??= path;
    }
    if (action !== "allow")
      uncertainPath ??= uncertainSubtrees?.find((branch) =>
        this.mayContainGlobMatch(branch),
      )?.directory;
    return uncertainPath === undefined ? undefined : { action: "deny", matched: uncertainPath };
  }

  private mayContainGlobMatch(branch: UncertainGlobBranch): boolean {
    if (!this.windows) return false;
    const { candidate } = this.windows;
    const parts = candidate.spelling.split("/").filter(Boolean);
    const firstUnseenDepth = drivePathDepth(branch.directory) + 1;
    const maxDepth = Math.min(parts.length, branch.prefixDepth + branch.maxDepth);
    if (firstUnseenDepth > maxDepth || this.coverageOf(branch.directory) === "none") return false;

    for (let depth = firstUnseenDepth; depth <= maxDepth; depth++) {
      const relative = parts.slice(branch.prefixDepth, depth).join("/");
      if (!branch.asciiCaseMatcher || !isAscii(relative) || branch.asciiCaseMatcher.test(relative))
        return true;
    }
    return false;
  }

  denyGlobCoverage(pattern: string, name: string): PathCoverage {
    if (!this.windows || !isDrivePath(pattern))
      return globToRegExp(pattern, name).test(this.absolutePath) ? "match" : "none";

    const glob = windowsDriveGlob(pattern, name);
    const { lookup, candidate } = this.windows;
    if (!lookup.couldCover(glob.prefix, candidate)) return "none";
    const prefix = lookup.inspect(glob.prefix);
    const coverage = lookup.coverage(prefix, candidate);
    if (coverage === "none") return "none";
    if (prefix.state === "existing" && !prefix.directory) return "none";
    if (coverage === "possible" || candidate.state !== "existing") return "possible";
    if (!prefix.spelling.endsWith("/") && prefix.spelling === candidate.spelling) return "none";
    const suffix = globToRegExp(glob.suffixPattern, name);
    return suffix.test(relativeToGlobPrefix(candidate.spelling, prefix.spelling))
      ? "match"
      : "none";
  }

  assertVerified(): void {
    if (this.windows?.candidate.state === "unverified")
      throw new Error(`Cannot verify Windows path: ${this.absolutePath}`);
  }
}

export function resolvePathActionMatch(
  section: ExpandedPathSection | undefined,
  candidatePath: string,
  comparison = new AuthorizationPath(resolve(candidatePath)),
): PathActionMatch {
  let resolved: PathActionMatch = { action: "deny" };
  for (const entry of section ?? []) resolved = comparison.matchRule(entry) ?? resolved;
  return resolved;
}

export function resolvePathAction(
  section: ExpandedPathSection | undefined,
  candidatePath: string,
): PathAction {
  return resolvePathActionMatch(section, candidatePath).action;
}
export function defaultGuardrailConfigPath(
  agentDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): string {
  const deployedPath = join(agentDir, "config", "guardrails.yaml");
  if (existsSync(deployedPath)) return deployedPath;

  const sourcePath = join(agentDir, "config.exact", "guardrails.yaml");
  if (existsSync(sourcePath)) return sourcePath;

  return join(agentDir, "..", "..", ".agents", "config.exact", "guardrails.yaml");
}

function readKernelRelease(): string {
  try {
    return readFileSync("/proc/sys/kernel/osrelease", "utf8");
  } catch {
    return "";
  }
}

/** WSL has explicit markers and a kernel release marker; native Linux has neither. */
export function isWslEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  kernelRelease = readKernelRelease(),
): boolean {
  return (
    environment.WSL_INTEROP !== undefined ||
    environment.WSL_DISTRO_NAME !== undefined ||
    /(?:microsoft|wsl)/i.test(kernelRelease)
  );
}

const WSL_WINDOWS_PATH_ENTRY = /^\/mnt\/[A-Za-z](?:\/|$)/;

function isWslWindowsPathEntry(pathEntry: string): boolean {
  return WSL_WINDOWS_PATH_ENTRY.test(pathEntry);
}

/** Remove only WSL-translated Windows PATH entries from one sandbox child. */
export function sanitizeSandboxEnvironment(
  environment: NodeJS.ProcessEnv,
  kernelRelease = readKernelRelease(),
): NodeJS.ProcessEnv {
  if (!isWslEnvironment(environment, kernelRelease) || environment.PATH === undefined)
    return { ...environment };

  return {
    ...environment,
    PATH: environment.PATH.split(delimiter)
      .filter((pathEntry) => !isWslWindowsPathEntry(pathEntry))
      .join(delimiter),
  };
}
