import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parse as parseShell } from "shell-quote";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";

export type PathAction = "allow" | "deny" | "ask";

/** Commands add the reason-gated action: the call is returned to the agent,
 * which must obtain a one-shot approval via ask_permission (SPEC §3・§4). */
export type CommandAction = PathAction | "ask_with_reason";

/**
 * Dialog approval info returned when the user approved access through a
 * confirmation dialog (§2.3). `undefined` means access passed without a new
 * dialog approval (config allow or an existing dynamic grant). For write
 * approvals, `bashWritable` reports whether the granted path also became
 * writable in the bash sandbox: unset paths do, ask-final paths stay
 * read-only there (§6.1).
 */
export type PathApproval = {
  operation: "read" | "write";
  scope: "file" | "directory";
  grantedPath: string;
  bashWritable?: boolean;
};

/** Where a command pattern matched inside its candidate segment, for dialog highlighting (§2.3). */
export type MatchSpan = { candidate: string; index: number; length: number };

/** Action resolution result together with the pattern that caused it (§2.3). */
export type PathActionMatch = { action: PathAction; matched?: string };
export type CommandActionMatch = {
  action: CommandAction;
  matched?: string;
  /** Where the pattern matched inside its candidate segment, for dialog highlighting (§2.3). */
  matchSpan?: MatchSpan;
};

export type ToolName = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";

/** Session metadata forwarded to run-tools so the sandboxed bash tool can expose PI_* env vars. */
export type ToolSession = {
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
};

/** ask_permission tool outcome (§3 許可要求ツール): denial resolves instead of throwing.
 * `bashWritable` on granted/already-granted outcomes reports whether the
 * granted subtree is also writable from bash (unset paths) or fs tools only
 * (ask-final paths stay read-only in bash, §6.1). */
export type WritePermissionRequest =
  | { status: "already granted"; grantedPath: string; bashWritable: boolean }
  | { status: "granted"; grantedPath: string; bashWritable: boolean }
  | { status: "denied"; grantedPath: string; reason?: string };

/** ask_permission outcome for `command` (§3): same semantics, one-shot command approval. */
export type CommandPermissionRequest =
  | { status: "already granted"; command: string }
  | { status: "granted"; command: string }
  | { status: "denied"; command: string; reason?: string };

/** One `{action: pattern(s)}` element of the flat rule lists (SPEC §6). */
type PathRuleEntry = { action: PathAction; patterns: string[] };
export type CommandRuleEntry = { action: CommandAction; patterns: string[] };

/** A command pattern with its configured regex source and compiled form (SPEC §6). */
export type CompiledCommandPattern = { source: string; regex: RegExp };
export type CompiledCommandRuleEntry = {
  action: CommandAction;
  patterns: CompiledCommandPattern[];
};

type SandboxedToolsConfig = {
  read?: PathRuleEntry[];
  write?: PathRuleEntry[];
  credentials?: string[];
  commands?: CommandRuleEntry[];
};

type ToolUI = {
  confirm(title: string, message: string): Promise<boolean>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  /** Provides the dialog accent color so the highlight can restore it afterwards. */
  theme?: { getFgAnsi(color: "accent"): string };
};

const ALLOW_OPTION = "Yes, allow";
const DENY_OPTION = "No, deny (reason next)";

/** Guidance returned with an `ask_with_reason` rejection so the model re-requests via ask_permission (§3・§4). */
const COMMAND_REASON_HINT =
  "This command requires a reason. Call ask_permission with this exact command and a reason; do not rewrite the command to bypass the gate.";

/** Max concurrently running sandbox (bwrap) processes per pi process (SPEC §7). */
const MAX_CONCURRENT_SANDBOX_RUNS = 4;

/**
 * Process-wide semaphore state for SPEC §7: every Sandbox instance in this
 * pi process shares one cap, so "1 つの pi プロセス内で最大 4" holds even if
 * the extension ever creates multiple instances. Waiters are woken strictly
 * FIFO by finishing runs.
 */
let runningSandboxRuns = 0;
const sandboxWaiters: (() => void)[] = [];

function withSandboxSlot<T>(run: () => Promise<T>): Promise<T> {
  const start = async () => {
    if (runningSandboxRuns >= MAX_CONCURRENT_SANDBOX_RUNS)
      await new Promise<void>((resolve) => sandboxWaiters.push(resolve));
    runningSandboxRuns++;
    try {
      return await run();
    } finally {
      runningSandboxRuns--;
      sandboxWaiters.shift()?.();
    }
  };
  return start();
}

type ToolContext = {
  cwd: string;
  hasUI?: boolean;
  ui?: ToolUI;
};

type RunOptions = {
  cwd?: string;
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  timeout?: number;
  mode?: "fs" | "bash";
};

type RunResult = { exitCode: number | null; stdout: Buffer; stderr: Buffer };

type RunToolsResponse = { ok: true; result: AgentToolResult<any> } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPatterns(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseSandboxedToolsConfig(source: string): SandboxedToolsConfig {
  const parsed = parseYaml(source) as unknown;
  if (!isRecord(parsed)) throw new Error("sandboxed-tools config must be a mapping");

  const parseEntries = <A extends PathAction | CommandAction>(
    value: unknown,
    allowedActions: readonly A[],
  ): { action: A; patterns: string[] }[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("rule section must be a list of entries");
    return value.map((element): { action: A; patterns: string[] } => {
      if (!isRecord(element)) throw new Error("rule entry must be a mapping");
      const keys = Object.keys(element);
      if (keys.length !== 1) throw new Error("rule entry must declare exactly one action");
      const [action] = keys as [A];
      if (!allowedActions.includes(action)) throw new Error(`unknown action: ${action}`);
      const pattern = element[action];
      if (typeof pattern !== "string" && !Array.isArray(pattern))
        throw new Error("rule entry pattern must be a string or a list of strings");
      return {
        action,
        patterns: typeof pattern === "string" ? [pattern] : asPatterns(pattern),
      };
    });
  };

  const pathActions = ["allow", "ask", "deny"] as const;
  const commandActions = [...pathActions, "ask_with_reason"] as const;

  return {
    read: parseEntries(parsed.read, pathActions),
    write: parseEntries(parsed.write, pathActions),
    credentials: asPatterns(parsed.credentials),
    commands: parseEntries(parsed.commands, commandActions),
  };
}

function expandBraces(pattern: string): string[] {
  const braceStart = pattern.indexOf("{");
  if (braceStart === -1) return [pattern];
  const braceEnd = pattern.indexOf("}", braceStart);
  if (braceEnd === -1) return [pattern];
  const choices = pattern.slice(braceStart + 1, braceEnd).split(",");
  return choices.flatMap((choice) =>
    expandBraces(`${pattern.slice(0, braceStart)}${choice}${pattern.slice(braceEnd + 1)}`),
  );
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern.charAt(index);
    if (character === "*") {
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
        source += pattern.slice(index, end + 1);
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

function hasGlob(pattern: string): boolean {
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
 * path. Outside a Git repository the entry expands to nothing (§3).
 */
function expandGitMainWorktreePath(pattern: string, mainWorktree: string | undefined): string[] {
  if (!pattern.includes(GIT_MAIN_WORKTREE_PATH)) return [pattern];
  return mainWorktree === undefined
    ? []
    : [pattern.replaceAll(GIT_MAIN_WORKTREE_PATH, mainWorktree)];
}

function expandRepositoryName(pattern: string, mainWorktree: string | undefined): string[] {
  if (!pattern.includes(REPOSITORY_NAME)) return [pattern];
  return mainWorktree === undefined
    ? []
    : [pattern.replaceAll(REPOSITORY_NAME, basename(mainWorktree))];
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
 * Git variables expand to nothing outside a Git repository (§3); ${XDG_RUNTIME_DIR}
 * resolves everywhere.
 */
function expandRuntimeVariables(pattern: string, mainWorktree: string | undefined): string[] {
  return expandGitMainWorktreePath(pattern, mainWorktree)
    .flatMap((expanded) => expandRepositoryName(expanded, mainWorktree))
    .map((expanded) => expanded.replaceAll(XDG_RUNTIME_DIR, resolveXdgRuntimeDir()));
}

function resolvePattern(pattern: string, cwd: string): string {
  const homeExpanded =
    pattern === "~"
      ? homedir()
      : pattern.startsWith("~/")
        ? join(homedir(), pattern.slice(2))
        : pattern;
  return isAbsolute(homeExpanded) ? resolve(homeExpanded) : resolve(cwd, homeExpanded);
}

type ShellToken = string | { op?: string; pattern?: string; comment?: string };

/** Control operators that end one simple command and start the next. */
const SEGMENT_OPS = new Set([";", "&&", "||", "|", "|&", ";;", "&", "(", ")", "<("]);

/** Leading words that wrap the real command head (`env gh pr create` etc.). */
const SEGMENT_HEAD_SKIPS = new Set(["{", "}", "env"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a shell command into one candidate per simple command it may run, so
 * that `deny`/`ask` patterns cannot be bypassed by compound commands
 * (`git remote add ...; git push ...`). shell-quote keeps quoting and operator
 * semantics but flattens newlines, so newlines become ";" first. Parentheses
 * also open a segment: subshells, command substitutions, and process
 * substitutions all execute their contents. Heredoc bodies, comments, and
 * empty expansion words are skipped; leading `{`, `}`, `env`, and `VAR=value`
 * words are stripped so patterns match the actual command head.
 *
 * Known blind spots (ADR): backtick substitution, `bash -c`/`eval`/script
 * indirection, and other wrapper prefixes (`nohup`, `timeout`, ...).
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let words: string[] = [];
  let consecutiveHeredocOps = 0;
  let expectHeredocDelimiter = false;
  let heredocEnd: string | null = null;

  const flush = () => {
    while (words.length > 0) {
      const head = words[0];
      if (head !== undefined && (SEGMENT_HEAD_SKIPS.has(head) || ENV_ASSIGNMENT.test(head)))
        words.shift();
      else break;
    }
    if (words.length > 0) {
      segments.push(words.join(" "));
      words = [];
    }
  };

  for (const token of parseShell(command.replaceAll("\n", ";")) as ShellToken[]) {
    if (heredocEnd !== null) {
      if (typeof token === "string" && token === heredocEnd) heredocEnd = null;
      continue;
    }
    if (typeof token === "string" || token.pattern !== undefined) {
      const word = typeof token === "string" ? token : token.pattern;
      if (word === undefined || word === "") continue;
      if (expectHeredocDelimiter) {
        heredocEnd = word.replace(/^-+/, "");
        expectHeredocDelimiter = false;
        continue;
      }
      consecutiveHeredocOps = 0;
      words.push(word);
      continue;
    }
    if (token.comment !== undefined) continue;
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
  flush();
  return segments;
}

type CommandPatternMatch = { pattern: string; index: number; length: number };

/**
 * Compile configured command patterns to regexes (SPEC §6). Patterns that do
 * not compile are dropped (they never match) and reported in `invalidPatterns`
 * so the session start can warn about them.
 */
export function compileCommandRuleEntries(entries: CommandRuleEntry[] | undefined): {
  entries: CompiledCommandRuleEntry[];
  invalidPatterns: string[];
} {
  const compiled: CompiledCommandRuleEntry[] = [];
  const invalidPatterns: string[] = [];
  for (const entry of entries ?? []) {
    const patterns: CompiledCommandPattern[] = [];
    for (const source of entry.patterns) {
      try {
        patterns.push({ source, regex: new RegExp(source) });
      } catch {
        invalidPatterns.push(source);
      }
    }
    compiled.push({ action: entry.action, patterns });
  }
  return { entries: compiled, invalidPatterns };
}

function findCommandPattern(
  patterns: CompiledCommandPattern[] | undefined,
  candidate: string,
): CommandPatternMatch | undefined {
  for (const pattern of patterns ?? []) {
    const match = pattern.regex.exec(candidate);
    if (match !== null)
      return { pattern: pattern.source, index: match.index, length: match[0].length };
  }
  return undefined;
}

export function resolveCommandActionMatch(
  entries: CompiledCommandRuleEntry[] | undefined,
  command: string,
): CommandActionMatch {
  if (!entries) return { action: "deny" };
  const withSpan = (
    action: CommandAction,
    match: CommandPatternMatch,
    candidate: string,
  ): CommandActionMatch => ({
    action,
    matched: match.pattern,
    matchSpan: { candidate, index: match.index, length: match.length },
  });
  // Last match wins (SPEC §6): every matching entry overwrites the resolution,
  // so a later `{allow: systemctl status}` carves allow out of an earlier
  // `{ask: systemctl}`. No match at all is unset (deny).
  const actionFor = (candidate: string): CommandActionMatch => {
    let resolved: CommandActionMatch = { action: "deny" };
    for (const entry of entries) {
      const match = findCommandPattern(entry.patterns, candidate);
      if (match !== undefined) resolved = withSpan(entry.action, match, candidate);
    }
    return resolved;
  };
  // Parse fallback: a command that yields no segments (empty or unparsable)
  // is checked as the raw string, preserving the pre-split behavior.
  const candidates = splitCommandSegments(command);
  if (candidates.length === 0) candidates.push(command);
  const results = candidates.map(actionFor);
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
function actionPatterns(entries: PathRuleEntry[] | undefined, action: PathAction): string[] {
  return (entries ?? [])
    .filter((entry) => entry.action === action)
    .flatMap((entry) => entry.patterns);
}

// "/**" is the `read.allow` sentinel for all paths (§3).
// bun's globSync silently drops dotfiles, so expand by walking the static prefix
// and testing each path with globToRegExp (same semantics as command matching).
// Walks the whole prefix subtree; add per-segment matching if large trees get slow.
function expandGlobPattern(absolutePattern: string): string[] {
  const regexes = expandBraces(absolutePattern).map(globToRegExp);
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
  walk(staticPrefix);
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
function expandPathPatterns(
  patterns: string[] | undefined,
  cwd: string,
  gitMainWorktreePath: string | undefined,
  allowAllPaths = false,
  globCache?: Map<string, string[]>,
): string[] {
  return (patterns ?? []).flatMap((pattern) =>
    // The single-valued runtime variables must fan out before the
    // brace expansion below.
    expandRuntimeVariables(pattern, gitMainWorktreePath).flatMap((variableExpanded) =>
      expandBraces(variableExpanded).flatMap((expandedPattern) => {
        if (allowAllPaths && expandedPattern === "*") return ["/**"];
        const resolvedPattern = resolvePattern(expandedPattern, cwd);
        if (!hasGlob(resolvedPattern)) return [resolvedPattern];
        let expanded = globCache?.get(resolvedPattern);
        if (expanded === undefined) {
          expanded = expandGlobPattern(resolvedPattern);
          globCache?.set(resolvedPattern, expanded);
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

function pathCovers(grantedPath: string, candidatePath: string): boolean {
  const normalizedCandidate = resolve(candidatePath);
  return (
    grantedPath === "/**" ||
    grantedPath === "/" ||
    normalizedCandidate === grantedPath ||
    normalizedCandidate.startsWith(`${grantedPath}${sep}`)
  );
}

function pathsMatchCandidate(paths: string[], candidatePath: string): boolean {
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

/** Dialog line explaining which pattern caused the confirmation (§2.3). */
function matchedPatternNote(matched: string | undefined): string {
  return matched === undefined ? "no matching pattern (default ask)" : `matched: ${matched}`;
}

// Invert + yellow: the inverted background stays visible on any terminal palette,
// where basic yellow alone can sit too close to the dialog accent color. Selective
// SGRs (no full reset) so the dialog's accent/bold styling survives.
const MATCH_HIGHLIGHT = "\x1b[7m\x1b[33m";
const MATCH_HIGHLIGHT_END = "\x1b[27m";

/** Characters that may surround a shell word in the raw command string. */
const WORD_BOUNDARY = /[\s;&|()<>"'`]/;

function isWordBoundary(character: string | undefined): boolean {
  return character === undefined || WORD_BOUNDARY.test(character);
}

/** First occurrence of `text` in `raw` that starts and ends on shell word boundaries. */
function findWordBoundaryIndex(raw: string, text: string): number {
  for (let at = raw.indexOf(text); at !== -1; at = raw.indexOf(text, at + 1)) {
    if (isWordBoundary(raw[at - 1]) && isWordBoundary(raw[at + text.length])) return at;
  }
  return -1;
}

/**
 * Highlight the matched span inside the raw command for the ask dialog (§2.3).
 * The span lives in the reassembled candidate (quotes stripped, head words skipped),
 * so map it back: try the whole candidate first, then the matched text alone.
 * Return the raw command unchanged when neither is found (quoted commands).
 * The span is closed with `MATCH_HIGHLIGHT_END` (leaving the inverted region) and
 * `accentStart` so the dialog accent color continues after it.
 */
function highlightCommandMatch(raw: string, span: MatchSpan, accentStart: string): string {
  const candidateAt = findWordBoundaryIndex(raw, span.candidate);
  const start =
    candidateAt !== -1
      ? candidateAt + span.index
      : findWordBoundaryIndex(raw, span.candidate.slice(span.index, span.index + span.length));
  if (start === -1) return raw;
  return (
    raw.slice(0, start) +
    MATCH_HIGHLIGHT +
    raw.slice(start, start + span.length) +
    MATCH_HIGHLIGHT_END +
    accentStart +
    raw.slice(start + span.length)
  );
}

function addParentDirectories(args: string[], targetPath: string): void {
  const parents: string[] = [];
  for (let parent = dirname(targetPath); parent !== "/"; parent = dirname(parent))
    parents.push(parent);
  parents.reverse();
  for (const parent of parents) args.push("--dir", parent);
}

function parseRunToolsResponse(execution: RunResult): RunToolsResponse {
  try {
    const parsed = JSON.parse(execution.stdout.toString("utf8")) as {
      ok?: boolean;
      result?: AgentToolResult<any>;
      error?: string;
    };
    if (parsed.ok === true && parsed.result !== undefined)
      return { ok: true, result: parsed.result };
    if (parsed.ok === false && typeof parsed.error === "string")
      return { ok: false, error: parsed.error };
  } catch {
    // Non-JSON stdout means run-tools itself failed to start; fall through to exit info.
  }
  const stderrText = execution.stderr.toString("utf8").trim();
  const exitDetail =
    execution.exitCode !== null
      ? `run-tools exited with code ${execution.exitCode}`
      : "run-tools terminated";
  return { ok: false, error: stderrText || exitDetail };
}

export function defaultSandboxConfigPath(
  agentDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): string {
  const deployedPath = join(agentDir, "config", "sandbox.yaml");
  if (existsSync(deployedPath)) return deployedPath;

  const sourcePath = join(agentDir, "config.exact", "sandbox.yaml");
  if (existsSync(sourcePath)) return sourcePath;

  return join(agentDir, "..", "..", ".agents", "config.exact", "sandbox.yaml");
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

export class Sandbox {
  private readonly dynamicPaths = new Map<string, Set<"read" | "write">>();
  /** One-shot ask_permission approvals, as normalized command segments (§3). */
  private readonly approvedCommands: string[][] = [];
  // pi's TUI has a single slot for extension dialogs: a second dialog replaces
  // the first without resolving its promise, deadlocking that tool call.
  // One global queue; split per dialog kind if contention ever matters.
  private uiQueue: Promise<void> = Promise.resolve();
  private readonly config: SandboxedToolsConfig;
  /** Command entries with patterns compiled to regex once at startup (SPEC §6). */
  private readonly commandEntries: CompiledCommandRuleEntry[];
  /** Configured command patterns that failed regex compilation, deduped in config order (SPEC §6). */
  readonly invalidCommandPatterns: string[];
  /** Glob expansions are computed once per resolved pattern (§3 startup semantics). */
  private readonly globCache = new Map<string, string[]>();
  private readonly runToolsPath = join(dirname(fileURLToPath(import.meta.url)), "run-tools.ts");
  private readonly piPackageDir = getPackageDir();

  constructor(
    private readonly cwd: string,
    configPath = defaultSandboxConfigPath(),
  ) {
    try {
      this.config = parseSandboxedToolsConfig(readFileSync(configPath, "utf8"));
    } catch {
      this.config = {};
    }
    const compiledCommands = compileCommandRuleEntries(this.config.commands);
    this.commandEntries = compiledCommands.entries;
    this.invalidCommandPatterns = [...new Set(compiledCommands.invalidPatterns)];
    this.prepareWriteDirectories();
    this.warmGlobCache();
  }

  /**
   * Expand every configured glob once at Sandbox construction (§3 startup
   * semantics) so later re-expansions reuse the first result and never pick up
   * paths created during the session.
   */
  private warmGlobCache(): void {
    const gitMainWorktreePath = resolveGitMainWorktreePath(this.cwd);
    expandPathSection(this.config.read, this.cwd, true, gitMainWorktreePath, this.globCache);
    expandPathSection(this.config.write, this.cwd, false, gitMainWorktreePath, this.globCache);
    expandPathPatterns(
      this.config.credentials,
      this.cwd,
      gitMainWorktreePath,
      false,
      this.globCache,
    );
  }

  // Path sections are recomputed on every access instead of cached, so
  // Git variables re-run `git worktree list` per authorization and bind
  // decision (§3). Globs stay startup-expanded via globCache.
  private readPaths(): ExpandedPathSection {
    return expandPathSection(
      this.config.read,
      this.cwd,
      true,
      resolveGitMainWorktreePath(this.cwd),
      this.globCache,
    );
  }

  private writePaths(): ExpandedPathSection {
    return expandPathSection(
      this.config.write,
      this.cwd,
      false,
      resolveGitMainWorktreePath(this.cwd),
      this.globCache,
    );
  }

  private credentialPaths(): string[] {
    return expandPathPatterns(
      this.config.credentials,
      this.cwd,
      resolveGitMainWorktreePath(this.cwd),
      false,
      this.globCache,
    );
  }

  /**
   * Expanded write-section paths split by their final resolved action (§3
   * last-match-wins). `allow` holds the paths fs tools would allow per call —
   * the only configured paths the bash sandbox may writable-bind. `restricted`
   * holds the deny- and ask-final paths, which must stay non-writable in bash
   * (§6.1) exactly as fs tools deny or ask about them per call.
   */
  private writePathsByFinalAction(): { allow: string[]; restricted: string[] } {
    const section = this.writePaths();
    const allow = new Set<string>();
    const restricted = new Set<string>();
    for (const entry of section)
      for (const path of entry.paths) {
        if (allow.has(path) || restricted.has(path)) continue;
        if (resolvePathActionMatch(section, path).action === "allow") allow.add(path);
        else restricted.add(path);
      }
    return { allow: [...allow], restricted: [...restricted] };
  }

  /**
   * Whether a write grant also opens the granted path in the bash sandbox
   * (§6.1): unset paths become writable there via the dynamic-grant bind,
   * while ask-final paths are re-bound read-only after every writable bind,
   * so they stay non-writable in bash even after this fs-side approval.
   */
  private grantWritableViaBash(grantedPath: string): boolean {
    return resolvePathActionMatch(this.writePaths(), grantedPath).action !== "ask";
  }

  private hiddenFsPaths(): string[] {
    const gitMainWorktreePath = resolveGitMainWorktreePath(this.cwd);
    return [
      ...expandPathPatterns(
        actionPatterns(this.config.read, "deny"),
        this.cwd,
        gitMainWorktreePath,
        false,
        this.globCache,
      ),
      ...expandPathPatterns(
        this.config.credentials,
        this.cwd,
        gitMainWorktreePath,
        false,
        this.globCache,
      ),
    ];
  }

  private prepareWriteDirectories(): void {
    // Only allow-final paths are created (§6.1): a deny/ask-final path is
    // never writable-bound, so creating it would hand the sandbox a path fs
    // tools deny writing to. Globs expand to existing paths only, so they
    // skip the mkdir -p guarantee by themselves. Runtime-directory paths
    // belong to the session manager: an absent runtime directory is left
    // unbound by --bind-try instead of being created.
    const runtimeDir = resolveXdgRuntimeDir();
    for (const path of this.writePathsByFinalAction().allow) {
      if (path === runtimeDir || path.startsWith(`${runtimeDir}${sep}`)) continue;
      if (!existsSync(path)) mkdirSync(path, { recursive: true });
    }
  }

  private readAllPaths(): boolean {
    return actionPatterns(this.config.read, "allow").includes("*");
  }

  private addMount(args: string[], sourcePath: string, writable: boolean): void {
    if (!existsSync(sourcePath)) return;
    addParentDirectories(args, sourcePath);
    args.push(writable ? "--bind-try" : "--ro-bind-try", sourcePath, sourcePath);
  }

  private addConfiguredMounts(args: string[], mode: "fs" | "bash"): void {
    const gitMainWorktreePath = resolveGitMainWorktreePath(this.cwd);
    const mounted = new Set<string>();
    const writableMountPaths: string[] = [];
    const { allow: allowFinalPaths, restricted: restrictedFinalPaths } =
      this.writePathsByFinalAction();

    const mount = (path: string, writable: boolean) => {
      const normalized = resolve(path);
      if (mounted.has(`${normalized}:${writable}`)) return;
      mounted.add(`${normalized}:${writable}`);
      if (writable) writableMountPaths.push(normalized);
      this.addMount(args, normalized, writable);
    };

    if (!this.readAllPaths()) {
      for (const path of expandPathPatterns(
        actionPatterns(this.config.read, "allow"),
        this.cwd,
        gitMainWorktreePath,
        true,
        this.globCache,
      ))
        mount(path, false);
      // bwrap later mounts win: the cwd read-only bind must precede every
      // writable mount below, or it would shadow write allows and dynamic
      // write grants inside the cwd, turning the whole tree read-only.
      mount(this.cwd, false);
    }
    // Writable binds mirror the fs tools' per-call resolution (§6.1): only
    // allow-final paths are mounted writable, so a later deny or ask entry
    // keeps its paths out of the bash sandbox even when an allow entry
    // declared them.
    for (const path of allowFinalPaths) mount(path, true);
    for (const [path, accessModes] of this.dynamicPaths) mount(path, accessModes.has("write"));

    if (mode === "bash") {
      for (const path of this.credentialPaths()) {
        if (existsSync(path)) mount(path, false);
      }
      // fs tools resolve deny/ask-final paths per call; the bash sandbox has
      // no per-path gate, so re-bind them read-only after every writable
      // bind. Later bwrap mounts win, which keeps a path non-writable even
      // through an allowed ancestor or a dynamic grant (§6.1) — an ask-final
      // path stays non-writable in bash even after an fs approval.
      for (const restrictedPath of restrictedFinalPaths) {
        if (writableMountPaths.some((writablePath) => pathCovers(writablePath, restrictedPath)))
          mount(restrictedPath, false);
      }
    }
  }

  private addHiddenPaths(args: string[], mode: "fs" | "bash"): void {
    if (mode === "bash") return;
    for (const path of this.hiddenFsPaths()) {
      if (!existsSync(path)) continue;
      addParentDirectories(args, path);
      if (statSync(path).isDirectory()) args.push("--tmpfs", path);
      else args.push("--ro-bind-try", "/dev/null", path);
    }
  }

  buildArgs(mode: "fs" | "bash", commandCwd = this.cwd): string[] {
    const args = ["--die-with-parent", "--proc", "/proc"];
    if (this.readAllPaths()) args.push("--ro-bind", "/", "/");
    args.push("--dev", "/dev");
    if (mode === "bash") {
      // Keep GPU device binds optional across native Linux and WSL environments.
      for (const devicePath of ["/dev/dxg", "/dev/dri"])
        args.push("--dev-bind-try", devicePath, devicePath);
    }
    for (const runtimePath of [
      "/nix",
      "/usr",
      "/bin",
      "/lib",
      "/lib64",
      "/etc",
      "/run",
      join(homedir(), ".nix-profile"),
    ]) {
      if (!this.readAllPaths() && existsSync(runtimePath))
        args.push("--ro-bind-try", runtimePath, runtimePath);
    }
    this.addConfiguredMounts(args, mode);
    this.addHiddenPaths(args, mode);
    args.push("--chdir", commandCwd);
    return args;
  }

  async authorizePath(
    operation: "read" | "write",
    candidatePath: string,
    context: ToolContext,
  ): Promise<PathApproval | undefined> {
    const absolutePath = resolve(candidatePath);
    if (pathsMatchCandidate(this.credentialPaths(), absolutePath)) {
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    }
    const section = operation === "read" ? this.readPaths() : this.writePaths();
    const { action, matched } = resolvePathActionMatch(section, absolutePath);
    if (action === "allow") return undefined;
    if (action === "deny" && matched !== undefined)
      throw new Error(`Access denied: ${absolutePath}`);
    if (this.hasDynamicGrant(operation, absolutePath)) return undefined;
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      // A sibling tool call may have obtained the grant while this call queued.
      if (this.hasDynamicGrant(operation, absolutePath)) return undefined;
      return this.requestAccess(operation, absolutePath, ui, matched);
    });
  }

  private async withUiLock<T>(showDialog: () => Promise<T>): Promise<T> {
    const previous = this.uiQueue;
    let release!: () => void;
    this.uiQueue = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await showDialog();
    } finally {
      release();
    }
  }

  private hasDynamicGrant(operation: "read" | "write", candidatePath: string): boolean {
    for (const [grantedPath, accessModes] of this.dynamicPaths)
      if (accessModes.has(operation) && pathCovers(grantedPath, candidatePath)) return true;
    return false;
  }

  /**
   * Request user approval for writing under a directory subtree via the
   * ask_permission tool (§3 許可要求ツール). Explicit deny and credential
   * paths throw; denial resolves so the tool can return it as its result.
   */
  async requestWritePermission(
    directoryPath: string,
    reason: string,
    context: ToolContext,
  ): Promise<WritePermissionRequest> {
    const absolutePath = resolve(directoryPath);
    if (pathsMatchCandidate(this.credentialPaths(), absolutePath))
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    const { action, matched } = resolvePathActionMatch(this.writePaths(), absolutePath);
    if (action === "deny" && matched !== undefined)
      throw new Error(`Access denied: ${absolutePath}`);
    const grantedPath = this.directoryScopePath(absolutePath);
    if (action === "allow" || this.hasDynamicGrant("write", grantedPath))
      return {
        status: "already granted",
        grantedPath,
        bashWritable: this.grantWritableViaBash(grantedPath),
      };
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      // A sibling tool call may have obtained the grant while this call queued.
      if (this.hasDynamicGrant("write", grantedPath))
        return {
          status: "already granted",
          grantedPath,
          bashWritable: this.grantWritableViaBash(grantedPath),
        };
      return this.confirmWritePermission(grantedPath, reason, ui, matched);
    });
  }

  /** The write scope for a permission request: the path itself, or its parent for a file path (§3). */
  private directoryScopePath(absolutePath: string): string {
    try {
      return statSync(absolutePath).isDirectory() ? absolutePath : dirname(absolutePath);
    } catch {
      // Non-existent paths (e.g. a worktree to create) request the subtree at the path.
      return absolutePath;
    }
  }

  private async confirmWritePermission(
    grantedPath: string,
    reason: string,
    ui: ToolUI,
    matched?: string,
  ): Promise<WritePermissionRequest> {
    const question = "Allow write access to directory subtree?";
    const details = `${grantedPath}\nreason: ${reason}\n${matchedPatternNote(matched)}`;
    if (ui.select) {
      const selectedOption = await ui.select(`${question}\n${details}`, [
        ALLOW_OPTION,
        DENY_OPTION,
      ]);
      if (selectedOption === ALLOW_OPTION) return this.grantWriteDirectory(grantedPath);
    } else if (await ui.confirm(question, details)) {
      return this.grantWriteDirectory(grantedPath);
    }
    const denialReason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return { status: "denied", grantedPath, ...(denialReason ? { reason: denialReason } : {}) };
  }

  /** Grant the directory-scope dynamic write and build the request result (§3). */
  private grantWriteDirectory(grantedPath: string): WritePermissionRequest {
    this.addDynamicGrant("write", grantedPath, "directory");
    return {
      status: "granted",
      grantedPath,
      bashWritable: this.grantWritableViaBash(grantedPath),
    };
  }

  private async requestAccess(
    operation: "read" | "write",
    absolutePath: string,
    ui: ToolUI,
    matched?: string,
  ): Promise<PathApproval> {
    const directoryScopeOption = "Directory (subtree)";
    const title = `Allow ${operation} access?\n${absolutePath}\n${matchedPatternNote(matched)}`;
    if (ui.select) {
      const selectedOption = await ui.select(
        title,
        operation === "write"
          ? ["File only", directoryScopeOption, DENY_OPTION]
          : [ALLOW_OPTION, DENY_OPTION],
      );
      if (selectedOption === undefined || selectedOption === DENY_OPTION)
        throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
      if (operation === "write") {
        if (selectedOption !== "File only" && selectedOption !== directoryScopeOption)
          throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
        const scope = selectedOption === directoryScopeOption ? "directory" : "file";
        const grantPath = scope === "directory" ? dirname(absolutePath) : absolutePath;
        this.addDynamicGrant("write", grantPath, scope);
        return {
          operation: "write",
          scope,
          grantedPath: grantPath,
          bashWritable: this.grantWritableViaBash(grantPath),
        };
      }
      if (selectedOption !== ALLOW_OPTION)
        throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
      this.addDynamicGrant(operation, absolutePath, "file");
      return { operation, scope: "file", grantedPath: absolutePath };
    }
    const approved = await ui.confirm(
      `Allow ${operation} access?`,
      `${absolutePath}\n${matchedPatternNote(matched)}`,
    );
    if (!approved) throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
    this.addDynamicGrant(operation, absolutePath, "file");
    if (operation === "write")
      return {
        operation,
        scope: "file",
        grantedPath: absolutePath,
        bashWritable: this.grantWritableViaBash(absolutePath),
      };
    return { operation, scope: "file", grantedPath: absolutePath };
  }

  private denialMessage(base: string, reason?: string): string {
    return reason === undefined ? base : `${base}\nUser reason: ${reason}`;
  }

  /** Build the denial error after a canceled selection dialog, asking for an optional reason (§2.3). */
  private async deniedError(message: string, ui: ToolUI): Promise<Error> {
    const reason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return new Error(this.denialMessage(message, reason || undefined));
  }

  private addDynamicGrant(
    operation: "read" | "write",
    grantPath: string,
    scope: "file" | "directory",
  ): void {
    if (operation === "write") this.ensureGrantPathExists(grantPath, scope);
    const accessModes = this.dynamicPaths.get(grantPath) ?? new Set<"read" | "write">();
    accessModes.add(operation);
    this.dynamicPaths.set(grantPath, accessModes);
  }

  private ensureGrantPathExists(grantPath: string, scope: "file" | "directory"): void {
    if (scope === "directory") {
      mkdirSync(grantPath, { recursive: true });
      return;
    }
    mkdirSync(dirname(grantPath), { recursive: true });
    if (!existsSync(grantPath)) writeFileSync(grantPath, "");
  }

  /**
   * Match `command` against the one-shot ask_permission approvals (§3).
   * Quoting differences normalize away because segments are reassembled
   * words; partial matches never consume. Consumes the approval on match.
   */
  private consumeApprovedCommand(command: string): boolean {
    const segments = splitCommandSegments(command);
    const index = this.approvedCommands.findIndex(
      (approved) =>
        approved.length === segments.length &&
        approved.every((segment, i) => segment === segments[i]),
    );
    if (index === -1) return false;
    this.approvedCommands.splice(index, 1);
    return true;
  }

  /**
   * Request user approval for a gated command via the ask_permission tool
   * (§3 許可要求ツール). Explicit deny and `ask` (confirmed at bash time)
   * throw; denial resolves so the tool can return it as its result.
   */
  async requestCommandPermission(
    command: string,
    reason: string,
    context: ToolContext,
  ): Promise<CommandPermissionRequest> {
    const { action, matched, matchSpan } = resolveCommandActionMatch(this.commandEntries, command);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (action === "allow") return { status: "already granted", command };
    if (action === "ask")
      throw new Error(`Command is confirmed when run via bash; no pre-approval needed: ${command}`);
    if (!context.hasUI || !context.ui) throw new Error(`Access requires confirmation: ${command}`);
    const ui = context.ui;
    return this.withUiLock(() =>
      this.confirmCommandPermission(command, reason, ui, matched, matchSpan),
    );
  }

  private async confirmCommandPermission(
    command: string,
    reason: string,
    ui: ToolUI,
    matched?: string,
    matchSpan?: MatchSpan,
  ): Promise<CommandPermissionRequest> {
    const question = "Allow command execution?";
    // Same highlight rule as the `ask` dialog (§2.3): show where the pattern
    // matched, unless the UI lacks a theme or NO_COLOR is set.
    const display =
      matchSpan !== undefined && ui.theme && !process.env.NO_COLOR
        ? highlightCommandMatch(command, matchSpan, ui.theme.getFgAnsi("accent"))
        : command;
    const details = `${display}\nreason: ${reason}\n${matchedPatternNote(matched)}`;
    if (ui.select) {
      const selectedOption = await ui.select(`${question}\n${details}`, [
        ALLOW_OPTION,
        DENY_OPTION,
      ]);
      if (selectedOption === ALLOW_OPTION) return this.grantCommandApproval(command);
    } else if (await ui.confirm(question, details)) {
      return this.grantCommandApproval(command);
    }
    const denialReason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return { status: "denied", command, ...(denialReason ? { reason: denialReason } : {}) };
  }

  private grantCommandApproval(command: string): CommandPermissionRequest {
    this.approvedCommands.push(splitCommandSegments(command));
    return { status: "granted", command };
  }

  /**
   * Resolve the command action and, for `ask`, confirm with the user. For
   * `ask_with_reason`, consume a one-shot ask_permission approval when the
   * command matches one (§3), otherwise return the call to the agent with a
   * guidance hint. Returns true when this call passed through an approval
   * (dialog or one-shot; §2.3 approval note), false when it passed without a
   * dialog (config allow). Denial throws.
   */
  authorizeCommand(command: string, context: ToolContext): Promise<boolean> {
    const { action, matched, matchSpan } = resolveCommandActionMatch(this.commandEntries, command);
    if (action === "allow") return Promise.resolve(false);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (action === "ask_with_reason") {
      if (this.consumeApprovedCommand(command)) return Promise.resolve(true);
      throw new Error(`Command requires a reason: ${command}\n${COMMAND_REASON_HINT}`);
    }
    if (!context.hasUI || !context.ui) throw new Error(`Command requires confirmation: ${command}`);
    const ui = context.ui;
    const note = matchedPatternNote(matched);
    const display =
      matchSpan !== undefined && ui.theme && !process.env.NO_COLOR
        ? highlightCommandMatch(command, matchSpan, ui.theme.getFgAnsi("accent"))
        : command;
    return this.withUiLock(async () => {
      if (ui.select) {
        const selectedOption = await ui.select(`Allow command?\n${display}\n${note}`, [
          ALLOW_OPTION,
          DENY_OPTION,
        ]);
        if (selectedOption !== ALLOW_OPTION)
          throw await this.deniedError(`Command denied by user: ${command}`, ui);
        return true;
      }
      if (await ui.confirm("Allow command?", `${display}\n${note}`)) return true;
      throw await this.deniedError(`Command denied by user: ${command}`, ui);
    });
  }

  /**
   * Execute one tool call entirely inside the sandbox: a single bwrap invocation
   * runs `bun run-tools.ts <toolName>`, which calls the pi-standard tool definition.
   */
  async runTool(
    toolName: ToolName,
    params: unknown,
    options: {
      mode: "fs" | "bash";
      signal?: AbortSignal;
      session?: ToolSession;
      onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
    },
  ): Promise<AgentToolResult<any>> {
    const request = JSON.stringify({ toolCallId: "cli", params, session: options.session });
    const execution = await this.run("bun", [this.runToolsPath, toolName], {
      input: request,
      mode: options.mode,
      signal: options.signal,
      env: { ...process.env, SANDBOXED_TOOLS_PI_PACKAGE_DIR: this.piPackageDir },
      onData: options.onData,
    });
    const response = parseRunToolsResponse(execution);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  private run(
    command: string,
    commandArgs: string[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    return this.withSandboxSlot(() => this.runSandboxProcess(command, commandArgs, options));
  }

  private runSandboxProcess(
    command: string,
    commandArgs: string[],
    options: RunOptions,
  ): Promise<RunResult> {
    return new Promise((resolveRun, rejectRun) => {
      const environment = sanitizeSandboxEnvironment({ ...process.env, ...options.env });
      const child = spawn(
        "bwrap",
        [...this.buildArgs(options.mode ?? "fs", options.cwd ?? this.cwd), command, ...commandArgs],
        {
          cwd: this.cwd,
          env: environment,
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeoutHandle =
        options.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeout * 1000)
          : undefined;
      const onAbort = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onData?.(chunk, "stdout");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onData?.(chunk, "stderr");
      });
      child.on("error", rejectRun);
      child.on("close", (exitCode) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted) return rejectRun(new Error("aborted"));
        if (timedOut) return rejectRun(new Error(`timeout:${options.timeout}`));
        resolveRun({
          exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }

  /**
   * Gate one sandbox run on the SPEC §7 concurrency limit. Waiters queue in
   * FIFO order and a finishing run wakes the next waiter, so waiting never
   * changes the run's outcome and start order is preserved.
   */
  private withSandboxSlot<T>(run: () => Promise<T>): Promise<T> {
    return withSandboxSlot(run);
  }
}
