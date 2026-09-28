import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
// Augments the cordis Context with the userQuestions service declaration.
import type {} from "@deepseek-ai/dsh-user-questions";
import { Sandbox, type ConfirmOptions, type SandboxHostPaths } from "./sandbox";
import { RtkRewriter } from "./rtk";
import { ReadObservations, registerSandboxedTools, type SandboxToolContext } from "./tools";
import type { ConfirmUi } from "./confirm";

export const name = "sandboxed-tools";
// The tools service registers the seven filesystem/process tools +
// ask_permission; the §2.3 confirmation dialogs ride the userQuestions seam.
export const inject = ["tools", "userQuestions", "attachments"];

/** Resolve the plugin's dist directory (build output of src/index.ts + src/runner.ts). */
function distDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function apply(ctx: Context) {
  const logger = ctx.logger("sandboxed-tools");
  const rtk = new RtkRewriter(ctx.logger("bash-rtk"));

  // §7 host resources bound into every sandbox run: the node and runner
  // binaries, the ripgrep and rtk binary directories, rtk config, and spill.
  const hostPaths: SandboxHostPaths = {
    nodePath: process.execPath,
    runnerJsPath: join(distDirectory(), "runner.js"),
    spillDir: mkdtempSync(join(tmpdir(), "dsh-sandboxed-tools-spill-")),
    ...(rtk.binaryPath === undefined
      ? {}
      : { rtkPath: rtk.binaryPath, rtkConfigPath: rtk.configPath }),
  };
  let rgPathValue: string | undefined;
  const toolDeps = (): Parameters<typeof registerSandboxedTools>[1] => ({
    contextOf,
    observations,
    get rgPath() {
      return rgPathValue;
    },
    spillDir: hostPaths.spillDir,
    rtk,
  });
  void import("@vscode/ripgrep")
    .then((ripgrep) => {
      rgPathValue = ripgrep.rgPath;
      hostPaths.rgDir = dirname(ripgrep.rgPath);
    })
    .catch((error) => {
      logger.warn(`ripgrep binary not resolved; glob/grep will fail: ${String(error)}`);
    });

  // One Sandbox per session (§6: reload config + re-expand variables, globs,
  // and the §6.1 existence guarantee at every session start). The fallback
  // sandbox serves agentless calls with the process cwd.
  const observations = new ReadObservations();
  const sandboxes = new Map<string, Sandbox>();
  const agentlessSandbox = new Sandbox(process.cwd(), undefined, hostPaths);

  ctx.on("session/created", (session) => {
    const key = String(session.header.id ?? "");
    if (key === "") return;
    sandboxes.set(key, new Sandbox(session.header.cwd ?? process.cwd(), undefined, hostPaths));
  });
  ctx.on("session/disposed", (session) => {
    const key = String(session.header.id ?? "");
    if (key === "") return;
    sandboxes.delete(key);
    observations.clearSession(key);
  });

  const contextOf = (exec: ToolRunContext): SandboxToolContext => {
    const header = exec.agent?.session.header;
    const sessionKey = String(header?.id ?? "");
    const cwd = header?.cwd ?? process.cwd();
    const sandbox =
      sessionKey === ""
        ? agentlessSandbox
        : (sandboxes.get(sessionKey) ?? new Sandbox(cwd, undefined, hostPaths));
    // §2.3 confirmation channel for this execution: the userQuestions seam,
    // the calling agent (so the Web answerer accepts the question), and the
    // call's cancellation signal.
    const confirm: ConfirmOptions = {
      ui: ctx.userQuestions as unknown as ConfirmUi,
      agent: exec.agent,
      signal: exec.signal,
    };
    return { sandbox, sessionKey, cwd, callId: String(exec.callId), confirm };
  };

  const warnInvalidPatterns = (sandbox: Sandbox, origin: string): void => {
    if (sandbox.invalidCommandPatterns.length === 0) return;
    const patterns = sandbox.invalidCommandPatterns.map((p) => JSON.stringify(p)).join(", ");
    logger.warn(`ignoring invalid command regex patterns (${origin}): ${patterns}`);
  };
  warnInvalidPatterns(agentlessSandbox, "startup");

  // Stock tool rows are disabled in cordis.patch.yml to avoid duplicate names.
  registerSandboxedTools(ctx, toolDeps());
}
