// Plugin-entry lifecycle tests (SPEC §3・§6・§2.4): apply() wiring verified
// against a minimal fake cordis context — one Sandbox per session with the §6
// reload at every session start, the §3 dynamic-grant and §2.4 observation
// cleanup on session disposal, and the §6 invalid-regex host-log warning.
// The bwrap execution behind runTool is stubbed at the prototype (restored in
// each test's finally); the sandbox spawn itself is covered by the fake-bwrap
// tests in sandbox.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Sandbox } from "./sandbox";
import type { ConfirmUi } from "./confirm";
import { apply } from "./index";

/** One tool definition captured from the ctx.tools.register sink. */
type CapturedTool = {
  name: string;
  // Captured definitions are asserted and invoked, not narrowly consumed.
  execute: (
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ) => Promise<Record<string, unknown>>;
};

/** The minimal execution identity contextOf reads: the session header. */
const execOf = (sessionId: string, cwd: string): ToolRunContext =>
  ({
    callId: "call-1",
    signal: new AbortController().signal,
    agent: { session: { header: { id: sessionId, cwd } } },
  }) as ToolRunContext;

/** A scripted userQuestions seam standing in for ctx.userQuestions; records questions. */
function scriptedUi(rounds: { label?: string; custom?: string }[]): {
  ui: ConfirmUi;
  questions: string[];
} {
  const questions: string[] = [];
  const ui: ConfirmUi = {
    async ask(request) {
      const question = request.questions[0]!;
      questions.push(question.question);
      const round = rounds.shift() ?? {};
      return {
        answers: [
          {
            id: question.id,
            selected: round.label === undefined ? [] : [round.label],
            ...(round.custom === undefined ? {} : { custom: round.custom }),
          },
        ],
      };
    },
  };
  return { ui, questions };
}

/**
 * Run apply() against a fake context with $DSH_HOME pointed at a temp home
 * (so sandbox.yaml is test-owned and rewritable), runTool stubbed at the
 * prototype, and the session/created・session/disposed handlers exposed.
 */
function withPluginEnvironment(
  options: {
    configYaml: (workDir: string) => string;
    ui?: ConfirmUi;
  },
  test: (helpers: {
    tool: (name: string) => CapturedTool;
    createSession: (id: string, cwd: string) => void;
    disposeSession: (id: string) => void;
    writeConfig: (yaml: string) => void;
    warnings: string[];
    workDir: string;
  }) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "sandboxed-tools-dsh-home-"));
    const workDir = mkdtempSync(join(tmpdir(), "sandboxed-tools-work-"));
    const configPath = join(homeDir, "config", "sandbox.yaml");
    const writeConfig = (yaml: string) => writeFileSync(configPath, yaml);
    const previousDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = homeDir;
    const originalRunTool = Sandbox.prototype.runTool;
    Sandbox.prototype.runTool = async function (
      this: Sandbox,
      request: { tool: string; params: Record<string, unknown> },
    ) {
      // Canned §7 answers: enough shape for the tool bodies to finish.
      switch (request.tool) {
        case "read":
          return {
            path: request.params.file_path,
            offset: 1,
            lines: [],
            totalLines: 0,
            mtimeMs: 1000,
          };
        case "write":
          return { path: request.params.file_path, operation: "create", mtimeMs: 1000 };
        case "edit":
          return { path: request.params.file_path, replacements: 1, mtimeMs: 1000 };
        default:
          return {};
      }
    } as unknown as Sandbox["runTool"];
    try {
      mkdirSync(join(homeDir, "config"), { recursive: true });
      writeConfig(options.configYaml(workDir));
      const tools: CapturedTool[] = [];
      const warnings: string[] = [];
      const handlers: Record<string, (session: { header: { id?: string; cwd?: string } }) => void> =
        {};
      const ctx = {
        logger: () => ({ warn: (message: string) => warnings.push(message) }),
        on: (
          event: string,
          handler: (session: { header: { id?: string; cwd?: string } }) => void,
        ) => {
          handlers[event] = handler;
        },
        tools: { register: (definition: unknown) => tools.push(definition as CapturedTool) },
        inject: (_names: string[], mount: (ctx: Context) => void) => mount(ctx as Context),
        provide: () => () => {},
        userQuestions: options.ui,
        get: () => undefined,
      } as unknown as Context;
      apply(ctx);
      await test({
        tool: (name) => {
          const found = tools.find((definition) => definition.name === name);
          assert.ok(found !== undefined, `tool ${name} should be registered`);
          return found;
        },
        createSession: (id, cwd) => handlers["session/created"]!({ header: { id, cwd } }),
        disposeSession: (id) => handlers["session/disposed"]!({ header: { id } }),
        writeConfig,
        warnings,
        workDir,
      });
    } finally {
      Sandbox.prototype.runTool = originalRunTool;
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  };
}

describe("§6 セッション開始時の再読み込み（index.ts）", () => {
  it(
    "各セッションの開始時に sandbox.yaml を読み込み直し、既存セッションは読み込み時の設定を保つ",
    withPluginEnvironment(
      {
        configYaml: (workDir) => {
          mkdirSync(join(workDir, "dirA"));
          return `\nread:\n  - allow: ${join(workDir, "dirA")}\n`;
        },
      },
      async ({ tool, createSession, writeConfig, workDir }) => {
        const dirA = join(workDir, "dirA");
        // Session s1 starts under config v1: the read passes the gate.
        createSession("s1", dirA);
        await tool("read").execute({ file_path: join(dirA, "a.txt") }, execOf("s1", dirA));
        // §6: every session start reloads — s2 sees the rewritten config.
        writeConfig(`\nread:\n  - deny: ${dirA}\n`);
        createSession("s2", dirA);
        await assert.rejects(
          tool("read").execute({ file_path: join(dirA, "a.txt") }, execOf("s2", dirA)),
          /Access denied: /,
        );
        // …while s1 keeps the config as loaded at its own session start.
        await tool("read").execute({ file_path: join(dirA, "a.txt") }, execOf("s1", dirA));
      },
    ),
  );
});

describe("§3 動的許可のセッション破棄（index.ts）", () => {
  it("セッション終了で動的許可を破棄し、再開セッションでは再確認する", async () => {
    const { ui, questions } = scriptedUi([{ label: "Yes, allow" }, { label: "File only" }]);
    await withPluginEnvironment(
      {
        configYaml: (workDir) => `\nwrite:\n  - ask: ${join(workDir, "dirW")}\n`,
        ui,
      },
      async ({ tool, createSession, disposeSession, workDir }) => {
        const dirW = join(workDir, "dirW");
        createSession("s1", workDir);
        const granted = await tool("ask_permission").execute(
          { path: dirW, reason: "to edit files" },
          execOf("s1", workDir),
        );
        assert.equal(granted.status, "granted");
        // The grant covers writes for the rest of the session…
        await tool("write").execute(
          { file_path: join(dirW, "a.txt"), content: "x" },
          execOf("s1", workDir),
        );
        assert.equal(questions.length, 1);
        // …and §3 discards it when the session ends: the recreated session
        // re-confirms the write (dialog 2).
        disposeSession("s1");
        createSession("s1", workDir);
        await tool("write").execute(
          { file_path: join(dirW, "a.txt"), content: "x" },
          execOf("s1", workDir),
        );
        assert.equal(questions.length, 2);
      },
    )();
  });
});

describe("§2.4 観測のセッション破棄（index.ts）", () => {
  it(
    "セッション終了で read 観測を破棄し、再開セッションでは未読みゲートに掛かる",
    withPluginEnvironment(
      {
        configYaml: (workDir) => {
          mkdirSync(join(workDir, "dirA"));
          return `\nread:\n  - allow: ${join(workDir, "dirA")}\nwrite:\n  - allow: ${join(workDir, "dirA")}\n`;
        },
      },
      async ({ tool, createSession, disposeSession, workDir }) => {
        const dirA = join(workDir, "dirA");
        const target = join(dirA, "a.txt");
        createSession("s1", dirA);
        await tool("read").execute({ file_path: target }, execOf("s1", dirA));
        await tool("edit").execute(
          { file_path: target, old_string: "x", new_string: "y" },
          execOf("s1", dirA),
        );
        // Disposal clears the §2.4 observation along with the sandbox.
        disposeSession("s1");
        createSession("s1", dirA);
        await assert.rejects(
          tool("edit").execute(
            { file_path: target, old_string: "x", new_string: "y" },
            execOf("s1", dirA),
          ),
          /file has not been read/,
        );
      },
    ),
  );
});

describe("§6 無効 regex の警告（index.ts）", () => {
  it(
    "起動時に無効だったコマンドパターンを dsh ログへ警告する",
    withPluginEnvironment(
      {
        configYaml: () => 'commands:\n  - { allow: ".*" }\n  - { ask: [\'^\', "[unclosed"] }\n',
      },
      async ({ warnings }) => {
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /ignoring invalid command regex patterns/);
        assert.match(warnings[0]!, /\[unclosed/);
      },
    ),
  );
});
