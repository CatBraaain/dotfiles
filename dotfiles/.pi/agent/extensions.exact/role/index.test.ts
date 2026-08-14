import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import roleExtension, {
  __abortTimer,
  __spawn,
  type RoleConfig,
  buildRoleSystemPromptAddendum,
  canDelegate,
  childRole,
  initialRole,
  parseRoleConfig,
  formatToolCall,
  shouldBlockToolCall,
  switchRole,
} from "./index";

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
  const previousGroup = group;
  group = name;
  fn();
  group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

const config: RoleConfig = {
  default: "manager",
  roles: {
    manager: {
      model: "zai/glm-5.2",
      tools: ["*"],
      subagents: ["worker"],
      systemPrompt: ["ファイル操作は禁止"],
    },
    worker: { model: "commandcode/gpt-5.6-luna", tools: ["*"], subagents: [], systemPrompt: [] },
    chat: {
      model: "commandcode/gpt-5.6-luna",
      tools: ["web_search", "web_fetch"],
      subagents: [],
      systemPrompt: [],
    },
  },
};

type CapturedTool = {
  execute: (...args: any[]) => Promise<any>;
  renderResult?: (...args: any[]) => unknown;
};
type Handler = (event: any, ctx: any) => Promise<any>;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killHistory: string[] = [];
  ignoreTerm = false;

  kill(signal = "SIGTERM"): boolean {
    this.killHistory.push(signal);
    if (signal === "SIGKILL" || !this.ignoreTerm) {
      this.killed = true;
      setImmediate(() => this.emit("close", 1));
    }
    return true;
  }
}

function captureRoleExtension(
  injectedConfig: { config?: RoleConfig; error?: string } = { config },
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const notifications: string[] = [];
  const activeTools: string[][] = [];
  const selectedModels: unknown[] = [];
  const sentMessages: string[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const children: FakeChild[] = [];
  let spawnResponder: (child: FakeChild) => void = () => {};
  let roleWidget: any;
  let registeredTool: CapturedTool | undefined;

  const originalSpawn = __spawn.current;
  __spawn.current = ((command: string, args: string[], options: { cwd?: string }) => {
    const child = new FakeChild();
    spawnCalls.push({ command, args, cwd: options.cwd });
    children.push(child);
    setImmediate(() => spawnResponder(child));
    return child;
  }) as unknown as typeof __spawn.current;

  roleExtension(
    {
      on(event: string, handler: Handler) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
      registerCommand(name: string, definition: { handler: Handler }) {
        commands.set(name, definition.handler);
      },
      registerFlag() {},
      registerTool(tool: CapturedTool) {
        registeredTool = tool;
      },
      getFlag() {},
      getAllTools() {
        return [{ name: "read" }, { name: "bash" }, { name: "subagent" }];
      },
      setActiveTools(tools: string[]) {
        activeTools.push(tools);
      },
      async setModel(model: unknown) {
        selectedModels.push(model);
        return true;
      },
      sendUserMessage(content: string) {
        sentMessages.push(content);
      },
    } as never,
    injectedConfig,
  );

  const ui = {
    setWidget(_key: string, widget: unknown) {
      roleWidget = widget;
    },
    notify(message: string) {
      notifications.push(message);
    },
  };
  const context = {
    cwd: "/parent",
    ui,
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
  };

  return {
    children,
    commands,
    context,
    notifications,
    activeTools,
    selectedModels,
    sentMessages,
    spawnCalls,
    restore() {
      __spawn.current = originalSpawn;
    },
    respondToChild(responder: (child: FakeChild) => void) {
      spawnResponder = responder;
    },
    async sessionStart() {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    },
    async runCommand(role: string, args = "") {
      await commands.get(`role:${role}`)?.(args, context);
    },
    roleWidget() {
      return roleWidget?.({}, { fg: (_color: string, text: string) => text })?.render();
    },
    async toolCall(toolName: string) {
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = await handler({ toolName }, context);
        if (result) return result;
      }
      return undefined;
    },
    async beforeAgentStart(systemPrompt: string) {
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = await handler({ systemPrompt }, context);
        if (result) return result;
      }
      return undefined;
    },
    async executeSubagent(
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (update: any) => void,
    ) {
      return registeredTool?.execute("call", params, signal, onUpdate, context);
    },
    renderResult(...args: any[]) {
      return registeredTool?.renderResult?.(...args);
    },
  };
}
describe("設定", () => {
  it("YAML を role 設定として読み込む", () => {
    const result = parseRoleConfig(`default: manager
roles:
  manager:
    model: test/model
    tools: [read]
    subagents: []
    systemPrompt: [hello]`);
    assert.equal(result.config?.default, "manager");
    assert.deepEqual(result.config?.roles.manager.tools, ["read"]);
  });

  it("YAML アンカーで共有した prompt 要素を配列として読み込む", () => {
    const result = parseRoleConfig(`default: manager
_common: &common shared
roles:
  manager:
    model: test/model
    tools: []
    subagents: []
    systemPrompt: [*common]`);
    assert.deepEqual(result.config?.roles.manager.systemPrompt, ["shared"]);
  });

  it("配列でない systemPrompt を拒否する", () => {
    const result = parseRoleConfig(`default: manager
roles:
  manager:
    model: test/model
    tools: []
    subagents: []
    systemPrompt: hello`);
    assert.match(result.error ?? "", /invalid systemPrompt/);
  });

  it("未定義の default role を拒否する", () => {
    const result = parseRoleConfig("default: missing\nroles: {}\n");
    assert.match(result.error ?? "", /not defined/);
  });

  it("未定義の委譲先を拒否する", () => {
    const result = parseRoleConfig(`default: manager
roles:
  manager:
    model: test/model
    tools: []
    subagents: [missing]
    systemPrompt: []`);
    assert.match(result.error ?? "", /undefined role/);
  });
});

describe("セッションの role", () => {
  it("config の default role で開始し、指定された role は子セッションの開始 role にする", () => {
    assert.equal(initialRole(config), "manager");
    assert.equal(initialRole(config, "chat"), "chat");
    assert.equal(initialRole(config, "missing"), "manager");
  });
  it("定義済み role に切り替える", () => {
    assert.equal(switchRole("chat", config), "chat");
  });
});

describe("ツール許可", () => {
  it("許可一覧にないツールをブロックする", () => {
    assert.equal(shouldBlockToolCall("chat", "bash", config), true);
  });

  it("ワイルドカードは未知のツールを含むすべてを許可する", () => {
    assert.equal(shouldBlockToolCall("manager", "future_tool", config), false);
  });

  it("subagent は role のツール一覧に関係なく利用可能", () => {
    assert.equal(shouldBlockToolCall("chat", "subagent", config), false);
  });

  it("chat は web_search と web_fetch だけを許可する", () => {
    assert.equal(shouldBlockToolCall("chat", "web_search", config), false);
    assert.equal(shouldBlockToolCall("chat", "web_fetch", config), false);
  });
});

describe("委譲", () => {
  it("manager は設定された worker だけを起動できる", () => {
    assert.equal(canDelegate("manager", "worker", config), true);
    assert.equal(canDelegate("manager", "chat", config), false);
    assert.equal(childRole("manager", "worker", config), "worker");
  });
});

describe("システムプロンプト", () => {
  it("role の systemPrompt を追記する", () => {
    assert.match(buildRoleSystemPromptAddendum("manager", config), /ファイル操作は禁止/);
  });
});

describe("ツール実行の表示", () => {
  it("引数プレビューを100文字まで表示する", () => {
    const renderedCall = formatToolCall(
      "bash",
      { command: "x".repeat(95) },
      (_color, text) => text,
    );
    assert.equal(renderedCall.length, 108);
  });
});

describe("拡張の接続", () => {
  it("起動時に default role を適用し、role 表示と allowlist を更新する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.roleWidget(), ["🤖 role: manager"]);
      assert.deepEqual(extension.activeTools.at(-1), ["read", "bash", "subagent"]);
    } finally {
      extension.restore();
    }
  });

  it("role 切り替え時にモデル、ツール、表示を role の設定へ切り替える", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat");
      assert.deepEqual(extension.activeTools.at(-1), ["web_search", "web_fetch", "subagent"]);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.deepEqual(extension.roleWidget(), ["🤖 role: chat"]);
      assert.deepEqual(extension.notifications, ["role: chat"]);
    } finally {
      extension.restore();
    }
  });

  it("role 切り替え時の引数を切り替え後のユーザーメッセージとして送信する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat", "  hello world  ");
      assert.deepEqual(extension.sentMessages, ["hello world"]);
    } finally {
      extension.restore();
    }
  });

  it("引数のない role 切り替えはユーザーメッセージを送信しない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat");
      assert.deepEqual(extension.sentMessages, []);
    } finally {
      extension.restore();
    }
  });

  it("許可されないツールの tool_call をブロックし、セッション継続理由を返す", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat");
      const blockedCall = await extension.toolCall("bash");
      assert.deepEqual(blockedCall, { block: true, reason: "role chat cannot use bash" });
    } finally {
      extension.restore();
    }
  });

  it("設定された systemPrompt を次回実行のシステムプロンプトへ追記する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.runCommand("manager");
      const result = await extension.beforeAgentStart("base");
      assert.match(result.systemPrompt, /^base\n\nファイル操作は禁止$/);
    } finally {
      extension.restore();
    }
  });

  it("許可された role の subagent を指定モデルと role で起動し、最終結果を親へ返す", async () => {
    const extension = captureRoleExtension();
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } })}\n${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({
        role: "worker",
        task: "work",
        cwd: "/child",
      });
      assert.equal(result.content[0].text, "done");
      assert.equal(extension.spawnCalls.length, 1);
      assert.equal(extension.spawnCalls[0].cwd, "/child");
      assert.deepEqual(extension.spawnCalls[0].args.slice(1), [
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--model",
        "commandcode/gpt-5.6-luna",
        "--role",
        "worker",
        "Task: work",
      ]);
    } finally {
      extension.restore();
    }
  });

  it("委譲が許可されない role からの subagent を起動せず理由を返す", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "manager", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Permission denied/);
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("未定義 role の subagent を起動せず理由を返す", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "missing", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /not defined/);
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("subagent の実行中に子の結果を onUpdate へ渡す", async () => {
    const extension = captureRoleExtension();
    const updates: any[] = [];
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } })}\n${JSON.stringify({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" }, partialResult: { content: [] } })}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [] }, isError: false })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      await extension.executeSubagent({ role: "worker", task: "work" }, undefined, (update) =>
        updates.push(update),
      );
      assert.equal(updates.length, 3);
      assert.equal(updates[0].details.results[0].actions[0].name, "bash");
      assert.equal(updates[0].details.results[0].actions[0].args.command, "pwd");
    } finally {
      extension.restore();
    }
  });

  it("親のキャンセルを SIGTERM として子へ伝播し、子を中断結果にする", async () => {
    const extension = captureRoleExtension();
    const controller = new AbortController();
    let scheduledAbortTimer = false;
    let clearedAbortTimer = false;
    const originalAbortTimer = __abortTimer.set;
    const originalClearAbortTimer = __abortTimer.clear;
    __abortTimer.set = (callback) => {
      scheduledAbortTimer = true;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    __abortTimer.clear = () => {
      clearedAbortTimer = true;
    };
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent(
        { role: "worker", task: "work" },
        controller.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      const result = await execution;
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0].stopReason, "aborted");
      assert.match(result.content[0].text, /aborted/);
      assert.deepEqual(extension.children[0].killHistory, ["SIGTERM"]);
      assert.equal(scheduledAbortTimer, true);
      assert.equal(clearedAbortTimer, true);
    } finally {
      __abortTimer.set = originalAbortTimer;
      __abortTimer.clear = originalClearAbortTimer;
      extension.restore();
    }
  });

  it("SIGTERM を無視する子へ 5 秒後に SIGKILL を送る", async () => {
    const extension = captureRoleExtension();
    const controller = new AbortController();
    let runAbortTimer: (() => void) | undefined;
    const originalAbortTimer = __abortTimer.set;
    __abortTimer.set = (callback) => {
      runAbortTimer = callback;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    extension.respondToChild((child) => {
      child.ignoreTerm = true;
    });
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent(
        { role: "worker", task: "work" },
        controller.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runAbortTimer !== undefined, true);
      runAbortTimer?.();
      const result = await execution;
      assert.equal(result.isError, true);
      assert.deepEqual(extension.children[0].killHistory, ["SIGTERM", "SIGKILL"]);
    } finally {
      __abortTimer.set = originalAbortTimer;
      extension.restore();
    }
  });

  it("正常終了した子に対する親の abort を無視する", async () => {
    const extension = captureRoleExtension();
    const controller = new AbortController();
    extension.respondToChild((child) => child.emit("close", 0));
    try {
      await extension.sessionStart();
      await extension.executeSubagent({ role: "worker", task: "work" }, controller.signal);
      controller.abort();
      assert.deepEqual(extension.children[0].killHistory, []);
    } finally {
      extension.restore();
    }
  });

  it("設定エラーを subagent のエラー結果として返す", async () => {
    const extension = captureRoleExtension({ error: "invalid config" });
    try {
      const result = await extension.executeSubagent({ role: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid config/);
    } finally {
      extension.restore();
    }
  });

  it("空の task を拒否し、子プロセスを起動しない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "worker", task: "" });
      assert.equal(result.content[0].text, "Invalid parameters. Provide a task.");
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("role の設定エラーを session_start で owner に通知する", async () => {
    const extension = captureRoleExtension({ error: "invalid config" });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.notifications, ["role configuration error: invalid config"]);
    } finally {
      extension.restore();
    }
  });
});

describe("subagent の表示", () => {
  it("常に展開形式で task、ツール実行、最終応答を表示する", async () => {
    const extension = captureRoleExtension();
    const details = {
      results: [
        {
          role: "worker",
          task: "work",
          exitCode: 0,
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "bash", arguments: { command: "pwd" } }],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          ],
          actions: [],
          stderr: "",
        },
      ],
    };
    try {
      const rendered = extension.renderResult(
        { content: [], details },
        {},
        {
          fg: (color: string, text: string) => `[${color}]${text}`,
          bold: (text: string) => `*${text}*`,
        },
      );
      assert.ok(rendered instanceof Container);
    } finally {
      extension.restore();
    }
  });

  it("ツール利用がない場合は Actions を表示しない", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [{ role: "worker", task: "work", exitCode: 0, messages: [], actions: [], stderr: "" }],
    };
    try {
      const rendered = extension.renderResult({ content: [], details }, {}, {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      });
      assert.equal((rendered as Container).render(200).some((line) => line.includes("─── Actions ───")), false);
    } finally {
      extension.restore();
    }
  });

  it("出力が確定するまで Output を表示しない", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [{ role: "worker", task: "work", exitCode: 0, messages: [], actions: [], stderr: "" }],
    };
    try {
      const rendered = extension.renderResult({ content: [], details }, { isPartial: true }, {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      });
      assert.equal((rendered as Container).render(200).some((line) => line.includes("─── Output ───")), false);
    } finally {
      extension.restore();
    }
  });

  it("出力がある場合だけ Output を表示する", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [{
        role: "worker",
        task: "work",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        actions: [],
        stderr: "",
      }],
    };
    try {
      const rendered = extension.renderResult({ content: [], details }, { isPartial: false }, {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      });
      assert.ok((rendered as Container).render(200).some((line) => line.includes("─── Output ───")));
    } finally {
      extension.restore();
    }
  });
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed++;
  } catch (error) {
    failures.push(
      `  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
