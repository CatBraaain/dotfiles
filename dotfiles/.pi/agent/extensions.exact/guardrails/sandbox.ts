import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  type GuardrailConfig,
  type GlobCache,
  type PathActionMatch,
  type ExpandedPathSection,
  AuthorizationPath,
  actionPatterns,
  expandBraces,
  expandPathPatterns,
  expandPathSection,
  expandPathSnapshot,
  expandRuntimeVariables,
  globToRegExp,
  hasGlob,
  pathCovers,
  repositoryName,
  resolveGitMainWorktreePath,
  resolvePathActionMatch,
  resolvePattern,
} from "./config.ts";
import { WindowsPathLookup } from "./windows-path-identity.ts";

export type DynamicPaths = Map<string, Set<"read" | "write">>;

export type SandboxMode = "fs" | "bash";

/**
 * Expand every configured glob once (§3 startup semantics) so later
 * re-expansions reuse the first result and never pick up paths created during
 * the session.
 */
export function warmGlobCache(
  config: GuardrailConfig,
  cwd: string,
  mainWorktree: string,
): GlobCache {
  const globCache: GlobCache = new Map();
  expandPathSection(config.read, cwd, true, mainWorktree, globCache);
  expandPathSection(config.write, cwd, false, mainWorktree, globCache);
  expandPathSnapshot(config.credentials, cwd, mainWorktree, false, globCache);
  return globCache;
}

export function resolvePolicyWorktreePath(cwd: string): string {
  return resolveGitMainWorktreePath(cwd) ?? resolve(cwd);
}

export function readPaths(
  config: GuardrailConfig,
  cwd: string,
  globCache: GlobCache,
): ExpandedPathSection {
  return expandPathSection(config.read, cwd, true, resolvePolicyWorktreePath(cwd), globCache);
}

export function writePaths(
  config: GuardrailConfig,
  cwd: string,
  globCache: GlobCache,
  mainWorktree = resolvePolicyWorktreePath(cwd),
): ExpandedPathSection {
  return expandPathSection(config.write, cwd, false, mainWorktree, globCache).map((entry) =>
    entry.action === "allow" ? { ...entry, paths: [...new Set(entry.paths)] } : entry,
  );
}

export function credentialSnapshot(
  config: GuardrailConfig,
  cwd: string,
  globCache: GlobCache,
  mainWorktree = resolvePolicyWorktreePath(cwd),
) {
  return expandPathSnapshot(config.credentials, cwd, mainWorktree, false, globCache);
}

/**
 * Read section resolution with dynamic glob matching for deny patterns.
 * Startup expansion only lists paths that existed at construction (§3), so
 * a deny pattern matching `.env` at any depth must also test the candidate
 * path against the compiled glob directly; otherwise a matching file
 * created during the session would pass. Entries keep config order, so the
 * resolution stays last-match-wins (§3 アクションの決定).
 */
export function readActionMatch(
  config: GuardrailConfig,
  cwd: string,
  globCache: GlobCache,
  comparison: AuthorizationPath,
  mainWorktree: string,
): PathActionMatch {
  const candidatePath = comparison.absolutePath;
  const section = expandPathSection(config.read, cwd, true, mainWorktree, globCache);
  const name = repositoryName(cwd, mainWorktree);
  const legacyDenyGlobs = comparison.windows
    ? []
    : resolvedGlobs(actionPatterns(config.read, "deny"), cwd, mainWorktree).map((pattern) =>
        globToRegExp(pattern, name),
      );
  let resolved: PathActionMatch = { action: "deny" };
  for (const [index, entry] of section.entries()) {
    const match = comparison.matchRule(entry);
    if (match) {
      resolved = match;
    } else if (entry.action === "deny") {
      const denyMatch = comparison.windows
        ? resolvedGlobs(config.read![index]!.patterns, cwd, mainWorktree).some(
            (pattern) => comparison.denyGlobCoverage(pattern, name) !== "none",
          )
        : legacyDenyGlobs.some((regex) => regex.test(candidatePath));
      if (denyMatch) resolved = { action: "deny", matched: candidatePath };
    }
  }
  return resolved;
}

function resolvedGlobs(
  patterns: string[],
  cwd: string,
  mainWorktree: string | undefined,
): string[] {
  return patterns
    .flatMap((pattern) => expandRuntimeVariables(pattern, mainWorktree, cwd))
    .flatMap(expandBraces)
    .map((expanded) => resolvePattern(expanded, cwd))
    .filter(hasGlob);
}

/**
 * Expanded write-section paths split by their final resolved action (§3
 * last-match-wins). `allow`, `ask`, and `deny` expose the same path classes
 * used by fs authorization. `restricted` preserves deny/ask bind ordering
 * for the bash sandbox (§6.1).
 */
export function writePathsByFinalAction(section: ExpandedPathSection): {
  allow: string[];
  ask: string[];
  deny: string[];
  restricted: string[];
} {
  const pathsByAction = {
    allow: new Set<string>(),
    ask: new Set<string>(),
    deny: new Set<string>(),
  };
  const restricted = new Set<string>();
  const seen = new Set<string>();
  const lookup = process.platform === "win32" ? new WindowsPathLookup() : undefined;
  for (const entry of section)
    for (const path of entry.paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const comparison = new AuthorizationPath(path, lookup);
      const action = resolvePathActionMatch(section, path, comparison).action;
      pathsByAction[action].add(path);
      if (action !== "allow") restricted.add(path);
    }
  return {
    allow: [...pathsByAction.allow],
    ask: [...pathsByAction.ask],
    deny: [...pathsByAction.deny],
    restricted: [...restricted],
  };
}

export function readAllPaths(config: GuardrailConfig): boolean {
  return actionPatterns(config.read, "allow").includes("*");
}

function hiddenFsPaths(
  config: GuardrailConfig,
  cwd: string,
  globCache: GlobCache,
  mainWorktree: string,
): string[] {
  return [
    ...expandPathPatterns(actionPatterns(config.read, "deny"), cwd, mainWorktree, false, globCache),
    ...expandPathPatterns(config.credentials, cwd, mainWorktree, false, globCache),
  ];
}

export function prepareWriteDirectories(
  config: GuardrailConfig,
  cwd: string,
  globCache: GlobCache,
  mainWorktree: string,
): void {
  const uncertainCredentials =
    process.platform === "win32"
      ? credentialSnapshot(config, cwd, globCache, mainWorktree).uncertainSubtrees
      : undefined;
  const writeSection = writePaths(config, cwd, globCache, mainWorktree);
  for (const path of writePathsByFinalAction(writeSection).allow) {
    if (
      uncertainCredentials &&
      new AuthorizationPath(path).matchesRestriction({
        paths: [],
        uncertainSubtrees: uncertainCredentials,
      })
    )
      continue;
    if (existsSync(path)) continue;
    try {
      mkdirSync(path, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `guardrails: could not create write directory ${JSON.stringify(path)}:`,
        message,
      );
    }
  }
}

function addParentDirectories(args: string[], targetPath: string): void {
  const parents: string[] = [];
  for (let parent = dirname(targetPath); parent !== "/"; parent = dirname(parent))
    parents.push(parent);
  parents.reverse();
  for (const parent of parents) args.push("--dir", parent);
}

function addMount(args: string[], sourcePath: string, writable: boolean): void {
  if (!existsSync(sourcePath)) return;
  addParentDirectories(args, sourcePath);
  args.push(writable ? "--bind-try" : "--ro-bind-try", sourcePath, sourcePath);
}

function addConfiguredMounts(
  args: string[],
  input: {
    cwd: string;
    config: GuardrailConfig;
    globCache: GlobCache;
    dynamicPaths: DynamicPaths;
    mode: SandboxMode;
    readOnly?: boolean;
  },
  mainWorktree: string,
): void {
  const writableMountPaths: string[] = [];
  const writeSection = writePaths(input.config, input.cwd, input.globCache, mainWorktree);
  const { allow: allowFinalPaths, restricted: restrictedFinalPaths } =
    writePathsByFinalAction(writeSection);

  function mount(path: string, writable: boolean): void {
    const normalized = resolve(path);
    if (writable) writableMountPaths.push(normalized);
    addMount(args, normalized, writable);
  }

  if (!readAllPaths(input.config)) {
    for (const path of expandPathPatterns(
      actionPatterns(input.config.read, "allow"),
      input.cwd,
      mainWorktree,
      true,
      input.globCache,
    ))
      mount(path, false);
    // bwrap later mounts win: the cwd read-only bind must precede every
    // writable mount below, or it would shadow write allows and dynamic
    // write grants inside the cwd, turning the whole tree read-only.
    mount(input.cwd, false);
  }
  for (const path of allowFinalPaths) mount(path, !input.readOnly);
  if (input.readOnly) {
    for (const path of input.dynamicPaths.keys()) mount(path, false);
    return;
  }
  if (input.mode === "fs") {
    for (const [path, accessModes] of input.dynamicPaths) mount(path, accessModes.has("write"));
    return;
  }

  const writeGrants: string[] = [];
  for (const [path, accessModes] of input.dynamicPaths) {
    if (accessModes.has("write")) writeGrants.push(path);
    else mount(path, false);
  }
  function hasWriteGrant(path: string): boolean {
    return writeGrants.some((grant) => pathCovers(grant, path));
  }
  const permissionPaths = new Set([
    ...restrictedFinalPaths,
    ...writeGrants,
    ...allowFinalPaths.filter(hasWriteGrant),
  ]);
  const orderedPaths = [...permissionPaths].sort(
    (left, right) => left.split(sep).length - right.split(sep).length,
  );
  for (const path of orderedPaths) {
    const { action, matched } = resolvePathActionMatch(writeSection, path);
    const writable = (action !== "deny" || matched === undefined) && hasWriteGrant(path);
    if (writable || writableMountPaths.some((parent) => pathCovers(parent, path)))
      mount(path, writable);
  }
  const credentials = credentialSnapshot(input.config, input.cwd, input.globCache, mainWorktree);
  for (const path of credentials.paths) mount(path, false);
}

function addHiddenPaths(
  args: string[],
  input: {
    cwd: string;
    config: GuardrailConfig;
    globCache: GlobCache;
    mode: SandboxMode;
  },
  mainWorktree: string,
): void {
  if (input.mode === "bash") return;
  for (const path of hiddenFsPaths(input.config, input.cwd, input.globCache, mainWorktree)) {
    if (!existsSync(path)) continue;
    addParentDirectories(args, path);
    if (statSync(path).isDirectory()) args.push("--tmpfs", path);
    else args.push("--ro-bind-try", "/dev/null", path);
  }
}

/** Build the bwrap argument list for one sandboxed tool run (SPEC §6.1). */
export function buildSandboxArgs(input: {
  cwd: string;
  config: GuardrailConfig;
  globCache: GlobCache;
  dynamicPaths: DynamicPaths;
  mode: SandboxMode;
  commandCwd?: string;
  readOnly?: boolean;
}): string[] {
  const args = ["--die-with-parent"];
  if (readAllPaths(input.config)) args.push("--ro-bind", "/", "/");
  args.push("--proc", "/proc", "--dev", "/dev");
  if (input.mode === "bash" && !input.readOnly) {
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
    if (!readAllPaths(input.config) && existsSync(runtimePath))
      args.push("--ro-bind-try", runtimePath, runtimePath);
  }
  const mainWorktree = resolvePolicyWorktreePath(input.cwd);
  addConfiguredMounts(args, input, mainWorktree);
  addHiddenPaths(args, input, mainWorktree);
  args.push("--chdir", input.commandCwd ?? input.cwd);
  return args;
}
