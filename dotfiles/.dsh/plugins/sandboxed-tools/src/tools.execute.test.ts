// Tool-registration-layer tests (SPEC §1–§4, §2.1): the defineTool bodies of
// the seven tools + ask_permission, executed directly through a
// minimal ctx.tools.register sink. A real Sandbox provides the authorization
// gates (§2/§3/§4), while the §7 bwrap execution is replaced by a per-instance
// runTool stub that records each request; §2.1 uses fake llm/attachments
// services. The cordis runtime and the real bwrap environment stay out of
// these unit tests (the §7 process plumbing is covered in sandbox.test.ts).

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { RunnerBashResult, RunnerRequest } from "./runner";
import { Sandbox, type ConfirmOptions, type RunToolOptions } from "./sandbox";
import type { ConfirmUi } from "./confirm";
import {
  COMMAND_APPROVAL_NOTE,
  EROFS_HINT,
  NOT_BEEN_READ,
  ReadObservations,
  registerSandboxedTools,
  writeApprovalNote,
  type SandboxToolContext,
  type SandboxToolDeps,
} from "./tools";

/** One tool definition captured from the ctx.tools.register sink. */
type CapturedTool = {
  name: string;
  description: string;
  timeoutMs?: number;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  // Captured definitions are asserted and invoked, not narrowly consumed.
  execute: (
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ) => Promise<Record<string, unknown>>;
  output: { render: (args: unknown, value: unknown) => { type: string; text?: string }[] };
};

/** A minimal fake cordis context: a tool sink plus injectable ctx.get services. */
function captureRegistry(services: Record<string, unknown> = {}) {
  const tools: CapturedTool[] = [];
  const ctx = {
    tools: { register: (definition: unknown) => tools.push(definition as CapturedTool) },
    get: (name: string) => services[name],
  } as unknown as Context;
  return { ctx, tools };
}

/** The minimal execution identity the tool bodies read: signal + agent. */
const execOf = (agent?: unknown): ToolRunContext =>
  ({ callId: "call-1", signal: new AbortController().signal, agent }) as ToolRunContext;

/** One §2.1-capable agent: routed provider/model via requestHeader and options. */
const imageAgent = (provider = "prov", model = "m1") => ({
  options: { provider, model },
  session: {
    header: { id: "s1", cwd: "/w" },
    requestHeader: () => ({ config: { provider, model } }),
  },
});

/** Canned runner results keyed by tool, so the §7 stub can answer any call. */
function cannedResult(request: RunnerRequest): unknown {
  const params = request.params as Record<string, unknown>;
  switch (request.tool) {
    case "read":
      return {
        path: params.file_path,
        offset: 1,
        lines: [{ number: 1, text: "x" }],
        totalLines: 1,
        mtimeMs: 1000,
      };
    case "write":
      return { path: params.file_path, operation: "create", mtimeMs: 1000 };
    case "edit":
      return { path: params.file_path, replacements: 1, mtimeMs: 1000 };
    case "bash":
      return {
        stdout: { text: "out", truncated: false },
        stderr: { text: "", truncated: false },
        exitCode: 0,
        signal: null,
        timedOut: false,
        timeoutMs: 120000,
      };
    default:
      return {};
  }
}

type RecordedRun = { request: RunnerRequest; options: RunToolOptions };

/**
 * Register the full tool set against a real Sandbox (authorization gates
 * live) with runTool stubbed to record each §7 request. `setup` receives the
 * fixture directory and returns the config plus per-test services.
 */
function withToolLayer(
  setup: (dir: string) => {
    configYaml: string;
    cwd?: string;
    services?: Record<string, unknown>;
    respond?: (request: RunnerRequest) => unknown;
    ui?: ConfirmUi;
  },
  test: (helpers: {
    tools: CapturedTool[];
    tool: (name: string) => CapturedTool;
    runs: RecordedRun[];
    observations: ReadObservations;
    dir: string;
  }) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-tools-"));
    try {
      const { configYaml, cwd = dir, services, respond, ui } = setup(dir);
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, configYaml);
      const sandbox = new Sandbox(cwd, configPath);
      const runs: RecordedRun[] = [];
      const answer = respond ?? cannedResult;
      sandbox.runTool = (async (request: RunnerRequest, runOptions: RunToolOptions) => {
        runs.push({ request, options: runOptions });
        return answer(request);
      }) as Sandbox["runTool"];
      const observations = new ReadObservations();
      const confirm: ConfirmOptions = ui === undefined ? {} : { ui };
      const deps: SandboxToolDeps = {
        contextOf: (): SandboxToolContext => ({
          sandbox,
          sessionKey: "s1",
          cwd,
          callId: "call-1",
          confirm,
        }),
        observations,
      };
      const { ctx, tools } = captureRegistry(services ?? {});
      registerSandboxedTools(ctx, deps);
      await test({
        tools,
        tool: (name) => {
          const found = tools.find((definition) => definition.name === name);
          assert.ok(found !== undefined, `tool ${name} should be registered`);
          return found;
        },
        runs,
        observations,
        dir,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Fake llm + attachments services for §2.1, recording every call. */
function imageServices(options?: { modalities?: string[] }) {
  const llmCalls: { provider: string; model: string }[] = [];
  const saveCalls: { data: Uint8Array; mediaType: string; name?: string }[] = [];
  return {
    llmCalls,
    saveCalls,
    llm: {
      async resolveModelInfo(provider: string, model: string) {
        llmCalls.push({ provider, model });
        return { inputModalities: options?.modalities ?? ["text", "image"] };
      },
    },
    attachments: {
      async saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
        saveCalls.push(input);
        return {
          attachmentId: "att-1",
          mediaType: input.mediaType,
          bytes: 1234,
          width: 640,
          height: 480,
          name: input.name,
        };
      },
    },
  };
}

/** PNG signature bytes; the §2.1 sniff only needs the header. */
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");

// ---------------------------------------------------------------------------
// §2.1 read — text and image through one tool
// ---------------------------------------------------------------------------

describe("§2.1 read（ツール経路）", () => {
  const pngRespond = (path: string) => () => ({
    path,
    dataBase64: PNG_BYTES.toString("base64"),
    mediaType: "image/png",
  });

  it(
    "拡張子なしでシグネチャ非対応のファイルは既存の read 結果を返す",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\n`,
        respond: () => ({
          path: join(dir, "image"),
          offset: 1,
          lines: [{ number: 1, text: "plain text" }],
          totalLines: 1,
          mtimeMs: 1000,
        }),
      }),
      async ({ tool, runs, dir }) => {
        const result = await tool("read").execute({ file_path: join(dir, "image") }, execOf());
        assert.deepEqual(result, {
          path: join(dir, "image"),
          offset: 1,
          lines: [{ number: 1, text: "plain text" }],
          totalLines: 1,
        });
        assert.equal(runs.length, 1);
      },
    ),
  );

  it(
    "未許可パス → §2 のとおり拒否",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\n  - deny: ${join(dir, "secret")}\n`,
        services: imageServices(),
        respond: pngRespond(join(dir, "secret", "k.png")),
      }),
      async ({ tool, runs, dir }) => {
        await assert.rejects(
          tool("read").execute({ file_path: join(dir, "secret", "k.png") }, execOf(imageAgent())),
          /Access denied: /,
        );
        assert.equal(runs.length, 0);
      },
    ),
  );

  it(
    "許可 + 画像入力対応 → 正規化済みの値で画像添付を返す",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\n`,
        services: imageServices(),
        respond: pngRespond(join(dir, "img.png")),
      }),
      async ({ tool, runs, dir }) => {
        const result = await tool("read").execute({ file_path: "img.png" }, execOf(imageAgent()));
        // The attachment reference (post-normalization values from the store)
        // is what the tool returns — §2.1 downscale/normalize lives in the
        // attachment service, and the image rides the session's attachments.
        assert.deepEqual(result, {
          path: join(dir, "img.png"),
          image: {
            attachmentId: "att-1",
            mediaType: "image/png",
            bytes: 1234,
            width: 640,
            height: 480,
            name: "img.png",
          },
        });
        assert.equal(JSON.stringify(result).includes(PNG_BYTES.toString("base64")), false);
        // §2.1 render: text envelope plus the image content block.
        const rendered = tool("read").output.render({}, result);
        assert.equal(rendered[0]!.type, "text");
        assert.equal(rendered[1]!.type, "image");
        assert.equal(runs.length, 1);
      },
    ),
  );

  it(
    "画像入力非対応経路 → Vision 入力を作らず vision 委譲エラー",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\n`,
        services: imageServices({ modalities: ["text"] }),
        respond: pngRespond(join(dir, "img.png")),
      }),
      async ({ tool, runs, dir }) => {
        await assert.rejects(
          tool("read").execute({ file_path: join(dir, "img.png") }, execOf(imageAgent())),
          (error: Error) =>
            error.message.includes("does not accept image input") &&
            error.message.includes("subagent") &&
            error.message.includes("vision") &&
            error.message.includes("(prov/m1)"),
        );
        // The runner inspects the signature before the host creates an image input.
        assert.equal(runs.length, 1);
      },
    ),
  );

  it(
    "provider/model が解決できない経路でも委譲エラー",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\n`,
        services: imageServices(),
        respond: pngRespond(join(dir, "img.png")),
      }),
      async ({ tool, runs, dir }) => {
        await assert.rejects(
          tool("read").execute({ file_path: join(dir, "img.png") }, execOf()),
          /does not accept image input/,
        );
        assert.equal(runs.length, 1);
      },
    ),
  );

  it(
    "対応外拡張子でも対応形式のシグネチャがあれば画像として返す",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\n`,
        services: imageServices(),
        respond: pngRespond(join(dir, "img.bmp")),
      }),
      async ({ tool, runs, dir }) => {
        const result = await tool("read").execute(
          { file_path: join(dir, "img.bmp") },
          execOf(imageAgent()),
        );
        assert.equal((result.image as { mediaType: string }).mediaType, "image/png");
        assert.equal(runs.length, 1);
      },
    ),
  );

  it(
    "シグネチャを優先し、拡張子は補助に使う（.png で内容が GIF なら image/gif）",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\n`,
        services: imageServices(),
        respond: () => ({
          path: join(dir, "mislabeled.png"),
          dataBase64: GIF_BYTES.toString("base64"),
          mediaType: "image/gif",
        }),
      }),
      async ({ tool, dir }) => {
        const result = await tool("read").execute(
          { file_path: join(dir, "mislabeled.png") },
          execOf(imageAgent()),
        );
        assert.equal((result.image as { mediaType: string }).mediaType, "image/gif");
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// §3 ask_permission — exclusivity, schema shape, and the tool outcomes
// ---------------------------------------------------------------------------

/** A scripted userQuestions seam (same shape as sandbox.test.ts). */
function scriptedUi(rounds: { label?: string; custom?: string; error?: Error }[]): {
  ui: ConfirmUi;
  questions: { question: string; detail?: string; options?: string[] }[];
} {
  const questions: { question: string; detail?: string; options?: string[] }[] = [];
  const ui: ConfirmUi = {
    async ask(request) {
      const question = request.questions[0]!;
      questions.push({
        question: question.question,
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        ...(question.options === undefined
          ? {}
          : { options: question.options.map((option) => option.label) }),
      });
      const round = rounds.shift() ?? {};
      if (round.error !== undefined) throw round.error;
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

describe("§3 ask_permission（ツール経路）", () => {
  it(
    "path と command の両方・どちらも無しは、期待する引数形式を伝えるエラー",
    withToolLayer(
      () => ({ configYaml: "\nwrite:\n  - ask: /w\n" }),
      async ({ tool }) => {
        await assert.rejects(
          tool("ask_permission").execute(
            { path: "/w/dir", command: "git push", reason: "why" },
            execOf(),
          ),
          /exactly one of "path" or "command"/,
        );
        await assert.rejects(
          tool("ask_permission").execute({ reason: "why" }, execOf()),
          /exactly one of "path" or "command"/,
        );
      },
    ),
  );

  it(
    "スキーマは単一オブジェクトで reason のみ必須（anyOf/union を使わない）",
    withToolLayer(
      () => ({ configYaml: "" }),
      ({ tool }) => {
        const parameters = tool("ask_permission").parameters;
        assert.deepEqual(Object.keys(parameters.properties).sort(), ["command", "path", "reason"]);
        assert.deepEqual(parameters.required, ["reason"]);
        const serialized = JSON.stringify(parameters);
        assert.equal(serialized.includes("anyOf"), false);
        assert.equal(serialized.includes("oneOf"), false);
      },
    ),
  );

  it(
    "path の承認は granted と承認ノートと同じ効果を伝えるテキストを返す",
    withToolLayer(
      (dir) => ({
        configYaml: `\nwrite:\n  - ask: ${join(dir, "w")}\n`,
        ui: scriptedUi([{ label: "Yes, allow" }]).ui,
      }),
      async ({ tool, dir }) => {
        const result = await tool("ask_permission").execute(
          { path: join(dir, "w"), reason: "to edit files" },
          execOf(),
        );
        assert.equal(result.status, "granted");
        assert.equal(
          result.text,
          writeApprovalNote({
            operation: "write",
            scope: "directory",
            grantedPath: join(dir, "w"),
          }),
        );
      },
    ),
  );

  it(
    "command の承認は1回限り: 同じ bash 再送が確認なしで走り、承認を消費する",
    withToolLayer(
      () => ({
        configYaml: "commands:\n  - { ask_with_reason: '^sudo\\b' }\n",
        ui: scriptedUi([{ label: "Yes, allow" }]).ui,
      }),
      async ({ tool, runs }) => {
        const granted = await tool("ask_permission").execute(
          { command: "sudo id", reason: "inspect" },
          execOf(),
        );
        assert.equal(granted.status, "granted");
        assert.ok(String(granted.text).includes("re-send the same bash call"));
        // The one-shot approval lets the same command run without a dialog.
        const bashResult = (await tool("bash").execute(
          { command: "sudo id", description: "inspect user identity" },
          execOf(),
        )) as { note?: string };
        assert.equal(runs.length, 1);
        assert.equal(runs[0]!.request.tool, "bash");
        assert.equal(bashResult.note, COMMAND_APPROVAL_NOTE);
        // Consumed: the next identical call is gated again (§4).
        await assert.rejects(
          tool("bash").execute(
            { command: "sudo id", description: "inspect user identity" },
            execOf(),
          ),
          /Command requires a reason: sudo id/,
        );
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// §2.3 approval notes on write/edit/bash results
// ---------------------------------------------------------------------------

describe("§2.3 承認ノート（write/edit/bash の render）", () => {
  it(
    "write の承認ノートは最終結果の最終行に1行追記される",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\nwrite:\n  - ask: ${join(dir, "w")}\n`,
        ui: scriptedUi([{ label: "File only" }]).ui,
      }),
      async ({ tool, dir }) => {
        const target = join(dir, "w", "a.txt");
        const result = await tool("write").execute(
          { file_path: target, content: "hello" },
          execOf(),
        );
        assert.equal(
          result.note,
          writeApprovalNote({ operation: "write", scope: "file", grantedPath: target }),
        );
        const text = tool("write").output.render(
          { file_path: target, content: "hello" },
          result,
        )[0]!.text!;
        assert.ok(text.includes("Created file"));
        assert.ok(text.endsWith(`\n${result.note}`));
      },
    ),
  );

  it(
    "確認を要しない write（allow）にはノートを付けない",
    withToolLayer(
      (dir) => ({ configYaml: `\nread:\n  - allow: ${dir}\nwrite:\n  - allow: ${dir}\n` }),
      async ({ tool, dir }) => {
        const result = await tool("write").execute(
          { file_path: join(dir, "a.txt"), content: "hello" },
          execOf(),
        );
        assert.equal("note" in result, false);
      },
    ),
  );

  it(
    "edit の承認ノートも最終行に追記される",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\nwrite:\n  - ask: ${join(dir, "w")}\n`,
        ui: scriptedUi([{ label: "Directory (subtree)" }]).ui,
      }),
      async ({ tool, observations, dir }) => {
        const target = join(dir, "w", "a.txt");
        observations.markRead("s1", target, 1000);
        const result = await tool("edit").execute(
          { file_path: target, old_string: "x", new_string: "y" },
          execOf(),
        );
        assert.equal(
          result.note,
          writeApprovalNote({
            operation: "write",
            scope: "directory",
            grantedPath: join(dir, "w"),
          }),
        );
        const text = tool("edit").output.render(
          { file_path: target, old_string: "x", new_string: "y" },
          result,
        )[0]!.text!;
        assert.ok(text.endsWith(`\n${result.note}`));
      },
    ),
  );

  it(
    "read の許可承認にはノートを付けない",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - ask: ${dir}\n`,
        ui: scriptedUi([{ label: "Yes, allow" }]).ui,
      }),
      async ({ tool, dir }) => {
        const result = await tool("read").execute({ file_path: join(dir, "a.txt") }, execOf());
        assert.equal("note" in result, false);
      },
    ),
  );

  it(
    "bash は EROFS ヒントの後に承認ノートを追記し、ノートが最終行になる",
    withToolLayer(
      () => ({
        configYaml: "commands:\n  - { ask: '^deploy\\b' }\n",
        ui: scriptedUi([{ label: "Yes, allow" }]).ui,
        respond: () =>
          ({
            stdout: { text: "deploy: touching files", truncated: false },
            stderr: { text: "touch: cannot touch 'x': Read-only file system", truncated: false },
            exitCode: 1,
            signal: null,
            timedOut: false,
            timeoutMs: 120000,
          }) satisfies RunnerBashResult,
      }),
      async ({ tool }) => {
        const result = (await tool("bash").execute(
          { command: "deploy --prod", description: "deploy to production" },
          execOf(),
        )) as { note?: string };
        assert.equal(result.note, `${EROFS_HINT}\n${COMMAND_APPROVAL_NOTE}`);
        const text = tool("bash").output.render(
          { command: "deploy --prod", description: "deploy to production" },
          result,
        )[0]!.text!;
        assert.equal(text.split("\n").at(-1), COMMAND_APPROVAL_NOTE);
        assert.ok(text.includes(EROFS_HINT));
        assert.ok(text.indexOf(EROFS_HINT) < text.indexOf(COMMAND_APPROVAL_NOTE));
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// §1・§3・§4 argument resolution and validation at the tool layer
// ---------------------------------------------------------------------------

describe("§1・§3・§4 引数パス・workdir・バリデーション", () => {
  it(
    "相対パスはセッション cwd 基準で絶対パスへ解決して実行する（read・~ 展開）",
    withToolLayer(
      (dir) => ({ configYaml: `\nread:\n  - allow: ${dir}\n  - allow: "~"\n` }),
      async ({ tool, runs, dir }) => {
        await tool("read").execute({ file_path: "sub/a.txt" }, execOf());
        assert.equal(runs[0]!.request.params.file_path, join(dir, "sub", "a.txt"));
        await tool("read").execute({ file_path: "~/docs/n.txt" }, execOf());
        assert.equal(runs[1]!.request.params.file_path, join(homedir(), "docs", "n.txt"));
      },
    ),
  );

  it(
    "bash の workdir 未指定はセッション cwd、相対指定は cwd 基準、timeoutMs は上限クランプ",
    withToolLayer(
      () => ({ configYaml: "commands:\n  - { allow: '.*' }\n" }),
      async ({ tool, runs, dir }) => {
        await tool("bash").execute(
          { command: "pwd", description: "print working directory" },
          execOf(),
        );
        assert.equal(runs[0]!.request.params.workdir, dir);
        await tool("bash").execute(
          { command: "pwd", description: "print working directory", workdir: "sub" },
          execOf(),
        );
        assert.equal(runs[1]!.request.params.workdir, join(dir, "sub"));
        await tool("bash").execute(
          { command: "sleep 0", description: "sleep briefly", timeoutMs: 999999 },
          execOf(),
        );
        assert.equal(runs[2]!.request.params.timeoutMs, 600000);
      },
    ),
  );

  it(
    "bash は空 command・空 description・不正 timeoutMs を引数検証で拒否する",
    withToolLayer(
      () => ({ configYaml: "commands:\n  - { allow: '.*' }\n" }),
      async ({ tool }) => {
        await assert.rejects(
          tool("bash").execute({ command: "  ", description: "d" }, execOf()),
          /invalid command/,
        );
        await assert.rejects(
          tool("bash").execute({ command: "ls", description: " " }, execOf()),
          /invalid description/,
        );
        await assert.rejects(
          tool("bash").execute({ command: "ls", description: "d", timeoutMs: 0 }, execOf()),
          /invalid timeoutMs/,
        );
      },
    ),
  );

  it(
    "ls の path 未指定はセッション cwd を渡す",
    withToolLayer(
      (dir) => ({ configYaml: `\nread:\n  - allow: ${dir}\n` }),
      async ({ tool, runs, dir }) => {
        await tool("ls").execute({}, execOf());
        assert.equal(runs[0]!.request.params.path, dir);
      },
    ),
  );

  it(
    "glob/grep には 30 秒の検索タイムアウト（+5 秒の安全域）を適用する",
    withToolLayer(
      (dir) => ({ configYaml: `\nread:\n  - allow: ${dir}\n` }),
      ({ tool, runs }) => {
        assert.equal(tool("glob").timeoutMs, 30000);
        assert.equal(tool("grep").timeoutMs, 30000);
        return (async () => {
          await tool("glob").execute({ pattern: "**/*.ts" }, execOf());
          assert.equal(runs[0]!.options.timeoutMs, 35000);
          await tool("grep").execute({ pattern: "needle" }, execOf());
          assert.equal(runs[1]!.options.timeoutMs, 35000);
        })();
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// §1 description requirements (spec-mandated wording)
// ---------------------------------------------------------------------------

describe("§1 説明文の明記要件", () => {
  it(
    "read・ask_permission・bash・write/edit の説明文に必要な案内を含む",
    withToolLayer(
      () => ({ configYaml: "" }),
      ({ tools, tool }) => {
        // §1: read_image is not registered; read owns both text and image paths.
        assert.equal(
          tools.some((definition) => definition.name === "read_image"),
          false,
        );
        // §2.1: read notes Vision input and vision delegation.
        assert.match(tool("read").description, /Image files.*image input/);
        assert.ok(tool("read").description.includes("vision"));
        const readSchema = (tool("read").output as unknown as { schema: { oneOf?: unknown[] } })
          .schema;
        assert.equal(readSchema.oneOf?.length, 2);
        // §3: ask_permission covers worktree/parent write requests and the
        // reason-gated command re-request.
        const askPermission = tool("ask_permission").description;
        for (const phrase of ["worktree", "parent directory", "Command requires a reason"])
          assert.ok(askPermission.includes(phrase), `ask_permission: ${phrase}`);
        // §4: bash routes EROFS and the reason gate to ask_permission.
        const bash = tool("bash").description;
        for (const phrase of [
          "Read-only file system",
          "ask_permission",
          "Command requires a reason",
        ])
          assert.ok(bash.includes(phrase), `bash: ${phrase}`);
        // §7: write/edit explain the approval → session-writable flow.
        for (const name of ["write", "edit"]) {
          const description = tool(name).description;
          assert.ok(description.includes("prompts the user for permission"), name);
          assert.ok(description.includes("including from bash"), name);
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// §2.4 read-before-write at the tool layer
// ---------------------------------------------------------------------------

describe("§2.4 未読みゲート（ツール経路）", () => {
  it(
    "未読みパスの編集は§2.4 の文言で拒否し、read 後は観測 mtime を付けて通す",
    withToolLayer(
      (dir) => ({ configYaml: `\nread:\n  - allow: ${dir}\nwrite:\n  - allow: ${dir}\n` }),
      async ({ tool, runs, dir }) => {
        const target = join(dir, "a.txt");
        await assert.rejects(
          tool("edit").execute({ file_path: target, old_string: "x", new_string: "y" }, execOf()),
          (error: Error) => error.message === NOT_BEEN_READ(target),
        );
        assert.equal(runs.length, 0);
        await tool("read").execute({ file_path: target }, execOf());
        await tool("edit").execute(
          { file_path: target, old_string: "x", new_string: "y" },
          execOf(),
        );
        assert.equal(runs[1]!.request.options?.observedMtimeMs, 1000);
      },
    ),
  );

  it(
    "画像 read は観測せず、直後の edit は未読みで拒否する",
    withToolLayer(
      (dir) => ({
        configYaml: `\nread:\n  - allow: ${dir}\nwrite:\n  - allow: ${dir}\n`,
        services: imageServices(),
        respond: () => ({
          path: join(dir, "img.png"),
          dataBase64: PNG_BYTES.toString("base64"),
          mediaType: "image/png",
        }),
      }),
      async ({ tool, runs, dir }) => {
        await tool("read").execute({ file_path: join(dir, "img.png") }, execOf(imageAgent()));
        await assert.rejects(
          tool("edit").execute(
            { file_path: join(dir, "img.png"), old_string: "x", new_string: "y" },
            execOf(imageAgent()),
          ),
          (error: Error) => error.message === NOT_BEEN_READ(join(dir, "img.png")),
        );
        assert.equal(runs.length, 1);
      },
    ),
  );
});
