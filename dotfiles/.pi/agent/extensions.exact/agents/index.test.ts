import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { Container, Text } from "@earendil-works/pi-tui";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import agentsExtension, {
  __abortTimer,
  __resetRoutingState,
  __spawn,
  __spinnerTimers,
  type AgentConfig,
  buildAgentSystemPromptAddendum,
  canDelegate,
  childAgent,
  childInvocationArgs,
  cleanupOldSubagentSessions,
  initialAgent,
  loadAgentConfig,
  parseAgentConfig,
  sessionNameFor,
  shouldBlockToolCall,
  subagentSessionDir,
} from "./index";
import { SPINNER_FRAMES, spinnerFrame } from "../titlebar/index.ts";

const config: AgentConfig = {
  default: "manager",
  tiers: {
    middle: [
      { provider: "zai", model: "glm-5.2" },
      { provider: "commandcode", model: "gpt-5.6-luna" },
    ],
    low: [{ provider: "commandcode", model: "gpt-5.6-luna" }],
  },
  agents: {
    manager: {
      tier: "middle",
      tools: ["*"],
      subagents: ["worker"],
      systemPrompt: ["ファイル操作は禁止"],
    },
    worker: { tier: "low", tools: ["bash"], subagents: ["chat"], systemPrompt: ["worker prompt"] },
    chat: {
      tier: "low",
      tools: ["web_search", "web_fetch"],
      subagents: [],
      systemPrompt: ["チャット用"],
    },
    locked: { tier: "low", tools: [], subagents: [], systemPrompt: [] },
  },
};

type CapturedTool = {
  execute: (...args: any[]) => Promise<any>;
  renderCall?: (...args: any[]) => unknown;
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

function succeedChild(child: FakeChild): void {
  child.stdout.emit(
    "data",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
    ),
  );
  child.emit("close", 0);
}

interface CaptureOptions {
  flags?: Record<string, string>;
  findModel?: (provider: string, id: string) => { provider: string; id: string } | undefined;
  setModelSucceeds?: boolean | boolean[];
}

function captureAgentsExtension(
  injectedConfig: { config?: AgentConfig; error?: string } = { config },
  options: CaptureOptions = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const notifications: string[] = [];
  const notificationEvents: Array<{ message: string; level: string }> = [];
  const activeTools: string[][] = [];
  const selectedModels: unknown[] = [];
  const registeredFlags: string[] = [];
  const sentMessages: Array<{ content: string; options?: unknown }> = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const children: FakeChild[] = [];
  let spawnResponder: (child: FakeChild) => void = () => {};
  let agentWidget: any;
  let requestedRenderCount = 0;
  let registeredTool: CapturedTool | undefined;

  const originalSpawn = __spawn.current;
  __spawn.current = ((command: string, args: string[], options: { cwd?: string }) => {
    const child = new FakeChild();
    spawnCalls.push({ command, args, cwd: options.cwd });
    children.push(child);
    setImmediate(() => spawnResponder(child));
    return child;
  }) as unknown as typeof __spawn.current;

  agentsExtension(
    {
      on(event: string, handler: Handler) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
      registerCommand(name: string, definition: { handler: Handler }) {
        commands.set(name, definition.handler);
      },
      registerFlag(name: string) {
        registeredFlags.push(name);
      },
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
        const attemptIndex = selectedModels.length;
        selectedModels.push(model);
        context.model = model as { provider: string; id: string };
        return Array.isArray(options.setModelSucceeds)
          ? (options.setModelSucceeds[attemptIndex] ?? true)
          : (options.setModelSucceeds ?? true);
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
      agentWidget = widget;
    },
    notify(message: string, level: string) {
      notifications.push(message);
      notificationEvents.push({ message, level });
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
  };

  return {
    children,
    commands,
    context,
    notifications,
    notificationEvents,
    activeTools,
    selectedModels,
    registeredFlags,
    sentMessages,
    spawnCalls,
    restore() {
      __spawn.current = originalSpawn;
      __resetRoutingState();
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
    async runCommand(agent: string, args = "") {
      await commands.get(`agent:${agent}`)?.(args, context);
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
    async messageEnd(message: unknown): Promise<any> {
      let result: any;
      for (const handler of handlers.get("message_end") ?? []) {
        const handled = await handler({ message }, context);
        if (handled !== undefined) result = handled;
      }
      return result;
    },
    agentWidget() {
      return agentWidget?.(
        { requestRender: () => requestedRenderCount++ },
        { fg: (_color: string, text: string) => text },
      )?.render();
    },
    requestedRenderCount() {
      return requestedRenderCount;
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
    renderCall(...args: any[]) {
      return registeredTool?.renderCall?.(...args);
    },
    renderResult(...args: any[]) {
      return registeredTool?.renderResult?.(...args);
    },
  };
}
describe("設定", () => {
  it("agent retry configuration retries five times without a delay", () => {
    const settingsPath = new URL("../../settings.merge.json", import.meta.url);
    const settings = readFileSync(settingsPath, "utf8");

    assert.match(
      settings,
      /"maxRetries": 5,\s*"baseDelayMs": 0,\s*"provider": \{\s*"maxRetries": 0/m,
    );
  });

  it("YAML を tier つき agent 設定として読み込む", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle:
    - provider: zai
      model: glm-5.2
      when: 'exit 0'
agents:
  manager:
    tier: middle
    tools: [read]
    subagents: []
    systemPrompt: [hello]`);
    assert.equal(result.config?.default, "manager");
    assert.deepEqual(result.config?.tiers.middle, [
      { provider: "zai", model: "glm-5.2", when: "exit 0" },
    ]);
    assert.equal(result.config?.agents.manager?.tier, "middle");
    assert.deepEqual(result.config?.agents.manager?.tools, ["read"]);
  });

  it("YAML アンカーで共有した prompt 要素を配列として読み込む", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
_common: &common shared
agents:
  manager:
    tier: middle
    tools: []
    subagents: []
    systemPrompt: [*common]`);
    assert.deepEqual(result.config?.agents.manager?.systemPrompt, ["shared"]);
  });

  it("設定ファイルがない場合は読み込みエラーを返す", () => {
    const result = loadAgentConfig("/path/that/does/not/exist/agents-config.yaml");
    assert.match(result.error ?? "", /config file not found/);
  });

  it("設定ファイルを読み取れない場合は読み込みエラーを返す", () => {
    const result = loadAgentConfig("/");
    assert.ok(result.error);
  });

  it("YAML として不正な設定を拒否する", () => {
    const result = parseAgentConfig("agents: [");
    assert.ok(result.error);
  });

  it("default が文字列でない設定を拒否する", () => {
    const result = parseAgentConfig(`default: 123
agents: {}
tiers: {}`);
    assert.match(result.error ?? "", /default and agents are required/);
  });

  it("agents がオブジェクトでない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
agents: []
tiers: {}`);
    assert.match(result.error ?? "", /default and agents are required/);
  });

  it("tier の候補要素がオブジェクトでない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: [invalid]
agents:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /candidate must be an object/);
  });

  it("agent 定義がオブジェクトでない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: []
agents:
  manager: invalid`);
    assert.match(result.error ?? "", /agent manager must be an object/);
  });

  it("tools の要素が文字列でない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: []
agents:
  manager: {tier: middle, tools: [123], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid tools/);
  });

  it("subagents の要素が文字列でない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: []
agents:
  manager: {tier: middle, tools: [], subagents: [123], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid subagents/);
  });

  it("systemPrompt の要素が文字列でない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: []
agents:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: [123]}`);
    assert.match(result.error ?? "", /invalid systemPrompt/);
  });

  it("複数の systemPrompt 要素を順序どおりに読み込み、agent 間で共有する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
_common: &common shared
agents:
  manager:
    tier: middle
    tools: []
    subagents: []
    systemPrompt: [*common, manager-only]
  worker:
    tier: middle
    tools: []
    subagents: []
    systemPrompt: [*common, worker-only]`);
    assert.deepEqual(result.config?.agents.manager?.systemPrompt, ["shared", "manager-only"]);
    assert.deepEqual(result.config?.agents.worker?.systemPrompt, ["shared", "worker-only"]);
  });

  it("tiers がない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
agents:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /tiers are required/);
  });

  it("tier が配列でないものを拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: {provider: zai}
agents:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /must be an array/);
  });

  it("provider か model のない候補を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle:
    - provider: zai
agents:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /provider and model strings/);
  });

  it("when が文字列でない候補を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle:
    - {provider: zai, model: glm-5.2, when: 123}
agents:
  manager: {tier: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid when/);
  });

  it("agent の tier がない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager: {tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid tier/);
  });

  it("未定義の tier を参照する agent を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager: {tier: high, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /undefined tier high/);
  });

  it("配列でない systemPrompt を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager:
    tier: middle
    tools: []
    subagents: []
    systemPrompt: hello`);
    assert.match(result.error ?? "", /invalid systemPrompt/);
  });

  it("未定義の default agent を拒否する", () => {
    const result = parseAgentConfig(`default: missing
tiers:
  middle: [{provider: zai, model: glm-5.2}]
agents: {}`);
    assert.match(result.error ?? "", /not defined/);
  });

  it("未定義の委譲先を拒否する", () => {
    const result = parseAgentConfig(`default: manager
tiers:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager:
    tier: middle
    tools: []
    subagents: [missing]
    systemPrompt: []`);
    assert.match(result.error ?? "", /undefined agent/);
  });

  it("廃止した profiles キーを agent 定義として受け入れない", () => {
    const result = parseAgentConfig(`default: main
tiers:
  high: []
profiles:
  main: {tier: high, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /default and agents are required/);
  });
});

describe("セッションの agent", () => {
  it("config の default agent で開始し、指定された agent は子セッションの開始 agent にする", () => {
    assert.equal(initialAgent(config), "manager");
    assert.equal(initialAgent(config, "chat"), "chat");
    assert.equal(initialAgent(config, "missing"), "manager");
  });
});

describe("ツール許可", () => {
  it("許可一覧にないツールをブロックする", () => {
    assert.equal(shouldBlockToolCall("chat", "bash", config), true);
  });

  it("ワイルドカードは未知のツールを含むすべてを許可する", () => {
    assert.equal(shouldBlockToolCall("manager", "future_tool", config), false);
  });

  it("subagent は agent のツール一覧に関係なく利用可能", () => {
    assert.equal(shouldBlockToolCall("chat", "subagent", config), false);
  });

  it("chat は web_search と web_fetch だけを許可する", () => {
    assert.equal(shouldBlockToolCall("chat", "web_search", config), false);
    assert.equal(shouldBlockToolCall("chat", "web_fetch", config), false);
  });
});

describe("委譲", () => {
  it("親 agent と子 agent の subagents 設定に従って再委譲を許可する", () => {
    assert.equal(canDelegate("manager", "worker", config), true);
    assert.equal(canDelegate("manager", "chat", config), false);
    assert.equal(canDelegate("worker", "chat", config), true);
    assert.equal(childAgent("manager", "worker", config), "worker");
    assert.equal(childAgent("worker", "chat", config), "chat");
  });
});

describe("システムプロンプト", () => {
  it("agent の systemPrompt を追記する", () => {
    assert.match(buildAgentSystemPromptAddendum("manager", config), /ファイル操作は禁止/);
  });

  it("appends multiple prompts in configured order", () => {
    const configuredPrompts: AgentConfig = {
      ...config,
      agents: {
        ...config.agents,
        manager: { ...config.agents.manager!, systemPrompt: ["first", "second"] },
      },
    };

    assert.equal(
      buildAgentSystemPromptAddendum("manager", configuredPrompts),
      "\n\nfirst\n\nsecond",
    );
  });
});

describe("待機スピナー", () => {
  it("titlebar と同じ10フレームを 0.1 秒間隔で循環させる", () => {
    const displayedFrames = SPINNER_FRAMES.map((_, frameIndex) => spinnerFrame(frameIndex * 100));

    assert.deepEqual(displayedFrames, SPINNER_FRAMES);
  });
});

describe("拡張の接続", () => {
  it("起動時に default agent の tier 候補を適用し、agent 表示と allowlist を更新する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
      assert.deepEqual(extension.notifications, ["agent model → zai/glm-5.2"]);
      assert.deepEqual(extension.notificationEvents, [
        { message: "agent model → zai/glm-5.2", level: "info" },
      ]);
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager"]);
      assert.deepEqual(extension.activeTools.at(-1), ["read", "bash", "subagent"]);
    } finally {
      extension.restore();
    }
  });

  it("does not notify model switches without a UI", async () => {
    const extension = captureAgentsExtension();
    try {
      extension.context.hasUI = false;
      await extension.sessionStart();

      assert.deepEqual(extension.notifications, []);
    } finally {
      extension.restore();
    }
  });

  it("--agent フラグの agent で開始する", async () => {
    const extension = captureAgentsExtension({ config }, { flags: { agent: "chat" } });
    try {
      assert.deepEqual(extension.registeredFlags, ["agent"]);
      await extension.sessionStart();
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat"]);
      assert.deepEqual(extension.selectedModels, [{ provider: "commandcode", id: "gpt-5.6-luna" }]);
    } finally {
      extension.restore();
    }
  });

  it("agent 切り替え時に tier 候補のモデル、ツール、表示を切り替える", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat");
      assert.deepEqual(extension.activeTools.at(-1), ["web_search", "web_fetch", "subagent"]);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat"]);
      assert.ok(extension.notifications.includes("agent model → commandcode/gpt-5.6-luna"));
    } finally {
      extension.restore();
    }
  });

  it("tools が空の agent は標準ツールを拒否し subagent だけを有効にする", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("locked");
      assert.deepEqual(extension.activeTools.at(-1), ["subagent"]);
      assert.deepEqual(await extension.toolCall("bash"), {
        block: true,
        reason: "agent locked cannot use bash",
      });
    } finally {
      extension.restore();
    }
  });

  it("subagents が空の agent は子 agent の起動を拒否する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("locked");
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Permission denied/);
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("先頭候補の適用失敗後に次候補の適用を試みる", async () => {
    const extension = captureAgentsExtension({ config }, { setModelSucceeds: [false, true] });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2" },
        { provider: "commandcode", id: "gpt-5.6-luna" },
      ]);
      assert.equal(extension.notifications.at(-1), "agent model → commandcode/gpt-5.6-luna");
    } finally {
      extension.restore();
    }
  });

  it("tier の全候補に失敗したら現在のモデルを維持し warning で通知する", async () => {
    const extension = captureAgentsExtension({ config }, { setModelSucceeds: false });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2" },
        { provider: "commandcode", id: "gpt-5.6-luna" },
      ]);
      assert.deepEqual(
        extension.notifications.at(-1),
        "no available model for agent manager: tier middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("agent 切り替え時の引数を切り替え後のユーザーメッセージとして送信する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat", "  hello world  ");
      assert.deepEqual(extension.sentMessages, [{ content: "hello world" }]);
    } finally {
      extension.restore();
    }
  });

  it("agent 切り替え後の follow-up は切替先の systemPrompt で実行される", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat", "hello");
      const prompt = await extension.beforeAgentStart("base");
      assert.equal(prompt.systemPrompt, "base\n\nチャット用");
      assert.deepEqual(extension.sentMessages, [{ content: "hello" }]);
    } finally {
      extension.restore();
    }
  });

  it("引数のない agent 切り替えはユーザーメッセージを送信しない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat");
      assert.deepEqual(extension.sentMessages, []);
    } finally {
      extension.restore();
    }
  });

  it("許可されないツールの tool_call をブロックし、セッション継続理由を返す", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat");
      const blockedCall = await extension.toolCall("bash");
      assert.deepEqual(blockedCall, { block: true, reason: "agent chat cannot use bash" });
    } finally {
      extension.restore();
    }
  });

  it("設定された systemPrompt を次回実行のシステムプロンプトへ追記する", async () => {
    const extension = captureAgentsExtension();
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
    const extension = captureAgentsExtension();
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
    const extension = captureAgentsExtension();
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
    const extension = captureAgentsExtension({ config }, { findModel: () => undefined });
    try {
      extension.context.model = { provider: "external", id: "kept" };
      await extension.sessionStart();
      const result = await extension.input("hello");
      assert.deepEqual(result, { action: "handled" });
      assert.deepEqual(extension.context.model, { provider: "external", id: "kept" });
      assert.equal(extension.sentMessages.length, 0);
      assert.deepEqual(
        extension.notifications.at(-1),
        "no available model for agent manager: tier middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("tier の候補が不成立でも別 tier へ降格せず現在のモデルを維持する", async () => {
    const noDowngradeConfig: AgentConfig = {
      default: "highProfile",
      tiers: {
        high: [{ provider: "zai", model: "high-model" }],
        low: [{ provider: "zai", model: "low-model" }],
      },
      agents: { highProfile: { tier: "high", tools: [], subagents: [], systemPrompt: [] } },
    };
    const extension = captureAgentsExtension(
      { config: noDowngradeConfig },
      {
        findModel: (_provider, id) => (id === "low-model" ? { provider: "zai", id } : undefined),
      },
    );
    try {
      extension.context.model = { provider: "external", id: "kept" };
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, []);
      assert.deepEqual(extension.context.model, { provider: "external", id: "kept" });
      assert.equal(
        extension.notifications.at(-1),
        "no available model for agent highProfile: tier high",
      );
    } finally {
      extension.restore();
    }
  });

  it("UI のない環境で全候補が不成立のとき stderr へ出力し終了コードを 1 にする", async () => {
    const extension = captureAgentsExtension({ config }, { findModel: () => undefined });
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
      assert.deepEqual(stderrLines, ["no available model for agent manager: tier middle\n"]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode ?? 0;
      extension.restore();
    }
  });

  it("拡張からのメッセージ（agent 切替 follow-up）は再評価しない", async () => {
    const extension = captureAgentsExtension();
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
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager (manual)"]);
    } finally {
      extension.restore();
    }
  });

  it("手動状態はプロンプト送信前の再評価を行わない", async () => {
    const extension = captureAgentsExtension();
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
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("restore");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager"]);
    } finally {
      extension.restore();
    }
  });

  it("agent 切り替えで手動状態を解除する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      await extension.runCommand("chat");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat"]);
    } finally {
      extension.restore();
    }
  });
});

describe("レート制限（429）時のフォールバック", () => {
  it("429 の fallback 成功時は最終エラーを retryable に置換し、user message を送らない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.providerResponse(429);
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: "provider error",
      });
      assert.equal(
        replacement.message.errorMessage,
        "429 rate limit error; already switched to a fallback model",
      );
      assert.equal(replacement.message.errorMessage.includes("provider error"), false);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.deepEqual(extension.notificationEvents.at(-1), {
        message: "rate limited on zai/glm-5.2; switched to commandcode/gpt-5.6-luna",
        level: "warning",
      });
      assert.equal(extension.sentMessages.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("quota 系 in-band エラーはフォールバック後の置換文言で pi-ai の retryable 判定を満たす", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const quotaError =
        "OpenAI API error: 429 insufficient_quota: You exceeded your current quota, please check your plan and billing details.";
      const erroredMessage = {
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: quotaError,
      };
      // pi-ai の実パターン判定: 置換前の quota 系メッセージは再試行不可
      assert.equal(isRetryableAssistantError(erroredMessage as never), false);

      const replacement = await extension.messageEnd(erroredMessage);
      const replacedErrorMessage: string = replacement.message.errorMessage;
      assert.equal(replacedErrorMessage.includes(quotaError), false);
      assert.equal(replacedErrorMessage.includes("insufficient_quota"), false);
      // pi-ai の実パターン判定: 置換後のメッセージは再試行可能
      assert.equal(isRetryableAssistantError(replacement.message), true);
    } finally {
      extension.restore();
    }
  });

  it("does not notify fallback switches without a UI", async () => {
    const extension = captureAgentsExtension();
    try {
      extension.context.hasUI = false;
      await extension.sessionStart();
      await extension.providerResponse(429);

      assert.deepEqual(extension.notifications, []);
    } finally {
      extension.restore();
    }
  });

  it("HTTP 429 の Retry-After を cooldown に適用してセッション切替後の候補選択へ反映する", async () => {
    const before = captureAgentsExtension();
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.providerResponse(429, { "retry-after": "120" });
      await before.sessionShutdown();

      after = captureAgentsExtension();
      await after.sessionStart("resume");
      assert.deepEqual(after.selectedModels, [{ provider: "commandcode", id: "gpt-5.6-luna" }]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("3候補では最大2回だけ再試行し、user message の履歴を増やさない", async () => {
    const threeCandidateConfig: AgentConfig = {
      default: "manager",
      tiers: {
        middle: [
          { provider: "zai", model: "first" },
          { provider: "zai", model: "second" },
          { provider: "zai", model: "third" },
        ],
      },
      agents: { manager: { tier: "middle", tools: [], subagents: [], systemPrompt: [] } },
    };
    const extension = captureAgentsExtension({ config: threeCandidateConfig });
    try {
      await extension.sessionStart();
      await extension.providerResponse(429);
      await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "first",
        errorMessage: "429",
      });
      await extension.providerResponse(429);
      await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "second",
        errorMessage: "429",
      });
      await extension.providerResponse(429);
      const finalRetry = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "third",
        errorMessage: "429",
      });
      assert.equal(finalRetry, undefined);
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "first" },
        { provider: "zai", id: "second" },
        { provider: "zai", id: "third" },
      ]);
      assert.equal(extension.sentMessages.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("1310 の fallback 成功時は最終エラーを retryable に置換する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: 'Error: {"code":"1310","message":"Weekly/Monthly Limit Exhausted"}',
      });
      assert.equal(
        replacement.message.errorMessage,
        "429 rate limit error; already switched to a fallback model",
      );
      assert.equal(replacement.message.errorMessage.includes("1310"), false);
      assert.equal(extension.sentMessages.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("非レート制限の最終assistantエラーでは切り替えない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const selectedModelCount = extension.selectedModels.length;
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: "Error: service unavailable",
      });
      assert.equal(replacement, undefined);
      assert.equal(extension.selectedModels.length, selectedModelCount);
      assert.equal(extension.sentMessages.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("HTTP 429 の後の同一最終エラーでは二重に fallback しない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.providerResponse(429);
      const selectedModelCount = extension.selectedModels.length;
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: "Error: 429: too many requests",
      });
      assert.equal(
        replacement.message.errorMessage,
        "429 rate limit error; already switched to a fallback model",
      );
      assert.equal(replacement.message.errorMessage.includes("too many requests"), false);
      assert.equal(extension.selectedModels.length, selectedModelCount);
      assert.equal(extension.sentMessages.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("次候補がない場合は retryable に置換せず user message を送らない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("worker");
      await extension.providerResponse(429);
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "commandcode",
        model: "gpt-5.6-luna",
        errorMessage: "Error: 429: too many requests",
      });
      assert.equal(replacement, undefined);
      assert.equal(extension.sentMessages.length, 0);
      const noFallback = extension.notificationEvents.at(-1);
      assert.ok(noFallback);
      assert.equal(noFallback.level, "error");
      assert.match(
        noFallback.message,
        /^rate limited on commandcode\/gpt-5.6-luna; no fallback available/,
      );
      assert.ok(noFallback.message.includes("Error: 429: too many requests"));
      assert.match(noFallback.message, /resend your message/i);
    } finally {
      extension.restore();
    }
  });

  it("in-band エラーで次候補がない場合も元エラーと再送案内を通知する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("worker");
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "commandcode",
        model: "gpt-5.6-luna",
        errorMessage: "Error: insufficient_quota: You exceeded your current quota",
      });
      assert.equal(replacement, undefined);
      assert.equal(extension.sentMessages.length, 0);
      const noFallback = extension.notificationEvents.at(-1);
      assert.ok(noFallback);
      assert.equal(noFallback.level, "error");
      assert.match(
        noFallback.message,
        /^rate limited on commandcode\/gpt-5.6-luna; no fallback available/,
      );
      assert.ok(
        noFallback.message.includes("Error: insufficient_quota: You exceeded your current quota"),
      );
      assert.match(noFallback.message, /resend your message/i);
    } finally {
      extension.restore();
    }
  });

  it("手動状態でもフォールバックし、手動状態を維持する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      await extension.providerResponse(429);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager (manual)"]);
    } finally {
      extension.restore();
    }
  });

  it("429 以外のステータスでは何もしない", async () => {
    const extension = captureAgentsExtension();
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
    const before = captureAgentsExtension({ config }, { flags: { agent: "chat" } });
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.modelSelect("set");
      await before.providerResponse(429); // cooldown を 1 つ作る
      await before.sessionShutdown();

      after = captureAgentsExtension();
      await after.sessionStart("reload");
      assert.deepEqual(after.agentWidget(), ["🤖 agent: chat (manual)"]);
      assert.equal(after.selectedModels.length, 0);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("設定変更を伴う /reload は保存済み agent が消えた場合に default agent へ戻す", async () => {
    const before = captureAgentsExtension({ config }, { flags: { agent: "chat" } });
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    const changedConfig: AgentConfig = {
      default: "manager",
      tiers: { middle: config.tiers.middle! },
      agents: { manager: config.agents.manager! },
    };
    try {
      await before.sessionStart("startup");
      await before.modelSelect("set");
      await before.sessionShutdown();

      after = captureAgentsExtension({ config: changedConfig });
      await after.sessionStart("reload");
      assert.deepEqual(after.agentWidget(), ["🤖 agent: manager (manual)"]);
      assert.equal(after.selectedModels.length, 0);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("/fork では手動選択状態を解除する", async () => {
    const before = captureAgentsExtension();
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.modelSelect("set");
      await before.sessionShutdown();

      after = captureAgentsExtension();
      await after.sessionStart("fork");
      assert.deepEqual(after.agentWidget(), ["🤖 agent: manager"]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("/new では cooldown を破棄して初期 agent の候補を適用する", async () => {
    const before = captureAgentsExtension();
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.providerResponse(429); // zai/glm-5.2 が cooldown
      await before.sessionShutdown();

      after = captureAgentsExtension();
      await after.sessionStart("new");
      assert.deepEqual(after.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("セッション切替（resume）では cooldown を維持して次候補を適用する", async () => {
    const before = captureAgentsExtension();
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.providerResponse(429); // zai/glm-5.2 が cooldown
      await before.sessionShutdown();

      after = captureAgentsExtension();
      await after.sessionStart("resume");
      assert.deepEqual(after.selectedModels, [{ provider: "commandcode", id: "gpt-5.6-luna" }]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("セッション開始時に手動選択状態を解除する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart("startup");
      await extension.modelSelect("set");
      await extension.sessionShutdown();
      await extension.sessionStart("new");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager"]);
    } finally {
      extension.restore();
    }
  });

  it("/new で全候補が不成立でも既存モデルを維持し warning を通知する", async () => {
    const extension = captureAgentsExtension({ config }, { findModel: () => undefined });
    try {
      extension.context.model = { provider: "external", id: "kept" };
      await extension.sessionStart("new");
      assert.deepEqual(extension.context.model, { provider: "external", id: "kept" });
      assert.equal(
        extension.notifications.at(-1),
        "no available model for agent manager: tier middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("/resume で全候補が不成立でも既存モデルを維持し warning を通知する", async () => {
    const extension = captureAgentsExtension({ config }, { findModel: () => undefined });
    try {
      extension.context.model = { provider: "external", id: "kept" };
      await extension.sessionStart("resume");
      assert.deepEqual(extension.context.model, { provider: "external", id: "kept" });
      assert.equal(
        extension.notifications.at(-1),
        "no available model for agent manager: tier middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("/fork で全候補が不成立でも既存モデルを維持し warning を通知する", async () => {
    const extension = captureAgentsExtension({ config }, { findModel: () => undefined });
    try {
      extension.context.model = { provider: "external", id: "kept" };
      await extension.sessionStart("fork");
      assert.deepEqual(extension.context.model, { provider: "external", id: "kept" });
      assert.equal(
        extension.notifications.at(-1),
        "no available model for agent manager: tier middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("/agent 切り替えで全候補が不成立でも既存モデルを維持し warning を通知する", async () => {
    const extension = captureAgentsExtension({ config }, { findModel: () => undefined });
    try {
      extension.context.model = { provider: "external", id: "kept" };
      await extension.runCommand("chat");
      assert.deepEqual(extension.context.model, { provider: "external", id: "kept" });
      assert.equal(extension.notifications.at(-1), "no available model for agent chat: tier low");
    } finally {
      extension.restore();
    }
  });
});

describe("subagent", () => {
  it("子 agent の tier、tools、systemPrompt、再委譲設定を適用する", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "delegated" }] } })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      await extension.runCommand("worker");
      assert.deepEqual(extension.activeTools.at(-1), ["bash", "subagent"]);
      const prompt = await extension.beforeAgentStart("base");
      assert.equal(prompt.systemPrompt, "base\n\nworker prompt");
      assert.equal(
        (await extension.executeSubagent({ agent: "chat", task: "work" })).isError,
        undefined,
      );
    } finally {
      extension.restore();
    }
  });

  it("許可された agent の subagent を起動し、セッションを隔離先へ記録して最終結果を親へ返す", async () => {
    const extension = captureAgentsExtension();
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
        agent: "worker",
        task: "work",
        cwd: "/child",
      });
      assert.equal(result.content[0].text, "done");
      assert.equal(extension.spawnCalls.length, 1);
      assert.equal(extension.spawnCalls[0]?.cwd, "/child");
      assert.deepEqual(extension.spawnCalls[0]?.args.slice(1), [
        "--mode",
        "json",
        "-p",
        "--agent",
        "worker",
        "--session-dir",
        subagentSessionDir(),
        "--name",
        "worker: work",
        "Task: work",
      ]);
    } finally {
      extension.restore();
    }
  });

  it("cwd を省略した subagent は親の cwd で起動する", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      await extension.executeSubagent({ agent: "worker", task: "work", model: "forbidden" });
      assert.equal(extension.spawnCalls[0]?.cwd, "/parent");
      assert.equal(extension.spawnCalls[0]?.args.includes("--model"), false);
    } finally {
      extension.restore();
    }
  });

  it("委譲が許可されない agent からの subagent を起動せず理由を返す", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "manager", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Permission denied/);
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("未定義 agent の subagent を起動せず理由を返す", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "missing", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /not defined/);
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("子が出力する前から pending の実行結果を onUpdate へ渡す", async () => {
    const extension = captureAgentsExtension();
    const updates: any[] = [];
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent(
        { agent: "worker", task: "work" },
        undefined,
        (update) => updates.push(update),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(updates[0].details.results[0].pending, true);

      extension.children[0]?.emit("close", 0);
      await execution;
    } finally {
      extension.restore();
    }
  });

  it("同時実行は2つまでで、3つ目以降は空きが出ると先に待機した順に起動する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const executions = [
        extension.executeSubagent({ agent: "worker", task: "first" }),
        extension.executeSubagent({ agent: "worker", task: "second" }),
        extension.executeSubagent({ agent: "worker", task: "third" }),
        extension.executeSubagent({ agent: "worker", task: "fourth" }),
      ];
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(extension.spawnCalls.length, 2);

      succeedChild(extension.children[0]!);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(extension.spawnCalls.length, 3);
      assert.match(extension.spawnCalls[2]!.args.at(-1)!, /Task: third/);

      succeedChild(extension.children[1]!);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(extension.spawnCalls.length, 4);
      assert.match(extension.spawnCalls[3]!.args.at(-1)!, /Task: fourth/);

      succeedChild(extension.children[2]!);
      succeedChild(extension.children[3]!);
      await Promise.all(executions);
    } finally {
      extension.restore();
    }
  });

  it("待機中の呼び出しは待機中の表示を onUpdate へ渡す", async () => {
    const extension = captureAgentsExtension();
    const updates: any[] = [];
    try {
      await extension.sessionStart();
      const first = extension.executeSubagent({ agent: "worker", task: "first" });
      const second = extension.executeSubagent({ agent: "worker", task: "second" });
      const waiting = extension.executeSubagent(
        { agent: "worker", task: "third" },
        undefined,
        (update) => updates.push(update),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(updates[0].content[0].text, "(waiting for a free subagent slot...)");

      succeedChild(extension.children[0]!);
      succeedChild(extension.children[1]!);
      await new Promise((resolve) => setImmediate(resolve));
      succeedChild(extension.children[2]!);
      await Promise.all([first, second, waiting]);
    } finally {
      extension.restore();
    }
  });

  it("待機中の呼び出しを親がキャンセルしたらエラーとして終了する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const controller = new AbortController();
      const first = extension.executeSubagent({ agent: "worker", task: "first" });
      const second = extension.executeSubagent({ agent: "worker", task: "second" });
      const waiting = extension.executeSubagent(
        { agent: "worker", task: "third" },
        controller.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(extension.spawnCalls.length, 2);

      controller.abort();
      const result = await waiting;
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /aborted/);
      assert.equal(extension.spawnCalls.length, 2);

      succeedChild(extension.children[0]!);
      succeedChild(extension.children[1]!);
      await Promise.all([first, second]);
    } finally {
      extension.restore();
    }
  });

  it("実行中は 0.1 秒ごとに TUI の再描画を要求する", async () => {
    const extension = captureAgentsExtension();
    const originalTimers = { ...__spinnerTimers };
    let spinnerCallback: (() => void) | undefined;
    let spinnerIntervalMs: number | undefined;
    __spinnerTimers.set = (callback, intervalMs) => {
      spinnerCallback = callback;
      spinnerIntervalMs = intervalMs;
      return callback as unknown as ReturnType<typeof setInterval>;
    };
    __spinnerTimers.clear = () => {};
    try {
      await extension.sessionStart();
      extension.agentWidget();
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
      spinnerCallback?.();

      assert.deepEqual(
        { spinnerIntervalMs, requestedRenderCount: extension.requestedRenderCount() },
        { spinnerIntervalMs: 100, requestedRenderCount: 1 },
      );

      extension.children[0]?.emit("close", 0);
      await execution;
    } finally {
      Object.assign(__spinnerTimers, originalTimers);
      extension.restore();
    }
  });

  it("subagent の実行中に子の結果を onUpdate へ渡す", async () => {
    const extension = captureAgentsExtension();
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
      await extension.executeSubagent({ agent: "worker", task: "work" }, undefined, (update) =>
        updates.push(update),
      );
      assert.equal(updates.length, 4);
      assert.equal(updates[1].details.results[0].actions[0].name, "bash");
      assert.equal(updates[1].details.results[0].actions[0].args.command, "pwd");
    } finally {
      extension.restore();
    }
  });

  it("tool_execution_end の結果を toolCallId で対応する action へ紐づける", async () => {
    const extension = captureAgentsExtension();
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
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      const action = result.details.results[0].actions[0];
      assert.equal(action.result?.content?.[0]?.text, "/child");
      assert.equal(action.isError, false);
      assert.ok(action.startedAt !== undefined && action.endedAt !== undefined);
    } finally {
      extension.restore();
    }
  });

  it("toolCallId のない tool_execution_end はどの action にも紐づけない", async () => {
    const extension = captureAgentsExtension();
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
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.details.results[0].actions[0].result, undefined);
    } finally {
      extension.restore();
    }
  });

  it("親のキャンセルを SIGTERM として子へ伝播し、子を中断結果にする", async () => {
    const extension = captureAgentsExtension();
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
        { agent: "worker", task: "work" },
        controller.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      const result = await execution;
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0].stopReason, "aborted");
      assert.match(result.content[0].text, /aborted/);
      assert.deepEqual(extension.children[0]?.killHistory, ["SIGTERM"]);
      assert.equal(scheduledAbortTimer, true);
      assert.equal(clearedAbortTimer, true);
    } finally {
      __abortTimer.set = originalAbortTimer;
      __abortTimer.clear = originalClearAbortTimer;
      extension.restore();
    }
  });

  it("SIGTERM を無視する子へ 5 秒後に SIGKILL を送る", async () => {
    const extension = captureAgentsExtension();
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
        { agent: "worker", task: "work" },
        controller.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runAbortTimer !== undefined, true);
      runAbortTimer?.();
      const result = await execution;
      assert.equal(result.isError, true);
      assert.deepEqual(extension.children[0]?.killHistory, ["SIGTERM", "SIGKILL"]);
    } finally {
      __abortTimer.set = originalAbortTimer;
      extension.restore();
    }
  });

  it("子が exit しても close が来なければ、静穏タイマーで結果を確定する", async () => {
    const extension = captureAgentsExtension();
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
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
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
    const extension = captureAgentsExtension();
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
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
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
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => child.emit("close", null));
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0].stopReason, "killed");
      assert.match(result.content[0].text, /killed by a signal/);
    } finally {
      extension.restore();
    }
  });

  it("非0終了した子をエラーとして stderr を親へ返す", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stderr.emit("data", Buffer.from("child stderr\n"));
      child.emit("close", 2);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Child failed: child stderr\n");
    } finally {
      extension.restore();
    }
  });

  it("子プロセスの error イベントを優先して親へ返す", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stderr.emit("data", Buffer.from("stderr fallback\n"));
      child.emit("error", new Error("spawn failed"));
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Child failed: spawn failed");
    } finally {
      extension.restore();
    }
  });

  it("子の error stopReason では errorMessage を stderr と最終出力より優先する", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stderr.emit("data", Buffer.from("stderr fallback\n"));
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "assistant error",
              content: [{ type: "text", text: "final text" }],
            },
          })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Child error: assistant error");
    } finally {
      extension.restore();
    }
  });

  it("exit 0 でも出力のない子をエラーとして親へ返す", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => child.emit("close", 0));
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Child failed: (no output)");
    } finally {
      extension.restore();
    }
  });

  it("exit 0 で出力がなく stderr がある子は stderr を失敗出力として親へ返す", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stderr.emit("data", Buffer.from("no available model for agent worker: tier low\n"));
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        "Child failed: no available model for agent worker: tier low\n",
      );
    } finally {
      extension.restore();
    }
  });

  it("正常終了した子に対する親の abort を無視する", async () => {
    const extension = captureAgentsExtension();
    const controller = new AbortController();
    extension.respondToChild((child) => child.emit("close", 0));
    try {
      await extension.sessionStart();
      await extension.executeSubagent({ agent: "worker", task: "work" }, controller.signal);
      controller.abort();

      assert.deepEqual(extension.children[0]?.killHistory, []);
    } finally {
      extension.restore();
    }
  });

  it("設定エラーを subagent のエラー結果として返す", async () => {
    const extension = captureAgentsExtension({ error: "invalid config" });
    try {
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid config/);
    } finally {
      extension.restore();
    }
  });

  it("空の task を拒否し、子プロセスを起動しない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "" });
      assert.equal(result.content[0].text, "Invalid parameters. Provide a task.");
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("agent の設定エラーを session_start で owner に通知する", async () => {
    const extension = captureAgentsExtension({ error: "invalid config" });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.notifications, ["agent configuration error: invalid config"]);
    } finally {
      extension.restore();
    }
  });
});

describe("subagent の表示", () => {
  it("呼び出し時に subagent と agent 名を表示する", () => {
    const extension = captureAgentsExtension();
    try {
      const rendered = extension.renderCall(
        { agent: "worker" },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      ) as Text;
      assert.ok(rendered.render(200).some((line) => line.includes("subagent worker")));
    } finally {
      extension.restore();
    }
  });

  it("Actions をツール別の整形と結果サマリー行で表示する", () => {
    const extension = captureAgentsExtension();
    const details = {
      results: [
        {
          agent: "worker",
          task: "work",
          cwd: "/child",
          pending: false,
          exitCode: 0,
          messages: [],
          actions: [
            {
              toolCallId: "call-1",
              name: "edit",
              args: { path: "/child/a.ts", edits: [{ oldText: "x", newText: "y" }] },
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
      assert.ok(lines.some((line) => line.includes("→ edit ./a.ts")));
      assert.ok(lines.some((line) => line.includes("  edited 1 block(s)")));
    } finally {
      extension.restore();
    }
  });

  it("結果を受け取る前のツール呼び出しは結果行を表示しない", () => {
    const extension = captureAgentsExtension();
    const details = {
      results: [
        {
          agent: "worker",
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
    const extension = captureAgentsExtension();
    const details = {
      results: [
        {
          agent: "worker",
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
      assert.equal(
        lines.at(-1) &&
          SPINNER_FRAMES.some((frame) => lines.at(-1)?.includes(`[muted]${frame} worker`)),
        true,
      );
    } finally {
      extension.restore();
    }
  });

  it("再描画時に待機スピナーのフレームを進める", () => {
    const extension = captureAgentsExtension();
    const originalNow = __spinnerTimers.now;
    const details = {
      results: [
        {
          agent: "worker",
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
      __spinnerTimers.now = () => 0;
      const rendered = extension.renderResult(
        { content: [], details },
        {},
        {
          fg: (color: string, text: string) => `[${color}]${text}`,
          bold: (text: string) => `*${text}*`,
        },
      ) as Container;
      const initialLines = rendered.render(200);

      __spinnerTimers.now = () => 100;
      const nextLines = rendered.render(200);

      assert.deepEqual(
        [initialLines.length, nextLines.length, initialLines.at(-1), nextLines.at(-1)],
        [4, 4, "[muted]⠋ worker", "[muted]⠙ worker"],
      );
    } finally {
      __spinnerTimers.now = originalNow;
      extension.restore();
    }
  });

  it("実行確定時に表示済みのスピナー行を消す", () => {
    const extension = captureAgentsExtension();
    const details = {
      results: [
        {
          agent: "worker",
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
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      ) as Container;
      const displayedSpinnerLine = rendered
        .render(200)
        .some((line) => SPINNER_FRAMES.some((frame) => line.includes(`${frame} worker`)));

      details.results[0]!.pending = false;
      const clearedSpinnerLine = rendered
        .render(200)
        .some((line) => SPINNER_FRAMES.some((frame) => line.includes(`${frame} worker`)));

      assert.deepEqual([displayedSpinnerLine, clearedSpinnerLine], [true, false]);
    } finally {
      extension.restore();
    }
  });

  it("task、Actions、確定した Output の内容を展開表示する", () => {
    const extension = captureAgentsExtension();
    const details = {
      results: [
        {
          agent: "worker",
          task: "inspect files",
          cwd: "/child",
          pending: false,
          exitCode: 0,
          messages: [{ role: "assistant", content: [{ type: "text", text: "finished" }] }],
          actions: [
            {
              toolCallId: "call-1",
              name: "bash",
              args: { command: "pwd" },
              startedAt: 1000,
              endedAt: 1100,
              result: { content: [{ type: "text", text: "/child" }] },
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
        { isPartial: false },
        {
          fg: (color: string, text: string) => `[${color}]${text}`,
          bold: (text: string) => `*${text}*`,
        },
      ) as Container;
      const lines = rendered.render(200);
      const sectionLines = lines
        .filter((line) => line.startsWith("[muted]┌") || line.startsWith("[muted]└"))
        .map((line) => line.trimEnd());
      assert.deepEqual(sectionLines, [
        "[muted]┌─── Task ──────",
        "[muted]└───────────────",
        "[muted]┌─── Actions ───（ツール利用がある場合のみ表示）",
        "[muted]└───────────────",
        "[muted]┌─── Output ────（出力が確定したときに表示）",
        "[muted]└───────────────",
      ]);
      assert.ok(lines.some((line) => line.includes("inspect files")));
      assert.ok(lines.some((line) => line.includes("[text]inspect files")));
      assert.ok(lines.some((line) => line.includes("pwd")));
      assert.ok(lines.some((line) => line.includes("finished")));
    } finally {
      extension.restore();
    }
  });

  it("ツール利用がない場合は Actions を表示しない", () => {
    const extension = captureAgentsExtension();
    const details = {
      results: [
        { agent: "worker", task: "work", exitCode: 0, messages: [], actions: [], stderr: "" },
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
        lines.some((line) => line.includes("┌─── Actions ")),
        false,
      );
      assert.equal(lines.filter((line) => line.trimEnd() === "└───────────────").length, 1);
    } finally {
      extension.restore();
    }
  });

  it("出力が確定するまで Output を表示しない", () => {
    const extension = captureAgentsExtension();
    const details = {
      results: [
        {
          agent: "worker",
          task: "work",
          exitCode: 0,
          messages: [{ role: "assistant", content: [{ type: "text", text: "partial final" }] }],
          actions: [],
          stderr: "",
        },
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
      const lines = (rendered as Container).render(200);
      assert.equal(
        lines.some((line) => line.includes("┌─── Output ")),
        false,
      );
      assert.equal(lines.filter((line) => line.trimEnd() === "└───────────────").length, 1);
    } finally {
      extension.restore();
    }
  });

  it("出力がある場合だけ Output を表示する", () => {
    const extension = captureAgentsExtension();
    const details = {
      results: [
        {
          agent: "worker",
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
      const lines = (rendered as Container).render(200);
      assert.ok(lines.some((line) => line.includes("┌─── Output ")));
      assert.equal(lines.filter((line) => line.trimEnd() === "└───────────────").length, 2);
    } finally {
      extension.restore();
    }
  });
});

describe("sessionNameFor", () => {
  it("prefixes agent name to the first line of the task", () => {
    const name = sessionNameFor("junior", "目的: バローのURL確定\n\n背景: JAN価格DB");
    assert.equal(name, "junior: 目的: バローのURL確定");
  });

  it("truncates long first lines with an ellipsis", () => {
    const long = "あ".repeat(50);
    const name = sessionNameFor("junior", long);
    const expectedLength = Array.from("junior: ").length + 30 + 1;
    assert.equal(Array.from(name).length, expectedLength);
    assert.ok(name.endsWith("…"));
  });

  it("falls back to the agent name for an empty task", () => {
    assert.equal(sessionNameFor("senior", ""), "senior");
  });
});

describe("childInvocationArgs", () => {
  it("records sessions to the isolated subagent-sessions dir instead of --no-session", () => {
    const args = childInvocationArgs("junior", "do the thing");
    assert.ok(!args.includes("--no-session"));
    const dirIndex = args.indexOf("--session-dir");
    assert.notEqual(dirIndex, -1);
    assert.ok(args[dirIndex + 1].endsWith("subagent-sessions"));
    const nameIndex = args.indexOf("--name");
    assert.equal(args[nameIndex + 1], "junior: do the thing");
    assert.equal(args.at(-1), "Task: do the thing");
  });
});

describe("cleanupOldSubagentSessions", () => {
  it("removes jsonl files older than 30 days and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-sessions-"));
    try {
      const oldFile = join(dir, "old.jsonl");
      const freshFile = join(dir, "fresh.jsonl");
      const otherFile = join(dir, "keep.txt");
      writeFileSync(oldFile, "{}");
      writeFileSync(freshFile, "{}");
      writeFileSync(otherFile, "x");
      const now = Date.now();
      const staleDate = new Date(now - 31 * 24 * 60 * 60 * 1000);
      utimesSync(oldFile, staleDate, staleDate);

      const removed = cleanupOldSubagentSessions(dir, now);

      assert.equal(removed, 1);
      assert.ok(!existsSync(oldFile));
      assert.ok(existsSync(freshFile));
      assert.ok(existsSync(otherFile));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 when the directory does not exist", () => {
    const missing = join(tmpdir(), `pi-no-such-dir-${Date.now()}`);
    assert.equal(cleanupOldSubagentSessions(missing), 0);
  });

  it("ignores directories named like session files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-sessions-"));
    try {
      const nested = join(dir, "nested.jsonl");
      mkdirSync(nested);
      const now = Date.now();
      const staleDate = new Date(now - 40 * 24 * 60 * 60 * 1000);
      utimesSync(nested, staleDate, staleDate);

      assert.equal(cleanupOldSubagentSessions(dir, now), 0);
      assert.ok(existsSync(nested));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
