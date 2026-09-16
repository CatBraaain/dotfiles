import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const RTK_REWRITE_TIMEOUT_MS = 2_000;
export const MIN_SUPPORTED_RTK_MINOR = 23;

export type RtkLogger = {
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
};

type RtkExecutionError = {
  status?: number | null;
  stdout?: string;
};

type ExecuteRtk = (binaryPath: string, args: string[], timeoutMs: number) => string;

function executeRtk(binaryPath: string, args: string[], timeoutMs: number): string {
  return execFileSync(binaryPath, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
  }) as string;
}

/** Parse the first X.Y.Z semver found in an rtk version response. */
export function parseRtkSemver(raw: string): [number, number, number] | null {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

/** Normalize rtk rewrite stdout; blank output means pass-through. */
export function normalizeRtkRewrite(stdout: string | undefined): string | null {
  const rewritten = stdout?.trim();
  return rewritten === undefined || rewritten.length === 0 ? null : rewritten;
}

function findRtkBinary(): string | undefined {
  try {
    const binaryPath = execFileSync("which", ["rtk"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: RTK_REWRITE_TIMEOUT_MS,
    }).trim();
    return binaryPath.length === 0 ? undefined : binaryPath;
  } catch {
    return undefined;
  }
}

/** Resolve the executable used by rewritten commands and by the host probe. */
export function resolveRtkBinary(
  findBinary: () => string | undefined = findRtkBinary,
): string | undefined {
  try {
    const binaryPath = findBinary();
    if (binaryPath === undefined || !existsSync(binaryPath)) return undefined;
    const resolvedPath = realpathSync(binaryPath);
    return existsSync(resolvedPath) ? resolve(resolvedPath) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the config path that must remain visible to `rtk` in the sandbox. */
export function resolveRtkConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.RTK_CONFIG;
  if (configured !== undefined && configured.length > 0)
    return isAbsolute(configured) ? configured : resolve(configured);
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "rtk");
}

/**
 * Host-side rtk adapter for the model-facing sandboxed-tools bash tool.
 * Version probing happens once when the plugin is mounted; every rewrite
 * failure remains fail-open and returns the original command.
 */
export class RtkRewriter {
  readonly binaryPath: string | undefined;
  readonly configPath: string | undefined;
  private readonly enabled: boolean;
  private readonly execute: ExecuteRtk;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly logger: RtkLogger;

  constructor(
    logger: RtkLogger,
    options: {
      binaryPath?: string | null;
      configPath?: string;
      execute?: ExecuteRtk;
      environment?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.logger = logger;
    this.execute = options.execute ?? executeRtk;
    this.environment = options.environment ?? process.env;
    this.binaryPath =
      options.binaryPath === null ? undefined : (options.binaryPath ?? resolveRtkBinary());
    this.configPath =
      this.binaryPath === undefined
        ? undefined
        : (options.configPath ?? resolveRtkConfigPath(this.environment));
    this.enabled = this.probe();
  }

  rewrite(command: string): string {
    if (!this.enabled || command.trim().length === 0) return command;
    if (command.startsWith("rtk ") || this.environment.RTK_DISABLED === "1") return command;
    const rewritten = this.runRewrite(command);
    if (rewritten === null || rewritten === command) return command;
    this.logger.info("rtk rewrite: %s -> %s", command, rewritten);
    return rewritten;
  }

  private probe(): boolean {
    if (this.binaryPath === undefined) {
      this.logger.warn(
        "rtk binary not found in PATH — rewrite disabled, commands pass through unchanged",
      );
      return false;
    }
    let version: string;
    try {
      version = this.execute(this.binaryPath, ["--version"], RTK_REWRITE_TIMEOUT_MS);
    } catch {
      this.logger.warn(
        "rtk binary could not be probed — rewrite disabled, commands pass through unchanged",
      );
      return false;
    }
    const parsed = parseRtkSemver(version.replace(/^rtk\s+/, ""));
    if (parsed !== null) {
      const [major, minor] = parsed;
      if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
        this.logger.warn(
          "rtk %s is too old (need >= 0.%d.0) — rewrite disabled, commands pass through unchanged",
          version.trim(),
          MIN_SUPPORTED_RTK_MINOR,
        );
        return false;
      }
    }
    return true;
  }

  private runRewrite(command: string): string | null {
    if (this.binaryPath === undefined) return null;
    try {
      return normalizeRtkRewrite(
        this.execute(this.binaryPath, ["rewrite", command], RTK_REWRITE_TIMEOUT_MS),
      );
    } catch (error) {
      const executionError = error as RtkExecutionError;
      if (executionError.status !== 3) return null;
      return normalizeRtkRewrite(executionError.stdout);
    }
  }
}
