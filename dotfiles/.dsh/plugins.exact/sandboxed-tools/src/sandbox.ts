// dotfiles-sandboxed-tools policy engine — phase 1 of the host-side port of
// the pi sandboxed-tools extension (the behavioral source of truth).
//
// This module owns everything sandbox.yaml-related that runs before any
// sandbox process exists (SPEC §2.2, §3, §4, §6):
//   - sandbox.yaml parsing and validation, with the all-sections-unset (= deny)
//     fallback when validation fails (§6)
//   - command-pattern compilation to regexes with invalid-pattern reporting (§6)
//   - path-pattern resolution: runtime variables (${GIT_MAIN_WORKTREE_PATH},
//     ${REPOSITORY_NAME}, ${XDG_RUNTIME_DIR}), glob expansion, `~`/relative
//     resolution, and the read-only `"*"` sentinel (§3)
//   - last-match-wins action resolution with the explicit-deny vs unset
//     distinction (§3), for paths and commands alike (§4)
//   - compound-command segmentation so no gate can be bypassed by `;`, `&&`,
//     `||`, `|`, `|&`, `&`, `;;`, newlines, subshells, command/process
//     substitution; heredoc bodies and comments are excluded (§4)
//   - credentials recognition (§2.2): always-denied for fs tools, never part
//     of read/write action resolution
//
// Phase 3 additions (§2.3・§3): the confirmation dialogs over the
//   userQuestions seam (read/write/command approvals with the denial-reason
//   follow-up), session-scoped dynamic grants with the §6.1 existence
//   guarantee, one-shot command approvals for ask_with_reason, the ask_permission
//   request flows, and the process-wide confirmation serialization. Phase 2
//   added the bwrap argv assembly with binds and masks (§6.1), the §6.1
//   existence guarantee, the §2/§4 authorization gates, the 4-slot sandbox
//   concurrency semaphore, and the sandboxed runner spawn (§7) — the runner
//   IO itself lives in runner.ts/io-core.ts.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseShell } from "shell-quote";
import {
  ALLOW_OPTION,
  DENY_OPTION,
  DIRECTORY_OPTION,
  FILE_OPTION,
  askChoice,
  askDenialReason,
  matchedPatternNote,
  type ConfirmUi,
} from "./confirm";
import type { RunnerRequest, RunnerResponse } from "./runner";

export type PathAction = "allow" | "deny" | "ask";

/** Commands add the reason-gated action: the call is returned to the agent,
 * which must obtain a one-shot approval via ask_permission (SPEC §3・§4). */
export type CommandAction = PathAction | "ask_with_reason";

/** Action resolution result together with the pattern that caused it (§2.3). */
export type PathActionMatch = { action: PathAction; matched?: string };

/** Where a command pattern matched inside its candidate segment, for dialog highlighting (§2.3). */
export type MatchSpan = { candidate: string; index: number; length: number };

export type CommandActionMatch = {
  action: CommandAction;
  matched?: string;
  matchSpan?: MatchSpan;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPatterns(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Parse and validate sandbox.yaml (SPEC §6). Throws on the violations that
 * must fail the whole load: a section that is not a list, an entry that is
 * not a mapping, an entry declaring more than one (or an unknown) action, or
 * a pattern that is neither a string nor a list of strings. Non-string
 * elements inside a pattern list are ignored. Callers treat a throw as
 * "all sections unset (= deny)".
 */
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

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

export const GIT_MAIN_WORKTREE_PATH = "${GIT_MAIN_WORKTREE_PATH}";
export const REPOSITORY_NAME = "${REPOSITORY_NAME}";
export const XDG_RUNTIME_DIR = "${XDG_RUNTIME_DIR}";

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

/**
 * Normalize a tool-call path argument before authorization (SPEC §3): expand
 * `~` / `~/...` to the home directory. The same normalized value must be used
 * for both the confirmation and the sandboxed IO, so the reviewed path and
 * the executed path always match. Anything else is returned unchanged for the
 * caller to resolve against the session cwd.
 */
export function normalizeToolPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
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
 * Known blind spots (carried over from the pi implementation): backtick
 * substitution, `bash -c`/`eval`/script indirection, and other wrapper
 * prefixes (`nohup`, `timeout`, ...).
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
 * so the plugin can warn about them in the dsh host log.
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
  // The strictest action across all segments wins (SPEC §4).
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
 * Fence the matched span with `>>>` / `<<<` for the §2.3 command dialogs. The
 * question UI renders plain text, so markers replace pi's terminal invert.
 * The span lives in the reassembled candidate (quotes stripped, head words
 * skipped), so map it back: try the whole candidate first, then the matched
 * text alone. Returns the raw command unchanged when neither is found
 * (quoted commands) or when `span` is absent.
 */
export function highlightCommandMatch(raw: string, span?: MatchSpan): string {
  if (span === undefined) return raw;
  const candidateAt = findWordBoundaryIndex(raw, span.candidate);
  const start =
    candidateAt !== -1
      ? candidateAt + span.index
      : findWordBoundaryIndex(raw, span.candidate.slice(span.index, span.index + span.length));
  if (start === -1) return raw;
  return `${raw.slice(0, start)}>>>${raw.slice(start, start + span.length)}<<<${raw.slice(start + span.length)}`;
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

/** Config path: `$DSH_HOME/config/sandbox.yaml`, or `~/.dsh/config/sandbox.yaml` when unset (SPEC §6). */
export function defaultSandboxConfigPath(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(dshHome, "config", "sandbox.yaml");
}

/**
 * Host resources the sandbox needs bound to run the in-sandbox runner (§7):
 * the node binary, the compiled runner CLI, the ripgrep binary directory for
 * glob/grep, and a writable spill directory for capped bash output (§4).
 */
export type SandboxHostPaths = {
  /** Absolute path of the node executable that runs the runner (its directory is ro-bound). */
  nodePath: string;
  /** Absolute path of the compiled runner CLI (its directory is ro-bound). */
  runnerJsPath: string;
  /** Directory containing the ripgrep binary, when resolved (ro-bound). */
  rgDir?: string;
  /** Writable directory bound into the sandbox for bash output spill. */
  spillDir?: string;
  /** Absolute rtk executable used by rewritten commands, when available. */
  rtkPath?: string;
  /** rtk config file or directory used by rewritten commands, when available. */
  rtkConfigPath?: string;
};

/** One §2/§2.2 authorization outcome for a path operation. */
export type PathAuthorization =
  | { kind: "allow" }
  /** Confirmation required (an `ask` entry, or unset — `match.matched` is undefined only for unset). */
  | { kind: "ask"; match: PathActionMatch }
  /** Denied — an explicit deny, or unset (= deny, but a permission request is possible). */
  | { kind: "deny"; match: PathActionMatch }
  /** §2.2: always denied for fs tools, overrides read/write resolution. */
  | { kind: "credential" };

/**
 * Dialog approval info returned when the user approved access through a
 * confirmation dialog (§2.3). `undefined` means access passed without a new
 * dialog approval (config allow or an existing dynamic grant).
 */
export type PathApproval = {
  operation: "read" | "write";
  scope: "file" | "directory";
  grantedPath: string;
  /** True when the §6.1 existence guarantee created `grantedPath` as a new
   * empty file (file-scope write approval on a not-yet-existing path). The
   * first write to it succeeds as create without a prior read (§2.4). */
  createdFile?: boolean;
};

/** ask_permission tool outcome for `path` (§3): denial resolves instead of throwing. */
export type WritePermissionRequest =
  | { status: "already granted"; grantedPath: string }
  | { status: "granted"; grantedPath: string }
  | { status: "denied"; grantedPath: string; reason?: string };

/** ask_permission outcome for `command` (§3): same semantics, one-shot command approval. */
export type CommandPermissionRequest =
  | { status: "already granted"; command: string }
  | { status: "granted"; command: string }
  | { status: "denied"; command: string; reason?: string };

/** What one confirmation-capable call passes to the §2.3 dialogs. */
export type ConfirmOptions = {
  /** The userQuestions seam; without it an `ask` resolution denies (§2.3). */
  ui?: ConfirmUi;
  /** The calling agent, so the Web answerer accepts the question. */
  agent?: unknown;
  signal?: AbortSignal;
};

/** Max concurrently running sandbox (bwrap) processes per dsh process (SPEC §7). */
const MAX_CONCURRENT_SANDBOX_RUNS = 4;

/** Process-wide semaphore state for SPEC §7: every Sandbox instance in this
 * dsh process shares one cap. Waiters are woken strictly FIFO by finishing
 * runs, and waiting never changes a run's outcome. */
let runningSandboxRuns = 0;
const sandboxWaiters: (() => void)[] = [];

export function withSandboxSlot<T>(run: () => Promise<T>): Promise<T> {
  return (async () => {
    if (runningSandboxRuns >= MAX_CONCURRENT_SANDBOX_RUNS)
      await new Promise<void>((resolve) => sandboxWaiters.push(resolve));
    runningSandboxRuns += 1;
    try {
      return await run();
    } finally {
      runningSandboxRuns -= 1;
      sandboxWaiters.shift()?.();
    }
  })();
}

/** Confirmation serialization state (SPEC §2/§2.3): confirmations and their
 * denial-reason follow-ups are shown one at a time per dsh process, in call
 * order. The queue is process-wide like the sandbox semaphore so main and
 * subagent sessions never stack dialogs. */
let uiQueue: Promise<void> = Promise.resolve();

export function withUiLock<T>(showDialog: () => Promise<T>): Promise<T> {
  const previous = uiQueue;
  let release!: () => void;
  uiQueue = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  return (async () => {
    await previous;
    try {
      return await showDialog();
    } finally {
      release();
    }
  })();
}

/** `Base message` plus the optional `User reason:` line (§2.3). */
function denialMessage(base: string, reason?: string): string {
  return reason === undefined ? base : `${base}\nUser reason: ${reason}`;
}

/** Guidance returned with an `ask_with_reason` rejection (§4): re-approval
 * arrives through the ask_permission tool. */
export const COMMAND_REASON_HINT =
  "This command requires a reason. Call ask_permission with this exact command and a reason; do not rewrite the command to bypass the gate.";

/** Options for one sandboxed runner execution. */
export type RunToolOptions = {
  mode: "fs" | "bash";
  /** Sandbox cwd (--chdir); defaults to the Sandbox's session cwd. */
  cwd?: string;
  signal?: AbortSignal;
  /** Outer safety timeout in ms; the in-sandbox runner owns the tool timeout. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

type SandboxRunResult = { exitCode: number | null; stdout: Buffer; stderr: Buffer };

export function parseRunnerResponse(execution: SandboxRunResult): RunnerResponse {
  try {
    const parsed = JSON.parse(execution.stdout.toString("utf8")) as RunnerResponse;
    if (parsed.ok === true && "result" in parsed) return parsed;
    if (parsed.ok === false && typeof parsed.error === "string") return parsed;
  } catch {
    // Non-JSON stdout means the runner itself failed; fall through to exit info.
  }
  const stderrText = execution.stderr.toString("utf8").trim();
  const exitDetail =
    execution.exitCode !== null
      ? `runner exited with code ${execution.exitCode}`
      : "runner terminated";
  return { ok: false, error: stderrText || exitDetail };
}

/** Runtime paths ro-bound so the runner executable and its libraries resolve (NixOS included, §7). */
export const RUNTIME_PATHS = [
  "/nix",
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc",
  "/run",
  join(homedir(), ".nix-profile"),
];

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

/**
 * The sandboxed-tools policy engine and sandbox launcher: configuration
 * loading with the all-deny fallback, pattern expansion, action resolution
 * for paths and commands, the §2/§2.2/§4 authorization gates with the §2.3
 * confirmation dialogs and session-scoped dynamic grants, one-shot command
 * approvals (§3), the §6.1 bind assembly with masks and the existence
 * guarantee, and the §7 sandboxed runner spawn under the 4-slot concurrency
 * semaphore.
 */
export class Sandbox {
  private readonly config: SandboxedToolsConfig;
  /** Session-scoped dynamic grants: absolute path → granted operations (§3). */
  private readonly dynamicPaths = new Map<string, Set<"read" | "write">>();
  /** One-shot ask_permission approvals, as normalized command segments (§3). */
  private readonly approvedCommands: string[][] = [];
  /** Command entries with patterns compiled to regex once at startup (SPEC §6). */
  private readonly commandEntries: CompiledCommandRuleEntry[];
  /** Configured command patterns that failed regex compilation, deduped in config order (SPEC §6). */
  readonly invalidCommandPatterns: string[];
  /** Glob expansions are computed once per resolved pattern (§3 startup semantics). */
  private readonly globCache = new Map<string, string[]>();
  /** Host resources bound into every sandbox run (§7); required for runTool. */
  private readonly hostPaths: SandboxHostPaths | undefined;

  constructor(
    private readonly cwd: string,
    configPath = defaultSandboxConfigPath(),
    hostPaths?: SandboxHostPaths,
  ) {
    this.hostPaths = hostPaths;
    try {
      this.config = parseSandboxedToolsConfig(readFileSync(configPath, "utf8"));
    } catch {
      // Validation failure leaves every section unset, which resolves to deny
      // for both paths and commands (SPEC §6).
      this.config = {};
    }
    const compiledCommands = compileCommandRuleEntries(this.config.commands);
    this.commandEntries = compiledCommands.entries;
    this.invalidCommandPatterns = [...new Set(compiledCommands.invalidPatterns)];
    this.warmGlobCache();
    this.prepareWriteDirectories();
  }

  /**
   * Resolve one §2 authorization for a path operation: credentials always
   * deny (§2.2), otherwise the read/write section decides (§3 last match
   * wins; unset = deny but a permission request stays possible — phase 3).
   * `ask` is returned as-is; the caller owns the confirmation-or-deny step.
   */
  authorizePath(operation: "read" | "write", candidatePath: string): PathAuthorization {
    const absolutePath = resolve(candidatePath);
    if (pathsMatchCandidate(this.credentialPaths(), absolutePath)) return { kind: "credential" };
    const section = operation === "read" ? this.readSection() : this.writeSection();
    const match = resolvePathActionMatch(section, absolutePath);
    if (match.action === "allow") return { kind: "allow" };
    return { kind: match.action, match };
  }

  // -----------------------------------------------------------------------
  // §2.3 confirmations, §3 dynamic grants and permission requests
  // -----------------------------------------------------------------------

  /**
   * Enforce one §2 path authorization with the §2.3 confirmation dialog for
   * `ask` and unset paths: credentials and explicit denies throw before any
   * dialog, an existing dynamic grant passes without one, an approval adds a
   * session dynamic grant (with the §6.1 existence guarantee for write) and
   * returns its approval info, a denial throws the user-denied error with the
   * optional reason. `undefined` means access passed without a new dialog
   * approval (config allow, dynamic grant, or a grant queued in by a sibling
   * call — §2: no re-confirmation, no approval note).
   */
  async authorizePathWithConfirm(
    operation: "read" | "write",
    candidatePath: string,
    confirm: ConfirmOptions = {},
  ): Promise<PathApproval | undefined> {
    const absolutePath = resolve(candidatePath);
    if (pathsMatchCandidate(this.credentialPaths(), absolutePath))
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    const section = operation === "read" ? this.readSection() : this.writeSection();
    const { action, matched } = resolvePathActionMatch(section, absolutePath);
    if (action === "allow") return undefined;
    if (action === "deny" && matched !== undefined)
      throw new Error(`Access denied: ${absolutePath}`);
    if (this.hasDynamicGrant(operation, absolutePath)) return undefined;
    if (confirm.ui === undefined) throw new Error(`Access requires confirmation: ${absolutePath}`);
    return withUiLock(async () => {
      // A sibling tool call may have obtained the grant while this call queued
      // (§2): no re-confirmation, and no approval note for this call.
      if (this.hasDynamicGrant(operation, absolutePath)) return undefined;
      return this.confirmPathAccess(operation, absolutePath, matched, confirm);
    });
  }

  /** The §2.3 dialog for one fs path access (ask or unset). */
  private async confirmPathAccess(
    operation: "read" | "write",
    absolutePath: string,
    matched: string | undefined,
    confirm: ConfirmOptions,
  ): Promise<PathApproval> {
    const ui = confirm.ui as ConfirmUi;
    const detail = `${absolutePath}\n${matchedPatternNote(matched)}`;
    const outcome = await askChoice(ui, {
      question: `Allow ${operation} access?`,
      detail,
      options:
        operation === "write"
          ? [FILE_OPTION, DIRECTORY_OPTION, DENY_OPTION]
          : [ALLOW_OPTION, DENY_OPTION],
      agent: confirm.agent,
      signal: confirm.signal,
    });
    if (outcome.kind === "selected" && outcome.label === ALLOW_OPTION && operation === "read") {
      this.addDynamicGrant(operation, absolutePath, "file");
      return { operation, scope: "file", grantedPath: absolutePath };
    }
    if (outcome.kind === "selected" && operation === "write") {
      if (outcome.label === FILE_OPTION) {
        const createdFile = this.addDynamicGrant(operation, absolutePath, "file");
        return {
          operation,
          scope: "file",
          grantedPath: absolutePath,
          ...(createdFile ? { createdFile: true } : {}),
        };
      }
      if (outcome.label === DIRECTORY_OPTION) {
        const grantPath = dirname(absolutePath);
        this.addDynamicGrant(operation, grantPath, "directory");
        return { operation, scope: "directory", grantedPath: grantPath };
      }
    }
    // Deny option, cancel, interruption, or a label outside the offered set.
    const reason = await askDenialReason(ui, confirm);
    throw new Error(denialMessage(`Access denied by user: ${absolutePath}`, reason));
  }

  private hasDynamicGrant(operation: "read" | "write", candidatePath: string): boolean {
    for (const [grantedPath, accessModes] of this.dynamicPaths)
      if (accessModes.has(operation) && pathCovers(grantedPath, candidatePath)) return true;
    return false;
  }

  /**
   * Add one session dynamic grant (§3). Write grants get the §6.1 existence
   * guarantee first (outside the fence): directory scopes mkdir -p the
   * subtree root, file scopes mkdir -p the parent and touch the file. A
   * failing guarantee throws before the grant is recorded, so later calls
   * behave exactly as before the request. Returns whether the guarantee
   * created `grantPath` as a new empty file (file scope on a missing path).
   */
  private addDynamicGrant(
    operation: "read" | "write",
    grantPath: string,
    scope: "file" | "directory",
  ): boolean {
    const createdFile =
      operation === "write" ? this.ensureGrantPathExists(grantPath, scope) : false;
    const accessModes = this.dynamicPaths.get(grantPath) ?? new Set<"read" | "write">();
    accessModes.add(operation);
    this.dynamicPaths.set(grantPath, accessModes);
    return createdFile;
  }

  private ensureGrantPathExists(grantPath: string, scope: "file" | "directory"): boolean {
    if (scope === "directory") {
      mkdirSync(grantPath, { recursive: true });
      return false;
    }
    mkdirSync(dirname(grantPath), { recursive: true });
    if (existsSync(grantPath)) return false;
    writeFileSync(grantPath, "");
    return true;
  }

  /**
   * Request write access to a directory subtree via ask_permission (§3).
   * Explicit denies and credential paths throw; `already granted` resolves
   * without a dialog; otherwise the §2.3 dialog decides and an approval has
   * the same effect as a directory-scope write dynamic grant.
   */
  async requestWritePermission(
    directoryPath: string,
    reason: string,
    confirm: ConfirmOptions = {},
  ): Promise<WritePermissionRequest> {
    const absolutePath = resolve(directoryPath);
    if (pathsMatchCandidate(this.credentialPaths(), absolutePath))
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    const { action, matched } = resolvePathActionMatch(this.writeSection(), absolutePath);
    if (action === "deny" && matched !== undefined)
      throw new Error(`Access denied: ${absolutePath}`);
    const grantedPath = this.directoryScopePath(absolutePath);
    if (action === "allow" || this.hasDynamicGrant("write", grantedPath))
      return { status: "already granted", grantedPath };
    if (confirm.ui === undefined) throw new Error(`Access requires confirmation: ${absolutePath}`);
    return withUiLock(async () => {
      if (this.hasDynamicGrant("write", grantedPath))
        return { status: "already granted", grantedPath };
      return this.confirmWritePermission(grantedPath, reason, matched, confirm);
    });
  }

  /** The ask_permission scope: the path itself, or its parent for a file path (§3). */
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
    matched: string | undefined,
    confirm: ConfirmOptions,
  ): Promise<WritePermissionRequest> {
    const ui = confirm.ui as ConfirmUi;
    const outcome = await askChoice(ui, {
      question: "Allow write access to directory subtree?",
      detail: `${grantedPath}\nreason: ${reason}\n${matchedPatternNote(matched)}`,
      options: [ALLOW_OPTION, DENY_OPTION],
      agent: confirm.agent,
      signal: confirm.signal,
    });
    if (outcome.kind === "selected" && outcome.label === ALLOW_OPTION) {
      this.addDynamicGrant("write", grantedPath, "directory");
      return { status: "granted", grantedPath };
    }
    const denialReason = await askDenialReason(ui, confirm);
    return { status: "denied", grantedPath, ...(denialReason ? { reason: denialReason } : {}) };
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
   * Request approval for a reason-gated command via ask_permission (§3).
   * Explicit denies, unset commands, and `ask` commands throw (an `ask`
   * command is confirmed at bash time, so it is outside pre-approval);
   * `allow` resolves as already granted; otherwise the §2.3 dialog decides
   * and an approval becomes a one-shot approval consumed by the matching
   * bash call.
   */
  async requestCommandPermission(
    command: string,
    reason: string,
    confirm: ConfirmOptions = {},
  ): Promise<CommandPermissionRequest> {
    const { action, matched, matchSpan } = this.resolveCommandAction(command);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (action === "allow") return { status: "already granted", command };
    if (action === "ask")
      throw new Error(`Command is confirmed when run via bash; no pre-approval needed: ${command}`);
    if (confirm.ui === undefined) throw new Error(`Access requires confirmation: ${command}`);
    return withUiLock(() =>
      this.confirmCommandPermission(command, reason, matched, matchSpan, confirm),
    );
  }

  private async confirmCommandPermission(
    command: string,
    reason: string,
    matched: string | undefined,
    matchSpan: MatchSpan | undefined,
    confirm: ConfirmOptions,
  ): Promise<CommandPermissionRequest> {
    const ui = confirm.ui as ConfirmUi;
    const display = highlightCommandMatch(command, matchSpan);
    const outcome = await askChoice(ui, {
      question: "Allow command execution?",
      detail: `${display}\nreason: ${reason}\n${matchedPatternNote(matched)}`,
      options: [ALLOW_OPTION, DENY_OPTION],
      agent: confirm.agent,
      signal: confirm.signal,
    });
    if (outcome.kind === "selected" && outcome.label === ALLOW_OPTION) {
      this.approvedCommands.push(splitCommandSegments(command));
      return { status: "granted", command };
    }
    const denialReason = await askDenialReason(ui, confirm);
    return { status: "denied", command, ...(denialReason ? { reason: denialReason } : {}) };
  }

  /**
   * Gate one bash call (§4): `allow` passes without a note, `deny` blocks,
   * `ask_with_reason` consumes a matching one-shot approval (§3) or returns
   * the call to the agent with the reason hint, and `ask` runs the §2.3
   * dialog. Resolves true when the call passed through an approval (dialog
   * or one-shot; §2.3 approval note), false when it passed without one.
   */
  async authorizeCommand(command: string, confirm: ConfirmOptions = {}): Promise<boolean> {
    const { action, matched, matchSpan } = this.resolveCommandAction(command);
    if (action === "allow") return false;
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (action === "ask_with_reason") {
      if (this.consumeApprovedCommand(command)) return true;
      throw new Error(`Command requires a reason: ${command}\n${COMMAND_REASON_HINT}`);
    }
    if (confirm.ui === undefined) throw new Error(`Command requires confirmation: ${command}`);
    const display = highlightCommandMatch(command, matchSpan);
    return withUiLock(async () => {
      const outcome = await askChoice(confirm.ui as ConfirmUi, {
        question: "Allow command?",
        detail: `${display}\n${matchedPatternNote(matched)}`,
        options: [ALLOW_OPTION, DENY_OPTION],
        agent: confirm.agent,
        signal: confirm.signal,
      });
      if (outcome.kind === "selected" && outcome.label === ALLOW_OPTION) return true;
      const reason = await askDenialReason(confirm.ui as ConfirmUi, confirm);
      throw new Error(denialMessage(`Command denied by user: ${command}`, reason));
    });
  }

  // -----------------------------------------------------------------------
  // §6.1 existence guarantee and bwrap argv assembly
  // -----------------------------------------------------------------------

  /**
   * mkdir -p the write-allow fixed paths (§6.1) so bwrap --bind-try always
   * has something to bind. Globs expand to existing paths only and skip this;
   * ${XDG_RUNTIME_DIR} entries skip it too (the runtime directory belongs to
   * the session manager — an absent one stays unbound via --bind-try).
   */
  private prepareWriteDirectories(): void {
    const gitMainWorktreePath = resolveGitMainWorktreePath(this.cwd);
    for (const pattern of actionPatterns(this.config.write, "allow")) {
      if (hasGlob(pattern) || pattern.includes(XDG_RUNTIME_DIR)) continue;
      for (const expanded of expandRuntimeVariables(pattern, gitMainWorktreePath)) {
        const path = resolvePattern(expanded, this.cwd);
        if (!existsSync(path)) mkdirSync(path, { recursive: true });
      }
    }
  }

  private readAllPaths(): boolean {
    return actionPatterns(this.config.read, "allow").includes("*");
  }

  private addParentDirectories(args: string[], targetPath: string): void {
    const parents: string[] = [];
    for (let parent = dirname(targetPath); parent !== "/"; parent = dirname(parent))
      parents.push(parent);
    parents.reverse();
    for (const parent of parents) args.push("--dir", parent);
  }

  private addMount(args: string[], sourcePath: string, writable: boolean): void {
    if (!existsSync(sourcePath)) return;
    this.addParentDirectories(args, sourcePath);
    args.push(writable ? "--bind-try" : "--ro-bind-try", sourcePath, sourcePath);
  }

  /**
   * Expanded write-section paths whose final action is an explicit deny (§3
   * last-match-wins): the paths fs tools hard-deny for writing, which the
   * bash sandbox must also keep non-writable (§6.1).
   */
  private explicitWriteDenyPaths(): string[] {
    const section = this.writeSection();
    const deniedPaths = new Set<string>();
    for (const entry of section)
      for (const path of entry.paths)
        if (resolvePathActionMatch(section, path).action === "deny") deniedPaths.add(path);
    return [...deniedPaths];
  }

  /** Paths masked in the fs sandbox: read-deny declared patterns + credentials (§6.1). */
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

  private addConfiguredMounts(args: string[], mode: "fs" | "bash"): void {
    const gitMainWorktreePath = resolveGitMainWorktreePath(this.cwd);
    const mounted = new Set<string>();
    const writableMountPaths: string[] = [];

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
    }
    for (const path of expandPathPatterns(
      actionPatterns(this.config.write, "allow"),
      this.cwd,
      gitMainWorktreePath,
      false,
      this.globCache,
    ))
      mount(path, true);
    // Session dynamic grants (§3): write grants bind writable, read grants
    // read-only — the approved path is writable from bash too (§2.3 note).
    for (const [path, accessModes] of this.dynamicPaths) mount(path, accessModes.has("write"));

    if (mode === "bash") {
      for (const path of this.credentialPaths()) {
        if (existsSync(path)) mount(path, false);
      }
      // fs tools hard-deny explicit write denies per call; the bash sandbox
      // has no per-path gate, so re-bind denied paths read-only after every
      // writable bind. Later bwrap mounts win, which keeps a path non-writable
      // even through an allowed ancestor (§6.1).
      for (const deniedPath of this.explicitWriteDenyPaths()) {
        if (writableMountPaths.some((writablePath) => pathCovers(writablePath, deniedPath)))
          mount(deniedPath, false);
      }
    }
  }

  private addHiddenPaths(args: string[], mode: "fs" | "bash"): void {
    if (mode === "bash") return;
    for (const path of this.hiddenFsPaths()) {
      if (!existsSync(path)) continue;
      this.addParentDirectories(args, path);
      if (statSync(path).isDirectory()) args.push("--tmpfs", path);
      else args.push("--ro-bind-try", "/dev/null", path);
    }
  }

  private addHostPathMounts(args: string[]): void {
    if (!this.hostPaths) return;
    // With the whole root ro-bound (read allow "*"), only the writable spill
    // directory needs an explicit mount; everything else is already visible.
    if (!this.readAllPaths()) {
      this.addMount(args, dirname(this.hostPaths.nodePath), false);
      this.addMount(args, dirname(this.hostPaths.runnerJsPath), false);
      if (this.hostPaths.rgDir !== undefined) this.addMount(args, this.hostPaths.rgDir, false);
    }
    if (this.hostPaths.spillDir !== undefined) this.addMount(args, this.hostPaths.spillDir, true);
  }

  /** Re-bind rtk resources after configured writable mounts so they stay read-only. */
  private addRtkReadOnlyMounts(args: string[]): void {
    if (this.hostPaths?.rtkPath === undefined) return;
    this.addMount(args, dirname(this.hostPaths.rtkPath), false);
    if (this.hostPaths.rtkConfigPath !== undefined)
      this.addMount(args, this.hostPaths.rtkConfigPath, false);
  }

  /**
   * Assemble the bwrap argv for one sandboxed run (§7): whitelist binds,
   * read-only mounts, masks, runtime paths, host resource mounts, and the
   * sandbox cwd. Network namespaces are deliberately not unshared (§5).
   */
  buildArgs(mode: "fs" | "bash", commandCwd = this.cwd): string[] {
    const args = ["--die-with-parent", "--proc", "/proc"];
    if (this.readAllPaths()) args.push("--ro-bind", "/", "/");
    args.push("--dev", "/dev");
    if (!this.readAllPaths()) {
      for (const runtimePath of RUNTIME_PATHS) {
        if (existsSync(runtimePath)) args.push("--ro-bind-try", runtimePath, runtimePath);
      }
    }
    this.addHostPathMounts(args);
    this.addConfiguredMounts(args, mode);
    this.addRtkReadOnlyMounts(args);
    this.addHiddenPaths(args, mode);
    args.push("--chdir", commandCwd);
    return args;
  }

  // -----------------------------------------------------------------------
  // §7 sandboxed runner execution
  // -----------------------------------------------------------------------

  /**
   * Execute one tool call entirely inside the sandbox: a single bwrap
   * invocation runs `node <runnerJsPath>`, which reads the request from stdin
   * and answers the JSON envelope on stdout (§7). Gated by the §7 semaphore.
   */
  async runTool(request: RunnerRequest, options: RunToolOptions): Promise<unknown> {
    if (!this.hostPaths) throw new Error("sandboxed-tools: host paths are not configured");
    const execution = await this.run([this.hostPaths.nodePath, this.hostPaths.runnerJsPath], {
      input: JSON.stringify(request),
      mode: options.mode,
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      env: options.env,
    });
    const response = parseRunnerResponse(execution);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  private run(
    command: string[],
    options: {
      input: string;
      mode: "fs" | "bash";
      cwd?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<SandboxRunResult> {
    return withSandboxSlot(() => this.runSandboxProcess(command, options));
  }

  private runSandboxProcess(
    command: string[],
    options: {
      input: string;
      mode: "fs" | "bash";
      cwd?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<SandboxRunResult> {
    return new Promise((resolveRun, rejectRun) => {
      const environment = sanitizeSandboxEnvironment({ ...process.env, ...options.env });
      if (this.hostPaths?.rtkPath !== undefined) {
        const rtkDirectory = dirname(this.hostPaths.rtkPath);
        const pathEntries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
        if (!pathEntries.includes(rtkDirectory)) pathEntries.unshift(rtkDirectory);
        environment.PATH = pathEntries.join(delimiter);
        if (this.hostPaths.rtkConfigPath !== undefined && environment.RTK_CONFIG !== undefined)
          environment.RTK_CONFIG = this.hostPaths.rtkConfigPath;
      }
      const child = spawn(
        "bwrap",
        [...this.buildArgs(options.mode, options.cwd ?? this.cwd), ...command],
        {
          cwd: this.cwd,
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeoutHandle =
        options.timeoutMs !== undefined && options.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeoutMs)
          : undefined;
      const onAbort = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // bwrap dying before the stdin write lands (bad argv, denied namespace)
      // surfaces as EPIPE here; swallow it so the close handler reports the
      // real bwrap stderr through the envelope fallback instead.
      child.stdin?.on("error", () => {});
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        rejectRun(error);
      });
      child.on("close", (exitCode) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted) {
          rejectRun(new Error("tool call aborted"));
          return;
        }
        if (timedOut) {
          rejectRun(new Error(`sandbox timed out after ${options.timeoutMs}ms`));
          return;
        }
        resolveRun({
          exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });
      child.stdin?.end(options.input);
    });
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
    this.expandCredentialPatterns(gitMainWorktreePath);
  }

  // Path sections are recomputed on every access instead of cached, so
  // Git variables re-run `git worktree list` per authorization and bind
  // decision (§3). Globs stay startup-expanded via globCache.
  readSection(): ExpandedPathSection {
    return expandPathSection(
      this.config.read,
      this.cwd,
      true,
      resolveGitMainWorktreePath(this.cwd),
      this.globCache,
    );
  }

  writeSection(): ExpandedPathSection {
    return expandPathSection(
      this.config.write,
      this.cwd,
      false,
      resolveGitMainWorktreePath(this.cwd),
      this.globCache,
    );
  }

  /**
   * Expanded `credentials` patterns (§2.2): bound read-only into the bash
   * sandbox, always denied for fs tools, and never part of read/write action
   * resolution. Path resolution follows the same §3 rules as read/write.
   */
  private expandCredentialPatterns(
    gitMainWorktreePath = resolveGitMainWorktreePath(this.cwd),
  ): string[] {
    return expandPathPatterns(
      this.config.credentials,
      this.cwd,
      gitMainWorktreePath,
      false,
      this.globCache,
    );
  }

  credentialPaths(): string[] {
    return this.expandCredentialPatterns();
  }

  /**
   * Whether a path falls under a `credentials` entry (§2.2). fs tools must
   * deny these even when read/write resolution says allow; the value is also
   * outside read/write action resolution and dynamic grants.
   */
  isCredentialPath(candidatePath: string): boolean {
    return pathsMatchCandidate(this.credentialPaths(), resolve(candidatePath));
  }

  /** Resolve the read (§2) or write (§2) action match for one path. */
  resolvePathAction(operation: "read" | "write", candidatePath: string): PathActionMatch {
    const section = operation === "read" ? this.readSection() : this.writeSection();
    return resolvePathActionMatch(section, resolve(candidatePath));
  }

  /** Resolve the strictest action across all segments of one command (§4). */
  resolveCommandAction(command: string): CommandActionMatch {
    return resolveCommandActionMatch(this.commandEntries, command);
  }
}
