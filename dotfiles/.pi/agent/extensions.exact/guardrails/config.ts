import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parse as parseShell } from "shell-quote";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export type PathAction = "allow" | "deny" | "ask";

export type MatchSpan = { ranges: { index: number; length: number }[] };

/** Action resolution result together with the pattern that caused it (§2.3). */
export type PathActionMatch = { action: PathAction; matched?: string };
export type CommandActionMatch = {
  action: CommandAction;
  matched?: string;
  matchSpan?: MatchSpan;
};

/** Commands add the reason-gated action: the call is returned to the agent,
 * which must obtain a one-shot approval via ask_permission (SPEC §3・§4). */
export type CommandAction = PathAction | "ask_with_reason";

export type ToolName = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";

/** Session metadata forwarded to run-tools so the sandboxed bash tool can expose PI_* env vars. */
export type ToolSession = {
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
};

/** One `{action: pattern(s)}` element of the flat rule lists (SPEC §6). */
type PathRuleEntry = { action: PathAction; patterns: string[] };
export type CommandRuleEntry = { action: CommandAction; pattern: string; args: string[] };

/** One `{action: argPatterns}` rule item of a command family (SPEC §6). */
const CommandRuleItemSchema = Type.Object(
  {
    allow: Type.Optional(Type.Array(Type.String())),
    ask: Type.Optional(Type.Array(Type.String())),
    ask_with_reason: Type.Optional(Type.Array(Type.String())),
    deny: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false, minProperties: 1, maxProperties: 1 },
);

/** Command family: exactly one command-pattern key mapped to its rule items (SPEC §6). */
const CommandFamilySchema = Type.Record(
  Type.String(),
  Type.Array(CommandRuleItemSchema, { minItems: 1 }),
  { minProperties: 1, maxProperties: 1 },
);

export type CompiledCommandPattern = { source: string; command: RegExp; args: RegExp[] };
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
    const [action, args] = Object.entries(item)[0] as [CommandAction, string[]];
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
    write: config.write?.map(toPathEntry),
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

/**
 * Expand the single-valued ${GIT_MAIN_WORKTREE_PATH} into the main worktree
 * path, falling back to the session cwd outside a Git repository (§3).
 */
function expandGitMainWorktreePath(
  pattern: string,
  mainWorktree: string | undefined,
  cwd: string,
): string[] {
  if (!pattern.includes(GIT_MAIN_WORKTREE_PATH)) return [pattern];
  return [pattern.replaceAll(GIT_MAIN_WORKTREE_PATH, mainWorktree ?? resolve(cwd))];
}

export const XDG_RUNTIME_DIR = "${XDG_RUNTIME_DIR}";

/**
 * Absolute path of the user's runtime directory (systemd-logind tmpfs):
 * $XDG_RUNTIME_DIR when set, falling back to the /run/user/<uid> convention.
 */
export function resolveXdgRuntimeDir(): string {
  // getuid is optional in @types for cross-platform compat, but this
  // extension requires bwrap (Linux); "unknown" names a path that never
  // exists, so --bind-try safely skips it on platforms without getuid.
  const uid = process.getuid?.();
  return process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid ?? "unknown"}`;
}

/**
 * Expand every single-valued runtime variable in a pattern.
 * ${GIT_MAIN_WORKTREE_PATH} falls back to the session cwd outside a Git
 * repository (§3); ${XDG_RUNTIME_DIR} resolves everywhere.
 */
export function expandRuntimeVariables(
  pattern: string,
  mainWorktree: string | undefined,
  cwd: string,
): string[] {
  if (pattern.includes(REPOSITORY_NAME) && repositoryName(cwd, mainWorktree) === "") return [];
  const repositoryMasked = pattern.replaceAll(REPOSITORY_NAME, LITERAL_REPOSITORY_NAME);
  return expandGitMainWorktreePath(repositoryMasked, mainWorktree, cwd).map((expanded) =>
    expanded.replaceAll(XDG_RUNTIME_DIR, resolveXdgRuntimeDir()),
  );
}

const LITERAL_REPOSITORY_NAME = "\0repo;";

export function repositoryName(cwd: string, mainWorktree: string | undefined): string {
  return basename(mainWorktree ?? resolve(cwd));
}

export function restoreRepositoryName(pattern: string, name: string): string {
  return pattern.replace(/\0(repo|[0-9a-f]+);/g, (_, token: string) =>
    token === "repo" ? name : String.fromCodePoint(Number.parseInt(token, 16)),
  );
}

export function resolvePattern(pattern: string, cwd: string): string {
  const homeExpanded =
    pattern === "~"
      ? homedir()
      : pattern.startsWith("~/")
        ? join(homedir(), pattern.slice(2))
        : pattern;
  const literalCwd = pattern.includes(LITERAL_REPOSITORY_NAME)
    ? cwd.replace(/[*?[\]{}]/g, (character) => `\0${character.charCodeAt(0).toString(16)};`)
    : cwd;
  return isAbsolute(homeExpanded) ? resolve(homeExpanded) : resolve(literalCwd, homeExpanded);
}

type ShellToken = string | { op?: string; pattern?: string; comment?: string };
type TokenRange = { index: number; length: number };
type CommandSegment = { tokens: string[]; ranges: TokenRange[] };

const SEGMENT_OPS = new Set([";", "&&", "||", "|", "|&", ";;", "&", "(", ")", "<("]);
const SEGMENT_HEAD_SKIPS = new Set(["{", "}", "env"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_OPERATOR = /^(?:\|\||&&|;;|\|&|<\(|<<<|>>|>&|<&|[&;()|<>])/;

type ShellChunk = { source: string; index: number; hasQuotedPart?: boolean };

function shellChunks(command: string): ShellChunk[] {
  const chunks: ShellChunk[] = [];
  let index = 0;
  while (index < command.length) {
    const character = command[index]!;
    if (character === "\n") {
      chunks.push({ source: ";", index: index++ });
      continue;
    }
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "#") {
      const end = command.indexOf("\n", index);
      index = end === -1 ? command.length : end;
      continue;
    }
    const operator = command.slice(index).match(SHELL_OPERATOR)?.[0];
    if (operator !== undefined) {
      chunks.push({ source: operator, index });
      index += operator.length;
      continue;
    }
    const start = index;
    let quote: string | undefined;
    let hasQuotedPart = false;
    while (index < command.length) {
      const next = command[index]!;
      if (next === "\\" && quote !== "'") {
        index += Math.min(2, command.length - index);
        continue;
      }
      if (quote !== undefined) {
        if (next === quote) quote = undefined;
      } else if (next === "'" || next === '"') {
        quote = next;
        hasQuotedPart = true;
      } else if (/\s/.test(next) || SHELL_OPERATOR.test(command.slice(index))) {
        break;
      }
      index++;
    }
    chunks.push({ source: command.slice(start, index), index: start, hasQuotedPart });
  }
  return chunks;
}

function parseCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let words: string[] = [];
  let ranges: TokenRange[] = [];
  let consecutiveHeredocOps = 0;
  let expectHeredocDelimiter = false;
  let heredocEnd: string | null = null;

  function flush(): void {
    while (
      words.length > 0 &&
      (SEGMENT_HEAD_SKIPS.has(words[0]!) || ENV_ASSIGNMENT.test(words[0]!))
    ) {
      words.shift();
      ranges.shift();
    }
    if (words.length > 0) segments.push({ tokens: words, ranges });
    words = [];
    ranges = [];
  }

  let commented = false;
  for (const chunk of shellChunks(command)) {
    if (command[chunk.index] === "\n") commented = false;
    if (commented) continue;
    for (const token of parseShell(chunk.source) as ShellToken[]) {
      if (heredocEnd !== null) {
        if (typeof token === "string" && token === heredocEnd) heredocEnd = null;
        continue;
      }
      if (typeof token === "string" || token.pattern !== undefined) {
        const word = typeof token === "string" ? token : token.pattern;
        if (word === undefined || (word === "" && !chunk.hasQuotedPart)) continue;
        if (expectHeredocDelimiter) {
          heredocEnd = word.replace(/^-+/, "");
          expectHeredocDelimiter = false;
          continue;
        }
        consecutiveHeredocOps = 0;
        words.push(word);
        ranges.push({ index: chunk.index, length: chunk.source.length });
        continue;
      }
      if (token.comment !== undefined) {
        commented = true;
        continue;
      }
      const op = token.op;
      expectHeredocDelimiter = false;
      if (op === "<") {
        consecutiveHeredocOps++;
        if (consecutiveHeredocOps === 2) expectHeredocDelimiter = true;
        continue;
      }
      consecutiveHeredocOps = 0;
      if (op !== undefined && SEGMENT_OPS.has(op)) flush();
    }
  }
  flush();
  return segments;
}

export function splitCommandSegments(command: string): string[][] {
  return parseCommandSegments(command).map((segment) => segment.tokens);
}

export function compileCommandRuleEntries(entries: CommandRuleEntry[] | undefined): {
  entries: CompiledCommandRuleEntry[];
  invalidPatterns: string[];
} {
  const compiled: CompiledCommandRuleEntry[] = [];
  const invalidPatterns: string[] = [];
  for (const entry of entries ?? []) {
    const source = JSON.stringify({ command: entry.pattern, args: entry.args });
    try {
      new RegExp(entry.pattern);
      for (const argument of entry.args) new RegExp(argument);
      compiled.push({
        action: entry.action,
        patterns: [
          {
            source,
            command: new RegExp("^(?:" + entry.pattern + ")(?![\\s\\S])"),
            args: entry.args.map((pattern) => new RegExp("^(?:" + pattern + ")(?![\\s\\S])")),
          },
        ],
      });
    } catch {
      invalidPatterns.push(source);
    }
  }
  return { entries: compiled, invalidPatterns };
}

function findCommandPattern(
  patterns: CompiledCommandPattern[],
  candidate: CommandSegment,
): { pattern: string; ranges: TokenRange[] } | undefined {
  for (const pattern of patterns) {
    if (!pattern.command.test(candidate.tokens[0]!)) continue;
    const args = candidate.tokens.slice(1);
    if (!pattern.args.every((regex) => args.some((argument) => regex.test(argument)))) continue;
    const ranges = candidate.ranges.filter(
      (_, index) =>
        index === 0 || pattern.args.some((regex) => regex.test(candidate.tokens[index]!)),
    );
    return { pattern: pattern.source, ranges };
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
          matched: match.pattern,
          matchSpan: { ranges: match.ranges },
        };
    }
    return resolved;
  });
  return (
    results.find((result) => result.action === "deny") ??
    results.find((result) => result.action === "ask_with_reason") ??
    results.find((result) => result.action === "ask") ??
    results.find((result) => result.action === "allow") ?? { action: "deny" }
  );
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

// "/**" is the `read.allow` sentinel for all paths (§3).
// bun's globSync silently drops dotfiles, so expand by walking the static prefix
// and testing each path with globToRegExp (same semantics as command matching).
// Walks the whole prefix subtree; add per-segment matching if large trees get slow.
function expandGlobPattern(absolutePattern: string, name: string): string[] {
  const regexes = expandBraces(absolutePattern).map((pattern) => globToRegExp(pattern, name));
  let staticPrefix = "";
  for (const segment of absolutePattern.split("/")) {
    if (hasGlob(segment) || segment.includes("{")) break;
    staticPrefix = staticPrefix ? join(staticPrefix, segment) : segment || "/";
  }
  const matches: string[] = [];
  const walk = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (regexes.some((regex) => regex.test(path))) matches.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(restoreRepositoryName(staticPrefix, name));
  return matches;
}

/**
 * Expand config path patterns into absolute paths. `gitMainWorktreePath` is
 * re-resolved by the caller on every access, so Git-variable entries track
 * the repository state during the session. Globs, in contrast,
 * keep the startup-expansion semantics (§3): pass a `globCache` to reuse the
 * first expansion per resolved pattern instead of picking up paths created
 * later in the session.
 */
export function expandPathPatterns(
  patterns: string[] | undefined,
  cwd: string,
  gitMainWorktreePath: string | undefined,
  allowAllPaths = false,
  globCache?: Map<string, string[]>,
): string[] {
  const name = repositoryName(cwd, gitMainWorktreePath);
  return (patterns ?? []).flatMap((pattern) =>
    // The single-valued runtime variables must fan out before the
    // brace expansion below.
    expandRuntimeVariables(pattern, gitMainWorktreePath, cwd).flatMap((variableExpanded) =>
      expandBraces(variableExpanded).flatMap((expandedPattern) => {
        if (allowAllPaths && expandedPattern === "*") return ["/**"];
        const resolvedPattern = resolvePattern(expandedPattern, cwd);
        if (!hasGlob(resolvedPattern)) return [restoreRepositoryName(resolvedPattern, name)];
        const cacheKey = JSON.stringify([resolvedPattern, name]);
        let expanded = globCache?.get(cacheKey);
        if (expanded === undefined) {
          expanded = expandGlobPattern(resolvedPattern, name);
          globCache?.set(cacheKey, expanded);
        }
        return expanded;
      }),
    ),
  );
}

export type ExpandedPathSection = { action: PathAction; paths: string[] }[];

export function expandPathSection(
  entries: PathRuleEntry[] | undefined,
  cwd: string,
  allowAllPaths = false,
  gitMainWorktreePath = resolveGitMainWorktreePath(cwd),
  globCache?: Map<string, string[]>,
): ExpandedPathSection {
  // `allowAllPaths` (read section) turns the `"*"` sentinel into "/**" only
  // for allow entries, preserving the read-only-whole-filesystem semantics.
  return (entries ?? []).map((entry) => ({
    action: entry.action,
    paths: expandPathPatterns(
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
    grantedPath === "/**" ||
    grantedPath === "/" ||
    normalizedCandidate === grantedPath ||
    normalizedCandidate.startsWith(`${grantedPath}${sep}`)
  );
}

export function pathsMatchCandidate(paths: string[], candidatePath: string): boolean {
  return paths.some((path) => pathCovers(path, candidatePath));
}

export function resolvePathActionMatch(
  section: ExpandedPathSection | undefined,
  candidatePath: string,
): PathActionMatch {
  if (!section) return { action: "deny" };
  // Last match wins (SPEC §6). When nothing matched, `matched` stays undefined,
  // which callers treat as unset (deny, but a permission request is possible).
  let resolved: PathActionMatch = { action: "deny" };
  for (const entry of section) {
    const path = entry.paths.find((candidate) => pathCovers(candidate, candidatePath));
    if (path !== undefined) resolved = { action: entry.action, matched: path };
  }
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
