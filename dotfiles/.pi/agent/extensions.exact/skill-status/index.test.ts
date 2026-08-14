// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import skillShortcut from "../skill-shortcut/index";
import skillStatusExtension, {
  buildSkillStatusWidgetLines,
  createSkillStatusState,
  markSkillFired,
  registerSkillPaths,
  skillNameForReadPath,
  SKILL_STATUS_WIDGET_KEY,
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

type Handler = (event: any, ctx: any) => unknown;

type WidgetContext = {
  context: {
    cwd: string;
    hasUI: boolean;
    sessionManager: { getEntries: () => any[] };
    ui: { setWidget: (...args: any[]) => void };
  };
  widgetCalls: any[][];
  widgetColors: string[];
};

function captureExtension(sessionEntries: any[] = []): {
  handlers: Map<string, Handler>;
  commands: any[];
} {
  const handlers = new Map<string, Handler>();
  const commands: any[] = [];
  skillStatusExtension({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    getCommands() {
      return commands;
    },
    appendEntry(customType: string, data: unknown) {
      sessionEntries.push({ type: "custom", customType, data });
    },
  } as never);
  return { handlers, commands };
}

function captureActualExtensionPath(): { handlers: Map<string, Handler[]>; commands: any[] } {
  const handlers = new Map<string, Handler[]>();
  const commands: any[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    getCommands() {
      return commands;
    },
    appendEntry() {},
  };
  skillShortcut(pi as never);
  skillStatusExtension(pi as never);
  return { handlers, commands };
}

function widgetContext(hasUI = true): WidgetContext {
  const widgetCalls: any[][] = [];
  const widgetColors: string[] = [];
  return {
    context: {
      cwd: "/project",
      hasUI,
      sessionManager: { getEntries: () => [] },
      ui: {
        setWidget: (...args: any[]) => {
          if (typeof args[1] === "function") {
            args[1] = args[1](
              {},
              {
                fg: (color: string, text: string) => {
                  widgetColors.push(color);
                  return text;
                },
              },
            ).render();
          }
          widgetCalls.push(args);
        },
      },
    },
    widgetCalls,
    widgetColors,
  };
}

function skillPrompt(skillName: string): string {
  return `<skill name="${skillName}" location="/project/${skillName}/SKILL.md">\nbody\n</skill>`;
}

function skillOptions(skillName: string): {
  cwd: string;
  skills: { name: string; filePath: string }[];
} {
  return {
    cwd: "/project",
    skills: [{ name: skillName, filePath: `/project/${skillName}/SKILL.md` }],
  };
}

function recordSkill(
  handlers: Map<string, Handler>,
  context: WidgetContext["context"],
  skillName: string,
): void {
  handlers.get("before_agent_start")!(
    { prompt: "ordinary prompt", systemPromptOptions: skillOptions(skillName) },
    context,
  );
  handlers.get("tool_call")!(
    {
      toolName: "read",
      toolCallId: `read-${skillName}`,
      input: { path: `/project/${skillName}/SKILL.md` },
    },
    context,
  );
  handlers.get("tool_result")!(
    {
      toolName: "read",
      toolCallId: `read-${skillName}`,
      isError: false,
      input: { path: `/project/${skillName}/SKILL.md` },
    },
    context,
  );
}

async function runActualInput(
  handlers: Map<string, Handler[]>,
  context: WidgetContext["context"],
  text: string,
): Promise<void> {
  let currentText = text;
  for (const handler of handlers.get("input") ?? []) {
    const result = await handler({ text: currentText, source: "interactive" }, context);
    if ((result as any)?.action === "transform") currentText = (result as any).text;
  }
}

function runActualBeforeAgentStart(
  handlers: Map<string, Handler[]>,
  context: WidgetContext["context"],
  skillName: string,
): void {
  for (const handler of handlers.get("before_agent_start") ?? []) {
    handler(
      { prompt: skillPrompt(skillName), systemPromptOptions: skillOptions(skillName) },
      context,
    );
  }
}

describe("表示", () => {
  it("発火済み skill がない場合は widget を消去する", () => {
    assert.equal(buildSkillStatusWidgetLines([]), undefined);
  });

  it("skill 名を初回発火順にカンマ区切りで表示する", () => {
    assert.deepEqual(buildSkillStatusWidgetLines(["skill-a", "skill-b"]), [
      "🎯 skills: skill-a, skill-b",
    ]);
  });
});

describe("発火", () => {
  it("未登録の明示 skill は表示を変更しない", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls } = widgetContext();

    handlers.get("input")!({ text: "/skill:skill-a", source: "interactive" }, context);
    handlers.get("before_agent_start")!(
      { prompt: skillPrompt("skill-a"), systemPromptOptions: skillOptions("skill-a") },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], undefined);
  });

  it("登録済み明示 skill の利用完了で表示する", () => {
    const { handlers, commands } = captureExtension();
    commands.push({ name: "skill:skill-a", source: "skill" });
    const { context, widgetCalls } = widgetContext();

    handlers.get("input")!({ text: "/skill:skill-a", source: "interactive" }, context);
    handlers.get("before_agent_start")!(
      { prompt: skillPrompt("skill-a"), systemPromptOptions: skillOptions("skill-a") },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a"]);
  });

  it("失敗した明示 skill は表示を変更しない", () => {
    const { handlers, commands } = captureExtension();
    commands.push({ name: "skill:skill-a", source: "skill" });
    const { context, widgetCalls } = widgetContext();
    recordSkill(handlers, context, "skill-b");
    widgetCalls.length = 0;

    handlers.get("input")!({ text: "/skill:skill-a", source: "interactive" }, context);
    handlers.get("before_agent_start")!(
      { prompt: "/skill:skill-a", systemPromptOptions: { skills: [] } },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-b"]);
  });

  it("skill 名を通常入力に含めても既存の表示を変更しない", () => {
    const { handlers, commands } = captureExtension();
    commands.push({ name: "skill:skill-a", source: "skill" });
    const { context, widgetCalls } = widgetContext();
    handlers.get("input")!({ text: "/skill:skill-a", source: "interactive" }, context);
    handlers.get("before_agent_start")!(
      { prompt: skillPrompt("skill-a"), systemPromptOptions: skillOptions("skill-a") },
      context,
    );
    widgetCalls.length = 0;

    handlers.get("input")!({ text: "skill-a の説明", source: "interactive" }, context);
    handlers.get("before_agent_start")!(
      { prompt: "skill-a の説明", systemPromptOptions: skillOptions("skill-a") },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a"]);
  });

  it("引数付き明示 skill を利用完了すると表示する", () => {
    const { handlers, commands } = captureExtension();
    commands.push({ name: "skill:skill-a", source: "skill" });
    const { context, widgetCalls } = widgetContext();

    handlers.get("input")!(
      { text: "/skill:skill-a extra argument", source: "interactive" },
      context,
    );
    handlers.get("before_agent_start")!(
      { prompt: skillPrompt("skill-a"), systemPromptOptions: skillOptions("skill-a") },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a"]);
  });

  it("skill 名に slash を含む明示入力は表示を変更しない", () => {
    const { handlers, commands } = captureExtension();
    commands.push({ name: "skill:skill-a/b", source: "skill" });
    const { context, widgetCalls } = widgetContext();

    handlers.get("input")!({ text: "/skill:skill-a/b", source: "interactive" }, context);
    handlers.get("before_agent_start")!(
      { prompt: skillPrompt("skill-a/b"), systemPromptOptions: skillOptions("skill-a/b") },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], undefined);
  });

  it("成功した自動 skill read の利用完了で表示する", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls } = widgetContext();
    handlers.get("before_agent_start")!(
      { prompt: "ordinary prompt", systemPromptOptions: skillOptions("skill-a") },
      context,
    );
    widgetCalls.length = 0;

    handlers.get("tool_call")!(
      {
        toolName: "read",
        toolCallId: "read-skill-a",
        input: { path: "/project/skill-a/SKILL.md" },
      },
      context,
    );
    handlers.get("tool_result")!(
      {
        toolName: "read",
        toolCallId: "read-skill-a",
        isError: false,
        input: { path: "/project/skill-a/SKILL.md" },
      },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a"]);
  });

  it("失敗した自動 skill read は表示を変更しない", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls } = widgetContext();
    recordSkill(handlers, context, "skill-b");
    handlers.get("before_agent_start")!(
      { prompt: "ordinary prompt", systemPromptOptions: skillOptions("skill-a") },
      context,
    );
    widgetCalls.length = 0;
    handlers.get("tool_call")!(
      {
        toolName: "read",
        toolCallId: "read-skill-a",
        input: { path: "/project/skill-a/SKILL.md" },
      },
      context,
    );
    handlers.get("tool_result")!(
      {
        toolName: "read",
        toolCallId: "read-skill-a",
        isError: true,
        input: { path: "/project/skill-a/SKILL.md" },
      },
      context,
    );

    assert.deepEqual(widgetCalls, []);
  });

  it("対象外 path の read は表示を変更しない", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls } = widgetContext();
    handlers.get("before_agent_start")!(
      { prompt: "ordinary prompt", systemPromptOptions: skillOptions("skill-a") },
      context,
    );
    widgetCalls.length = 0;
    handlers.get("tool_call")!(
      { toolName: "read", toolCallId: "read-other", input: { path: "/project/other.txt" } },
      context,
    );
    handlers.get("tool_result")!(
      {
        toolName: "read",
        toolCallId: "read-other",
        isError: false,
        input: { path: "/project/other.txt" },
      },
      context,
    );

    assert.deepEqual(widgetCalls, []);
  });

  it("実際の extension 経路で skill-a から skill-b の順序を記録する", async () => {
    const { handlers, commands } = captureActualExtensionPath();
    commands.push(
      { name: "skill:skill-a", source: "skill" },
      { name: "skill:skill-b", source: "skill" },
    );
    const { context, widgetCalls } = widgetContext();

    await runActualInput(handlers, context, "/skill-a");
    runActualBeforeAgentStart(handlers, context, "skill-a");
    await runActualInput(handlers, context, "/skill-b");
    runActualBeforeAgentStart(handlers, context, "skill-b");

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a, skill-b"]);
  });
});

describe("状態", () => {
  it("同じ skill の再発火を一度だけ初回発火順に記録する", () => {
    const state = createSkillStatusState();

    assert.equal(markSkillFired(state, "skill-a"), true);
    assert.equal(markSkillFired(state, "skill-a"), false);
    markSkillFired(state, "skill-b");

    assert.deepEqual(state.firedSkillNames, ["skill-a", "skill-b"]);
  });

  it("登録済み skill の絶対 path と相対 path を名前へ解決する", () => {
    const state = createSkillStatusState();
    registerSkillPaths(
      state,
      [{ name: "skill-a", filePath: "/project/.pi/skill-a/SKILL.md" }],
      "/project",
    );

    assert.equal(
      skillNameForReadPath(state, "/project/.pi/skill-a/SKILL.md", "/project"),
      "skill-a",
    );
    assert.equal(skillNameForReadPath(state, ".pi/skill-a/SKILL.md", "/project"), "skill-a");
  });

  it("登録されていない SKILL.md を skill として解決しない", () => {
    const state = createSkillStatusState();
    registerSkillPaths(
      state,
      [{ name: "skill-a", filePath: "/project/.pi/skill-a/SKILL.md" }],
      "/project",
    );

    assert.equal(skillNameForReadPath(state, "/project/other/SKILL.md", "/project"), undefined);
  });

  it("同じ skill を実際の extension 経路で再利用しても表示を変更しない", async () => {
    const { handlers, commands } = captureActualExtensionPath();
    commands.push({ name: "skill:skill-a", source: "skill" });
    const { context, widgetCalls } = widgetContext();

    await runActualInput(handlers, context, "/skill-a");
    runActualBeforeAgentStart(handlers, context, "skill-a");
    widgetCalls.length = 0;
    await runActualInput(handlers, context, "/skill-a");
    runActualBeforeAgentStart(handlers, context, "skill-a");

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a"]);
  });

  it("session_start の reload では表示を維持する", () => {
    const sessionEntries: any[] = [];
    const firstExtension = captureExtension(sessionEntries);
    const firstContext = widgetContext().context;
    firstContext.sessionManager = { getEntries: () => sessionEntries };
    recordSkill(firstExtension.handlers, firstContext, "skill-a");

    const secondExtension = captureExtension(sessionEntries);
    const { context: secondContext, widgetCalls } = widgetContext();
    secondContext.sessionManager = { getEntries: () => sessionEntries };
    secondExtension.handlers.get("session_start")!({ reason: "reload" }, secondContext);

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a"]);
  });

  it("session_start の new で別セッションの一覧を消去する", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls } = widgetContext();
    recordSkill(handlers, context, "skill-a");

    handlers.get("session_start")!({ reason: "new" }, context);

    assert.deepEqual(widgetCalls.at(-1), [
      SKILL_STATUS_WIDGET_KEY,
      undefined,
      { placement: "aboveEditor" },
    ]);
  });

  it("session_start の resume で別セッションの一覧を消去する", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls } = widgetContext();
    recordSkill(handlers, context, "skill-a");

    handlers.get("session_start")!({ reason: "resume" }, context);

    assert.deepEqual(widgetCalls.at(-1), [
      SKILL_STATUS_WIDGET_KEY,
      undefined,
      { placement: "aboveEditor" },
    ]);
  });

  it("session_start の fork で別セッションの一覧を消去する", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls } = widgetContext();
    recordSkill(handlers, context, "skill-a");

    handlers.get("session_start")!({ reason: "fork" }, context);

    assert.deepEqual(widgetCalls.at(-1), [
      SKILL_STATUS_WIDGET_KEY,
      undefined,
      { placement: "aboveEditor" },
    ]);
  });
});

describe("UI", () => {
  it("UI がなければ path 登録後の成功 read で内部状態だけを更新する", () => {
    const { handlers } = captureExtension();
    const { context, widgetCalls, widgetColors } = widgetContext(false);
    handlers.get("before_agent_start")!(
      { prompt: "ordinary prompt", systemPromptOptions: skillOptions("skill-a") },
      context,
    );

    handlers.get("tool_call")!(
      {
        toolName: "read",
        toolCallId: "read-skill-a",
        input: { path: "/project/skill-a/SKILL.md" },
      },
      context,
    );
    handlers.get("tool_result")!(
      {
        toolName: "read",
        toolCallId: "read-skill-a",
        isError: false,
        input: { path: "/project/skill-a/SKILL.md" },
      },
      context,
    );
    assert.deepEqual(widgetCalls, []);

    context.hasUI = true;
    handlers.get("before_agent_start")!(
      { prompt: "ordinary prompt", systemPromptOptions: skillOptions("skill-a") },
      context,
    );

    assert.deepEqual(widgetCalls.at(-1)?.[1], ["🎯 skills: skill-a"]);
    assert.deepEqual(widgetColors, ["dim"]);
  });
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`ok - ${test.name}`);
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
