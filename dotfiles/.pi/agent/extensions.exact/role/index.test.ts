import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import roleExtension, {
  __abortTimer,
  __resetRoutingState,
  __spawn,
  type RoleConfig,
  buildRoleSystemPromptAddendum,
  canDelegate,
  childRole,
  initialRole,
  parseRoleConfig,
  shouldBlockToolCall,
  spinnerFrame,
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
  tiers: {
    middle: [
      { provider: "zai", model: "glm-5.2" },
      { provider: "commandcode", model: "gpt-5.6-luna" },
    ],
    low: [{ provider: "commandcode", model: "gpt-5.6-luna" }],
  },
  roles: {
    manager: {
      tier: "middle",
      tools: ["*"],
      subagents: ["worker"],
      systemPrompt: ["ファイル操作は禁止"],
    },
    worker: { tier: "low", tools: ["*"], subagents: [], systemPrompt: [] },
    chat: {
      tier: "low",
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

class FakeChildStream extends EventEmitter {
  destroy(): void {}
}

class FakeChild extends EventEmitter {
  stdout = new FakeChildStream();
  stderr = new FakeChildStream();
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

interface CaptureOptions {
  flags?: Record<string, string>;
  findModel?: (provider: string, id: string) => { provider: string; id: string } | undefined;
  setModelSucceeds?: boolean;
}

function captureRoleExtension(
  injectedConfig: { config?: RoleConfig; error?: string } = { config },
  options: CaptureOptions = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const notifications: string[] = [];
  const activeTools: string[][] = [];
  const selectedModels: unknown[] = [];
  const sentMessages: Array<{ content: string; options?: unknown }> = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const children: FakeChild[] = [];
  let spawnResponder: (child: FakeChild) => void = () => {};
  let roleWidget: any;
  let registeredTool: CapturedTool | undefined;
  let branch: unknown[] = [];

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
      getFlag(name: string) {
        return options.flags?.[name];
      },
      getAllTools() {
        return [{ name: "read" }, { name: "bash" }, { name: "subagent" }];
      },
      setActiveTools(tools: string[]) {
        activeTools.push(tools);
      },
      async setModel(model: unknown) {
        selectedModels.push(model);
        context.model = model as { provider: string; id: string };
        return options.setModelSucceeds ?? true;
      },
      sendUserMessage(content: string, messageOptions?: unknown) {
        sentMessages.push(
          messageOptions === undefined ? { content } : { content, options: messageOptions },
        );
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
    hasUI: true,
    ui,
    model: undefined as { provider: string; id: string } | undefined,
    modelRegistry: {
      find: options.findModel ?? ((provider: string, id: string) => ({ provider, id })),
    },
    sessionManager: {
      getBranch: () => branch,
    },
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
      __resetRoutingState();
    },
    setBranch(entries: unknown[]) {
      branch = entries;
    },
    respondToChild(responder: (child: FakeChild) => void) {
      spawnResponder = responder;
    },
    async sessionStart(reason?: string) {
      for (const handler of handlers.get("session_start") ?? []) await handler({ reason }, context);
    },
    async sessionShutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
    },
    async runCommand(role: string, args = "") {
      await commands.get(`role:${role}`)?.(args, context);
    },
    async input(text: string, source = "interactive") {
      let result: unknown;
      for (const handler of handlers.get("input") ?? []) {
        const handled = await handler({ text, source }, context);
        if (handled) result = handled;
      }
      return result;
    },
    async modelSelect(source: string) {
      for (const handler of handlers.get("model_select") ?? []) await handler({ source }, context);
    },
    async providerResponse(status: number, headers: Record<string, string> = {}) {
      for (const handler of handlers.get("after_provider_response") ?? [])
        await handler({ status, headers }, context);
    },
    roleWidget() {
      return roleWidget?.(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text },
      )?.render();
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
  it("YAML を tier つき role 設定として読み込む", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle:
    - provider: zai
      model: glm-5.2
      when: 'exit 0'
roles:
  manager:
    tier: middle
    tools: [read]
    subagents: []
    systemPrompt: [hello]`);
    assert.equal(result.config?.default, "manager");
    assert.deepEqual(result.config?.tiers.middle, [
      { provider: "zai", model: "glm-5.2", when: "exit 0" },
    ]);
    assert.equal(result.config?.roles.manager.tier, "middle");
    assert.deepEqual(result.config?.roles.manager.tools, ["read"]);
  });

  it("YAML アンカーで共有した prompt 要素を配列として読み込む", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
_common: &common shared
roles:
  manager:
    tier: middle
    tools: []
    subagents: []
    systemPrompt: [*common]`);
    assert.deepEqual(result.config?.roles.manager.systemPrompt, ["shared"]);
  });

  it("tiers がない設定を拒否する", () => {
    const result = parseRoleConfig(`default: manager
roles:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /tiers are required/);
  });

  it("tier が配列でないものを拒否する", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle: {provider: zai}
roles:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /must be an array/);
  });

  it("provider か model のない候補を拒否する", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle:
    - provider: zai
roles:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /provider and model strings/);
  });

  it("when が文字列でない候補を拒否する", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle:
    - {provider: zai, model: glm-5.2, when: 123}
roles:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid when/);
  });

  it("role の tier がない設定を拒否する", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
roles:
  manager: {tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid tier/);
  });

  it("未定義の tier を参照する role を拒否する", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
roles:
  manager: {tier: high, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /undefined tier high/);
  });

  it("配列でない systemPrompt を拒否する", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
roles:
  manager:
    tier: middle
    tools: []
    subagents: []
    systemPrompt: hello`);
    assert.match(result.error ?? "", /invalid systemPrompt/);
  });

  it("未定義の default role を拒否する", () => {
    const result = parseRoleConfig(`default: missing
tiers:
  middle: [{provider: zai, model: glm-5.2}]
roles: {}`);
    assert.match(result.error ?? "", /not defined/);
  });

  it("未定義の委譲先を拒否する", () => {
    const result = parseRoleConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
roles:
  manager:
    tier: middle
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

describe("待機スピナー", () => {
  it("フレームを - \\ | / の順で 0.1 秒間隔で循環させる", () => {
    assert.equal(spinnerFrame(0), "-");
    assert.equal(spinnerFrame(100), "\\");
    assert.equal(spinnerFrame(200), "|");
    assert.equal(spinnerFrame(300), "/");
    assert.equal(spinnerFrame(400), "-");
  });
});

describe("拡張の接続", () => {
  it("起動時に default role の tier 候補を適用し、role 表示と allowlist を更新する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
      assert.deepEqual(extension.notifications, ["role model → zai/glm-5.2"]);
      assert.deepEqual(extension.roleWidget(), ["🤖 role: manager"]);
      assert.deepEqual(extension.activeTools.at(-1), ["read", "bash", "subagent"]);
    } finally {
      extension.restore();
    }
  });

  it("--role フラグの role で開始する", async () => {
    const extension = captureRoleExtension({ config }, { flags: { role: "chat" } });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.roleWidget(), ["🤖 role: chat"]);
      assert.deepEqual(extension.selectedModels, [{ provider: "commandcode", id: "gpt-5.6-luna" }]);
    } finally {
      extension.restore();
    }
  });

  it("role 切り替え時に tier 候補のモデル、ツール、表示を切り替える", async () => {
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
      assert.ok(extension.notifications.includes("role model → commandcode/gpt-5.6-luna"));
    } finally {
      extension.restore();
    }
  });

  it("tier の全候補に失敗したら現在のモデルを維持し warning で通知する", async () => {
    const extension = captureRoleExtension({ config }, { setModelSucceeds: false });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2" },
        { provider: "commandcode", id: "gpt-5.6-luna" },
      ]);
      assert.deepEqual(
        extension.notifications.at(-1),
        "no available model for role manager: tier middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("role 切り替え時の引数を切り替え後のユーザーメッセージとして送信する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat", "  hello world  ");
      assert.deepEqual(extension.sentMessages, [{ content: "hello world" }]);
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
});

describe("tier によるモデルルーティング", () => {
  it("プロンプト送信前に候補を再評価し、同じモデルなら切り替えない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      const modelCountBefore = extension.selectedModels.length;
      const result = await extension.input("hello");
      assert.equal(result, undefined);
      assert.equal(extension.selectedModels.length, modelCountBefore);
    } finally {
      extension.restore();
    }
  });

  it("プロンプト送信前に成立した別候補へ切り替える", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      extension.context.model = { provider: "zai", id: "other" };
      await extension.input("hello");
      assert.deepEqual(extension.selectedModels.at(-1), { provider: "zai", id: "glm-5.2" });
    } finally {
      extension.restore();
    }
  });

  it("プロンプト送信前に全候補が不成立ならエラー通知してプロンプトを実行しない", async () => {
    const extension = captureRoleExtension({ config }, { findModel: () => undefined });
    try {
      await extension.sessionStart();
      const result = await extension.input("hello");
      assert.deepEqual(result, { action: "handled" });
      assert.equal(extension.sentMessages.length, 0);
      assert.deepEqual(
        extension.notifications.at(-1),
        "no available model for role manager: tier middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("UI のない環境で全候補が不成立のとき stderr へ出力し終了コードを 1 にする", async () => {
    const extension = captureRoleExtension({ config }, { findModel: () => undefined });
    const stderrLines: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalExitCode = process.exitCode;
    process.stderr.write = ((chunk: Uint8Array | string) => {
      stderrLines.push(Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      extension.context.hasUI = false;
      await extension.sessionStart();
      const handledPrompt = await extension.input("hello");
      assert.deepEqual(handledPrompt, { action: "handled" });
      assert.deepEqual(stderrLines, ["no available model for role manager: tier middle\n"]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode;
      extension.restore();
    }
  });

  it("拡張からのメッセージ（再送・role 切替 follow-up）は再評価しない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      extension.context.model = { provider: "zai", id: "other" };
      const modelCountBefore = extension.selectedModels.length;
      await extension.input("hello", "extension");
      assert.equal(extension.selectedModels.length, modelCountBefore);
    } finally {
      extension.restore();
    }
  });
});

describe("手動モデル選択", () => {
  it("ユーザーの model_select で手動状態になり、表示に (manual) を付ける", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      assert.deepEqual(extension.roleWidget(), ["🤖 role: manager (manual)"]);
    } finally {
      extension.restore();
    }
  });

  it("手動状態はプロンプト送信前の再評価を行わない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      extension.context.model = { provider: "zai", id: "other" };
      const modelCountBefore = extension.selectedModels.length;
      await extension.input("hello");
      assert.equal(extension.selectedModels.length, modelCountBefore);
    } finally {
      extension.restore();
    }
  });

  it("restore 由来の model_select は手動状態にしない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("restore");
      assert.deepEqual(extension.roleWidget(), ["🤖 role: manager"]);
    } finally {
      extension.restore();
    }
  });

  it("role 切り替えで手動状態を解除する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      await extension.runCommand("chat");
      assert.deepEqual(extension.roleWidget(), ["🤖 role: chat"]);
    } finally {
      extension.restore();
    }
  });
});

describe("レート制限（429）時のフォールバック", () => {
  it("429 で現在モデルを cooldown し、次候補へ切り替えて直前のプロンプトを再送する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      extension.setBranch([{ type: "message", message: { role: "user", content: "do it" } }]);
      await extension.providerResponse(429);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.ok(
        extension.notifications.includes(
          "rate limited on zai/glm-5.2; switched to commandcode/gpt-5.6-luna",
        ),
      );
      // 429 フォールバックでは role model → の切替通知を重ねない
      assert.equal(
        extension.notifications.includes("role model → commandcode/gpt-5.6-luna"),
        false,
      );
      assert.deepEqual(extension.sentMessages, [
        { content: "do it", options: { deliverAs: "followUp" } },
      ]);
    } finally {
      extension.restore();
    }
  });

  it("次候補がない場合はエラー通知して再送しない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("worker");
      extension.setBranch([{ type: "message", message: { role: "user", content: "do it" } }]);
      await extension.providerResponse(429);
      assert.equal(extension.sentMessages.length, 0);
      assert.deepEqual(
        extension.notifications.at(-1),
        "rate limited on commandcode/gpt-5.6-luna; no fallback available",
      );
    } finally {
      extension.restore();
    }
  });

  it("同一プロンプトの再送は 1 回だけ行う", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      extension.setBranch([{ type: "message", message: { role: "user", content: "do it" } }]);
      await extension.providerResponse(429);
      // 同じプロンプトでもう一度 429 を受けても再送しない
      extension.context.model = { provider: "zai", id: "glm-5.2" };
      await extension.providerResponse(429);
      assert.equal(extension.sentMessages.length, 1);
    } finally {
      extension.restore();
    }
  });

  it("手動状態でもフォールバックし、手動状態を維持する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      extension.setBranch([{ type: "message", message: { role: "user", content: "do it" } }]);
      await extension.providerResponse(429);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.deepEqual(extension.roleWidget(), ["🤖 role: manager (manual)"]);
    } finally {
      extension.restore();
    }
  });

  it("429 以外のステータスでは何もしない", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart();
      const modelCountBefore = extension.selectedModels.length;
      await extension.providerResponse(500);
      assert.equal(extension.selectedModels.length, modelCountBefore);
      assert.equal(extension.sentMessages.length, 0);
    } finally {
      extension.restore();
    }
  });
});

describe("セッションライフサイクル", () => {
  it("/reload では手動選択状態と cooldown を維持し、モデルを変更しない", async () => {
    const before = captureRoleExtension({ config }, { flags: { role: "chat" } });
    let after: ReturnType<typeof captureRoleExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.modelSelect("set");
      await before.providerResponse(429); // cooldown を 1 つ作る
      await before.sessionShutdown();

      after = captureRoleExtension();
      await after.sessionStart("reload");
      assert.deepEqual(after.roleWidget(), ["🤖 role: chat (manual)"]);
      assert.equal(after.selectedModels.length, 0);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("/new では cooldown を破棄して初期 role の候補を適用する", async () => {
    const before = captureRoleExtension();
    let after: ReturnType<typeof captureRoleExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.providerResponse(429); // zai/glm-5.2 が cooldown
      await before.sessionShutdown();

      after = captureRoleExtension();
      await after.sessionStart("new");
      assert.deepEqual(after.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("セッション切替（resume）では cooldown を維持して次候補を適用する", async () => {
    const before = captureRoleExtension();
    let after: ReturnType<typeof captureRoleExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.providerResponse(429); // zai/glm-5.2 が cooldown
      await before.sessionShutdown();

      after = captureRoleExtension();
      await after.sessionStart("resume");
      assert.deepEqual(after.selectedModels, [{ provider: "commandcode", id: "gpt-5.6-luna" }]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("セッション開始時に手動選択状態を解除する", async () => {
    const extension = captureRoleExtension();
    try {
      await extension.sessionStart("startup");
      await extension.modelSelect("set");
      await extension.sessionShutdown();
      await extension.sessionStart("new");
      assert.deepEqual(extension.roleWidget(), ["🤖 role: manager"]);
    } finally {
      extension.restore();
    }
  });
});

describe("subagent", () => {
  it("許可された role の subagent を --role だけ渡して起動し、最終結果を親へ返す", async () => {
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

  it("tool_execution_end の結果を toolCallId で対応する action へ紐づける", async () => {
    const extension = captureRoleExtension();
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } })}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "/child" }] }, isError: false })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "worker", task: "work" });
      const action = result.details.results[0].actions[0];
      assert.equal(action.result?.content?.[0]?.text, "/child");
      assert.equal(action.isError, false);
      assert.ok(action.startedAt !== undefined && action.endedAt !== undefined);
    } finally {
      extension.restore();
    }
  });

  it("toolCallId のない tool_execution_end はどの action にも紐づけない", async () => {
    const extension = captureRoleExtension();
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } })}\n${JSON.stringify({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "worker", task: "work" });
      assert.equal(result.details.results[0].actions[0].result, undefined);
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

  it("子が exit しても close が来なければ、静穏タイマーで結果を確定する", async () => {
    const extension = captureRoleExtension();
    let fireIdleTimer: (() => void) | undefined;
    const originalSet = __abortTimer.set;
    __abortTimer.set = (callback) => {
      fireIdleTimer = callback;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
        ),
      );
      child.emit("exit", 0);
    });
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent({ role: "worker", task: "work" });
      await new Promise((resolve) => setImmediate(resolve));
      fireIdleTimer?.();
      const result = await execution;
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, "done");
    } finally {
      __abortTimer.set = originalSet;
      extension.restore();
    }
  });

  it("子の exit 後に届いた stdout の行も結果へ含める", async () => {
    const extension = captureRoleExtension();
    let fireIdleTimer: (() => void) | undefined;
    const originalSet = __abortTimer.set;
    __abortTimer.set = (callback) => {
      fireIdleTimer = callback;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    extension.respondToChild((child) => {
      child.emit("exit", 0);
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late done" }] } })}\n`,
        ),
      );
    });
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent({ role: "worker", task: "work" });
      await new Promise((resolve) => setImmediate(resolve));
      fireIdleTimer?.();
      const result = await execution;
      assert.equal(result.content[0].text, "late done");
    } finally {
      __abortTimer.set = originalSet;
      extension.restore();
    }
  });

  it("シグナルで死亡した子をエラーとして扱う", async () => {
    const extension = captureRoleExtension();
    extension.respondToChild((child) => child.emit("close", null));
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0].stopReason, "killed");
      assert.match(result.content[0].text, /killed by a signal/);
    } finally {
      extension.restore();
    }
  });

  it("exit 0 でも出力のない子をエラーとして親へ返す", async () => {
    const extension = captureRoleExtension();
    extension.respondToChild((child) => child.emit("close", 0));
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Child failed: (no output)");
    } finally {
      extension.restore();
    }
  });

  it("exit 0 で出力がなく stderr がある子は stderr を失敗出力として親へ返す", async () => {
    const extension = captureRoleExtension();
    extension.respondToChild((child) => {
      child.stderr.emit("data", Buffer.from("no available model for role worker: tier low\n"));
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ role: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        "Child failed: no available model for role worker: tier low\n",
      );
    } finally {
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
  it("Actions をツール別の整形と結果サマリー行で表示する", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [
        {
          role: "worker",
          task: "work",
          cwd: "/child",
          pending: false,
          exitCode: 0,
          messages: [],
          actions: [
            {
              toolCallId: "call-1",
              name: "edit",
              args: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
              startedAt: 1000,
              endedAt: 2500,
              result: { content: [{ type: "text", text: "" }] },
              isError: false,
            },
          ],
          stderr: "",
        },
      ],
    };
    try {
      const rendered = extension.renderResult(
        { content: [], details },
        {},
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      );
      const lines = (rendered as Container).render(200);
      assert.ok(lines.some((line) => line.includes("→ edit a.ts")));
      assert.ok(lines.some((line) => line.includes("  edited 1 block(s)")));
    } finally {
      extension.restore();
    }
  });

  it("結果を受け取る前のツール呼び出しは結果行を表示しない", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [
        {
          role: "worker",
          task: "work",
          cwd: "/child",
          pending: false,
          exitCode: 0,
          messages: [],
          actions: [{ toolCallId: "call-1", name: "edit", args: { path: "a.ts" } }],
          stderr: "",
        },
      ],
    };
    try {
      const rendered = extension.renderResult(
        { content: [], details },
        {},
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      );
      const lines = (rendered as Container).render(200);
      assert.equal(
        lines.some((line) => line.includes("edited")),
        false,
      );
    } finally {
      extension.restore();
    }
  });

  it("実行中はブロックの末尾にスピナー行を表示する", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [
        {
          role: "worker",
          task: "work",
          cwd: "/child",
          pending: true,
          exitCode: 0,
          messages: [],
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
      const lines = (rendered as Container).render(200);
      assert.ok(lines.some((line) => /^\[muted\][-\\|/] worker/.test(line)));
    } finally {
      extension.restore();
    }
  });

  it("実行確定後はスピナー行を表示しない", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [
        {
          role: "worker",
          task: "work",
          cwd: "/child",
          pending: false,
          exitCode: 0,
          messages: [],
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
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      );
      const lines = (rendered as Container).render(200);
      assert.equal(
        lines.some((line) => /^[-\\|/] worker/.test(line)),
        false,
      );
    } finally {
      extension.restore();
    }
  });

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
      results: [
        { role: "worker", task: "work", exitCode: 0, messages: [], actions: [], stderr: "" },
      ],
    };
    try {
      const rendered = extension.renderResult(
        { content: [], details },
        {},
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      );
      assert.equal(
        (rendered as Container).render(200).some((line) => line.includes("─── Actions ───")),
        false,
      );
    } finally {
      extension.restore();
    }
  });

  it("出力が確定するまで Output を表示しない", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [
        { role: "worker", task: "work", exitCode: 0, messages: [], actions: [], stderr: "" },
      ],
    };
    try {
      const rendered = extension.renderResult(
        { content: [], details },
        { isPartial: true },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      );
      assert.equal(
        (rendered as Container).render(200).some((line) => line.includes("─── Output ───")),
        false,
      );
    } finally {
      extension.restore();
    }
  });

  it("出力がある場合だけ Output を表示する", () => {
    const extension = captureRoleExtension();
    const details = {
      results: [
        {
          role: "worker",
          task: "work",
          exitCode: 0,
          messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
          actions: [],
          stderr: "",
        },
      ],
    };
    try {
      const rendered = extension.renderResult(
        { content: [], details },
        { isPartial: false },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      );
      assert.ok(
        (rendered as Container).render(200).some((line) => line.includes("─── Output ───")),
      );
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
