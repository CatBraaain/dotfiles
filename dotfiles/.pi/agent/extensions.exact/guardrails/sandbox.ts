import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  type GuardrailConfig,
  type PathActionMatch,
  type ExpandedPathSection,
  actionPatterns,
  expandBraces,
  expandPathPatterns,
  expandRuntimeVariables,
  globToRegExp,
  hasGlob,
  pathCovers,
  repositoryName,
  resolveGitMainWorktreePath,
  resolvePathActionMatch,
  resolvePattern,
  restoreRepositoryName,
} from "./config.ts";

export type DynamicPaths = Map<string, Set<"read" | "write">>;

export type SandboxMode = "fs" | "bash";

/**
 * Expand every configured glob once (§3 startup semantics) so later
 * re-expansions reuse the first result and never pick up paths created during
 * the session.
 */
export function warmGlobCache(config: GuardrailConfig, cwd: string): Map<string, string[]> {
  const globCache = new Map<string, string[]>();
  const gitMainWorktreePath = resolveGitMainWorktreePath(cwd);
  expandPathSectionInto(config.read, cwd, true, gitMainWorktreePath, globCache);
  expandPathSectionInto(config.write, cwd, false, gitMainWorktreePath, globCache);
  expandPathPatterns(config.credentials, cwd, gitMainWorktreePath, false, globCache);
  return globCache;
}

function expandPathSectionInto(
  entries: GuardrailConfig["read"],
  cwd: string,
  allowAllPaths: boolean,
  gitMainWorktreePath: string | undefined,
  globCache: Map<string, string[]>,
): ExpandedPathSection {
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

// Path sections are recomputed on every access instead of cached, so
// Git variables re-run `git worktree list` per authorization and bind
// decision (§3). Globs stay startup-expanded via globCache.
export function readPaths(
  config: GuardrailConfig,
  cwd: string,
  globCache: Map<string, string[]>,
): ExpandedPathSection {
  return expandPathSectionInto(config.read, cwd, true, resolveGitMainWorktreePath(cwd), globCache);
}

export function writePaths(
  config: GuardrailConfig,
  cwd: string,
  globCache: Map<string, string[]>,
): ExpandedPathSection {
  return expandPathSectionInto(
    config.write,
    cwd,
    false,
    resolveGitMainWorktreePath(cwd),
    globCache,
  );
}

export function credentialPaths(
  config: GuardrailConfig,
  cwd: string,
  globCache: Map<string, string[]>,
): string[] {
  return expandPathPatterns(
    config.credentials,
    cwd,
    resolveGitMainWorktreePath(cwd),
    false,
    globCache,
  );
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
  globCache: Map<string, string[]>,
  candidatePath: string,
): PathActionMatch {
  const section = readPaths(config, cwd, globCache);
  const denyGlobRegexes = readDenyGlobRegexes(config, cwd);
  let resolved: PathActionMatch = { action: "deny" };
  for (const entry of section) {
    const matchedPath = entry.paths.find((path) => pathCovers(path, candidatePath));
    const deniedDynamically =
      entry.action === "deny" && denyGlobRegexes.some((regex) => regex.test(candidatePath));
    if (matchedPath !== undefined || deniedDynamically)
      resolved = { action: entry.action, matched: matchedPath ?? candidatePath };
  }
  return resolved;
}

function readDenyGlobRegexes(config: GuardrailConfig, cwd: string): RegExp[] {
  return actionPatterns(config.read, "deny")
    .flatMap((pattern) => expandRuntimeVariables(pattern, resolveGitMainWorktreePath(cwd), cwd))
    .flatMap(expandBraces)
    .map((expanded) => resolvePattern(expanded, cwd))
    .filter(hasGlob)
    .map((pattern) => globToRegExp(pattern, repositoryName(cwd, resolveGitMainWorktreePath(cwd))));
}

/**
 * Expanded write-section paths split by their final resolved action (§3
 * last-match-wins). `allow`, `ask`, and `deny` expose the same path classes
 * used by fs authorization. `restricted` preserves deny/ask bind ordering
 * for the bash sandbox (§6.1).
 */
export function writePathsByFinalAction(
  config: GuardrailConfig,
  cwd: string,
  globCache: Map<string, string[]>,
): {
  allow: string[];
  ask: string[];
  deny: string[];
  restricted: string[];
} {
  const section = writePaths(config, cwd, globCache);
  const pathsByAction = {
    allow: new Set<string>(),
    ask: new Set<string>(),
    deny: new Set<string>(),
  };
  const restricted = new Set<string>();
  const seen = new Set<string>();
  for (const entry of section)
    for (const path of entry.paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const action = resolvePathActionMatch(section, path).action;
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

export function hiddenFsPaths(
  config: GuardrailConfig,
  cwd: string,
  globCache: Map<string, string[]>,
): string[] {
  const gitMainWorktreePath = resolveGitMainWorktreePath(cwd);
  return [
    ...expandPathPatterns(
      actionPatterns(config.read, "deny"),
      cwd,
      gitMainWorktreePath,
      false,
      globCache,
    ),
    ...expandPathPatterns(config.credentials, cwd, gitMainWorktreePath, false, globCache),
  ];
}

/**
 * Create allow-final write paths so their writable binds have a target (§6.1).
 * Only allow-final paths are created: a deny/ask-final path is never
 * writable-bound, so creating it would hand the sandbox a path fs tools deny
 * writing to. Globs expand to existing paths only, so they skip the mkdir -p
 * guarantee by themselves. Runtime-directory paths belong to the session
 * manager: an absent runtime directory is left unbound by --bind-try instead
 * of being created.
 */
export function prepareWriteDirectories(
  config: GuardrailConfig,
  cwd: string,
  globCache: Map<string, string[]>,
): void {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const runtimePath = runtimeDir
    ? restoreRepositoryName(resolvePattern(runtimeDir, cwd), "")
    : undefined;
  for (const path of writePathsByFinalAction(config, cwd, globCache).allow) {
    if (runtimePath && pathCovers(runtimePath, path)) continue;
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
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
    globCache: Map<string, string[]>;
    dynamicPaths: DynamicPaths;
    mode: SandboxMode;
  },
): void {
  const gitMainWorktreePath = resolveGitMainWorktreePath(input.cwd);
  const writableMountPaths: string[] = [];
  const { allow: allowFinalPaths, restricted: restrictedFinalPaths } = writePathsByFinalAction(
    input.config,
    input.cwd,
    input.globCache,
  );

  function mount(path: string, writable: boolean): void {
    const normalized = resolve(path);
    if (writable) writableMountPaths.push(normalized);
    addMount(args, normalized, writable);
  }

  if (!readAllPaths(input.config)) {
    for (const path of expandPathPatterns(
      actionPatterns(input.config.read, "allow"),
      input.cwd,
      gitMainWorktreePath,
      true,
      input.globCache,
    ))
      mount(path, false);
    // bwrap later mounts win: the cwd read-only bind must precede every
    // writable mount below, or it would shadow write allows and dynamic
    // write grants inside the cwd, turning the whole tree read-only.
    mount(input.cwd, false);
  }
  for (const path of allowFinalPaths) mount(path, true);
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
  const writeSection = writePaths(input.config, input.cwd, input.globCache);
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
  for (const path of credentialPaths(input.config, input.cwd, input.globCache)) mount(path, false);
}

function addHiddenPaths(
  args: string[],
  input: {
    cwd: string;
    config: GuardrailConfig;
    globCache: Map<string, string[]>;
    mode: SandboxMode;
  },
): void {
  if (input.mode === "bash") return;
  for (const path of hiddenFsPaths(input.config, input.cwd, input.globCache)) {
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
  globCache: Map<string, string[]>;
  dynamicPaths: DynamicPaths;
  mode: SandboxMode;
  commandCwd?: string;
}): string[] {
  const args = ["--die-with-parent"];
  if (readAllPaths(input.config)) args.push("--ro-bind", "/", "/");
  args.push("--proc", "/proc", "--dev", "/dev");
  if (input.mode === "bash") {
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
  addConfiguredMounts(args, input);
  addHiddenPaths(args, input);
  args.push("--chdir", input.commandCwd ?? input.cwd);
  return args;
}
