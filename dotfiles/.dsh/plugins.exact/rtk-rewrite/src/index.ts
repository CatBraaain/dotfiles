// rtk-rewriting bash executor for dsh.
//
// Replaces the stock POSIX bash executor with a subclass that rewrites each
// command through `rtk rewrite` before execution, saving tokens by routing
// read-heavy commands through rtk's compact output wrappers. All rewrite
// logic lives in the `rtk` CLI (`rtk rewrite`); this executor is a thin
// delegating wrapper — to change rules, edit rtk's Rust registry.
//
// Exit code contract for `rtk rewrite`:
//   0 + stdout  Rewrite found     -> mutate command
//   1           No RTK equivalent -> pass through unchanged
//   3 + stdout  Advisory rewrite  -> mutate command
// Anything else (missing binary, timeout, crash) fails open: the original
// command runs unchanged.
import { execFileSync } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";
import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
import type { Config } from "@deepseek-ai/dsh-bash-sandbox";
import type { ShellExecSpec, ShellProcess, ShellRunResult } from "@deepseek-ai/dsh-shell";

const LOGGER_NAME = "bash-rtk";
const REWRITE_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED_RTK_MINOR = 23;

type Logger = ReturnType<Context["logger"]>;

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10), Number.parseInt(m[3]!, 10)];
}

// Trim rewrite stdout; empty output means "nothing to apply".
function normalizeStdout(stdout: string | undefined): string | null {
  const rewritten = stdout?.trim();
  return rewritten ? rewritten : null;
}

// Call `rtk rewrite`; return the rewritten command, or null (pass through).
// Exit 0 and 3 both carry a rewrite on stdout; exit 1 means "no equivalent";
// anything else (missing binary, timeout, crash) fails open.
function rewriteCommand(command: string): string | null {
  try {
    const stdout = execFileSync("rtk", ["rewrite", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REWRITE_TIMEOUT_MS,
    });
    return normalizeStdout(stdout);
  } catch (error) {
    // execFileSync throws on every nonzero exit; only exit 3 still rewrites.
    const status = (error as { status?: number | null }).status;
    if (status !== 3) return null;
    return normalizeStdout((error as { stdout?: string }).stdout);
  }
}

// Probe rtk once at mount: the executor always works; the rewrite only arms
// when rtk is present and new enough (>= 0.23.0 introduced `rtk rewrite`).
function probeRtk(log: Logger): boolean {
  let version: string;
  try {
    version = execFileSync("rtk", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REWRITE_TIMEOUT_MS,
    });
  } catch {
    log.warn("rtk binary not found in PATH — rewrite disabled, commands pass through unchanged");
    return false;
  }
  const parsed = parseSemver(version.replace(/^rtk\s+/, ""));
  if (parsed) {
    const [major, minor] = parsed;
    if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
      log.warn(
        "rtk %s is too old (need >= 0.%d.0) — rewrite disabled, commands pass through unchanged",
        version.trim(),
        MIN_SUPPORTED_RTK_MINOR,
      );
      return false;
    }
  }
  return true;
}

/**
 * Mounts as `ctx.shell` in place of the stock sandbox executor (see
 * cordis.patch.yml). Sandbox confinement, budgets, and result classification
 * are the stock implementation's; the only addition is the pre-execution
 * command rewrite, so both foreground `run` and background `start` paths go
 * through `rewriteSpec` before the parent handles the spec.
 */
export default class RtkBashExecutor extends SandboxBashExecutor {
  private readonly rewriteEnabled: boolean;
  private readonly log: Logger;

  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    this.log = ctx.logger(LOGGER_NAME);
    this.rewriteEnabled = probeRtk(this.log);
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return super.run(this.rewriteSpec(spec));
  }

  override start(spec: ShellExecSpec): ShellProcess {
    return super.start(this.rewriteSpec(spec));
  }

  // Rewrite spec.command through rtk before execution; fail open to the
  // original spec for any condition the rewrite does not cover.
  private rewriteSpec(spec: ShellExecSpec): ShellExecSpec {
    if (!this.rewriteEnabled) return spec;
    const command = spec.command;
    if (typeof command !== "string" || command.trim() === "") return spec;
    if (command.startsWith("rtk ")) return spec;
    if (process.env.RTK_DISABLED === "1") return spec;
    const rewritten = rewriteCommand(command);
    if (rewritten === null || rewritten === command) return spec;
    this.log.info("rtk rewrite: %s -> %s", command, rewritten);
    return { ...spec, command: rewritten };
  }
}
