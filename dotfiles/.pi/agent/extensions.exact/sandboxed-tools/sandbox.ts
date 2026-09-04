import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parse as parseShell } from "shell-quote";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";

export type Action = "allow" | "deny" | "ask";

/**
 * Dialog approval info returned when the user approved access through a
 * confirmation dialog (§2.3). `undefined` means access passed without a new
 * dialog approval (config allow or an existing dynamic grant).
 */
export type PathApproval = {
  operation: "read" | "write";
  scope: "file" | "directory";
  grantedPath: string;
};

/** Where a command pattern matched inside its candidate segment, for dialog highlighting (§2.3). */
export type MatchSpan = { candidate: string; index: number; length: number };

/** Action resolution result together with the pattern that caused it (§2.3). */
export type ActionMatch = { action: Action; matched?: string; matchSpan?: MatchSpan };

export type ToolName = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";

/** Session metadata forwarded to run-tools so the sandboxed bash tool can expose PI_* env vars. */
export type ToolSession = {
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
};

type RuleSection = { allow?: string[]; ask?: string[]; deny?: string[] };

type SandboxedToolsConfig = {
  read?: RuleSection;
  write?: RuleSection;
  credentials?: string[];
  commands?: RuleSection;
};

type ToolUI = {
  confirm(title: string, message: string): Promise<boolean>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
};

const ALLOW_OPTION = "Yes, allow";
const DENY_OPTION = "No, deny (reason next)";

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

  const parseSection = (value: unknown): RuleSection | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error("rule section must be a mapping");
    return {
      allow: asPatterns(value.allow),
      ask: asPatterns(value.ask),
      deny: asPatterns(value.deny),
    };
  };

  return {
    read: parseSection(parsed.read),
    write: parseSection(parsed.write),
    credentials: asPatterns(parsed.credentials),
    commands: parseSection(parsed.commands),
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

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

export function resolveGitMainWorktreePath(cwd: string): string | undefined {
  try {
    const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const mainWorktree = worktrees.split("\n").find((line) => line.startsWith("worktree "));
    return mainWorktree === undefined ? undefined : resolve(mainWorktree.slice("worktree ".length));
  } catch {
    return undefined;
  }
}

function expandGitMainWorktreePath(
  pattern: string,
  gitMainWorktreePath: string | undefined,
): string | undefined {
  if (pattern.includes(GIT_MAIN_WORKTREE_PATH) && gitMainWorktreePath === undefined)
    return undefined;
  return pattern.replaceAll(GIT_MAIN_WORKTREE_PATH, gitMainWorktreePath ?? "");
}

function resolvePattern(
  pattern: string,
  cwd: string,
  gitMainWorktreePath: string | undefined,
): string | undefined {
  const gitPathExpanded = expandGitMainWorktreePath(pattern, gitMainWorktreePath);
  if (gitPathExpanded === undefined) return undefined;
  const homeExpanded =
    gitPathExpanded === "~"
      ? homedir()
      : gitPathExpanded.startsWith("~/")
        ? join(homedir(), gitPathExpanded.slice(2))
        : gitPathExpanded;
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

function findCommandPattern(
  patterns: string[] | undefined,
  candidate: string,
): CommandPatternMatch | undefined {
  for (const pattern of patterns ?? []) {
    for (const expandedPattern of expandBraces(pattern)) {
      if (expandedPattern === "*")
        return { pattern: expandedPattern, index: 0, length: candidate.length };
      if (hasGlob(expandedPattern)) {
        const match = globToRegExp(expandedPattern).exec(candidate);
        if (match !== null)
          return { pattern: expandedPattern, index: match.index, length: match[0].length };
      } else if (candidate === expandedPattern || candidate.startsWith(`${expandedPattern} `)) {
        return { pattern: expandedPattern, index: 0, length: expandedPattern.length };
      }
    }
  }
  return undefined;
}

export function resolveCommandActionMatch(
  section: RuleSection | undefined,
  command: string,
): ActionMatch {
  if (!section) return { action: "deny" };
  const withSpan = (
    action: Action,
    match: CommandPatternMatch,
    candidate: string,
  ): ActionMatch => ({
    action,
    matched: match.pattern,
    matchSpan: { candidate, index: match.index, length: match.length },
  });
  const actionFor = (candidate: string): ActionMatch => {
    const deny = findCommandPattern(section.deny, candidate);
    if (deny !== undefined) return withSpan("deny", deny, candidate);
    const ask = findCommandPattern(section.ask, candidate);
    if (ask !== undefined) return withSpan("ask", ask, candidate);
    const allow = findCommandPattern(section.allow, candidate);
    if (allow !== undefined) return withSpan("allow", allow, candidate);
    return { action: "deny" };
  };
  // Parse fallback: a command that yields no segments (empty or unparsable)
  // is checked as the raw string, preserving the pre-split behavior.
  const candidates = splitCommandSegments(command);
  if (candidates.length === 0) candidates.push(command);
  const results = candidates.map(actionFor);
  return (
    results.find((result) => result.action === "deny") ??
    results.find((result) => result.action === "ask") ??
    results.find((result) => result.action === "allow") ?? { action: "deny" }
  );
}

export function resolveCommandAction(section: RuleSection | undefined, command: string): Action {
  return resolveCommandActionMatch(section, command).action;
}

function getPathSection(
  config: SandboxedToolsConfig,
  operation: "read" | "write",
): RuleSection | undefined {
  return config[operation];
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

function expandPathPatterns(
  patterns: string[] | undefined,
  cwd: string,
  gitMainWorktreePath: string | undefined,
  allowAllPaths = false,
): string[] {
  return (patterns ?? []).flatMap((pattern) => {
    const gitPathExpanded = expandGitMainWorktreePath(pattern, gitMainWorktreePath);
    if (gitPathExpanded === undefined) return [];
    return expandBraces(gitPathExpanded).flatMap((expandedPattern) => {
      if (allowAllPaths && expandedPattern === "*") return ["/**"];
      const resolvedPattern = resolvePattern(expandedPattern, cwd, gitMainWorktreePath);
      if (resolvedPattern === undefined) return [];
      if (!hasGlob(resolvedPattern)) return [resolvedPattern];
      return expandGlobPattern(resolvedPattern);
    });
  });
}

export type ExpandedPathSection = { allow: string[]; ask: string[]; deny: string[] };

export function expandPathSection(
  section: RuleSection | undefined,
  cwd: string,
  allowAllPaths = false,
  gitMainWorktreePath = resolveGitMainWorktreePath(cwd),
): ExpandedPathSection {
  return {
    allow: expandPathPatterns(section?.allow, cwd, gitMainWorktreePath, allowAllPaths),
    ask: expandPathPatterns(section?.ask, cwd, gitMainWorktreePath),
    deny: expandPathPatterns(section?.deny, cwd, gitMainWorktreePath),
  };
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
): ActionMatch {
  if (!section) return { action: "deny" };
  const matchedIn = (paths: string[]): string | undefined =>
    paths.find((path) => pathCovers(path, candidatePath));
  const deny = matchedIn(section.deny);
  if (deny !== undefined) return { action: "deny", matched: deny };
  const ask = matchedIn(section.ask);
  if (ask !== undefined) return { action: "ask", matched: ask };
  const allow = matchedIn(section.allow);
  if (allow !== undefined) return { action: "allow", matched: allow };
  return { action: "deny" };
}

export function resolvePathAction(
  section: ExpandedPathSection | undefined,
  candidatePath: string,
): Action {
  return resolvePathActionMatch(section, candidatePath).action;
}

/** Dialog line explaining which pattern caused the confirmation (§2.3). */
function matchedPatternNote(matched: string | undefined): string {
  return matched === undefined ? "no matching pattern (default ask)" : `matched: ${matched}`;
}

// Selective ANSI (color only, no full reset) so the dialog's accent/bold styling survives.
const MATCH_HIGHLIGHT = "\x1b[33m";
const MATCH_HIGHLIGHT_END = "\x1b[39m";

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
 */
function highlightCommandMatch(raw: string, span: MatchSpan): string {
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

export class Sandbox {
  private readonly dynamicPaths = new Map<string, Set<"read" | "write">>();
  // pi's TUI has a single slot for extension dialogs: a second dialog replaces
  // the first without resolving its promise, deadlocking that tool call.
  // One global queue; split per dialog kind if contention ever matters.
  private uiQueue: Promise<void> = Promise.resolve();
  private readonly config: SandboxedToolsConfig;
  private readonly readPaths: ExpandedPathSection;
  private readonly writePaths: ExpandedPathSection;
  private readonly credentialPaths: string[];
  private readonly hiddenFsPaths: string[];
  private readonly gitMainWorktreePath: string | undefined;
  private readonly runToolsPath = join(dirname(fileURLToPath(import.meta.url)), "run-tools.ts");
  private readonly piPackageDir = getPackageDir();

  constructor(
    private readonly cwd: string,
    configPath = join(dirname(fileURLToPath(import.meta.url)), "config.yaml"),
  ) {
    try {
      this.config = parseSandboxedToolsConfig(readFileSync(configPath, "utf8"));
    } catch {
      this.config = {};
    }
    this.gitMainWorktreePath = resolveGitMainWorktreePath(cwd);
    this.readPaths = expandPathSection(this.config.read, cwd, true, this.gitMainWorktreePath);
    this.writePaths = expandPathSection(this.config.write, cwd, false, this.gitMainWorktreePath);
    this.credentialPaths = expandPathPatterns(
      this.config.credentials,
      cwd,
      this.gitMainWorktreePath,
    );
    this.hiddenFsPaths = [
      ...expandPathPatterns(
        getPathSection(this.config, "read")?.deny,
        cwd,
        this.gitMainWorktreePath,
      ),
      ...this.credentialPaths,
    ];
    this.prepareWriteDirectories();
  }

  private prepareWriteDirectories(): void {
    for (const pattern of getPathSection(this.config, "write")?.allow ?? []) {
      if (hasGlob(pattern)) continue;
      const path = resolvePattern(pattern, this.cwd, this.gitMainWorktreePath);
      if (path !== undefined && !existsSync(path)) mkdirSync(path, { recursive: true });
    }
  }

  private readAllPaths(): boolean {
    return getPathSection(this.config, "read")?.allow?.some((pattern) => pattern === "*") ?? false;
  }

  private addMount(args: string[], sourcePath: string, writable: boolean): void {
    addParentDirectories(args, sourcePath);
    args.push(writable ? "--bind-try" : "--ro-bind-try", sourcePath, sourcePath);
  }

  private addConfiguredMounts(args: string[], mode: "fs" | "bash"): void {
    const readSection = getPathSection(this.config, "read");
    const writeSection = getPathSection(this.config, "write");
    const mounted = new Set<string>();

    const mount = (path: string, writable: boolean) => {
      const normalized = resolve(path);
      if (mounted.has(`${normalized}:${writable}`)) return;
      mounted.add(`${normalized}:${writable}`);
      this.addMount(args, normalized, writable);
    };

    if (!this.readAllPaths()) {
      for (const path of expandPathPatterns(
        readSection?.allow,
        this.cwd,
        this.gitMainWorktreePath,
        true,
      ))
        mount(path, false);
    }
    for (const path of expandPathPatterns(writeSection?.allow, this.cwd, this.gitMainWorktreePath))
      mount(path, true);
    for (const [path, accessModes] of this.dynamicPaths) mount(path, accessModes.has("write"));

    if (!this.readAllPaths()) mount(this.cwd, false);
    if (mode === "bash") {
      for (const path of this.credentialPaths) {
        if (existsSync(path)) mount(path, false);
      }
    }
  }

  private addHiddenPaths(args: string[], mode: "fs" | "bash"): void {
    if (mode === "bash") return;
    for (const path of this.hiddenFsPaths) {
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
    if (pathsMatchCandidate(this.credentialPaths, absolutePath)) {
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    }
    const section = operation === "read" ? this.readPaths : this.writePaths;
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
        return { operation: "write", scope, grantedPath: grantPath };
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
    const accessModes = this.dynamicPaths.get(grantPath) ?? new Set<"read" | "write">();
    accessModes.add(operation);
    this.dynamicPaths.set(grantPath, accessModes);
    if (operation === "write") this.ensureGrantPathExists(grantPath, scope);
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
   * Resolve the command action and, for `ask`, confirm with the user. Returns
   * true when the user approved this call through a confirmation dialog
   * (§2.3 approval note), false when the command passed without a dialog
   * (config allow). Denial throws.
   */
  authorizeCommand(command: string, context: ToolContext): Promise<boolean> {
    const { action, matched, matchSpan } = resolveCommandActionMatch(this.config.commands, command);
    if (action === "allow") return Promise.resolve(false);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (!context.hasUI || !context.ui) throw new Error(`Command requires confirmation: ${command}`);
    const ui = context.ui;
    const note = matchedPatternNote(matched);
    const display =
      matchSpan !== undefined && !process.env.NO_COLOR
        ? highlightCommandMatch(command, matchSpan)
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
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        "bwrap",
        [...this.buildArgs(options.mode ?? "fs", options.cwd ?? this.cwd), command, ...commandArgs],
        {
          cwd: this.cwd,
          env: options.env,
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
}
