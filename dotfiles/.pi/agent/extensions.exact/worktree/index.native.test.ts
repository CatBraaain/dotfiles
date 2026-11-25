import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "bun:test";
import {
  createBashTool,
  createPowerShellTool,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import sessionMetadataExtension from "./index.ts";
import { getWorkspaces } from "./metadata.ts";

const TEST_TIMEOUT_MS = 30_000;
const piMuxCli = fileURLToPath(
  new URL("../../../../.local/cli.exact/pi-mux/src/main.ts", import.meta.url),
);
type Shell = "bash" | "powershell";
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

describe.skipIf(process.platform !== "win32")("Windows shell worktree tracking", () => {
  let directory: string;
  let gitEnvironment: NodeJS.ProcessEnv;
  const previousPath = process.env.PATH;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-worktree-native-"));
    const gitBin = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd");
    process.env.PATH = [directory, gitBin, previousPath].filter(Boolean).join(";");
    gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync(
      process.execPath,
      ["build", "--compile", piMuxCli, "--outfile", join(directory, "pi-mux.exe")],
      {
        cwd: directory,
        stdio: "pipe",
        timeout: TEST_TIMEOUT_MS,
      },
    );
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  function fixture() {
    const base = mkdtempSync(join(directory, "case-"));
    const main = join(base, "main 作業先");
    mkdirSync(main);
    git("init", "-q");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );

    const manager = SessionManager.inMemory(base);
    const ctx = { cwd: base, sessionManager: manager } as unknown as ExtensionContext;
    const handlers = new Map<string, Handler>();
    const notices: string[] = [];
    let nextId = 0;
    const tools = {
      bash: createBashTool(base, { spawnHook }),
      powershell: createPowerShellTool(base, { spawnHook }),
    };
    const pi = {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerMessageRenderer() {},
      appendEntry(customType: string, entry: unknown) {
        manager.appendCustomEntry(customType, entry);
      },
      sendMessage(message: { content: string }) {
        notices.push(message.content);
      },
      async exec(executable: string, args: string[], options: { cwd: string }) {
        assert.equal(executable, join(directory, "pi-mux.exe"));
        const result = spawnSync(executable, args, {
          cwd: options.cwd,
          env: gitEnvironment,
          encoding: "utf8",
          timeout: TEST_TIMEOUT_MS,
        });
        if (result.error) throw result.error;
        return {
          code: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
          killed: result.signal !== null,
        };
      },
    } as unknown as ExtensionAPI;
    sessionMetadataExtension(pi);

    function git(...args: string[]) {
      execFileSync("git.exe", ["-C", main, ...args], { env: gitEnvironment, stdio: "pipe" });
    }

    function spawnHook<T extends { env: NodeJS.ProcessEnv }>(context: T): T {
      return { ...context, env: { ...context.env, ...gitEnvironment } };
    }

    async function run(shell: Shell, command: string, afterObservation?: () => void) {
      const toolCallId = String(++nextId);
      const event = { toolName: shell, toolCallId, input: { command, timeout: 15 } };
      await handlers.get("tool_call")!(event, ctx);
      afterObservation?.();
      const result = await tools[shell].execute(toolCallId, event.input);
      const resultEvent = { ...event, ...result, isError: result.isError === true };
      const original = structuredClone(resultEvent);
      const override = await handlers.get("tool_result")!(resultEvent, ctx);
      await handlers.get("tool_execution_end")!(
        { toolName: shell, toolCallId, durationMs: 1 },
        ctx,
      );
      assert.equal(override, undefined);
      assert.deepEqual(resultEvent, original);
      assert.deepEqual(
        notices.filter((notice) => notice.includes("update failed")),
        [],
      );
      const outcome = result.structuredContent;
      assert.ok(outcome && typeof outcome === "object" && "exit_code" in outcome);
      assert.equal(typeof outcome.exit_code, "number");
      return outcome.exit_code;
    }

    function command(shell: Shell, executable: string, ...args: string[]) {
      const argumentsWithRepo = ["-C", main, "worktree", ...args];
      if (shell === "bash")
        return quote([executable, ...argumentsWithRepo.map((word) => word.replaceAll("\\", "/"))]);
      return `${executable} ${argumentsWithRepo.map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`;
    }

    return { base, command, git, manager, notices, run };
  }

  for (const shell of ["bash", "powershell"] as const) {
    for (const executable of ["git", "git.exe"]) {
      it(
        `records only the worktree added by ${executable} in ${shell}`,
        async () => {
          const { base, command, git, manager, run } = fixture();
          const target = join(base, "新 worktree");
          const unrelated = join(base, "unrelated worktree");
          const add = command(shell, executable, "add", "--detach", target, "HEAD");
          assert.equal(
            await run(shell, add, () => git("worktree", "add", "--detach", unrelated, "HEAD")),
            0,
          );
          assert.deepEqual(getWorkspaces(manager), [realpathSync.native(target)]);
        },
        TEST_TIMEOUT_MS,
      );
    }

    it(
      `follows moves and removals in ${shell} without recording failed operations`,
      async () => {
        const { base, command, manager, notices, run } = fixture();
        const executable = shell === "bash" ? "git.exe" : "& 'git.exe'";
        const original = join(base, "元 worktree");
        const moved = join(base, "移動 worktree");
        const missing = join(base, "missing worktree");
        const add = command(shell, executable, "add", "--detach", original, "HEAD");
        assert.equal(await run(shell, add), 0);
        const originalPath = realpathSync.native(original);
        assert.deepEqual(getWorkspaces(manager), [originalPath]);
        const entryCount = manager.getEntries().length;
        const noticeCount = notices.length;
        for (const args of [
          ["add", "--detach", missing, "nonexistent-ref"],
          ["move", missing, moved],
          ["remove", missing],
        ]) {
          assert.notEqual(await run(shell, command(shell, executable, ...args)), 0);
          assert.deepEqual(getWorkspaces(manager), [originalPath]);
          assert.equal(manager.getEntries().length, entryCount);
          assert.equal(notices.length, noticeCount);
        }
        assert.equal(await run(shell, command(shell, executable, "move", original, moved)), 0);
        assert.deepEqual(getWorkspaces(manager), [realpathSync.native(moved)]);
        assert.equal(await run(shell, command(shell, executable, "remove", moved)), 0);
        assert.deepEqual(getWorkspaces(manager), []);
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "records a PowerShell worktree that survives a later command failure",
    async () => {
      const { base, command, manager, run } = fixture();
      const target = join(base, "残った # worktree");
      const add = command("powershell", "git.exe", "add", "--detach", target, "HEAD");
      assert.notEqual(await run("powershell", `${add} # Keep the successful add\nexit 7`), 0);
      assert.deepEqual(getWorkspaces(manager), [realpathSync.native(target)]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not claim another worktree at the destination of a failed PowerShell move",
    async () => {
      const { base, command, git, manager, run } = fixture();
      const target = join(base, "own worktree");
      const unrelated = join(base, "unrelated worktree");
      const missing = join(base, "missing worktree");
      const add = command("powershell", "git.exe", "add", "--detach", target, "HEAD");
      const move = command("powershell", "git.exe", "move", missing, unrelated);
      const exitCode = await run("powershell", `${add}; ${move}; exit $LASTEXITCODE`, () =>
        git("worktree", "add", "--detach", unrelated, "HEAD"),
      );
      assert.notEqual(exitCode, 0);
      assert.deepEqual(getWorkspaces(manager), [realpathSync.native(target)]);
    },
    TEST_TIMEOUT_MS,
  );
});
