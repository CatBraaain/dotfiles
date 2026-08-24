import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";

export type Action = "allow" | "deny" | "ask";

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

type GuardrailsConfig = {
  read?: RuleSection;
  write?: RuleSection;
  credentials?: string[];
  commands?: RuleSection;
};

type ToolUI = {
  confirm(title: string, message: string): Promise<boolean>;
  select?(title: string, options: string[]): Promise<string | undefined>;
};

type ToolContext = {
  cwd: string;
  hasUI?: boolean;
  ui?: ToolUI;
};

type RunOptions = {
  cwd?: string;
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  mode?: "fs" | "bash";
};

type RunResult = { exitCode: number | null; stdout: Buffer; stderr: Buffer };

type RunToolsResponse = { ok: true; result: AgentToolResult } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPatterns(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseGuardrailsConfig(source: string): GuardrailsConfig {
  const parsed = parseYaml(source) as unknown;
  if (!isRecord(parsed)) throw new Error("guardrails config must be a mapping");

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
    const character = pattern[index];
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

export function resolveCommandAction(section: RuleSection | undefined, command: string): Action {
  if (!section) return "deny";
  const matches = (patterns: string[] | undefined) =>
    patterns?.some((pattern) =>
      expandBraces(pattern).some((expandedPattern) => {
        if (expandedPattern === "*") return true;
        if (hasGlob(expandedPattern)) return globToRegExp(expandedPattern).test(command);
        return command === expandedPattern || command.startsWith(`${expandedPattern} `);
      }),
    ) ?? false;
  if (matches(section.deny)) return "deny";
  if (matches(section.ask)) return "ask";
  if (matches(section.allow)) return "allow";
  return "deny";
}

function getPathSection(
  config: GuardrailsConfig,
  operation: "read" | "write",
): RuleSection | undefined {
  return config[operation];
}

// "/**" is the `read.allow` sentinel for all paths (§3).
// bun's globSync silently drops dotfiles, so expand by walking the static prefix
// and testing each path with globToRegExp (same semantics as command matching).
// ponytail: walks the whole prefix subtree; add per-segment matching if large trees get slow.
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

export function resolvePathAction(
  section: ExpandedPathSection | undefined,
  candidatePath: string,
): Action {
  if (!section) return "deny";
  if (pathsMatchCandidate(section.deny, candidatePath)) return "deny";
  if (pathsMatchCandidate(section.ask, candidatePath)) return "ask";
  if (pathsMatchCandidate(section.allow, candidatePath)) return "allow";
  return "deny";
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
      result?: AgentToolResult;
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
  private readonly config: GuardrailsConfig;
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
      this.config = parseGuardrailsConfig(readFileSync(configPath, "utf8"));
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
  ): Promise<void> {
    const absolutePath = resolve(candidatePath);
    if (pathsMatchCandidate(this.credentialPaths, absolutePath)) {
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    }
    const section = operation === "read" ? this.readPaths : this.writePaths;
    const action = resolvePathAction(section, absolutePath);
    if (action === "allow") return;
    const explicitlyDenied = pathsMatchCandidate(section.deny, absolutePath);
    if (action === "deny" && explicitlyDenied) throw new Error(`Access denied: ${absolutePath}`);
    if (this.hasDynamicGrant(operation, absolutePath)) return;
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    await this.requestAccess(operation, absolutePath, context.ui);
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
  ): Promise<void> {
    const directoryScopeOption = "Directory (subtree)";
    if (operation === "write" && ui.select) {
      const selectedScope = await ui.select(`Allow write access? ${absolutePath}`, [
        "File only",
        directoryScopeOption,
      ]);
      if (selectedScope === undefined) throw new Error(`Access denied by user: ${absolutePath}`);
      const scope = selectedScope === directoryScopeOption ? "directory" : "file";
      const grantPath = scope === "directory" ? dirname(absolutePath) : absolutePath;
      this.addDynamicGrant("write", grantPath, scope);
      return;
    }
    const approved = await ui.confirm(`Allow ${operation} access?`, absolutePath);
    if (!approved) throw new Error(`Access denied by user: ${absolutePath}`);
    this.addDynamicGrant(operation, absolutePath, "file");
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

  authorizeCommand(command: string, context: ToolContext): Promise<void> {
    const action = resolveCommandAction(this.config.commands, command);
    if (action === "allow") return Promise.resolve();
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (!context.hasUI || !context.ui) throw new Error(`Command requires confirmation: ${command}`);
    return context.ui.confirm("Allow command?", command).then((approved) => {
      if (!approved) throw new Error(`Command denied by user: ${command}`);
    });
  }

  /**
   * Execute one tool call entirely inside the sandbox: a single bwrap invocation
   * runs `bun run-tools.ts <toolName>`, which calls the pi-standard tool definition.
   */
  async runTool(
    toolName: ToolName,
    params: unknown,
    options: { mode: "fs" | "bash"; signal?: AbortSignal; session?: ToolSession },
  ): Promise<AgentToolResult> {
    const request = JSON.stringify({ toolCallId: "cli", params, session: options.session });
    const execution = await this.run("bun", [this.runToolsPath, toolName], {
      input: request,
      mode: options.mode,
      signal: options.signal,
      env: { ...process.env, GUARDRAILS_PI_PACKAGE_DIR: this.piPackageDir },
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
        options.onData?.(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onData?.(chunk);
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
