import { spawn } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BashOperations,
  EditOperations,
  ExtensionAPI,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type Action = "allow" | "deny" | "ask";

type RuleSection = { allow?: string[]; ask?: string[]; deny?: string[] };

type BwrapConfig = {
  read?: RuleSection;
  write?: RuleSection;
  credentials?: string[];
  commands?: RuleSection;
};

type ToolContext = {
  cwd: string;
  hasUI?: boolean;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
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

export const COMMAND_PREVIEW_LIMIT = 80;

export function truncateCommand(command: string, limit = COMMAND_PREVIEW_LIMIT): string {
  return command.length > limit ? `${command.slice(0, limit - 3)}...` : command;
}

export function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function countResultLines(text: string): number {
  if (text === "") return 0;
  const trimmed = text.trimEnd();
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPatterns(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseBwrapConfig(source: string): BwrapConfig {
  const parsed = parseYaml(source) as unknown;
  if (!isRecord(parsed)) throw new Error("bwrap-tools config must be a mapping");

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

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

function resolvePattern(pattern: string, cwd: string): string {
  if (pattern === "*") return "/**";
  const homeExpanded =
    pattern === "~"
      ? homedir()
      : pattern.startsWith("~/")
        ? join(homedir(), pattern.slice(2))
        : pattern;
  return isAbsolute(homeExpanded) ? resolve(homeExpanded) : resolve(cwd, homeExpanded);
}

function patternMatchesPath(pattern: string, candidatePath: string, cwd: string): boolean {
  const resolvedPattern = resolvePattern(pattern, cwd);
  const normalizedCandidate = resolve(candidatePath);
  if (hasGlob(resolvedPattern)) {
    return expandBraces(resolvedPattern).some((expandedPattern) =>
      globToRegExp(expandedPattern).test(normalizedCandidate),
    );
  }
  return (
    normalizedCandidate === resolvedPattern ||
    normalizedCandidate.startsWith(`${resolvedPattern}${sep}`)
  );
}

export function resolvePathAction(
  section: RuleSection | undefined,
  candidatePath: string,
  cwd: string,
): Action {
  if (!section) return "deny";
  const matches = (patterns: string[] | undefined) =>
    patterns?.some((pattern) => patternMatchesPath(pattern, candidatePath, cwd)) ?? false;
  if (matches(section.deny)) return "deny";
  if (matches(section.ask)) return "ask";
  if (matches(section.allow)) return "allow";
  return "deny";
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

function getPathSection(config: BwrapConfig, operation: "read" | "write"): RuleSection | undefined {
  return config[operation];
}

function resolveConfigPatterns(patterns: string[] | undefined, cwd: string): string[] {
  return (patterns ?? []).flatMap((pattern) => {
    const resolvedPattern = resolvePattern(pattern, cwd);
    if (!hasGlob(resolvedPattern)) return [resolvedPattern];
    return globSync(resolvedPattern, { absolute: true, dot: true }) as string[];
  });
}

function addParentDirectories(args: string[], targetPath: string): void {
  const parents: string[] = [];
  for (let parent = dirname(targetPath); parent !== "/"; parent = dirname(parent))
    parents.push(parent);
  parents.reverse();
  for (const parent of parents) args.push("--dir", parent);
}

const GREP_NOTICE_LINE_LENGTH = 500;

export type GrepMatch = {
  filePath: string;
  lineNumber: number;
  lineText: string;
};

export type GrepFormatDetails = {
  matchCount: number;
  matchLimitReached?: number;
  truncation?: TruncationResult;
  linesTruncated?: boolean;
};

export type GrepFormatResult = {
  text: string;
  details: GrepFormatDetails;
};

function formatGrepPath(filePath: string, searchPath: string, isDirectory: boolean): string {
  if (isDirectory) {
    const relativePath = relative(searchPath, filePath);
    if (relativePath && !relativePath.startsWith("..")) return relativePath.split(sep).join("/");
  }
  return basename(filePath);
}

export async function formatGrepMatches(
  matches: GrepMatch[],
  options: {
    context: number;
    limit: number;
    isDirectory: boolean;
    searchPath: string;
    readFile: (filePath: string) => Promise<string>;
  },
): Promise<GrepFormatResult> {
  const contextValue = options.context > 0 ? options.context : 0;
  const matchLimitReached = matches.length >= options.limit ? options.limit : undefined;

  const fileCache = new Map<string, string[]>();
  const getFileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      try {
        const content = await options.readFile(filePath);
        lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      } catch {
        lines = [];
      }
      fileCache.set(filePath, lines);
    }
    return lines;
  };

  const outputLines: string[] = [];
  let linesTruncated = false;

  for (const match of matches) {
    const relativePath = formatGrepPath(match.filePath, options.searchPath, options.isDirectory);
    if (contextValue === 0) {
      const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const { text, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
      continue;
    }
    const lines = await getFileLines(match.filePath);
    if (!lines.length) {
      outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
      continue;
    }
    const start = Math.max(1, match.lineNumber - contextValue);
    const end = Math.min(lines.length, match.lineNumber + contextValue);
    for (let current = start; current <= end; current++) {
      const lineText = lines[current - 1] ?? "";
      const { text, wasTruncated } = truncateLine(lineText.replace(/\r/g, ""));
      if (wasTruncated) linesTruncated = true;
      outputLines.push(
        current === match.lineNumber
          ? `${relativePath}:${current}: ${text}`
          : `${relativePath}-${current}- ${text}`,
      );
    }
  }

  const rawOutput = outputLines.join("\n") || "No matches found";
  const truncation = truncateHead(rawOutput, {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  let text = truncation.content;

  const notices: string[] = [];
  if (matchLimitReached)
    notices.push(
      `${matchLimitReached} matches limit reached. Use limit=${matchLimitReached * 2} for more, or refine pattern`,
    );
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  if (linesTruncated)
    notices.push(
      `Some lines truncated to ${GREP_NOTICE_LINE_LENGTH} chars. Use read tool to see full lines`,
    );
  if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;

  return {
    text,
    details: {
      matchCount: matches.length,
      matchLimitReached,
      truncation: truncation.truncated ? truncation : undefined,
      linesTruncated: linesTruncated || undefined,
    },
  };
}

export class Sandbox {
  private readonly dynamicPaths = new Map<string, Set<"read" | "write">>();
  private readonly config: BwrapConfig;

  constructor(
    private readonly cwd: string,
    configPath = join(import.meta.dir, "config.yaml"),
  ) {
    try {
      this.config = parseBwrapConfig(readFileSync(configPath, "utf8"));
    } catch {
      this.config = {};
    }
    this.prepareWriteDirectories();
  }

  private prepareWriteDirectories(): void {
    for (const pattern of getPathSection(this.config, "write")?.allow ?? []) {
      if (hasGlob(pattern)) continue;
      const path = resolvePattern(pattern, this.cwd);
      if (!existsSync(path)) mkdirSync(path, { recursive: true });
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
      for (const path of resolveConfigPatterns(readSection?.allow, this.cwd)) mount(path, false);
    }
    for (const path of resolveConfigPatterns(writeSection?.allow, this.cwd)) mount(path, true);
    for (const [path, accessModes] of this.dynamicPaths) mount(path, accessModes.has("write"));

    if (!this.readAllPaths()) mount(this.cwd, false);
    if (mode === "bash") {
      for (const path of resolveConfigPatterns(this.config.credentials, this.cwd)) {
        if (existsSync(path)) mount(path, false);
      }
    }
  }

  private addHiddenPaths(args: string[], mode: "fs" | "bash"): void {
    if (mode === "bash") return;
    const hiddenPatterns = [
      ...(getPathSection(this.config, "read")?.deny ?? []),
      ...(this.config.credentials ?? []),
    ];
    const hiddenPaths = resolveConfigPatterns(hiddenPatterns, this.cwd);
    for (const path of hiddenPaths) {
      if (!existsSync(path)) continue;
      addParentDirectories(args, path);
      if (statSync(path).isDirectory()) args.push("--tmpfs", path);
      else args.push("--ro-bind-try", "/dev/null", path);
    }
  }

  private buildArgs(mode: "fs" | "bash", commandCwd = this.cwd): string[] {
    const args = ["--die-with-parent", "--proc", "/proc"];
    if (this.readAllPaths()) args.push("--ro-bind", "/", "/");
    args.push("--dev", "/dev");
    for (const runtimePath of ["/nix", "/usr", "/bin", "/lib", "/lib64", "/etc", "/run"]) {
      if (!this.readAllPaths() && existsSync(runtimePath))
        args.push("--ro-bind-try", runtimePath, runtimePath);
    }
    this.addConfiguredMounts(args, mode);
    this.addHiddenPaths(args, mode);
    args.push("--chdir", commandCwd);
    return args;
  }

  authorizePath(
    operation: "read" | "write",
    candidatePath: string,
    context: ToolContext,
  ): Promise<void> {
    const absolutePath = resolve(candidatePath);
    if (
      (this.config.credentials ?? []).some((pattern) =>
        patternMatchesPath(pattern, absolutePath, this.cwd),
      )
    ) {
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    }
    const dynamicAccess = this.dynamicPaths.get(absolutePath);
    if (dynamicAccess?.has(operation)) return Promise.resolve();

    const section = getPathSection(this.config, operation);
    const action = resolvePathAction(section, absolutePath, this.cwd);
    if (action === "allow") return Promise.resolve();
    const explicitlyDenied =
      section?.deny?.some((pattern) => patternMatchesPath(pattern, absolutePath, this.cwd)) ??
      false;
    if (action === "deny" && explicitlyDenied) throw new Error(`Access denied: ${absolutePath}`);
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    return context.ui.confirm(`Allow ${operation} access?`, absolutePath).then((approved) => {
      if (!approved) throw new Error(`Access denied by user: ${absolutePath}`);
      const accessModes = this.dynamicPaths.get(absolutePath) ?? new Set<"read" | "write">();
      accessModes.add(operation);
      this.dynamicPaths.set(absolutePath, accessModes);
    });
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

  async execute(command: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
    const result = await this.run(command, args, options);
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString("utf8").trim() || `${command} exited with code ${result.exitCode}`,
      );
    }
    return result.stdout;
  }

  createReadOperations(): ReadOperations {
    return {
      readFile: (path) => this.execute("cat", [path]),
      access: async (path) => {
        await this.execute("test", ["-r", path]);
      },
      detectImageMimeType: async (path) => {
        const extension = path.toLowerCase().slice(path.lastIndexOf("."));
        return (
          (
            {
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".gif": "image/gif",
              ".webp": "image/webp",
              ".bmp": "image/bmp",
            } as Record<string, string>
          )[extension] ?? null
        );
      },
    };
  }

  createWriteOperations(): WriteOperations {
    return {
      writeFile: async (path, content) => {
        await this.execute("tee", [path], { input: content });
      },
      mkdir: async (path) => {
        await this.execute("mkdir", ["-p", path]);
      },
    };
  }

  createEditOperations(): EditOperations {
    const readOperations = this.createReadOperations();
    const writeOperations = this.createWriteOperations();
    return {
      readFile: readOperations.readFile,
      access: readOperations.access,
      writeFile: writeOperations.writeFile,
    };
  }

  createLsOperations(): LsOperations {
    return {
      exists: async (path) => {
        try {
          await this.execute("test", ["-e", path]);
          return true;
        } catch {
          return false;
        }
      },
      stat: async (path) => {
        const isDirectory = await this.execute("test", ["-d", path]).then(
          () => true,
          () => false,
        );
        return { isDirectory: () => isDirectory };
      },
      readdir: async (path) =>
        (await this.execute("find", [path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"]))
          .toString()
          .split("\0")
          .filter(Boolean),
    };
  }

  createFindOperations(): FindOperations {
    return {
      exists: async (path) => {
        try {
          await this.execute("test", ["-e", path]);
          return true;
        } catch {
          return false;
        }
      },
      glob: async (pattern, cwd, options) => {
        const commandArgs = [
          "--glob",
          "--hidden",
          "--color=never",
          "--no-require-git",
          "--max-results",
          String(options.limit),
        ];
        let effectivePattern = pattern;
        if (pattern.includes("/")) {
          commandArgs.push("--full-path");
          if (!pattern.startsWith("/") && !pattern.startsWith("**/"))
            effectivePattern = `**/${pattern}`;
        }
        commandArgs.push("--", effectivePattern, cwd);
        return (await this.execute("fd", commandArgs))
          .toString()
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      },
    };
  }

  async grep(
    pattern: string,
    searchPath: string,
    options: {
      glob?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      context?: number;
      limit: number;
      signal?: AbortSignal;
    },
  ): Promise<GrepFormatResult> {
    const commandArgs = ["--json", "--line-number", "--color=never", "--hidden"];
    if (options.ignoreCase) commandArgs.push("--ignore-case");
    if (options.literal) commandArgs.push("--fixed-strings");
    if (options.glob) commandArgs.push("--glob", options.glob);
    commandArgs.push("--", pattern, searchPath);
    const result = await this.run("rg", commandArgs, {
      signal: options.signal,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(
        result.stderr.toString("utf8").trim() || `rg exited with code ${result.exitCode}`,
      );
    }
    const searchIsDirectory = await this.execute("test", ["-d", searchPath]).then(
      () => true,
      () => false,
    );
    const matches: GrepMatch[] = [];
    for (const line of result.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      if (matches.length >= options.limit) break;
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (event.type !== "match") continue;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (!filePath || typeof lineNumber !== "number") continue;
      const lineText = (event.data.lines?.text ?? "").replace(/\r?\n$/, "");
      matches.push({ filePath, lineNumber, lineText });
    }
    // ponytail: rg の match-limit 到達時の早期 kill を省略。全走査するが結果は標準 grep と同一。巨大リポジトリで遅くなるなら run() にストリーミング kill を足す。
    return formatGrepMatches(matches, {
      context: options.context ?? 0,
      limit: options.limit,
      isDirectory: searchIsDirectory,
      searchPath,
      readFile: (filePath) => this.execute("cat", [filePath]).then((buffer) => buffer.toString()),
    });
  }

  createBashOperations(): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        const result = await this.run("bash", ["-c", command], {
          ...options,
          cwd,
          mode: "bash",
        });
        return { exitCode: result.exitCode };
      },
    };
  }
}

function renderTextToolResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
  context: any,
  unit: string,
): Text {
  if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (context.isError) return new Text(theme.fg("error", output), 0, 0);
  if (options.expanded) return new Text(theme.fg("dim", output), 0, 0);
  return new Text(theme.fg("success", `${countResultLines(output)} ${unit}`), 0, 0);
}

export default function bwrapToolsExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const sandbox = new Sandbox(cwd);
  const readOperations = sandbox.createReadOperations();
  const writeOperations = sandbox.createWriteOperations();
  const readTool = createReadTool(cwd, { operations: readOperations });
  const writeTool = createWriteTool(cwd, { operations: writeOperations });
  const editTool = createEditTool(cwd, {
    operations: sandbox.createEditOperations(),
  });
  const grepTool = createGrepTool(cwd);
  const findTool = createFindTool(cwd, {
    operations: sandbox.createFindOperations(),
  });
  const lsTool = createLsTool(cwd, {
    operations: sandbox.createLsOperations(),
  });
  const bashTool = createBashTool(cwd, {
    operations: sandbox.createBashOperations(),
  });

  pi.registerTool({
    ...bashTool,
    async execute(id, params, signal, onUpdate, context) {
      await sandbox.authorizeCommand(params.command, context);
      return bashTool.execute(id, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context.state && context.executionStarted && context.state.startedAt === undefined)
        context.state.startedAt = Date.now();
      return new Text(
        `${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg("accent", truncateCommand(args.command))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError)
        return new Text(
          theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : ""),
          0,
          0,
        );
      if (options.expanded)
        return new Text(
          theme.fg("dim", result.content[0]?.type === "text" ? result.content[0].text : ""),
          0,
          0,
        );
      const state = context.state;
      if (state?.startedAt !== undefined) {
        state.endedAt ??= Date.now();
        return new Text(theme.fg("success", formatDuration(state.endedAt - state.startedAt)), 0, 0);
      }
      return new Text(theme.fg("success", "done"), 0, 0);
    },
  });

  const registerTextTool = (
    tool: any,
    name: string,
    unit: string,
    getCall: (args: any) => string,
    authorize: (args: any, context: ToolContext) => Promise<void>,
  ) => {
    pi.registerTool({
      ...tool,
      async execute(
        id: string,
        params: any,
        signal: AbortSignal | undefined,
        onUpdate: any,
        context: ToolContext,
      ) {
        await authorize(params, context);
        return tool.execute(id, params, signal, onUpdate);
      },
      renderCall(args: any, theme: any) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold(`${name} `))}${theme.fg("accent", getCall(args))}`,
          0,
          0,
        );
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        return renderTextToolResult(result, options, theme, context, unit);
      },
    });
  };
  registerTextTool(
    readTool,
    "read",
    "lines",
    (args) => args.path,
    (args, context) => sandbox.authorizePath("read", resolve(cwd, args.path), context),
  );
  pi.registerTool({
    ...writeTool,
    async execute(id, params, signal, onUpdate, context) {
      await sandbox.authorizePath("write", resolve(cwd, params.path), context);
      return writeTool.execute(id, params, signal, onUpdate);
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("write "))}${theme.fg("accent", args.path)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (options.expanded) return new Text(theme.fg("dim", context.args?.content ?? ""), 0, 0);
      return new Text(
        theme.fg("success", `wrote ${formatSize(context.args?.content?.length ?? 0)}`),
        0,
        0,
      );
    },
  });
  pi.registerTool({
    ...editTool,
    async execute(id, params, signal, onUpdate, context) {
      await sandbox.authorizePath("read", resolve(cwd, params.path), context);
      await sandbox.authorizePath("write", resolve(cwd, params.path), context);
      return editTool.execute(id, params, signal, onUpdate);
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("accent", args.path)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (options.expanded) {
        const diff = (result.details as { diff?: string } | undefined)?.diff ?? output;
        return new Text(theme.fg("dim", diff), 0, 0);
      }
      const editCount = Array.isArray(context.args?.edits) ? context.args.edits.length : 1;
      return new Text(theme.fg("success", `edited ${editCount} block(s)`), 0, 0);
    },
  });
  registerTextTool(
    findTool,
    "find",
    "files",
    (args) => args.pattern,
    (args, context) => sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context),
  );
  registerTextTool(
    lsTool,
    "ls",
    "entries",
    (args) => args.path ?? ".",
    (args, context) => sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context),
  );

  pi.registerTool({
    ...grepTool,
    async execute(id, params, signal, onUpdate, context) {
      const searchPath = resolve(cwd, params.path ?? ".");
      await sandbox.authorizePath("read", searchPath, context);
      const { text, details } = await sandbox.grep(params.pattern, searchPath, {
        glob: params.glob,
        ignoreCase: params.ignoreCase,
        literal: params.literal,
        context: params.context,
        limit: Math.max(1, params.limit ?? 100),
        signal,
      });
      return { content: [{ type: "text", text }], details };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("grep "))}${theme.fg("accent", args.pattern)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (options.expanded) return new Text(theme.fg("dim", output), 0, 0);
      const matchCount =
        (result.details as { matchCount?: number } | undefined)?.matchCount ??
        countResultLines(output);
      return new Text(theme.fg("success", `${matchCount} matches`), 0, 0);
    },
  });
}
