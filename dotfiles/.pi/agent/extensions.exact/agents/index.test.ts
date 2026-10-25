import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
  __updateTimers,
  createThrottledEmitter,
  agentConfigPath,
  type AgentConfig,
  buildAgentSystemPromptAddendum,
  canDelegate,
  childAgent,
  childInvocationArgs,
  resolveChildSession,
  subagentSessionDir,
  initialAgent,
  loadAgentConfig,
  parseAgentConfig,
  shouldBlockToolCall,
} from "./index";
import { SPINNER_FRAMES, spinnerFrame } from "../titlebar/index.ts";
import { ERROR_OUTPUT_PREVIEW_LIMIT } from "../shared/tool-text.ts";
import { renderersOf } from "../tool-renderer/index.ts";
import { CLASS_CHANGE_EVENT, requestClassChange } from "./class-change.ts";

const config: AgentConfig = {
  default: "manager",
  classes: {
    middle: [
      { provider: "zai", model: "glm-5.2" },
      { provider: "commandcode", model: "gpt-5.6-luna" },
    ],
    low: [{ provider: "commandcode", model: "gpt-5.6-luna" }],
    vision: [{ provider: "zai", model: "glm-5.3-flash" }],
  },
  agents: {
    manager: {
      class: "middle",
      tools: ["*", "!replace_context"],
      subagents: ["worker", "vision"],
      systemPrompt: ["ファイル操作は禁止"],
    },
    worker: { class: "low", tools: ["bash"], subagents: ["chat"], systemPrompt: ["worker prompt"] },
    chat: {
      class: "low",
      tools: ["web_search", "web_fetch"],
      subagents: [],
      systemPrompt: ["チャット用"],
    },
    locked: { class: "low", tools: [], subagents: [], systemPrompt: [] },
    vision: {
      class: "vision",
      tools: ["*"],
      subagents: [],
      systemPrompt: ["visual prompt"],
    },
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
  classSelection?: string;
  beforeSetModel?: () => Promise<void>;
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
  const spawnCalls: Array<{
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
  }> = [];
  const appendedEntries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const children: FakeChild[] = [];
  let spawnResponder: (child: FakeChild) => void = () => {};
  let agentWidget: any;
  let requestedRenderCount = 0;
  let registeredTool: CapturedTool | undefined;
  const eventBusHandlers = new Map<string, Array<(data: unknown) => void>>();
  const classChangeRequests: unknown[] = [];

  const originalSpawn = __spawn.current;
  __spawn.current = ((
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
  ) => {
    const child = new FakeChild();
    spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
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
      appendEntry(customType: string, data: Record<string, unknown>) {
        appendedEntries.push({ customType, data });
      },
      setActiveTools(tools: string[]) {
        activeTools.push(tools);
      },
      async setModel(model: unknown) {
        const attemptIndex = selectedModels.length;
        selectedModels.push(model);
        await options.beforeSetModel?.();
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
      events: {
        emit(channel: string, data: unknown) {
          if (channel === CLASS_CHANGE_EVENT) classChangeRequests.push(data);
          for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
        },
        on(channel: string, handler: (data: unknown) => void) {
          const list = eventBusHandlers.get(channel) ?? [];
          eventBusHandlers.set(channel, [...list, handler]);
          return () => {
            eventBusHandlers.set(
              channel,
              (eventBusHandlers.get(channel) ?? []).filter((registered) => registered !== handler),
            );
          };
        },
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
    async select(_title: string, _items: string[]) {
      return options.classSelection;
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
    appendedEntries,
    classChangeRequests,
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
    async turnStart() {
      for (const handler of handlers.get("turn_start") ?? [])
        await handler({ type: "turn_start", turnIndex: 0, timestamp: 0 }, context);
    },
    requestClassChange(className: string) {
      return requestClassChange(
        {
          emit(channel, data) {
            for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
          },
          on() {
            return () => {};
          },
        },
        {
          class: className,
          context: context as never,
          preserveManualSelection: true,
          requiredAgent: "main",
        },
      );
    },
    async runCommand(agent: string, args = "") {
      await commands.get(`agent:${agent}`)?.(args, context);
    },
    async runClassCommand(args = "") {
      await commands.get("class")?.(args, context);
    },
    async input(
      text: string,
      source = "interactive",
      images?: Array<{ type: "image"; data: string; mimeType: string }>,
    ) {
      let result: unknown;
      for (const handler of handlers.get("input") ?? []) {
        const handled = await handler({ text, source, ...(images ? { images } : {}) }, context);
        if (handled) result = handled;
      }
      return result;
    },
    async modelSelect(source: string, model?: { provider: string; id: string; input?: string[] }) {
      for (const handler of handlers.get("model_select") ?? [])
        await handler(
          model ? { source, model, previousModel: context.model } : { source },
          context,
        );
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
      toolCallId = "call",
    ) {
      return registeredTool?.execute(toolCallId, params, signal, onUpdate, context);
    },
    renderCall(...args: any[]) {
      return renderersOf("subagent")?.renderCall?.(...(args as [any, any, any]));
    },
    renderResult(...args: any[]) {
      return renderersOf("subagent")?.renderResult?.(...(args as [any, any, any, any]));
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

  it("YAML を class つき agent 設定として読み込む", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle:
    - provider: zai
      model: glm-5.2
      when: 'exit 0'
  vision: [{provider: zai, model: glm-5.3-flash}]
agents:
  manager:
    class: middle
    tools: [read]
    subagents: []
    systemPrompt: [hello]
  vision:
    class: vision
    tools: ["*"]
    subagents: []
    systemPrompt: []`);
    assert.equal(result.config?.default, "manager");
    assert.deepEqual(result.config?.classes.middle, [
      { provider: "zai", model: "glm-5.2", when: "exit 0" },
    ]);
    assert.equal(result.config?.agents.manager?.class, "middle");
    assert.deepEqual(result.config?.agents.manager?.tools, ["read"]);
  });

  it("YAML アンカーで共有した prompt 要素を配列として読み込む", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
_common: &common shared
agents:
  manager:
    class: middle
    tools: []
    subagents: []
    systemPrompt: [*common]
  vision:
    class: vision
    tools: ["*"]
    subagents: []
    systemPrompt: []`);
    assert.deepEqual(result.config?.agents.manager?.systemPrompt, ["shared"]);
  });

  it("集約された config ディレクトリから agent 設定を読み込む", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agents-config-test-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const configPath = join(agentDir, "config", "agents.yaml");
      mkdirSync(join(agentDir, "config"));
      writeFileSync(
        configPath,
        `default: manager
classes:
  middle: []
  vision: []
agents:
  manager:
    class: middle
    tools: ["!replace_context"]
    subagents: [vision]
    systemPrompt: []
  vision:
    class: vision
    tools: ["*"]
    subagents: []
    systemPrompt: []
`,
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      assert.equal(agentConfigPath(agentDir), configPath);
      const result = loadAgentConfig();
      assert.equal(result.config?.default, "manager");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    }
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
classes: {}`);
    assert.match(result.error ?? "", /default and agents are required/);
  });

  it("agents がオブジェクトでない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
agents: []
classes: {}`);
    assert.match(result.error ?? "", /default and agents are required/);
  });

  it("class の候補要素がオブジェクトでない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [invalid]
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /candidate must be an object/);
  });

  it("agent 定義がオブジェクトでない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: []
agents:
  manager: invalid`);
    assert.match(result.error ?? "", /agent manager must be an object/);
  });

  it("tools の要素が文字列でない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: []
agents:
  manager: {class: middle, tools: [123], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid tools/);
  });

  it("subagents の要素が文字列でない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: []
agents:
  manager: {class: middle, tools: [], subagents: [123], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid subagents/);
  });

  it("systemPrompt の要素が文字列でない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: []
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: [123]}`);
    assert.match(result.error ?? "", /invalid systemPrompt/);
  });

  it("複数の systemPrompt 要素を順序どおりに読み込み、agent 間で共有する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
_common: &common shared
agents:
  manager:
    class: middle
    tools: []
    subagents: []
    systemPrompt: [*common, manager-only]
  worker:
    class: middle
    tools: []
    subagents: []
    systemPrompt: [*common, worker-only]
  vision:
    class: vision
    tools: ["*"]
    subagents: []
    systemPrompt: []`);
    assert.deepEqual(result.config?.agents.manager?.systemPrompt, ["shared", "manager-only"]);
    assert.deepEqual(result.config?.agents.worker?.systemPrompt, ["shared", "worker-only"]);
  });

  it("classes がない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /classes are required/);
  });

  it("class が配列でないものを拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: {provider: zai}
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /must be an array/);
  });

  it("provider か model のない候補を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle:
    - provider: zai
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /provider and model strings/);
  });

  it("when が文字列でない候補を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle:
    - {provider: zai, model: glm-5.2, when: 123}
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid when/);
  });

  it("agent の class がない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager: {tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /invalid class/);
  });

  it("未定義の class を参照する agent を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager: {class: high, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /undefined class high/);
  });

  it("配列でない systemPrompt を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager:
    class: middle
    tools: []
    subagents: []
    systemPrompt: hello`);
    assert.match(result.error ?? "", /invalid systemPrompt/);
  });

  it("未定義の default agent を拒否する", () => {
    const result = parseAgentConfig(`default: missing
classes:
  middle: [{provider: zai, model: glm-5.2}]
agents: {}`);
    assert.match(result.error ?? "", /not defined/);
  });

  it("未定義の委譲先を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager:
    class: middle
    tools: []
    subagents: [missing]
    systemPrompt: []`);
    assert.match(result.error ?? "", /undefined agent/);
  });

  it("廃止した profiles キーを agent 定義として受け入れない", () => {
    const result = parseAgentConfig(`default: main
classes:
  high: []
profiles:
  main: {class: high, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /default and agents are required/);
  });

  it("vision がない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /vision agent is required/);
  });

  it("vision が vision class を参照しない設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
agents:
  manager: {class: middle, tools: [], subagents: [], systemPrompt: []}
  vision: {class: middle, tools: ["*"], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /must use the vision class/);
  });

  it("main と senior の subagents に vision がない設定を拒否する", () => {
    const result = parseAgentConfig(`default: main
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
agents:
  main: {class: middle, tools: ["*", "!replace_context"], subagents: [], systemPrompt: []}
  senior: {class: middle, tools: ["*", "!replace_context"], subagents: [vision], systemPrompt: []}
  junior: {class: middle, tools: ["*", "!replace_context"], subagents: [], systemPrompt: []}
  vision: {class: vision, tools: ["*"], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /must delegate to vision/);
  });

  it("junior が vision を委譲先に持つ設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
agents:
  manager: {class: middle, tools: ["*", "!replace_context"], subagents: [vision], systemPrompt: []}
  senior: {class: middle, tools: ["*", "!replace_context"], subagents: [vision], systemPrompt: []}
  junior: {class: middle, tools: ["*", "!replace_context"], subagents: [vision], systemPrompt: []}
  vision: {class: vision, tools: ["*"], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /junior must not delegate to vision/);
  });

  it("vision が vision class で受け入れられる", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
agents:
  manager: {class: middle, tools: ["*"], subagents: [vision], systemPrompt: []}
  vision: {class: vision, tools: ["*"], subagents: [], systemPrompt: []}`);
    assert.equal(result.error, undefined);
  });

  it("vision と junior の tools・systemPrompt が異なっても設定検証を通す", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
agents:
  manager: {class: middle, tools: ["*"], subagents: [vision], systemPrompt: []}
  junior: {class: middle, tools: [bash], subagents: [], systemPrompt: [junior prompt]}
  vision: {class: vision, tools: ["*", "!replace_context"], subagents: [], systemPrompt: [vision prompt]}`);
    assert.equal(result.error, undefined);
  });

  it("否定指定が ! 単体の設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
agents:
  manager: {class: middle, tools: ["!"], subagents: [vision], systemPrompt: []}
  vision: {class: vision, tools: ["*"], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /bare "!" negation/);
  });

  it("同じツールを許可と否定の両方で指定する設定を拒否する", () => {
    const result = parseAgentConfig(`default: manager
classes:
  middle: [{provider: zai, model: glm-5.2}]
  vision: [{provider: zai, model: glm-5.3-flash}]
agents:
  manager: {class: middle, tools: [read, "!read", "*"], subagents: [vision], systemPrompt: []}
  vision: {class: vision, tools: ["*"], subagents: [], systemPrompt: []}`);
    assert.match(result.error ?? "", /both allows and negates tool read/);
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

  it("!<tool> はワイルドカードがあってもそのツールを拒否する", () => {
    assert.equal(shouldBlockToolCall("manager", "replace_context", config), true);
    assert.equal(isToolAllowed("manager", "future_tool", config), true);
  });
});

function isToolAllowed(
  agent: Parameters<typeof shouldBlockToolCall>[0],
  toolName: string,
  agentConfig: Parameters<typeof shouldBlockToolCall>[2],
): boolean {
  return !shouldBlockToolCall(agent, toolName, agentConfig);
}

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
  it("titlebar と同じ10フレームを 80 ミリ秒間隔で循環させる", () => {
    const displayedFrames = SPINNER_FRAMES.map((_, frameIndex) => spinnerFrame(frameIndex * 80));

    assert.deepEqual(displayedFrames, SPINNER_FRAMES);
  });
});

describe("拡張の接続", () => {
  it("起動時に default agent の class 候補を適用し、agent 表示と allowlist を更新する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
      assert.deepEqual(extension.notifications, ["agent model → zai/glm-5.2"]);
      assert.deepEqual(extension.notificationEvents, [
        { message: "agent model → zai/glm-5.2", level: "info" },
      ]);
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
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
      assert.deepEqual(extension.registeredFlags, ["agent", "class"]);
      await extension.sessionStart();
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat", "💎 class: low (auto)"]);
      assert.deepEqual(extension.selectedModels, [{ provider: "commandcode", id: "gpt-5.6-luna" }]);
    } finally {
      extension.restore();
    }
  });

  it("agent 切り替え時に class 候補のモデル、ツール、表示を切り替える", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runCommand("chat");
      assert.deepEqual(extension.activeTools.at(-1), ["web_search", "web_fetch", "subagent"]);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat", "💎 class: low (manual)"]);
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

  it("class の全候補に失敗したら現在のモデルを維持し warning で通知する", async () => {
    const extension = captureAgentsExtension({ config }, { setModelSucceeds: false });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2" },
        { provider: "commandcode", id: "gpt-5.6-luna" },
      ]);
      assert.deepEqual(
        extension.notifications.at(-1),
        "no available model for agent manager: class middle",
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

describe("class によるモデルルーティング", () => {
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
        "no available model for agent manager: class middle",
      );
    } finally {
      extension.restore();
    }
  });

  it("class の候補が不成立でも別 class へ降格せず現在のモデルを維持する", async () => {
    const noDowngradeConfig: AgentConfig = {
      default: "highProfile",
      classes: {
        high: [{ provider: "zai", model: "high-model" }],
        low: [{ provider: "zai", model: "low-model" }],
      },
      agents: { highProfile: { class: "high", tools: [], subagents: [], systemPrompt: [] } },
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
        "no available model for agent highProfile: class high",
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
      assert.deepEqual(stderrLines, ["no available model for agent manager: class middle\n"]);
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

  it("自動選択は画像能力で候補を除外しない", async () => {
    const extension = captureAgentsExtension(
      { config },
      {
        findModel: (provider, id) => ({
          provider,
          id,
          input: id === "glm-5.2" ? ["text", "image"] : ["text"],
        }),
      },
    );
    try {
      await extension.sessionStart();
      // class はデフォルトフォールバックの候補順序であり、モデルの種類による制限は
      // しない。仮に画像対応除外が復活すると先頭候補が飛ばされて次候補
      // （gpt-5.6-luna）へ変わり、この assert が失敗する。
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2", input: ["text", "image"] },
      ]);
    } finally {
      extension.restore();
    }
  });

  it("main の自動選択は class 先頭の画像対応候補を除外しない", async () => {
    const extension = captureAgentsExtension(
      {
        config: {
          ...config,
          default: "main",
          agents: {
            ...config.agents,
            main: {
              class: "middle",
              tools: ["*", "!replace_context"],
              subagents: ["worker", "vision"],
              systemPrompt: [],
            },
          },
        },
      },
      {
        findModel: (provider, id) => ({
          provider,
          id,
          input: id === "glm-5.2" ? ["text", "image"] : ["text"],
        }),
      },
    );
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2", input: ["text", "image"] },
      ]);
    } finally {
      extension.restore();
    }
  });

  it("vision の自動選択は vision class の画像非対応候補を除外しない", async () => {
    const extension = captureAgentsExtension(
      { config },
      { findModel: (provider, id) => ({ provider, id, input: ["text"] }) },
    );
    try {
      await extension.sessionStart();
      await extension.runCommand("vision");
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2", input: ["text"] },
        { provider: "zai", id: "glm-5.3-flash", input: ["text"] },
      ]);
      assert.ok(!extension.notifications.some((message) => message.includes("no available model")));
    } finally {
      extension.restore();
    }
  });
});

describe("class 選択", () => {
  it("/class <name> で実効 class を切り替え、モデルと表示を切り替える", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runClassCommand("low");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (manual)"]);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
      assert.ok(extension.notifications.includes("agent model → commandcode/gpt-5.6-luna"));
    } finally {
      extension.restore();
    }
  });

  it("/class で手動選択を解除する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      await extension.runClassCommand("low");
      // 手動状態が解除されていれば、モデルが実効 class の候補と異なるときに再評価で切替わる
      extension.context.model = { provider: "external", id: "other" };
      await extension.input("hello");
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
    } finally {
      extension.restore();
    }
  });

  it("/class に未定義の名前は warning で無視する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const modelCountBefore = extension.selectedModels.length;
      await extension.runClassCommand("nope");
      assert.deepEqual(extension.notificationEvents.at(-1), {
        message: "unknown class: nope",
        level: "warning",
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
      assert.equal(extension.selectedModels.length, modelCountBefore);
    } finally {
      extension.restore();
    }
  });

  it("/class の引数なしは選択 UI で class を選ぶ", async () => {
    const extension = captureAgentsExtension({ config }, { classSelection: "low" });
    try {
      await extension.sessionStart();
      await extension.runClassCommand();
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (manual)"]);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
    } finally {
      extension.restore();
    }
  });

  it("/class の選択 UI をキャンセルしたら何も変更しない", async () => {
    const extension = captureAgentsExtension({ config }, { classSelection: undefined });
    try {
      await extension.sessionStart();
      const modelCountBefore = extension.selectedModels.length;
      await extension.runClassCommand();
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
      assert.equal(extension.selectedModels.length, modelCountBefore);
      // キャンセルで新たな通知・モデル適用は起きない（notifications は sessionStart の1件のみ）
      assert.deepEqual(extension.notifications, ["agent model → zai/glm-5.2"]);
    } finally {
      extension.restore();
    }
  });

  it("UI のない環境で /class の引数を省略するとエラーを通知して変更しない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      extension.context.hasUI = false;
      await extension.runClassCommand();
      assert.deepEqual(extension.notificationEvents.at(-1), {
        message: "usage: /class <class-name>",
        level: "error",
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
    } finally {
      extension.restore();
    }
  });

  it("--class フラグで初期 class を指定できる", async () => {
    const extension = captureAgentsExtension({ config }, { flags: { class: "low" } });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (auto)"]);
      assert.deepEqual(extension.selectedModels, [{ provider: "commandcode", id: "gpt-5.6-luna" }]);
    } finally {
      extension.restore();
    }
  });

  it("--class と --agent は併用でき、agent と class は独立に選ばれる", async () => {
    const extension = captureAgentsExtension(
      { config },
      { flags: { agent: "chat", class: "middle" } },
    );
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat", "💎 class: middle (auto)"]);
      assert.deepEqual(extension.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
    } finally {
      extension.restore();
    }
  });

  it("--class に未定義の値は warning で無視し既定 class で開始する", async () => {
    const extension = captureAgentsExtension({ config }, { flags: { class: "nope" } });
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
      assert.deepEqual(extension.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
      assert.deepEqual(extension.notificationEvents.at(-2), {
        message: "unknown class flag: nope",
        level: "warning",
      });
    } finally {
      extension.restore();
    }
  });

  it("/class で全候補が不成立なら現在のモデルを維持し warning を通知する", async () => {
    const extension = captureAgentsExtension({ config }, { findModel: () => undefined });
    try {
      extension.context.model = { provider: "external", id: "kept" };
      await extension.sessionStart();
      await extension.runClassCommand("low");
      assert.deepEqual(extension.notificationEvents.at(-1), {
        message: "no available model for agent manager: class low",
        level: "warning",
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (manual)"]);
      assert.deepEqual(extension.context.model, { provider: "external", id: "kept" });
    } finally {
      extension.restore();
    }
  });

  it("/agent 切り替えで実効 class は切替先 agent の既定 class に戻る", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.runClassCommand("low");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (manual)"]);
      await extension.runCommand("chat");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat", "💎 class: low (manual)"]);
      await extension.runCommand("manager");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (manual)"]);
      assert.deepEqual(extension.selectedModels.at(-1), { provider: "zai", id: "glm-5.2" });
    } finally {
      extension.restore();
    }
  });

  it("/new では実効 class を初期 class に戻す", async () => {
    const extension = captureAgentsExtension({ config }, { flags: { class: "low" } });
    try {
      await extension.sessionStart("startup");
      await extension.runClassCommand("middle");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (manual)"]);
      await extension.sessionStart("new");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (auto)"]);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
    } finally {
      extension.restore();
    }
  });

  it("/resume では実効 class を初期 class に戻す", async () => {
    const extension = captureAgentsExtension({ config }, { flags: { class: "low" } });
    try {
      await extension.sessionStart("startup");
      await extension.runClassCommand("middle");
      await extension.sessionStart("resume");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (auto)"]);
    } finally {
      extension.restore();
    }
  });

  it("/reload では実効 class を維持する", async () => {
    const before = captureAgentsExtension({ config }, { flags: { class: "low" } });
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.runClassCommand("middle");
      await before.sessionShutdown();

      after = captureAgentsExtension({ config }, { flags: { class: "low" } });
      await after.sessionStart("reload");
      assert.deepEqual(after.agentWidget(), ["🤖 agent: manager", "💎 class: middle (manual)"]);
      assert.equal(after.selectedModels.length, 0);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("/reload 後に実効 class が設定から消えていたら既定 class へ戻す", async () => {
    const before = captureAgentsExtension();
    let after: ReturnType<typeof captureAgentsExtension> | undefined;
    try {
      await before.sessionStart("startup");
      await before.runClassCommand("low");
      await before.sessionShutdown();

      const reducedConfig: AgentConfig = {
        default: "manager",
        classes: { middle: config.classes.middle!, vision: config.classes.vision! },
        agents: { manager: config.agents.manager! },
      };
      after = captureAgentsExtension({ config: reducedConfig });
      await after.sessionStart("reload");
      assert.deepEqual(after.agentWidget(), ["🤖 agent: manager", "💎 class: middle (manual)"]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("プロンプト送信前の再評価は実効 class の候補に対して行われる", async () => {
    const extension = captureAgentsExtension({ config }, { flags: { class: "low" } });
    try {
      await extension.sessionStart("startup");
      // 実効 class（low）の候補と一致しているため、既定 class（middle）への再評価・切替は起きない
      const modelCountBefore = extension.selectedModels.length;
      await extension.input("hello");
      assert.equal(extension.selectedModels.length, modelCountBefore);
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: low (auto)"]);
    } finally {
      extension.restore();
    }
  });

  it("429 のフォールバックは実効 class 内の次候補へ切り替える", async () => {
    const twoCandidateLow: AgentConfig = {
      ...config,
      classes: {
        ...config.classes,
        low: [
          { provider: "commandcode", model: "gpt-5.6-luna" },
          { provider: "zai", model: "glm-5.2" },
        ],
      },
    };
    const extension = captureAgentsExtension(
      { config: twoCandidateLow },
      { flags: { class: "low" } },
    );
    try {
      await extension.sessionStart("startup");
      await extension.providerResponse(429);
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "commandcode",
        model: "gpt-5.6-luna",
        errorMessage: "provider error",
      });
      assert.equal(
        replacement.message.errorMessage,
        "429 rate limit error; already switched to a fallback model",
      );
      assert.deepEqual(extension.selectedModels.at(-1), { provider: "zai", id: "glm-5.2" });
    } finally {
      extension.restore();
    }
  });

  it("/class の切り替えは cooldown を維持する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      // HTTP 429 経路の cooldown は z-ai 以外のモデルで作る（z-ai は provider-error-retry 拡張の担当）
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await extension.providerResponse(429); // commandcode/gpt-5.6-luna が cooldown、fallback で zai へ戻る
      await extension.runClassCommand("low");
      await extension.runClassCommand("middle");
      // cooldown 中の commandcode は候補から除外され続けるため、class 切り替えで setModel は発生しない
      assert.deepEqual(extension.selectedModels, [
        { provider: "zai", id: "glm-5.2" },
        { provider: "zai", id: "glm-5.2" },
      ]);
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
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (manual)"]);
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
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
    } finally {
      extension.restore();
    }
  });

  it("main の model_select は画像対応モデルも受け入れて手動状態にする", async () => {
    const extension = captureAgentsExtension(
      {
        config: {
          ...config,
          default: "main",
          agents: {
            ...config.agents,
            main: {
              class: "middle",
              tools: ["*", "!replace_context"],
              subagents: ["worker", "vision"],
              systemPrompt: [],
            },
          },
        },
      },
      {
        findModel: (provider, id) => ({
          provider,
          id,
          input: id.includes("flash") ? ["text", "image"] : ["text"],
        }),
      },
    );
    try {
      await extension.sessionStart();
      await extension.modelSelect("set", {
        provider: "zai",
        id: "glm-5.3-flash",
        input: ["text", "image"],
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: main", "💎 class: middle (manual)"]);
      assert.ok(!extension.notifications.some((message) => message.includes("not allowed")));
    } finally {
      extension.restore();
    }
  });

  it("vision の model_select は vision class 外の画像非対応モデルも受け入れて手動状態にする", async () => {
    const extension = captureAgentsExtension(
      { config },
      {
        findModel: (provider, id) => ({
          provider,
          id,
          input: id.includes("flash") ? ["text", "image"] : ["text"],
        }),
      },
    );
    try {
      await extension.sessionStart();
      await extension.runCommand("vision");
      await extension.modelSelect("set", { provider: "zai", id: "glm-5.2", input: ["text"] });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: vision", "💎 class: vision (manual)"]);
      assert.ok(!extension.notifications.some((message) => message.includes("not allowed")));
    } finally {
      extension.restore();
    }
  });

  it("画像添付の input は画像対応モデルでは親モデルへそのまま送る", async () => {
    const imageCapable = (provider: string, id: string) => ({
      provider,
      id,
      input: ["text", "image"],
    });
    const extension = captureAgentsExtension({ config }, { findModel: imageCapable });
    try {
      await extension.sessionStart();
      const result = await extension.input("see this", "interactive", [
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      assert.deepEqual(result, { action: "continue" });
      assert.equal(extension.spawnCalls.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("画像添付の input は画像非対応モデルでは vision 子セッションへ委譲する", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "looked at image" }] } })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.input("check this diagram", "interactive", [
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      assert.deepEqual(result, { action: "handled" });
      assert.equal(extension.spawnCalls.length, 1);
      assert.equal(extension.spawnCalls[0]?.args.includes("--agent"), true);
      const agentFlagIndex = extension.spawnCalls[0]!.args.indexOf("--agent");
      assert.equal(extension.spawnCalls[0]!.args[agentFlagIndex + 1], "vision");
      const taskArg = extension.spawnCalls[0]!.args.at(-1)!;
      assert.match(taskArg, /Read each image with read/);
      assert.match(taskArg, /check this diagram/);
      // 子セッションへ active agent を伝える（子セッション上の拡張が active agent を参照する）。
      assert.equal(extension.spawnCalls[0]?.env?.PI_AGENT_NAME, "vision");
      // 子の完了を待ち、最終テキストが親へ報告される。
      await Bun.sleep(20);
      assert.ok(extension.notifications.some((message) => message === "vision: looked at image"));
    } finally {
      extension.restore();
    }
  });

  it("画像委譲の子が失敗したら親へエラーを報告する", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stderr.emit("data", Buffer.from("boom\n"));
      child.emit("close", 2);
    });
    try {
      await extension.sessionStart();
      await extension.input("see this", "interactive", [
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      await Bun.sleep(20);
      assert.ok(
        extension.notifications.some((message) => message.startsWith("vision delegation failed:")),
      );
    } finally {
      extension.restore();
    }
  });

  it("agent 切り替えで PI_AGENT_NAME を切り替える", async () => {
    const extension = captureAgentsExtension();
    const previousAgentName = process.env.PI_AGENT_NAME;
    try {
      await extension.sessionStart();
      assert.equal(process.env.PI_AGENT_NAME, "manager");
      await extension.runCommand("vision");
      assert.equal(process.env.PI_AGENT_NAME, "vision");
    } finally {
      if (previousAgentName === undefined) delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = previousAgentName;
      extension.restore();
    }
  });

  it("画像添付の input は画像非対応モデルで委譲できない agent（vision）では案内する", async () => {
    const imageCapableFind = (provider: string, id: string) => ({
      provider,
      id,
      input: id.includes("flash") ? ["text", "image"] : ["text"],
    });
    // 画像対応モデル: そのまま送る（handled にしない）
    const extension = captureAgentsExtension({ config }, { findModel: imageCapableFind });
    try {
      await extension.sessionStart();
      await extension.runCommand("vision");
      const result = await extension.input("see this", "interactive", [
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      assert.deepEqual(result, { action: "continue" });
    } finally {
      extension.restore();
    }
    // 画像非対応モデル: handled で止めてエラー
    const textOnlyExtension = captureAgentsExtension(
      { config },
      { findModel: (provider, id) => ({ provider, id, input: ["text"] }) },
    );
    try {
      await textOnlyExtension.sessionStart();
      await textOnlyExtension.runCommand("vision");
      const blocked = await textOnlyExtension.input("see this", "interactive", [
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      assert.deepEqual(blocked, { action: "handled" });
      assert.ok(
        textOnlyExtension.notifications.some((message) =>
          message.includes("does not support images"),
        ),
      );
      assert.equal(textOnlyExtension.spawnCalls.length, 0);
    } finally {
      textOnlyExtension.restore();
    }
  });

  it("junior とその他 agent の画像添付は委譲せず案内する", async () => {
    const juniorConfig: AgentConfig = {
      ...config,
      agents: {
        ...config.agents,
        junior: { class: "low", tools: ["*", "!replace_context"], subagents: [], systemPrompt: [] },
      },
    };
    const junior = captureAgentsExtension({ config: juniorConfig });
    try {
      await junior.sessionStart();
      await junior.runCommand("junior");
      const result = await junior.input("see this", "interactive", [
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      assert.deepEqual(result, { action: "handled" });
      assert.equal(junior.spawnCalls.length, 0);
      assert.ok(
        junior.notifications.some((message) =>
          message.includes("Report to the caller that visual confirmation by vision"),
        ),
      );
    } finally {
      junior.restore();
    }
    const other = captureAgentsExtension({ config });
    try {
      await other.sessionStart();
      await other.runCommand("chat");
      const result = await other.input("see this", "interactive", [
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      assert.deepEqual(result, { action: "handled" });
      assert.equal(other.spawnCalls.length, 0);
      assert.ok(
        other.notifications.some((message) =>
          message.includes("image input is not available for agent chat"),
        ),
      );
    } finally {
      other.restore();
    }
  });

  it("設定が無効なときは拡張のロードが失敗する", () => {
    assert.throws(
      () => captureAgentsExtension({ error: "classes are required" }),
      /agents\.yaml: classes are required/,
    );
  });

  it("agent 切り替えで手動状態を解除する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      await extension.runCommand("chat");
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: chat", "💎 class: low (manual)"]);
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
      // HTTP 429 経路の fallback は z-ai 以外のモデルで検証する（z-ai は同時実行系の
      // 可能性があるため provider-error-retry 拡張の担当）
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await extension.providerResponse(429);
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "commandcode",
        model: "gpt-5.6-luna",
        errorMessage: "provider error",
      });
      assert.equal(
        replacement.message.errorMessage,
        "429 rate limit error; already switched to a fallback model",
      );
      assert.equal(replacement.message.errorMessage.includes("provider error"), false);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "zai",
        id: "glm-5.2",
      });
      assert.deepEqual(extension.notificationEvents.at(-1), {
        message: "rate limited on commandcode/gpt-5.6-luna; switched to zai/glm-5.2",
        level: "warning",
      });
      assert.equal(extension.sentMessages.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("z-ai モデルの HTTP 429 は fallback せず最終エラー文言の判定に委ねる", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      await extension.providerResponse(429);

      // sessionStart で選ばれた zai から切り替わらない（cooldown も記録されない）
      assert.deepEqual(extension.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
      assert.deepEqual(extension.notifications, ["agent model → zai/glm-5.2"]);
    } finally {
      extension.restore();
    }
  });

  it("z-ai の同時実行系エラー（1302/1305）は fallback しない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: '{"error":{"code":"1302","message":"Rate limit reached for requests"}}',
      });

      assert.equal(replacement, undefined);
      assert.deepEqual(extension.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
    } finally {
      extension.restore();
    }
  });

  it("z-ai の quota 系エラー（1310）は従来どおり fallback する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage:
          '{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-01-01 00:00"}}',
      });

      assert.equal(
        replacement.message.errorMessage,
        "429 rate limit error; already switched to a fallback model",
      );
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
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
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
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
      before.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await before.providerResponse(429, { "retry-after": "120" });
      await before.sessionShutdown();

      after = captureAgentsExtension();
      await after.sessionStart("resume");
      // commandcode が cooldown 中なので、cooldown 外の zai が選ばれる
      assert.deepEqual(after.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
    } finally {
      after?.restore();
      before.restore();
    }
  });

  it("3候補では最大2回だけ再試行し、user message の履歴を増やさない", async () => {
    const threeCandidateConfig: AgentConfig = {
      default: "manager",
      classes: {
        middle: [
          { provider: "zai", model: "first" },
          { provider: "zai", model: "second" },
          { provider: "zai", model: "third" },
        ],
      },
      agents: { manager: { class: "middle", tools: [], subagents: [], systemPrompt: [] } },
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

  describe("same-turn later HTTP 429 suppression", () => {
    const http429Config: AgentConfig = {
      default: "main",
      classes: {
        middle: [
          { provider: "amazon-bedrock", model: "global.anthropic.claude-opus-4-6-v1" },
          { provider: "cursor", model: "composer-2.5:slow" },
          { provider: "openai-codex", model: "gpt-6-luna" },
        ],
      },
      agents: { main: { class: "middle", tools: [], subagents: [], systemPrompt: [] } },
    };
    const cursorModel = { provider: "cursor", id: "composer-2.5:slow" };
    const codexModel = { provider: "openai-codex", id: "gpt-6-luna" };

    it("ignores later HTTP 429s without cooling down the fallback model", async () => {
      const extension = captureAgentsExtension({ config: http429Config });
      try {
        await extension.sessionStart("startup");
        await extension.providerResponse(429);
        assert.deepEqual(extension.selectedModels.at(-1), cursorModel);
        assert.equal(
          extension.notificationEvents.filter(
            (event) => event.level === "warning" && event.message.includes("switched to"),
          ).length,
          1,
        );
        extension.context.model = cursorModel;
        await extension.providerResponse(429);
        assert.deepEqual(extension.selectedModels.at(-1), cursorModel);
        assert.equal(
          extension.notificationEvents.filter(
            (event) => event.level === "warning" && event.message.includes("switched to"),
          ).length,
          1,
        );
        await extension.input("again");
        assert.deepEqual(extension.context.model, cursorModel);
        assert.ok(
          !extension.notifications.some((message) => message.includes("no available model")),
        );
      } finally {
        extension.restore();
      }
    });

    it("preserves suppression across non-429 responses and extension input until user input", async () => {
      const extension = captureAgentsExtension({ config: http429Config });
      try {
        await extension.sessionStart("startup");
        await extension.providerResponse(429);
        await extension.providerResponse(200);
        await extension.input("continue", "extension");
        await extension.providerResponse(429);
        assert.deepEqual(extension.context.model, cursorModel);
        assert.equal(extension.selectedModels.length, 2);
        await extension.input("again");
        await extension.providerResponse(429);
        assert.deepEqual(extension.context.model, codexModel);
        assert.equal(extension.selectedModels.length, 3);
      } finally {
        extension.restore();
      }
    });

    it("resets suppression when a session starts", async () => {
      const extension = captureAgentsExtension({ config: http429Config });
      try {
        await extension.sessionStart("startup");
        await extension.providerResponse(429);
        await extension.sessionStart("new");
        await extension.providerResponse(429);
        assert.deepEqual(extension.context.model, cursorModel);
        assert.equal(
          extension.notifications.filter((message) => message.includes("switched to")).length,
          2,
        );
      } finally {
        extension.restore();
      }
    });

    it("allows another HTTP 429 fallback after an unsuccessful attempt", async () => {
      let fallbackAvailable = false;
      const extension = captureAgentsExtension(
        { config: http429Config },
        {
          findModel: (provider, id) =>
            provider === "amazon-bedrock" || fallbackAvailable ? { provider, id } : undefined,
        },
      );
      try {
        await extension.sessionStart("startup");
        await extension.providerResponse(429);
        assert.equal(extension.selectedModels.length, 1);
        fallbackAvailable = true;
        await extension.providerResponse(429);
        assert.deepEqual(extension.context.model, cursorModel);
        assert.equal(extension.selectedModels.length, 2);
      } finally {
        extension.restore();
      }
    });
  });

  it("HTTP 429 の後の同一最終エラーでは二重に fallback しない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await extension.providerResponse(429);
      const selectedModelCount = extension.selectedModels.length;
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "commandcode",
        model: "gpt-5.6-luna",
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

  it("429 フォールバック後の失敗メッセージが切替先の provider を名乗っても誤 fallback しない", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      // HTTP 429 の主体: commandcode。経路 A で cooldown され、切替先 zai へ setModel される
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await extension.providerResponse(429);
      assert.deepEqual(extension.selectedModels.at(-1), { provider: "zai", id: "glm-5.2" });
      const switchedModelCount = extension.selectedModels.length;
      // pi 本体は失敗メッセージの provider/model を失敗処理時点のセッションモデルで
      // 記録するため、429 を受けた commandcode の失敗が切替先 zai を名乗って届く
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: "Provider error: ThrottlingException: Too many tokens per day",
      });
      // 切替先を cooldown せず、fallback 済みの置換文言へ差み替える
      assert.equal(
        replacement.message.errorMessage,
        "429 rate limit error; already switched to a fallback model",
      );
      assert.equal(extension.selectedModels.length, switchedModelCount);
      assert.equal(extension.sentMessages.length, 0);
      assert.ok(
        !extension.notifications.some((message) => message.includes("rate limited on zai/glm-5.2")),
      );
      // 次のプロンプトでも切替先 zai を cooldown せずに使い続ける
      await extension.input("again");
      assert.equal(extension.selectedModels.length, switchedModelCount);
      assert.ok(!extension.notifications.some((message) => message.includes("no available model")));
    } finally {
      extension.restore();
    }
  });

  it("429 フォールバック後に別の HTTP レスポンスが来たら抑止を解除する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await extension.providerResponse(429);
      // 切替先 zai で次のリクエストが飛んだ（HTTP は成功）→ 抑止を解除
      extension.context.model = { provider: "zai", id: "glm-5.2" };
      await extension.providerResponse(200);
      // 解除後は provider ベースの通常判定: zai 自身の in-band throttle は fallback 対象。
      // class middle の次候補 commandcode は cooldown 中のため fallback できず no fallback 通知
      const replacement = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: "usage limit reached",
      });
      assert.equal(replacement, undefined);
      const noFallback = extension.notificationEvents.at(-1);
      assert.ok(noFallback);
      assert.equal(noFallback.level, "error");
      assert.match(noFallback.message, /^rate limited on zai\/glm-5\.2; no fallback available/);
    } finally {
      extension.restore();
    }
  });

  it("フォールバック済みターンでレート制限以外のエラーが来ても抑止を維持する", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await extension.providerResponse(429);
      const switchedModelCount = extension.selectedModels.length;
      // レート制限と無関係なエラーは抑止を消費しない
      const nonRateLimited = await extension.messageEnd({
        role: "assistant",
        stopReason: "error",
        provider: "zai",
        model: "glm-5.2",
        errorMessage: "prompt is too long: context overflow",
      });
      assert.equal(nonRateLimited, undefined);
      assert.equal(extension.selectedModels.length, switchedModelCount);
      // 抑止が維持されるため、後続の throttle 文言も誤 fallback しない
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
      extension.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await extension.providerResponse(429);
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "zai",
        id: "glm-5.2",
      });
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (manual)"]);
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
      assert.deepEqual(after.agentWidget(), ["🤖 agent: chat", "💎 class: low (manual)"]);
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
      classes: { middle: config.classes.middle! },
      agents: { manager: config.agents.manager! },
    };
    try {
      await before.sessionStart("startup");
      await before.modelSelect("set");
      await before.sessionShutdown();

      after = captureAgentsExtension({ config: changedConfig });
      await after.sessionStart("reload");
      assert.deepEqual(after.agentWidget(), ["🤖 agent: manager", "💎 class: middle (manual)"]);
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
      assert.deepEqual(after.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
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
      before.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await before.providerResponse(429); // commandcode/gpt-5.6-luna が cooldown
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
      before.context.model = { provider: "commandcode", id: "gpt-5.6-luna" };
      await before.providerResponse(429); // commandcode/gpt-5.6-luna が cooldown
      await before.sessionShutdown();

      after = captureAgentsExtension();
      await after.sessionStart("resume");
      // cooldown 維持で commandcode は除外され、cooldown 外の zai が選ばれる
      assert.deepEqual(after.selectedModels, [{ provider: "zai", id: "glm-5.2" }]);
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
      assert.deepEqual(extension.agentWidget(), ["🤖 agent: manager", "💎 class: middle (auto)"]);
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
        "no available model for agent manager: class middle",
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
        "no available model for agent manager: class middle",
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
        "no available model for agent manager: class middle",
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
      assert.equal(extension.notifications.at(-1), "no available model for agent chat: class low");
    } finally {
      extension.restore();
    }
  });
});

describe("subagent", () => {
  it("子 agent の class、tools、systemPrompt、再委譲設定を適用する", async () => {
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
        subagentSessionDir("/child"),
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
      assert.equal(extension.spawnCalls[0]?.args.includes("--no-session"), false);
      const sessionDirIndex = extension.spawnCalls[0]!.args.indexOf("--session-dir");
      assert.equal(
        extension.spawnCalls[0]!.args[sessionDirIndex + 1],
        subagentSessionDir("/parent"),
      );
      assert.equal(extension.spawnCalls[0]?.args.includes("--model"), false);
      assert.equal(extension.spawnCalls[0]?.args.includes("--class"), false);
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
      assert.deepEqual(extension.appendedEntries, []);

      succeedChild(extension.children[0]!);
      succeedChild(extension.children[1]!);
      await Promise.all([first, second]);
    } finally {
      extension.restore();
    }
  });

  it("実行中は 80 ミリ秒ごとに TUI の再描画を要求する", async () => {
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
        { spinnerIntervalMs: 80, requestedRenderCount: 1 },
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
      // 初回の (running...) と tool_execution_start の即時送出、および窓内の
      // update / end が併合された送出1回の計3回。flush で最新状態（end の結果まで）が
      // 反映される。
      assert.equal(updates.length, 3);
      assert.equal(updates[1].details.results[0].actions[0].name, "bash");
      assert.equal(updates[1].details.results[0].actions[0].args.command, "pwd");
      assert.equal(updates[2].details.results[0].actions[0].endedAt !== undefined, true);
    } finally {
      extension.restore();
    }
  });

  it("onUpdate の送出をスロットリングして stdout の読み取りを優先する", () => {
    const originalTimers = { ...__updateTimers };
    let currentNow = 0;
    let scheduled: { callback: () => void; delayMs: number } | undefined;
    __updateTimers.now = () => currentNow;
    __updateTimers.set = (callback, delayMs) => {
      scheduled = { callback, delayMs };
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    __updateTimers.clear = () => {
      scheduled = undefined;
    };
    try {
      const emitted: number[] = [];
      const throttled = createThrottledEmitter(() => emitted.push(currentNow));

      // 初回は同期的に送出する
      throttled.call();
      assert.deepEqual(emitted, [0]);

      // 窓内の連続した call は送出せず、タイマーで1回だけ併合送出する
      throttled.call();
      throttled.call();
      throttled.call();
      assert.deepEqual(emitted, [0]);
      assert.ok(scheduled !== undefined);
      const timer = scheduled!;
      currentNow += timer.delayMs;
      timer.callback();
      assert.deepEqual(emitted, [0, 150]);

      // 窓を空けた call は再び同期的に送出する
      currentNow += 150;
      throttled.call();
      assert.deepEqual(emitted, [0, 150, 300]);

      // flush は保留中の送出を即座に行う
      throttled.call();
      assert.deepEqual(emitted, [0, 150, 300]);
      throttled.flush();
      assert.deepEqual(emitted, [0, 150, 300, 300]);
    } finally {
      Object.assign(__updateTimers, originalTimers);
    }
  });

  it("大量の tool_execution_update が流れても onUpdate の送出は間引き、受領は全伴する", async () => {
    const extension = captureAgentsExtension();
    const eventCount = 2000;
    let onUpdateCalls = 0;
    extension.respondToChild((child) => {
      const lines: string[] = [
        JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "cat huge.log" },
        }),
      ];
      for (let i = 0; i < eventCount; i++) {
        lines.push(
          JSON.stringify({
            type: "tool_execution_update",
            toolCallId: "call-1",
            toolName: "bash",
            args: { command: "cat huge.log" },
            partialResult: { content: [{ type: "text", text: `chunk ${i}` }] },
          }),
        );
      }
      lines.push(
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "done" }] },
          isError: false,
        }),
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "finished" }] },
        }),
      );
      child.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`));
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent(
        { agent: "worker", task: "work" },
        undefined,
        () => {
          onUpdateCalls++;
          // レンダリングの代替の重い同期処理。窓内のイベントごとに呼ばれると stdout の
          // 読み取りが止まるため、間引きが機能していれば呼び出し回数はイベント数より
          // 桁違いに少なくなる。
          const until = Date.now() + 5;
          while (Date.now() < until) {}
        },
      );
      // 受領は全伴: 最終イベントまで処理して確定する
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, "finished");
      assert.equal(result.details.results[0].actions[0].result?.content?.[0]?.text, "done");
      // 送出は間引き: 初回・start・flush の数回に留まる
      assert.ok(onUpdateCalls < 10, `onUpdate called ${onUpdateCalls} times`);
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

  it("renders nested subagent errors in the error color", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "subagent", args: { agent: "chat", task: "work" } })}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: "subagent", result: { content: [{ type: "text", text: "Permission denied" }], isError: true }, isError: false })}\n${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "delegation failed" }] } })}\n`,
        ),
      );
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      const rendered = extension.renderResult(
        result,
        { isPartial: false },
        {
          fg: (color: string, text: string) => `[${color}]${text}`,
          bold: (text: string) => text,
        },
      ) as Container;

      assert.ok(rendered.render(200).some((line) => line.includes("[error]Permission denied")));
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

  it("エージェント側ターンで 15 分無音の子を stalled として停止する", async () => {
    const extension = captureAgentsExtension();
    let fireStallTimer: (() => void) | undefined;
    const originalSet = __abortTimer.set;
    const originalClear = __abortTimer.clear;
    let clearedTimers = 0;
    __abortTimer.set = (callback) => {
      fireStallTimer = callback;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    __abortTimer.clear = () => {
      clearedTimers += 1;
    };
    extension.respondToChild((child) => {
      // 子は assistant の確定だけを返し、それ以降エージェント側ターンで無音になる。
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
        ),
      );
    });
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fireStallTimer !== undefined, true);
      fireStallTimer?.();
      await new Promise((resolve) => setImmediate(resolve));
      const result = await execution;
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0].stopReason, "stalled");
      assert.match(result.content[0].text, /Child stalled: no child events for 15 min/);
      assert.deepEqual(extension.children[0]?.killHistory, ["SIGTERM"]);
      assert.ok(clearedTimers >= 1, "停止時に無進捗タイマーが解除される");
    } finally {
      __abortTimer.set = originalSet;
      __abortTimer.clear = originalClear;
      extension.restore();
    }
  });

  it("stall 後に遅れて届いた message_end で停止理由とエラーを上書きしない", async () => {
    const extension = captureAgentsExtension();
    let fireStallTimer: (() => void) | undefined;
    const originalSet = __abortTimer.set;
    const originalClear = __abortTimer.clear;
    __abortTimer.set = (callback, delayMs) => {
      if (delayMs === 15 * 60_000) fireStallTimer = callback;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    __abortTimer.clear = () => {};
    extension.respondToChild((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "initial" }] } })}\n`,
        ),
      );
    });
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
      await new Promise((resolve) => setImmediate(resolve));
      fireStallTimer?.();
      // SIGTERM 後、子が close する前に遅れて assistant error を流す。
      extension.children[0]?.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "late child error", content: [] } })}\n`,
        ),
      );
      const result = await execution;
      assert.equal(result.details.results[0].stopReason, "stalled");
      assert.match(result.content[0].text, /Child stalled: no child events for 15 min/);
      assert.doesNotMatch(result.content[0].text, /late child error/);
    } finally {
      __abortTimer.set = originalSet;
      __abortTimer.clear = originalClear;
      extension.restore();
    }
  });

  it("tool 実行中は無進捗タイマーを止めて誤発火を防ぐ", async () => {
    const extension = captureAgentsExtension();
    let setCalls = 0;
    let clearCalls = 0;
    const originalSet = __abortTimer.set;
    const originalClear = __abortTimer.clear;
    __abortTimer.set = (callback) => {
      setCalls += 1;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    __abortTimer.clear = () => {
      clearCalls += 1;
    };
    extension.respondToChild((child) => {
      // tool 実行を開始したまま応答が来ない（静かな長時間 bash 相当）。
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", args: { command: "sleep 3600", timeout: 3600 } })}\n`,
        ),
      );
    });
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
      await new Promise((resolve) => setImmediate(resolve));
      // 起動直後の初回 arm だけがスケジュールされ、start イベント受信で解除される。
      // tool 実行中は再 arm されないため、これ以上 set が呼ばれない。
      assert.equal(setCalls, 1);
      assert.ok(clearCalls >= 1, "start イベント受信で初回 arm が解除される");
      assert.equal(extension.children[0]?.killHistory.length ?? 0, 0);
      extension.children[0]?.emit("close", 1);
      const result = await execution;
      assert.equal(result.isError, true);
      assert.notEqual(result.details.results[0].stopReason, "stalled");
    } finally {
      __abortTimer.set = originalSet;
      __abortTimer.clear = originalClear;
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

  it("長い stderr は末尾を残して親へ返す", async () => {
    const extension = captureAgentsExtension();
    const stderr = `head${"x".repeat(ERROR_OUTPUT_PREVIEW_LIMIT)}tail`;
    extension.respondToChild((child) => {
      child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", 2);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      const output = result.content[0].text;
      assert.equal(result.isError, true);
      assert.ok(output.length <= `Child failed: `.length + ERROR_OUTPUT_PREVIEW_LIMIT);
      assert.ok(output.includes("tail"));
      assert.match(output, /Output truncated; showing the tail/);
      assert.ok(!output.includes("head"));
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
      child.stderr.emit("data", Buffer.from("no available model for agent worker: class low\n"));
      child.emit("close", 0);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        "Child failed: no available model for agent worker: class low\n",
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

  it("設定エラーでは拡張のロードが失敗する", () => {
    assert.throws(
      () => captureAgentsExtension({ error: "invalid config" }),
      /agents\.yaml: invalid config/,
    );
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

  it("設定エラーでは session_start の登録前にロードが失敗する", () => {
    assert.throws(
      () => captureAgentsExtension({ error: "invalid config" }),
      /agents\.yaml: invalid config/,
    );
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

  it("確定結果に session 行を表示し部分表示では出さない", () => {
    const extension = captureAgentsExtension();
    const makeDetails = () => ({
      results: [
        {
          agent: "worker",
          task: "work",
          cwd: "/child",
          pending: false,
          exitCode: 0,
          sessionId: "child-id",
          messages: [],
          actions: [],
          stderr: "",
        },
      ],
    });
    try {
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const rendered = extension.renderResult(
        { content: [], details: makeDetails() },
        { isPartial: false },
        theme,
      ) as Container;
      assert.ok(rendered.render(200).some((line) => line.includes("session: child-id")));
      const partial = extension.renderResult(
        { content: [], details: makeDetails() },
        { isPartial: true },
        theme,
      ) as Container;
      assert.equal(
        partial.render(200).some((line) => line.includes("session: child-id")),
        false,
      );
    } finally {
      extension.restore();
    }
  });

  it("呼び出し時に resume・fork 対象のセッションを表示する", () => {
    const extension = captureAgentsExtension();
    try {
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const resumed = extension.renderCall(
        { agent: "worker", session: "/sessions/subagents/2026-10-22T08-00-00-123Z_old-id.jsonl" },
        theme,
      ) as Text;
      assert.ok(
        resumed
          .render(200)
          .some((line) =>
            line.includes("subagent worker (resume 2026-10-22T08-00-00-123Z_old-id.jsonl)"),
          ),
      );
      const forked = extension.renderCall(
        { agent: "worker", session: "old-id", fork: true },
        theme,
      ) as Text;
      assert.ok(forked.render(200).some((line) => line.includes("subagent worker (fork old-id)")));
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

      __spinnerTimers.now = () => 80;
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
        "[muted]┌─── Actions ───",
        "[muted]└───────────────",
        "[muted]┌─── Output ────",
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

describe("independent child session storage", () => {
  const header = {
    type: "session",
    version: 3,
    id: "child-id",
    timestamp: "2026-10-22T08:00:00.123Z",
    cwd: "/parent",
  };

  function emitHeader(child: FakeChild): void {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(header)}\n`));
  }

  it("passes only new-session storage and agent arguments", () => {
    assert.deepEqual(childInvocationArgs("junior", "do the thing", "/project/nested"), [
      "--mode",
      "json",
      "-p",
      "--agent",
      "junior",
      "--session-dir",
      subagentSessionDir("/project/nested"),
      "Task: do the thing",
    ]);
    assert.ok(
      subagentSessionDir("/project/nested").endsWith("/sessions/--project-nested--/subagents"),
    );
    assert.equal(subagentSessionDir("."), subagentSessionDir(process.cwd()));
  });

  it("passes session continuation arguments for resume and fork", () => {
    assert.deepEqual(
      childInvocationArgs("junior", "continue work", "/project/nested", {
        path: "/sessions/subagents/a_child.jsonl",
        fork: false,
      }),
      [
        "--mode",
        "json",
        "-p",
        "--agent",
        "junior",
        "--session-dir",
        subagentSessionDir("/project/nested"),
        "--session",
        "/sessions/subagents/a_child.jsonl",
        "Task: continue work",
      ],
    );
    assert.deepEqual(
      childInvocationArgs("junior", "branch work", "/project/nested", {
        path: "/sessions/subagents/a_child.jsonl",
        fork: true,
      }),
      [
        "--mode",
        "json",
        "-p",
        "--agent",
        "junior",
        "--session-dir",
        subagentSessionDir("/project/nested"),
        "--fork",
        "/sessions/subagents/a_child.jsonl",
        "Task: branch work",
      ],
    );
  });

  it("records the header before completion and excludes child history from references", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
      const child = extension.children[0]!;
      emitHeader(child);
      const start = extension.appendedEntries[0]!;
      const sessionFile = join(
        subagentSessionDir("/parent"),
        "2026-10-22T08-00-00-123Z_child-id.jsonl",
      );
      assert.deepEqual(start, {
        customType: "agents.subagent-session",
        data: {
          invocationId: "call",
          source: "subagent",
          agent: "worker",
          task: "work",
          cwd: "/parent",
          sessionDir: subagentSessionDir("/parent"),
          mode: "new",
          phase: "start",
          sessionId: "child-id",
          sessionFile,
        },
      });
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private reasoning" },
                { type: "text", text: "done" },
              ],
              stopReason: "stop",
            },
          })}\n`,
        ),
      );
      child.emit("close", 0);
      const result = await execution;
      assert.equal(result.content[0].text, "done\n\nsession: child-id");
      assert.deepEqual(extension.appendedEntries[1], {
        customType: start.customType,
        data: {
          ...start.data,
          phase: "end",
          exitCode: 0,
          stopReason: "stop",
          sessionFileExists: false,
        },
      });
      assert.equal(extension.appendedEntries.length, 2);
      assert.equal(JSON.stringify(extension.appendedEntries).includes("private reasoning"), false);
      assert.equal("inlineEvents" in result.details.results[0], false);
    } finally {
      extension.restore();
    }
  });

  for (const failure of [
    "nonzero",
    "signal",
    "spawn-error",
    "empty-output",
    "assistant-error",
  ] as const) {
    it(`records an end reference for ${failure}`, async () => {
      const extension = captureAgentsExtension();
      extension.respondToChild((child) => {
        if (failure !== "spawn-error") emitHeader(child);
        if (failure === "spawn-error") child.emit("error", new Error("cannot spawn child"));
        else if (failure === "assistant-error") {
          child.stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [],
                  stopReason: "error",
                  errorMessage: "provider failed",
                },
              })}\n`,
            ),
          );
          child.emit("close", 0);
        } else child.emit("close", failure === "nonzero" ? 2 : failure === "signal" ? null : 0);
      });
      try {
        await extension.sessionStart();
        const result = await extension.executeSubagent({ agent: "worker", task: "work" });
        assert.equal(result.isError, true);
        const end = extension.appendedEntries.at(-1)!.data;
        assert.equal(end.phase, "end");
        assert.equal(end.invocationId, "call");
        assert.equal(end.sessionFileExists, false);
        assert.equal(
          end.exitCode,
          failure === "nonzero" ? 2 : failure === "signal" || failure === "spawn-error" ? 1 : 0,
        );
        if (failure === "spawn-error") {
          assert.equal(extension.appendedEntries.length, 1);
          assert.equal("sessionId" in end, false);
          assert.equal("sessionFile" in end, false);
          assert.equal(end.errorMessage, "cannot spawn child");
        } else assert.equal(end.sessionId, header.id);
        if (failure === "signal") assert.equal(end.stopReason, "killed");
        if (failure === "assistant-error") assert.equal(end.errorMessage, "provider failed");
      } finally {
        extension.restore();
      }
    });
  }

  it("records synchronous launch failures without inventing a child session", async () => {
    const extension = captureAgentsExtension();
    __spawn.current = (() => {
      throw new Error("launch failed");
    }) as typeof __spawn.current;
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.deepEqual(
        extension.appendedEntries.map((entry) => entry.data.phase),
        ["end"],
      );
      assert.equal(extension.appendedEntries[0]!.data.errorMessage, "launch failed");
      assert.equal("sessionId" in extension.appendedEntries[0]!.data, false);
    } finally {
      extension.restore();
    }
  });

  it("keeps the same child identity when an active child is aborted", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const controller = new AbortController();
      const execution = extension.executeSubagent(
        { agent: "worker", task: "work" },
        controller.signal,
      );
      emitHeader(extension.children[0]!);
      controller.abort();
      const result = await execution;
      assert.equal(result.isError, true);
      assert.deepEqual(
        extension.appendedEntries.map((entry) => entry.data.phase),
        ["start", "end"],
      );
      const end = extension.appendedEntries[1]!.data;
      assert.equal(end.sessionId, header.id);
      assert.equal(end.stopReason, "aborted");
      assert.equal(end.errorMessage, "Subagent was aborted");
    } finally {
      extension.restore();
    }
  });

  it("records a stalled child with its acquired session reference", async () => {
    const extension = captureAgentsExtension();
    const originalTimers = { ...__abortTimer };
    let fireStall: (() => void) | undefined;
    __abortTimer.set = (callback, delayMs) => {
      if (delayMs === 15 * 60_000) fireStall = callback;
      return callback as unknown as ReturnType<typeof setTimeout>;
    };
    __abortTimer.clear = () => {};
    try {
      await extension.sessionStart();
      const execution = extension.executeSubagent({ agent: "worker", task: "work" });
      emitHeader(extension.children[0]!);
      assert.ok(fireStall);
      fireStall();
      const result = await execution;
      assert.equal(result.isError, true);
      const end = extension.appendedEntries.at(-1)!.data;
      assert.equal(end.phase, "end");
      assert.equal(end.sessionId, header.id);
      assert.equal(end.stopReason, "stalled");
      assert.equal(end.errorMessage, "Child stalled: no child events for 15 min");
      assert.equal(end.sessionFileExists, false);
    } finally {
      Object.assign(__abortTimer, originalTimers);
      extension.restore();
    }
  });

  it("records automatic vision references and preserves image cleanup and reports", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      emitHeader(child);
      succeedChild(child);
    });
    try {
      await extension.sessionStart();
      for (let invocation = 0; invocation < 2; invocation++) {
        assert.deepEqual(
          await extension.input("inspect image", "interactive", [
            { type: "image", data: "aGk=", mimeType: "image/png" },
          ]),
          { action: "handled" },
        );
        await new Promise((resolve) => setImmediate(resolve));
      }
      const starts = extension.appendedEntries.filter((entry) => entry.data.phase === "start");
      const ends = extension.appendedEntries.filter((entry) => entry.data.phase === "end");
      assert.equal(starts.length, 2);
      assert.equal(ends.length, 2);
      assert.notEqual(starts[0]!.data.invocationId, starts[1]!.data.invocationId);
      for (const start of starts) {
        assert.equal(start.data.source, "image");
        assert.equal(start.data.agent, "vision");
        assert.equal(start.data.sessionDir, subagentSessionDir("/parent"));
        assert.match(start.data.invocationId as string, /^[0-9a-f-]{36}$/);
        const end = ends.find((entry) => entry.data.invocationId === start.data.invocationId)!;
        assert.equal(end.data.sessionId, start.data.sessionId);
        assert.equal(end.data.sessionFile, start.data.sessionFile);
        assert.equal(end.data.exitCode, 0);
        const imagePath = (start.data.task as string).split("\n").at(-1)!;
        assert.equal(existsSync(imagePath), false);
      }
      for (const call of extension.spawnCalls) {
        assert.equal(call.args.includes("--no-session"), false);
        assert.equal(
          call.args[call.args.indexOf("--session-dir") + 1],
          subagentSessionDir("/parent"),
        );
      }
      assert.equal(
        extension.notifications.filter((message) => message === "vision: done").length,
        2,
      );
    } finally {
      extension.restore();
    }
  });

  it("uses native pi persistence for parallel runs and new extension instances", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agents-native-sessions-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temporaryRoot;
    const savedFiles: string[] = [];
    try {
      for (let instance = 0; instance < 2; instance++) {
        const extension = captureAgentsExtension();
        try {
          await extension.sessionStart();
          const executions = [0, 1].map((index) =>
            extension.executeSubagent(
              { agent: "worker", task: "same task", cwd: temporaryRoot },
              undefined,
              undefined,
              `call-${instance}-${index}`,
            ),
          );
          for (const child of [...extension.children].reverse()) {
            const call = extension.spawnCalls[extension.children.indexOf(child)]!;
            const sessionDir = call.args[call.args.indexOf("--session-dir") + 1]!;
            const manager = SessionManager.create(call.cwd!, sessionDir);
            const sessionFile = manager.getSessionFile()!;
            assert.equal(existsSync(sessionFile), false);
            child.stdout.emit("data", Buffer.from(`${JSON.stringify(manager.getHeader())}\n`));
            assert.equal(extension.appendedEntries.at(-1)!.data.sessionFile, sessionFile);
            assert.equal(existsSync(sessionFile), false);
            manager.appendMessage({ role: "user", content: "same task", timestamp: Date.now() });
            assert.equal(existsSync(sessionFile), true);
            succeedChild(child);
            savedFiles.push(sessionFile);
          }
          await Promise.all(executions);
          const starts = extension.appendedEntries.filter((entry) => entry.data.phase === "start");
          const ends = extension.appendedEntries.filter((entry) => entry.data.phase === "end");
          assert.equal(starts.length, 2);
          assert.equal(ends.length, 2);
          for (const start of starts) {
            const end = ends.find((entry) => entry.data.invocationId === start.data.invocationId)!;
            assert.equal(end.data.sessionId, start.data.sessionId);
            assert.equal(end.data.sessionFile, start.data.sessionFile);
            assert.equal(end.data.sessionFileExists, true);
            const records = readFileSync(end.data.sessionFile as string, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assert.equal(records[0].id, end.data.sessionId);
            assert.equal(records[0].parentSession, undefined);
            assert.ok(records.some((record) => record.message?.content === "same task"));
          }
        } finally {
          extension.restore();
        }
      }
      assert.equal(new Set(savedFiles).size, 4);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("resolves absolute files, exact IDs and partial IDs inside the subagent directory", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agents-resolve-sessions-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temporaryRoot;
    try {
      const sessionDir = subagentSessionDir("/parent");
      mkdirSync(sessionDir, { recursive: true });
      const sessionFile = join(sessionDir, "2026-10-22T08-00-00-123Z_id-a.jsonl");
      writeFileSync(sessionFile, "");
      assert.deepEqual(resolveChildSession(sessionFile, "/parent"), { path: sessionFile });
      assert.deepEqual(resolveChildSession("id-a", "/parent"), { path: sessionFile });
      assert.deepEqual(resolveChildSession("id-", "/parent"), { path: sessionFile });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects sessions outside the directory, without a match, or ambiguous", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agents-resolve-sessions-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temporaryRoot;
    try {
      const sessionDir = subagentSessionDir("/parent");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "2026-10-22T08-00-00-123Z_id-a.jsonl"), "");
      writeFileSync(join(sessionDir, "2026-10-22T08-00-00-123Z_id-b.jsonl"), "");

      assert.ok("error" in resolveChildSession("/elsewhere/session.jsonl", "/parent"));
      assert.ok("error" in resolveChildSession(join(sessionDir, "missing.jsonl"), "/parent"));
      assert.ok("error" in resolveChildSession("missing", "/parent"));
      assert.ok("error" in resolveChildSession("id-", "/parent"));
      assert.ok("error" in resolveChildSession("nested/path.jsonl", "/parent"));
      assert.ok("error" in resolveChildSession("id-a", "/other-cwd"));

      mkdirSync(join(sessionDir, "notebook-dir"));
      assert.ok("error" in resolveChildSession(join(sessionDir, "notebook-dir"), "/parent"));
      writeFileSync(join(sessionDir, "notes.txt"), "");
      const notJsonl = resolveChildSession(join(sessionDir, "notes.txt"), "/parent");
      assert.ok("error" in notJsonl);
      assert.match(notJsonl.error, /\.jsonl extension/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects fork without a session and unresolvable sessions before spawning", async () => {
    const extension = captureAgentsExtension();
    try {
      await extension.sessionStart();
      const forkOnly = await extension.executeSubagent({
        agent: "worker",
        task: "work",
        fork: true,
      });
      assert.equal(forkOnly.isError, true);
      assert.match(forkOnly.content[0].text, /fork requires a session/);

      const unknown = await extension.executeSubagent({
        agent: "worker",
        task: "work",
        session: "missing-id",
      });
      assert.equal(unknown.isError, true);
      assert.match(unknown.content[0].text, /child session directory not found/);
      assert.equal(extension.children.length, 0);
    } finally {
      extension.restore();
    }
  });

  it("resumes an existing child session by ID and records the continuation reference", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agents-resume-sessions-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temporaryRoot;
    try {
      const sessionDir = subagentSessionDir("/parent");
      mkdirSync(sessionDir, { recursive: true });
      const sessionFile = join(sessionDir, "2026-10-22T08-00-00-123Z_old-id.jsonl");
      writeFileSync(sessionFile, "");
      const extension = captureAgentsExtension();
      try {
        await extension.sessionStart();
        const execution = extension.executeSubagent({
          agent: "worker",
          task: "continue",
          session: "old-id",
        });
        const spawnCall = extension.spawnCalls[0]!;
        assert.equal(spawnCall.args[spawnCall.args.indexOf("--session") + 1], sessionFile);
        const child = extension.children[0]!;
        emitHeader(child);
        const start = extension.appendedEntries[0]!;
        assert.equal(start.data.mode, "resume");
        assert.equal(start.data.resumedFrom, sessionFile);
        succeedChild(child);
        const result = await execution;
        assert.equal(result.content[0].text, "done\n\nsession: child-id");
        const end = extension.appendedEntries[1]!;
        assert.equal(end.data.mode, "resume");
        assert.equal(end.data.resumedFrom, sessionFile);
      } finally {
        extension.restore();
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("forks an existing child session by path and records the fork reference", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agents-fork-sessions-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temporaryRoot;
    try {
      const sessionDir = subagentSessionDir("/parent");
      mkdirSync(sessionDir, { recursive: true });
      const sessionFile = join(sessionDir, "2026-10-22T08-00-00-123Z_old-id.jsonl");
      writeFileSync(sessionFile, "");
      const extension = captureAgentsExtension();
      try {
        await extension.sessionStart();
        const execution = extension.executeSubagent({
          agent: "worker",
          task: "branch",
          session: sessionFile,
          fork: true,
        });
        const spawnCall = extension.spawnCalls[0]!;
        assert.equal(spawnCall.args[spawnCall.args.indexOf("--fork") + 1], sessionFile);
        const child = extension.children[0]!;
        emitHeader(child);
        const start = extension.appendedEntries[0]!;
        assert.equal(start.data.mode, "fork");
        assert.equal(start.data.resumedFrom, sessionFile);
        succeedChild(child);
        await execution;
      } finally {
        extension.restore();
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("appends the session line to failed reports when the child ID is known", async () => {
    const extension = captureAgentsExtension();
    extension.respondToChild((child) => {
      emitHeader(child);
      child.emit("close", 2);
    });
    try {
      await extension.sessionStart();
      const result = await extension.executeSubagent({ agent: "worker", task: "work" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /\nsession: child-id$/);
    } finally {
      extension.restore();
    }
  });

  it("resolves the session against the effective child cwd", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agents-resume-cwd-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temporaryRoot;
    try {
      const childSessionDir = subagentSessionDir("/child");
      mkdirSync(childSessionDir, { recursive: true });
      const sessionFile = join(childSessionDir, "2026-10-22T08-00-00-123Z_old-id.jsonl");
      writeFileSync(sessionFile, "");
      const extension = captureAgentsExtension();
      try {
        await extension.sessionStart();
        const execution = extension.executeSubagent({
          agent: "worker",
          task: "continue",
          cwd: "/child",
          session: "old-id",
        });
        const spawnCall = extension.spawnCalls[0]!;
        assert.equal(spawnCall.cwd, "/child");
        assert.equal(spawnCall.args[spawnCall.args.indexOf("--session-dir") + 1], childSessionDir);
        assert.equal(spawnCall.args[spawnCall.args.indexOf("--session") + 1], sessionFile);
        succeedChild(extension.children[0]!);
        await execution;
      } finally {
        extension.restore();
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("replace_context によるクラス指定", () => {
  const configWithMain: AgentConfig = {
    ...config,
    classes: {
      ...config.classes,
      high: [{ provider: "commandcode", model: "gpt-5.6-luna" }],
    },
    agents: {
      ...config.agents,
      main: {
        class: "middle",
        tools: ["*", "!handoff_session"],
        subagents: ["worker", "vision"],
        systemPrompt: ["main prompt"],
      },
    },
  };

  it("shows manual command selection without disabling class routing", async () => {
    const extension = captureAgentsExtension(
      { config: configWithMain },
      { flags: { agent: "main" } },
    );
    try {
      await extension.sessionStart();
      assert.match(extension.agentWidget()!.join("\n"), /class: middle \(auto\)/);
      await extension.runClassCommand("high");
      assert.match(extension.agentWidget()!.join("\n"), /class: high \(manual\)/);
      extension.context.model = { provider: "external", id: "other" };
      await extension.input("continue");
      assert.equal(extension.context.model.id, "gpt-5.6-luna");
      assert.match(extension.agentWidget()!.join("\n"), /class: high \(manual\)/);
      await extension.runCommand("worker");
      assert.match(extension.agentWidget()!.join("\n"), /class: low \(manual\)/);
    } finally {
      extension.restore();
    }
  });

  it("keeps agent attribution during reevaluation and rate-limit fallback", async () => {
    const extension = captureAgentsExtension(
      {
        config: {
          ...configWithMain,
          classes: {
            ...configWithMain.classes,
            high: [
              { provider: "commandcode", model: "gpt-5.6-luna" },
              { provider: "zai", model: "glm-5.2" },
            ],
          },
        },
      },
      { flags: { agent: "main" } },
    );
    try {
      await extension.sessionStart();
      await extension.requestClassChange("high");
      assert.match(extension.agentWidget()!.join("\n"), /class: high \(agent\)/);
      await extension.input("continue");
      await extension.providerResponse(429);
      assert.equal(extension.context.model!.id, "glm-5.2");
      assert.match(extension.agentWidget()!.join("\n"), /class: high \(agent\)/);
    } finally {
      extension.restore();
    }
  });

  it("does not change attribution for ignored or unchanged requests", async () => {
    const extension = captureAgentsExtension(
      { config: configWithMain },
      { flags: { agent: "main" } },
    );
    try {
      await extension.sessionStart();
      await extension.runClassCommand("high");
      assert.equal(await extension.requestClassChange("high"), "unchanged");
      assert.equal(await extension.requestClassChange("unknown"), "ignored");
      assert.match(extension.agentWidget()!.join("\n"), /class: high \(manual\)/);
      await extension.modelSelect("set");
      assert.equal(await extension.requestClassChange("low"), "ignored");
      assert.match(extension.agentWidget()!.join("\n"), /class: high \(manual\)/);
    } finally {
      extension.restore();
    }
  });

  for (const source of ["auto", "manual", "agent"] as const) {
    it(`preserves ${source} attribution across extension reload`, async () => {
      const before = captureAgentsExtension(
        { config: configWithMain },
        { flags: { agent: "main" } },
      );
      let after: ReturnType<typeof captureAgentsExtension> | undefined;
      try {
        await before.sessionStart("startup");
        if (source === "manual") await before.runClassCommand("high");
        if (source === "agent") await before.requestClassChange("high");
        await before.sessionShutdown();
        after = captureAgentsExtension({ config: configWithMain }, { flags: { agent: "main" } });
        await after.sessionStart("reload");
        assert.ok(after.agentWidget()!.at(-1)!.endsWith(`(${source})`));
        assert.equal(after.selectedModels.length, 0);
      } finally {
        after?.restore();
        before.restore();
      }
    });
  }

  for (const reason of ["new", "resume", "fork"]) {
    it(`resets agent attribution to auto on ${reason}`, async () => {
      const extension = captureAgentsExtension(
        { config: configWithMain },
        { flags: { agent: "main" } },
      );
      try {
        await extension.sessionStart("startup");
        await extension.requestClassChange("high");
        await extension.sessionStart(reason);
        assert.match(extension.agentWidget()!.join("\n"), /class: middle \(auto\)/);
      } finally {
        extension.restore();
      }
    });
  }

  it("routes both class commands and agent defaults through the same event", async () => {
    const extension = captureAgentsExtension(
      { config: configWithMain },
      { flags: { agent: "main" } },
    );
    try {
      await extension.sessionStart();
      await extension.runClassCommand("low");
      await extension.runCommand("worker");
      assert.deepEqual(
        extension.classChangeRequests.map((request: any) => request.class),
        ["low", undefined],
      );
      assert.match(extension.agentWidget()!.join("\n"), /class: low/);
    } finally {
      extension.restore();
    }
  });

  for (const command of ["class", "agent"] as const) {
    it(`awaits model application before completing the ${command} command`, async () => {
      let blockModel = false;
      const started = Promise.withResolvers<void>();
      const completion = Promise.withResolvers<void>();
      const extension = captureAgentsExtension(
        { config: configWithMain },
        {
          flags: { agent: "main" },
          beforeSetModel: async () => {
            if (!blockModel) return;
            started.resolve();
            await completion.promise;
          },
        },
      );
      try {
        await extension.sessionStart();
        blockModel = true;
        let finished = false;
        const change = (
          command === "class"
            ? extension.runClassCommand("low")
            : extension.runCommand("worker", "continue")
        ).then(() => {
          finished = true;
        });
        await started.promise;
        assert.equal(finished, false);
        assert.deepEqual(extension.sentMessages, []);
        completion.resolve();
        await change;
        if (command === "agent")
          assert.deepEqual(extension.sentMessages, [{ content: "continue" }]);
      } finally {
        completion.resolve();
        extension.restore();
      }
    });
  }

  it("continues handling requests after a failed class application", async () => {
    let failModel = false;
    const extension = captureAgentsExtension(
      { config: configWithMain },
      {
        flags: { agent: "main" },
        beforeSetModel: async () => {
          if (failModel) throw new Error("model failed");
        },
      },
    );
    try {
      await extension.sessionStart();
      failModel = true;
      await assert.rejects(extension.runClassCommand("low"), /model failed/);
      failModel = false;
      await extension.runClassCommand("high");
      assert.match(extension.agentWidget()!.join("\n"), /class: high/);
    } finally {
      extension.restore();
    }
  });

  it("applies the requested model before the request completes", async () => {
    const extension = captureAgentsExtension(
      { config: configWithMain },
      { flags: { agent: "main" } },
    );
    try {
      await extension.sessionStart();
      assert.deepEqual(extension.selectedModels[0], { provider: "zai", id: "glm-5.2" });
      await extension.requestClassChange("high");
      assert.deepEqual(extension.selectedModels.at(-1), {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
    } finally {
      extension.restore();
    }
  });

  it("1つの指定は1つのターンだけで適用される", async () => {
    const extension = captureAgentsExtension(
      { config: configWithMain },
      { flags: { agent: "main" } },
    );
    try {
      await extension.sessionStart();
      await extension.requestClassChange("high");
      const applied = extension.selectedModels.length;
      await extension.turnStart();
      assert.equal(extension.selectedModels.length, applied);
    } finally {
      extension.restore();
    }
  });

  it("手動選択中は適用せず warning を出す", async () => {
    const extension = captureAgentsExtension(
      { config: configWithMain },
      { flags: { agent: "main" } },
    );
    try {
      await extension.sessionStart();
      await extension.modelSelect("set");
      const applied = extension.selectedModels.length;
      await extension.requestClassChange("high");
      assert.equal(extension.selectedModels.length, applied);
      assert.match(
        extension.notifications.at(-1)!,
        /class change to high ignored: manual model selection is active/,
      );
    } finally {
      extension.restore();
    }
  });

  it("main 以外の agent では適用しない", async () => {
    const extension = captureAgentsExtension({ config: configWithMain });
    try {
      await extension.sessionStart();
      await extension.requestClassChange("high");
      assert.equal(extension.selectedModels.length, 1);
      assert.deepEqual(extension.selectedModels[0], { provider: "zai", id: "glm-5.2" });
    } finally {
      extension.restore();
    }
  });

  it("現在と同じクラス・未定義のクラス名ではモデルを切り替えない", async () => {
    const extension = captureAgentsExtension(
      { config: configWithMain },
      { flags: { agent: "main", class: "high" } },
    );
    try {
      await extension.sessionStart();
      await extension.requestClassChange("high");
      await extension.requestClassChange("ultra");
      assert.equal(extension.selectedModels.length, 1);
      assert.deepEqual(extension.selectedModels[0], {
        provider: "commandcode",
        id: "gpt-5.6-luna",
      });
    } finally {
      extension.restore();
    }
  });
});
