import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { quote } from "shell-quote";
import {
  AuthorizationPath,
  commandOnceApprovalKey,
  commandPatternApprovalKey,
  compileCommandRuleEntries,
  defaultGuardrailConfigPath,
  expandBraces,
  expandPathSection,
  expandRuntimeVariables,
  globToRegExp,
  hasGlob,
  repositoryName,
  resolveGitMainWorktreePath,
  resolvePattern,
  restoreRepositoryName,
  type CommandActionMatch,
  type CompiledCommandRuleEntry,
  type GlobCache,
  type GuardrailConfig,
  type MatchSpan,
  parseGuardrailConfig,
  pathCovers,
  pathsMatchCandidate,
  resolveCommandActionMatch,
  resolvePathActionMatch,
} from "./config.ts";
import {
  type DynamicPaths,
  type SandboxMode,
  buildSandboxArgs,
  credentialSnapshot,
  prepareWriteDirectories,
  readActionMatch,
  readAllPaths,
  resolvePolicyWorktreePath,
  warmGlobCache,
  writePaths,
  writePathsByFinalAction,
} from "./sandbox.ts";

export type PathApproval = {
  operation: "read" | "write";
  scope: "file" | "directory";
  grantedPath: string;
};

export type WritePermissionRequest =
  | { status: "already granted"; grantedPath: string }
  | { status: "granted"; grantedPath: string }
  | { status: "denied"; grantedPath: string; reason?: string };

export type CommandPermissionRequest =
  | { status: "already granted"; command: string; approvedPattern?: string; grant?: "turn" }
  | {
      status: "granted";
      command: string;
      grant: "once" | "session" | "turn";
      approvedPattern?: string;
    }
  | { status: "denied"; command: string; reason?: string };

export function writeApprovalNote(approval: PathApproval): string {
  return approval.scope === "directory"
    ? `User approved Guardrails write access via confirmation (scope: directory ${approval.grantedPath}); valid for the rest of the session for all tools using Guardrails; explicit deny and credentials remain protected.`
    : `User approved Guardrails write access via confirmation (scope: file ${approval.grantedPath}); valid for the rest of the session for all tools using Guardrails; explicit deny and credentials remain protected.`;
}

export type ToolUI = {
  confirm(title: string, message: string): Promise<boolean>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  /** Provides the dialog accent color so the highlight can restore it afterwards. */
  theme?: { getFgAnsi(color: "accent"): string };
};

export type ToolContext = {
  cwd?: string;
  hasUI?: boolean;
  ui?: ToolUI;
};

function canonicalWritePath(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonicalWritePath(dirname(path)), basename(path));
  }
  return realpathSync.native(path);
}

function directoryIdentity(path: string): string | undefined {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isDirectory() && realpathSync.native(path) === path)
      return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

function compileMutationPatterns(
  patterns: string[] | undefined,
  cwd: string,
  main: string | undefined,
  name: string,
) {
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  function normalize(path: string): string {
    const portable = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
    return foldCase ? portable.normalize("NFC").toLowerCase() : portable;
  }

  const realMatches = new Set<string>();
  const paths = new Map<string, string>();
  function recordMatch(path: string, canonical: string): void {
    realMatches.add(normalize(canonical));
    paths.set(path, canonical);
  }
  const aliases = new Map<string, { path: string; pattern: RegExp }[]>();
  const normalizedName = normalize(name);
  const matchers = (patterns ?? [])
    .flatMap((pattern) => expandRuntimeVariables(pattern, main, cwd))
    .flatMap(expandBraces)
    .map((pattern) => resolvePattern(pattern, cwd))
    .map((pattern) => {
      let prefix = pattern;
      while (hasGlob(prefix)) prefix = dirname(prefix);
      const literalPrefix = restoreRepositoryName(prefix, name);
      const canonical = mutationPatternAlias(literalPrefix);
      const normalized = normalize(pattern);
      if (!hasGlob(pattern)) {
        if (mutationPathExists(literalPrefix))
          recordMatch(literalPrefix, canonical ?? literalPrefix);
        const literals = [normalize(literalPrefix), ...(canonical ? [normalize(canonical)] : [])];
        return (candidate: string) => literals.includes(candidate);
      }

      const glob = globToRegExp(normalized, normalizedName);
      const regexes = [new RegExp(glob.source, "s")];
      const suffix = normalize(pattern.slice(prefix.length));
      if (canonical && prefix !== dirname(prefix)) {
        const suffixRegex = globToRegExp(suffix, normalizedName);
        const literal = normalize(canonical).replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
        regexes.push(new RegExp("^" + literal + suffixRegex.source.slice(1), "s"));
      }
      collectMutationAliases(
        literalPrefix,
        suffix,
        regexes[0]!,
        normalizedName,
        normalize,
        recordMatch,
        (path, canonical, pattern) => {
          const key = normalize(canonical);
          const entries = aliases.get(key) ?? [];
          entries.push({ path, pattern });
          aliases.set(key, entries);
        },
      );
      return (candidate: string) => regexes.some((regex) => regex.test(candidate));
    });

  return { matches, paths };

  function matches(candidate: string): boolean {
    for (let path = candidate; ; path = dirname(path)) {
      const normalized = normalize(path);
      if (realMatches.has(normalized) || matchers.some((matches) => matches(normalized)))
        return true;
      if (aliases.size !== 0 && matchesProspectiveAlias(path)) return true;
      if (dirname(path) === path) return false;
    }
  }

  function matchesProspectiveAlias(candidate: string): boolean {
    const suffix: string[] = [];
    for (let ancestor = candidate; ; ancestor = dirname(ancestor)) {
      for (const alias of aliases.get(normalize(ancestor)) ?? []) {
        const projected = join(alias.path, ...suffix);
        if (
          alias.pattern.test(normalize(projected)) &&
          normalize(canonicalWritePath(projected)) === normalize(candidate)
        )
          return true;
      }
      if (dirname(ancestor) === ancestor) return false;
      suffix.unshift(basename(ancestor));
    }
  }
}

function collectMutationAliases(
  root: string,
  suffix: string,
  pattern: RegExp,
  repository: string,
  normalize: (path: string) => string,
  recordMatch: (path: string, canonical: string) => void,
  recordAlias: (path: string, canonical: string, pattern: RegExp) => void,
): void {
  const segments = suffix.split("/").filter(Boolean);
  const hasCrossSegmentClass = [...suffix.matchAll(/\[[^\]]+\]/g)].some(([characterClass]) =>
    globToRegExp(characterClass, repository).test("/"),
  );
  const fallback =
    hasCrossSegmentClass || segments.some((segment) => segment !== "**" && segment.includes("**"));
  const matchers = segments.map(
    (segment) => new RegExp(globToRegExp(segment, repository).source, "s"),
  );
  const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let visited = 0;
  walk(root, 0, new Set());

  function walk(path: string, index: number, ancestors: Set<string>): void {
    if (++visited > 100_000)
      throw new Error("Too many paths to verify scoped write protection under " + root);
    const directory = mutationPathExists(path);
    if (!directory) return;
    const canonical = realpathSync.native(path);
    if (pattern.test(normalize(path))) recordMatch(path, canonical);
    if (!directory.isDirectory() || (!fallback && index === segments.length)) return;
    if (canonical !== path && (path === root || lstatSync(path).isSymbolicLink()))
      recordAlias(path, canonical, pattern);

    const recursive = fallback || segments[index] === "**";
    const nextIndex = recursive ? index : index + 1;
    if (recursive && ancestors.has(canonical))
      throw new Error("Cannot verify scoped write protection through a directory cycle: " + path);
    if (!fallback && recursive && index + 1 < segments.length) walk(path, index + 1, ancestors);
    const nextAncestors = new Set([...ancestors, canonical]);
    for (const bytes of readdirSync(path, { encoding: "buffer" })) {
      const entry = decode.decode(bytes);
      if (recursive || matchers[index]!.test(normalize(entry)))
        walk(join(path, entry), nextIndex, nextAncestors);
    }
  }
}

function mutationPathExists(path: string) {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") return undefined;
    if (code !== "ENOENT") throw error;
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error(`Cannot resolve a symbolic link in scoped write protection: ${path}`);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
    }
    return undefined;
  }
}

function mutationPatternAlias(path: string): string | undefined {
  try {
    const canonical = canonicalWritePath(path);
    return canonical === path ? undefined : canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

const ALLOW_OPTION = "Yes, allow";
const ALLOW_ONCE_OPTION = "Allow once";
const ALLOW_TURN_OPTION = "Allow in this turn";
const ALLOW_SESSION_OPTION = "Allow in this session";
const EXPIRED_TURN_APPROVAL = "Turn approval expired. Request approval again.";
const DENY_OPTION = "No, deny (reason next)";

/** Guidance returned with an `ask_with_reason` rejection so the model re-requests via ask_permission (§3・§4). */
export const COMMAND_REASON_HINT =
  "This command requires a reason. Call ask_permission with this exact command and a reason; do not rewrite the command to bypass the gate.";

/** Dialog line explaining which pattern caused the confirmation (§2.3). */
function matchedPatternNote(matched: string | undefined): string {
  return matched === undefined ? "no matching pattern (default ask)" : `matched: ${matched}`;
}

function commandMatchNote({ matched, compoundPatterns }: CommandActionMatch): string {
  const primary = matchedPatternNote(matched);
  if (compoundPatterns === undefined) return primary;
  if (compoundPatterns.length === 1) return `${primary}\nscope: compound commands only`;
  return `${primary}\nalso required: ${compoundPatterns.slice(1).join(", ")}`;
}

// Invert + yellow: the inverted background stays visible on any terminal palette,
// where basic yellow alone can sit too close to the dialog accent color. Selective
// SGRs (no full reset) so the dialog's accent/bold styling survives.
const MATCH_HIGHLIGHT = "\x1b[7m\x1b[33m";
const MATCH_HIGHLIGHT_END = "\x1b[27m";

function highlightCommandMatch(raw: string, span: MatchSpan, accentStart: string): string {
  let highlighted = raw;
  for (const range of [...span.ranges].sort((left, right) => right.index - left.index)) {
    highlighted =
      highlighted.slice(0, range.index) +
      MATCH_HIGHLIGHT +
      highlighted.slice(range.index, range.index + range.length) +
      MATCH_HIGHLIGHT_END +
      accentStart +
      highlighted.slice(range.index + range.length);
  }
  return highlighted;
}

export class Guardrail {
  private readonly dynamicPaths = new Map<string, Set<"read" | "write">>();
  private readonly directoryGrants = new Map<symbol, { path: string; isCurrent: () => boolean }>();
  /** One-shot ask_permission approvals, as normalized command segments (§3). */
  private readonly approvedCommands: string[] = [];
  /**
   * Session-approved command patterns (§3): config pattern strings approved
   * via an "Allow in this session" selection. Commands matching one of these
   * run without confirmation for the rest of the session; the grant is never
   * consumed and dies with the session.
   */
  private readonly sessionApprovedPatterns: string[] = [];
  private readonly turnApprovedPatterns = new Set<string>();
  private turnApprovalGeneration = 0;
  // pi's TUI has a single slot for extension dialogs: a second dialog replaces
  // the first without resolving its promise, deadlocking that tool call.
  // One global queue; split per dialog kind if contention ever matters.
  private uiQueue: Promise<void> = Promise.resolve();
  private readonly config: GuardrailConfig;
  /** Command entries with patterns compiled to regex once at startup (SPEC §6). */
  private readonly commandEntries: CompiledCommandRuleEntry[];
  /** Configured command patterns that failed regex compilation, deduped in config order (SPEC §6). */
  readonly invalidCommandPatterns: string[];
  readonly startupWritePaths: { allow: string[]; ask: string[]; deny: string[] };
  /** Glob expansions are computed once per resolved pattern (§3 startup semantics). */
  private readonly globCache: GlobCache;

  constructor(
    private readonly cwd: string,
    configPath = defaultGuardrailConfigPath(),
  ) {
    try {
      this.config = parseGuardrailConfig(readFileSync(configPath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`guardrails.yaml (${configPath}): ${message}`);
    }
    const compiledCommands = compileCommandRuleEntries(this.config.commands);
    this.commandEntries = compiledCommands.entries;
    this.invalidCommandPatterns = [...new Set(compiledCommands.invalidPatterns)];
    const mainWorktree = resolvePolicyWorktreePath(this.cwd);
    this.globCache = warmGlobCache(this.config, this.cwd, mainWorktree);
    prepareWriteDirectories(this.config, this.cwd, this.globCache, mainWorktree);
    this.startupWritePaths = this.summarizeStartupWritePaths(mainWorktree);
  }

  private summarizeStartupWritePaths(mainWorktree: string) {
    const writeSection = writePaths(this.config, this.cwd, this.globCache, mainWorktree);
    const { allow, ask, deny } = writePathsByFinalAction(writeSection);
    const credentials = credentialSnapshot(this.config, this.cwd, this.globCache, mainWorktree);
    const excludeCredentials = (paths: string[]) =>
      paths.filter((path) => !new AuthorizationPath(path).matchesRestriction(credentials));
    return {
      allow: excludeCredentials(allow),
      ask: excludeCredentials(ask),
      deny: excludeCredentials(deny),
    };
  }

  /** Build the bwrap argument list (delegates to the shared pure builder; tests use this entry). */
  buildArgs(mode: SandboxMode, commandCwd = this.cwd, readOnly = false): string[] {
    return buildSandboxArgs({
      cwd: this.cwd,
      config: this.config,
      globCache: this.globCache,
      dynamicPaths: this.getDynamicPaths(),
      mode,
      commandCwd,
      readOnly,
    });
  }

  getDynamicPaths(): DynamicPaths {
    const paths = new Map(this.dynamicPaths);
    for (const path of this.currentGrantPaths()) {
      paths.set(path, new Set([...(paths.get(path) ?? []), "write"]));
    }
    return paths;
  }

  assertDirectoryGrantAllowed(path: string): void {
    if (!isAbsolute(path) || path.includes("\0") || path !== resolve(path))
      throw new Error(`Expected a normalized absolute directory path: ${path}`);
    if (canonicalWritePath(path) !== path)
      throw new Error(`Directory grant path uses a symbolic link: ${path}`);
    this.assertScopedWriteAllowed([path]);
  }

  private scopedWriteProtection() {
    const main = resolveGitMainWorktreePath(this.cwd);
    const name = repositoryName(this.cwd, main);
    const credentials = compileMutationPatterns(this.config.credentials, this.cwd, main, name);
    const writeRules = (this.config.write ?? []).map(({ action, patterns }, index) => ({
      action,
      protection:
        action === "deny" ? compileMutationPatterns(patterns, this.cwd, main, name) : undefined,
      index,
    }));
    const expandedWrite = expandPathSection(
      this.config.write,
      this.cwd,
      false,
      main,
      this.globCache,
    );

    function writeDenied(path: string): boolean {
      let denied = false;
      for (const { action, protection, index } of writeRules) {
        if (protection?.matches(path) || pathsMatchCandidate(expandedWrite[index]!.paths, path))
          denied = action === "deny";
      }
      return denied;
    }

    function assertAllowed(paths: readonly string[], unlinkSymlinks: readonly string[] = []): void {
      for (const path of paths) {
        if (!isAbsolute(path) || path.includes("\0") || path !== resolve(path))
          throw new Error(`Expected a normalized absolute mutation path: ${path}`);
        if (credentials.matches(path))
          throw new Error(`Access denied for credential path: ${path}`);
        if (writeDenied(path)) throw new Error(`Access denied: ${path}`);
        let canonical: string;
        try {
          if (unlinkSymlinks.includes(path)) {
            const parent = dirname(path);
            if (!lstatSync(path).isSymbolicLink())
              throw new Error("Expected a symbolic link to unlink");
            canonical = join(realpathSync.native(parent), basename(path));
          } else {
            canonical = canonicalWritePath(path);
          }
        } catch (cause) {
          throw new Error(`Cannot resolve scoped write path: ${path}`, { cause });
        }
        if (canonical !== path)
          throw new Error(`Scoped write path uses an alias: ${path} resolves to ${canonical}`);
      }
    }

    return {
      assertAllowed,
      *protectedPaths(): Iterable<[string, string]> {
        yield* credentials.paths;
        for (const { protection } of writeRules) {
          if (!protection) continue;
          for (const [path, canonical] of protection.paths) {
            if (writeDenied(path) || writeDenied(canonical)) yield [path, canonical];
          }
        }
      },
    };
  }

  assertScopedWriteAllowed(paths: readonly string[]): void {
    this.scopedWriteProtection().assertAllowed(paths);
  }

  assertScopedCommandAllowed(argv: readonly string[]): void {
    const executablePath = argv[0]!;
    const executableName = win32.basename(executablePath);
    const names = [executableName.replace(/\.exe$/i, ""), executableName, executablePath];
    for (const executable of new Set(names)) {
      const command = quote([executable, ...argv.slice(1)]);
      const rule = resolveCommandActionMatch(this.commandEntries, command);
      if (rule.action === "deny" && rule.matched !== undefined)
        throw new Error(`Command denied: ${command}`);
    }
  }

  planScopedWriteProtection(
    paths: readonly string[],
    directories: readonly string[],
    sandboxed: boolean,
    unlinkSymlinks: readonly string[] = [],
  ): string[] {
    const protection = this.scopedWriteProtection();
    protection.assertAllowed(directories);
    protection.assertAllowed(paths, unlinkSymlinks);
    if (!sandboxed || directories.length === 0) return [];
    if (!readAllPaths(this.config))
      throw new Error(
        'Scoped write execution requires Bash read access configured with allow: "*"',
      );
    const masks = new Set<string>();
    for (const [path, canonical] of protection.protectedPaths()) {
      if (
        directories.some(
          (directory) => pathCovers(path, directory) || pathCovers(canonical, directory),
        )
      )
        throw new Error(`Scoped write scope overlaps a protected path: ${path}`);
      if (path !== canonical && directories.some((directory) => pathCovers(directory, path)))
        throw new Error(`Scoped write scope overlaps a protected alias: ${path}`);
      if (directories.some((directory) => pathCovers(directory, canonical))) {
        const blocked = paths.find((planned) => pathCovers(canonical, planned));
        if (blocked !== undefined)
          throw new Error(
            `Scoped write plan conflicts with read-only protection: ${blocked} (mount: ${canonical})`,
          );
        masks.add(canonical);
      }
    }
    return [...masks].sort((a, b) => a.length - b.length);
  }

  grantExistingDirectory(path: string, validate?: () => boolean): () => void {
    this.assertDirectoryGrantAllowed(path);
    const identity = directoryIdentity(path);
    if (identity === undefined) throw new Error(`Directory does not exist: ${path}`);
    function isCurrent(): boolean {
      return directoryIdentity(path) === identity && (validate?.() ?? true);
    }
    if (!isCurrent()) throw new Error(`Directory changed before it could be granted: ${path}`);
    const id = Symbol();
    this.directoryGrants.set(id, { path, isCurrent });
    return () => {
      this.directoryGrants.delete(id);
    };
  }

  clearDirectoryGrants(): void {
    this.directoryGrants.clear();
  }

  private *currentGrantPaths(): Iterable<string> {
    for (const [id, grant] of this.directoryGrants) {
      if (grant.isCurrent()) yield grant.path;
      else this.directoryGrants.delete(id);
    }
  }

  private assertWriteNotDenied(path: string): void {
    this.pathAction("write", new AuthorizationPath(path));
  }

  private pathAction(operation: "read" | "write", comparison: AuthorizationPath) {
    comparison.assertVerified();
    const path = comparison.absolutePath;
    const mainWorktree = resolvePolicyWorktreePath(this.cwd);
    const credentials = credentialSnapshot(this.config, this.cwd, this.globCache, mainWorktree);
    if (comparison.matchesRestriction(credentials))
      throw new Error(`Access denied for credential path: ${path}`);

    const match =
      operation === "read"
        ? readActionMatch(this.config, this.cwd, this.globCache, comparison, mainWorktree)
        : resolvePathActionMatch(
            writePaths(this.config, this.cwd, this.globCache, mainWorktree),
            path,
            comparison,
          );
    if (match.action === "deny" && match.matched !== undefined)
      throw new Error(`Access denied: ${path}`);
    return match;
  }

  async authorizePath(
    operation: "read" | "write",
    candidatePath: string,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<PathApproval | undefined> {
    signal?.throwIfAborted();
    const absolutePath = resolve(candidatePath);
    const comparison = new AuthorizationPath(absolutePath);
    const initialMatch = this.pathAction(operation, comparison);
    if (initialMatch.action === "allow" || this.hasDynamicGrant(operation, comparison))
      return undefined;
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      signal?.throwIfAborted();
      const current = comparison.windows ? new AuthorizationPath(absolutePath) : comparison;
      const match = comparison.windows ? this.pathAction(operation, current) : initialMatch;
      if (match.action === "allow" || this.hasDynamicGrant(operation, current)) return undefined;
      return this.requestAccess(operation, absolutePath, ui, match.matched, signal);
    });
  }

  async withUiLock<T>(showDialog: () => Promise<T>): Promise<T> {
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

  private hasDynamicGrant(operation: "read" | "write", comparison: AuthorizationPath): boolean {
    for (const [grantedPath, accessModes] of this.dynamicPaths)
      if (accessModes.has(operation) && comparison.coverageOf(grantedPath) === "match") return true;
    if (operation !== "write") return false;
    for (const path of this.currentGrantPaths()) {
      if (comparison.coverageOf(path) !== "match") continue;
      const canonical = canonicalWritePath(comparison.absolutePath);
      if (canonical !== comparison.absolutePath) this.assertWriteNotDenied(canonical);
      if (pathCovers(path, canonical)) return true;
    }
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
    const comparison = new AuthorizationPath(absolutePath);
    const initialMatch = this.pathAction("write", comparison);
    const grantedPath = this.directoryScopePath(absolutePath);
    const scope = grantedPath === absolutePath ? comparison : new AuthorizationPath(grantedPath);
    scope.assertVerified();
    if (initialMatch.action === "allow" || this.hasDynamicGrant("write", scope))
      return { status: "already granted", grantedPath };
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      const current = comparison.windows ? new AuthorizationPath(absolutePath) : comparison;
      const match = comparison.windows ? this.pathAction("write", current) : initialMatch;
      const currentScope = comparison.windows ? new AuthorizationPath(grantedPath) : scope;
      currentScope.assertVerified();
      if (match.action === "allow" || this.hasDynamicGrant("write", currentScope))
        return { status: "already granted", grantedPath };
      return this.confirmWritePermission(grantedPath, reason, ui, match.matched, absolutePath);
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
    matched: string | undefined,
    candidatePath: string,
  ): Promise<WritePermissionRequest> {
    const question = "Allow write access to directory subtree?";
    const details = `${grantedPath}\nreason: ${reason}\n${matchedPatternNote(matched)}`;
    if (ui.select) {
      const selectedOption = await ui.select(`${question}\n${details}`, [
        ALLOW_OPTION,
        DENY_OPTION,
      ]);
      if (selectedOption === ALLOW_OPTION)
        return this.grantWriteDirectory(grantedPath, candidatePath);
    } else if (await ui.confirm(question, details)) {
      return this.grantWriteDirectory(grantedPath, candidatePath);
    }
    const denialReason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return { status: "denied", grantedPath, ...(denialReason ? { reason: denialReason } : {}) };
  }

  /** Grant the directory-scope dynamic write and build the request result (§3). */
  private grantWriteDirectory(grantedPath: string, candidatePath: string): WritePermissionRequest {
    this.addDynamicGrant("write", grantedPath, "directory", candidatePath);
    return {
      status: "granted",
      grantedPath,
    };
  }

  private async requestAccess(
    operation: "read" | "write",
    absolutePath: string,
    ui: ToolUI,
    matched?: string,
    signal?: AbortSignal,
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
      signal?.throwIfAborted();
      if (selectedOption === undefined || selectedOption === DENY_OPTION)
        throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
      if (operation === "write") {
        if (selectedOption !== "File only" && selectedOption !== directoryScopeOption)
          throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
        const scope = selectedOption === directoryScopeOption ? "directory" : "file";
        const grantPath = scope === "directory" ? dirname(absolutePath) : absolutePath;
        this.addDynamicGrant("write", grantPath, scope, absolutePath);
        return {
          operation: "write",
          scope,
          grantedPath: grantPath,
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
    signal?.throwIfAborted();
    if (!approved) throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
    this.addDynamicGrant(operation, absolutePath, "file");
    return { operation, scope: "file", grantedPath: absolutePath };
  }

  /** Build the denial error after a canceled selection dialog, asking for an optional reason (§2.3). */
  private async deniedError(message: string, ui: ToolUI): Promise<Error> {
    const reason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return new Error(reason ? `${message}\nUser reason: ${reason}` : message);
  }

  private addDynamicGrant(
    operation: "read" | "write",
    grantPath: string,
    scope: "file" | "directory",
    candidatePath = grantPath,
  ): void {
    const comparison = new AuthorizationPath(candidatePath);
    if (comparison.windows) {
      this.pathAction(operation, comparison);
      if (grantPath !== candidatePath) new AuthorizationPath(grantPath).assertVerified();
    }
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
   * Quoting differences normalize away while token boundaries remain distinct.
   * Consumes the approval on an exact token-sequence match.
   */
  private consumeApprovedCommand(command: string, orderedPattern?: string): boolean {
    const index = this.approvedCommands.indexOf(commandOnceApprovalKey(command, orderedPattern));
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
    const match = resolveCommandActionMatch(this.commandEntries, command);
    const { action } = match;
    const approvalKey = commandPatternApprovalKey(match);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (action === "allow") return { status: "already granted", command };
    if (action === "ask")
      throw new Error(`Command is confirmed when run via bash; no pre-approval needed: ${command}`);
    const generation = this.turnApprovalGeneration;
    const existingApproval = this.commandPatternApproval(command, approvalKey, generation);
    if (existingApproval) return existingApproval;
    if (!context.hasUI || !context.ui) throw new Error(`Access requires confirmation: ${command}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      const approval = this.commandPatternApproval(command, approvalKey, generation);
      return approval ?? this.confirmCommandPermission(command, reason, ui, generation, match);
    });
  }

  private async confirmCommandPermission(
    command: string,
    reason: string,
    ui: ToolUI,
    generation: number,
    match: CommandActionMatch,
  ): Promise<CommandPermissionRequest> {
    const { matchSpan, ordered } = match;
    const approvalKey = commandPatternApprovalKey(match);
    const orderedPattern = ordered ? approvalKey : undefined;
    const question = "Allow command execution?";
    // Same highlight rule as the `ask` dialog (§2.3): show where the pattern
    // approvalKey, unless the UI lacks a theme or NO_COLOR is set.
    const display =
      matchSpan !== undefined && ui.theme && !process.env.NO_COLOR
        ? highlightCommandMatch(command, matchSpan, ui.theme.getFgAnsi("accent"))
        : command;
    const details = `${display}\nreason: ${reason}\n${commandMatchNote(match)}`;
    if (ui.select) {
      const selectedOption = await ui.select(`${question}\n${details}`, [
        ALLOW_ONCE_OPTION,
        ALLOW_TURN_OPTION,
        ALLOW_SESSION_OPTION,
        DENY_OPTION,
      ]);
      if (selectedOption === ALLOW_TURN_OPTION && approvalKey !== undefined) {
        if (generation !== this.turnApprovalGeneration)
          return { status: "denied", command, reason: EXPIRED_TURN_APPROVAL };
        this.turnApprovedPatterns.add(approvalKey);
        return { status: "granted", command, grant: "turn", approvedPattern: approvalKey };
      }
      if (selectedOption === ALLOW_SESSION_OPTION && approvalKey !== undefined) {
        this.sessionApprovedPatterns.push(approvalKey);
        return { status: "granted", command, grant: "session", approvedPattern: approvalKey };
      }
      if (selectedOption === ALLOW_ONCE_OPTION || selectedOption === ALLOW_SESSION_OPTION)
        return this.grantCommandApproval(command, orderedPattern);
    } else if (await ui.confirm(question, details)) {
      // No select UI: no way to choose the scope, so fall back to "once".
      return this.grantCommandApproval(command, orderedPattern);
    }
    const denialReason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return { status: "denied", command, ...(denialReason ? { reason: denialReason } : {}) };
  }

  private grantCommandApproval(command: string, orderedPattern?: string): CommandPermissionRequest {
    this.approvedCommands.push(commandOnceApprovalKey(command, orderedPattern));
    return { status: "granted", command, grant: "once" };
  }

  expireTurnCommandApprovals(): void {
    this.turnApprovedPatterns.clear();
    this.turnApprovalGeneration++;
  }

  private commandPatternApproval(
    command: string,
    matched: string | undefined,
    generation: number,
  ): CommandPermissionRequest | undefined {
    if (matched === undefined) return undefined;
    if (this.sessionApprovedPatterns.includes(matched))
      return { status: "already granted", command, approvedPattern: matched };
    if (generation === this.turnApprovalGeneration && this.turnApprovedPatterns.has(matched))
      return { status: "already granted", command, approvedPattern: matched, grant: "turn" };
    return undefined;
  }

  authorizeCommand(command: string, context: ToolContext): Promise<boolean> {
    const match = resolveCommandActionMatch(this.commandEntries, command);
    const { action, matchSpan, ordered } = match;
    const approvalKey = commandPatternApprovalKey(match);
    if (action === "allow") return Promise.resolve(false);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    const generation = this.turnApprovalGeneration;
    if (this.commandPatternApproval(command, approvalKey, generation)) return Promise.resolve(true);
    if (action === "ask_with_reason") {
      if (this.consumeApprovedCommand(command, ordered ? approvalKey : undefined))
        return Promise.resolve(true);
      throw new Error(`Command requires a reason: ${command}\n${COMMAND_REASON_HINT}`);
    }
    if (!context.hasUI || !context.ui) throw new Error(`Command requires confirmation: ${command}`);
    const ui = context.ui;
    const note = commandMatchNote(match);
    const display =
      matchSpan !== undefined && ui.theme && !process.env.NO_COLOR
        ? highlightCommandMatch(command, matchSpan, ui.theme.getFgAnsi("accent"))
        : command;
    return this.withUiLock(async () => {
      if (this.commandPatternApproval(command, approvalKey, generation)) return true;
      if (ui.select) {
        const options =
          approvalKey === undefined
            ? [ALLOW_ONCE_OPTION, DENY_OPTION]
            : [ALLOW_ONCE_OPTION, ALLOW_TURN_OPTION, ALLOW_SESSION_OPTION, DENY_OPTION];
        const selectedOption = await ui.select(`Allow command?\n${display}\n${note}`, options);
        if (selectedOption === ALLOW_TURN_OPTION && approvalKey !== undefined) {
          if (generation !== this.turnApprovalGeneration)
            throw new Error(`Command denied: ${command}\n${EXPIRED_TURN_APPROVAL}`);
          this.turnApprovedPatterns.add(approvalKey);
        }
        if (selectedOption === ALLOW_SESSION_OPTION && approvalKey !== undefined)
          this.sessionApprovedPatterns.push(approvalKey);
        if (selectedOption === undefined || selectedOption === DENY_OPTION)
          throw await this.deniedError(`Command denied by user: ${command}`, ui);
        return true;
      }
      if (await ui.confirm("Allow command?", `${display}\n${note}`)) return true;
      throw await this.deniedError(`Command denied by user: ${command}`, ui);
    });
  }
}
