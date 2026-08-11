// 実行: bun --install=auto run index.test.ts
//
// role 拡張機能の振る舞いを検証する。
// 権限マトリクス等は ./index.ts の純粋関数を直接叩き、
// session_start / before_agent_start / tool_call / role:* コマンドは factory をモック起動して検証する。
// 各 it のタイトルが要件仕様（出典: ./SPEC.md）。
import assert from "node:assert/strict";
import roleExtension, {
  FAILURE_CATEGORIES,
  FAILURE_CATEGORY_LABELS,
  ROLES,
  buildRoleSystemPromptAddendum,
  canDelegate,
  canOperateFiles,
  childRole,
  initialRole,
  isOwnerDisplayObservation,
  isParentReportObservation,
  reportDestination,
  shouldBlockToolCall,
  switchRole,
} from "./index";
import type { ChildObservation, Principal, Role } from "./index";

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

interface ToolCallResult {
  block?: boolean;
  reason?: string;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
}

interface CapturedExtension {
  fireSessionStart: () => Promise<void>;
  runRoleCommand: (role: Role) => Promise<void>;
  getRoleWidget: () => string[] | undefined;
  getRoleWidgetPlacement: () => string | undefined;
  onToolCall: (toolName: string) => Promise<ToolCallResult | undefined>;
  fireBeforeAgentStart: (systemPrompt: string) => Promise<BeforeAgentStartResult | undefined>;
}

const roleWidgetUi = {
  roleWidget: undefined as unknown,
  roleWidgetPlacement: undefined as string | undefined,
  setWidget(key: string, content: unknown, options?: { placement?: string }) {
    if (key === "role") {
      this.roleWidget = content;
      this.roleWidgetPlacement = options?.placement;
    }
  },
  notify: () => {},
};

// factory をモック pi で起動し、イベントハンドラとコマンドを捕捉する。
// quiet-tools の captureTool と同じ粒度の seam。
function captureRoleExtension(): CapturedExtension {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>> = {};
  const commands = new Map<string, (args: string | undefined) => Promise<void>>();
  roleWidgetUi.roleWidget = undefined;
  roleWidgetUi.roleWidgetPlacement = undefined;
  roleExtension({
    on: (event: string, handler: typeof handlers[string][number]) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, def: { handler: (args: string | undefined) => Promise<void> }) => {
      commands.set(name, def.handler);
    },
  } as never);

  return {
    async fireSessionStart() {
      for (const handler of handlers.session_start ?? []) {
        await handler({}, { ui: roleWidgetUi });
      }
    },
    async runRoleCommand(role: Role) {
      await commands.get(`role:${role}`)?.(undefined, { ui: roleWidgetUi });
    },
    getRoleWidget() {
      const widgetFactory = roleWidgetUi.roleWidget as
        | ((_ui: unknown, theme: { fg: (color: string, text: string) => string }) => { render: () => string[] })
        | undefined;
      return widgetFactory?.({}, { fg: (color, text) => `${color}(${text})` })?.render();
    },
    getRoleWidgetPlacement() {
      return roleWidgetUi.roleWidgetPlacement;
    },
    async onToolCall(toolName: string) {
      for (const handler of handlers.tool_call ?? []) {
        const result = (await handler({ toolName }, { ui: roleWidgetUi })) as ToolCallResult | undefined;
        if (result?.block) return result;
      }
      return undefined;
    },
    async fireBeforeAgentStart(systemPrompt: string) {
      for (const handler of handlers.before_agent_start ?? []) {
        const result = (await handler({ systemPrompt }, {})) as BeforeAgentStartResult | undefined;
        if (result?.systemPrompt) return result;
      }
      return undefined;
    },
  };
}

describe("セッションのロール遷移", () => {
  it("新規セッションは manager で始まる", () => {
    assert.equal(initialRole(), "manager");
  });
  it("保存済みセッションを再開すると、保存前のロール（orch / manager / worker / chat）によらず manager で始まる", () => {
    for (const previousRole of ROLES) {
      assert.equal(initialRole(previousRole), "manager");
    }
  });
  it("オーナーがロールを orch へ切り替えると、セッションのロールは orch になる", () => {
    assert.equal(switchRole("orch"), "orch");
  });
  it("オーナーがロールを manager へ切り替えると、セッションのロールは manager になる", () => {
    assert.equal(switchRole("manager"), "manager");
  });
  it("オーナーがロールを worker へ切り替えると、セッションのロールは worker になる", () => {
    assert.equal(switchRole("worker"), "worker");
  });
  it("オーナーがロールを chat へ切り替えると、セッションのロールは chat になる", () => {
    assert.equal(switchRole("chat"), "chat");
  });
});

describe("ファイル操作の権限", () => {
  it("orch のセッションで read / write / edit を要求すると、操作はハードブロックされる", () => {
    const hardBlockedTools = ["read", "write", "edit"] as const;
    for (const tool of hardBlockedTools) {
      assert.equal(shouldBlockToolCall("orch", tool), true);
    }
  });
  it("orch のセッションで bash を要求すると、操作は実行される", () => {
    assert.equal(shouldBlockToolCall("orch", "bash"), false);
  });
  it("manager / worker のセッションでは read / write / edit / bash すべて実行される", () => {
    const rolesWithFileAccess: Role[] = ["manager", "worker"];
    const executableTools = ["read", "write", "edit", "bash"] as const;
    for (const role of rolesWithFileAccess) {
      assert.equal(canOperateFiles(role), true);
      for (const tool of executableTools) {
        assert.equal(shouldBlockToolCall(role, tool), false);
      }
    }
  });
  it("chat のセッションで read / write / edit を要求すると、操作はハードブロックされる", () => {
    const hardBlockedTools = ["read", "write", "edit"] as const;
    for (const tool of hardBlockedTools) {
      assert.equal(shouldBlockToolCall("chat", tool), true);
    }
  });
});

describe("ファイル操作禁止のシステムプロンプト指定", () => {
  it("orch ロールでは、システムプロンプトにファイル操作禁止の指示を追加する", () => {
    const addendum = buildRoleSystemPromptAddendum("orch");
    assert.ok(addendum.length > 0);
    assert.ok(addendum.includes("ファイル操作"));
  });
  it("chat ロールでは、システムプロンプトにファイル操作禁止の指示を追加する", () => {
    const addendum = buildRoleSystemPromptAddendum("chat");
    assert.ok(addendum.length > 0);
    assert.ok(addendum.includes("ファイル操作"));
  });
  it("manager / worker ロールでは、システムプロンプトへの追加は空になる", () => {
    assert.equal(buildRoleSystemPromptAddendum("manager"), "");
    assert.equal(buildRoleSystemPromptAddendum("worker"), "");
  });
});

describe("委譲の可否", () => {
  it("orch から orch へ委譲すると、子セッションは起動せず orch のセッションが継続する", () => {
    assert.equal(canDelegate("orch", "orch"), false);
    assert.equal(childRole("orch", "orch"), undefined);
  });
  it("orch から manager へ委譲すると、manager ロールの子セッションが起動する", () => {
    assert.equal(canDelegate("orch", "manager"), true);
    assert.equal(childRole("orch", "manager"), "manager");
  });
  it("orch から worker へ委譲すると、子セッションは起動せず orch のセッションが継続する", () => {
    assert.equal(canDelegate("orch", "worker"), false);
    assert.equal(childRole("orch", "worker"), undefined);
  });
  it("orch から chat へ委譲すると、子セッションは起動せず orch のセッションが継続する", () => {
    assert.equal(canDelegate("orch", "chat"), false);
    assert.equal(childRole("orch", "chat"), undefined);
  });
  it("manager から orch へ委譲すると、子セッションは起動せず manager のセッションが継続する", () => {
    assert.equal(canDelegate("manager", "orch"), false);
    assert.equal(childRole("manager", "orch"), undefined);
  });
  it("manager から manager へ委譲すると、子セッションは起動せず manager のセッションが継続する", () => {
    assert.equal(canDelegate("manager", "manager"), false);
    assert.equal(childRole("manager", "manager"), undefined);
  });
  it("manager から worker へ委譲すると、worker ロールの子セッションが起動する", () => {
    assert.equal(canDelegate("manager", "worker"), true);
    assert.equal(childRole("manager", "worker"), "worker");
  });
  it("manager から chat へ委譲すると、子セッションは起動せず manager のセッションが継続する", () => {
    assert.equal(canDelegate("manager", "chat"), false);
    assert.equal(childRole("manager", "chat"), undefined);
  });
  it("worker から orch へ委譲すると、子セッションは起動せず worker のセッションが継続する", () => {
    assert.equal(canDelegate("worker", "orch"), false);
    assert.equal(childRole("worker", "orch"), undefined);
  });
  it("worker から manager へ委譲すると、子セッションは起動せず worker のセッションが継続する", () => {
    assert.equal(canDelegate("worker", "manager"), false);
    assert.equal(childRole("worker", "manager"), undefined);
  });
  it("worker から worker へ委譲すると、子セッションは起動せず worker のセッションが継続する", () => {
    assert.equal(canDelegate("worker", "worker"), false);
    assert.equal(childRole("worker", "worker"), undefined);
  });
  it("chat から worker へ委譲すると、子セッションは起動せず chat のセッションが継続する", () => {
    assert.equal(canDelegate("chat", "worker"), false);
    assert.equal(childRole("chat", "worker"), undefined);
  });
});

describe("chat ロールのツール制限", () => {
  it("chat のセッションで web_search / web_fetch を要求すると、操作は実行される", () => {
    const allowedTools = ["web_search", "web_fetch"] as const;
    for (const tool of allowedTools) {
      assert.equal(shouldBlockToolCall("chat", tool), false);
    }
  });
  it("chat のセッションで web_search / web_fetch 以外のツール（ファイル操作・bash など）を要求すると、操作は実行されない", () => {
    const blockedTools = ["read", "write", "edit", "bash"] as const;
    for (const tool of blockedTools) {
      assert.equal(shouldBlockToolCall("chat", tool), true);
    }
  });
});

describe("委譲結果の観測", () => {
  it("委譲中、子エージェントの進行（メッセージ・ツール実行）はオーナーに表示される", () => {
    const childProgress: ChildObservation = { kind: "progress", content: "running bash..." };
    assert.equal(isOwnerDisplayObservation(childProgress), true);
  });
  it("子エージェントの中間ログは親エージェントに渡らない", () => {
    const childIntermediateLog: ChildObservation = { kind: "intermediate-log", content: "log line" };
    assert.equal(isParentReportObservation(childIntermediateLog), false);
  });
  it("委譲完了時、親エージェントに渡るのは 最終結果・作業要点・成果物情報 の3つだけで、中間ログは含まれない", () => {
    const parentReportKinds = ["final-result", "work-highlights", "artifact-info"] as const;
    for (const kind of parentReportKinds) {
      const observation: ChildObservation = { kind, content: "x" };
      assert.equal(isParentReportObservation(observation), true);
    }
    assert.equal(isParentReportObservation({ kind: "intermediate-log", content: "x" }), false);
    assert.equal(isParentReportObservation({ kind: "progress", content: "x" }), false);
  });
});

describe("報告", () => {
  it("タスクを遂行できないとき、理由を 権限不足 と 力量・情報不足 の2区分で報告する", () => {
    assert.deepEqual([...FAILURE_CATEGORIES], ["permission", "capacity"]);
    assert.equal(FAILURE_CATEGORY_LABELS.permission, "権限不足");
    assert.equal(FAILURE_CATEGORY_LABELS.capacity, "力量・情報不足");
  });
  it("worker が manager から呼ばれて遂行できないとき、報告先は manager になる", () => {
    const destination: Principal = reportDestination("worker", "manager");
    assert.equal(destination, "manager");
  });
  it("worker がオーナー直下で遂行できないとき、報告先はオーナーになる", () => {
    const destination: Principal = reportDestination("worker", "owner");
    assert.equal(destination, "owner");
  });
  it("manager が orch から呼ばれて遂行できないとき、報告先は orch になる", () => {
    const destination: Principal = reportDestination("manager", "orch");
    assert.equal(destination, "orch");
  });
  it("manager がオーナー直下で遂行できないとき、報告先はオーナーになる", () => {
    const destination: Principal = reportDestination("manager", "owner");
    assert.equal(destination, "owner");
  });
  it("orch が遂行できないとき、報告先はオーナーになる", () => {
    const destination: Principal = reportDestination("orch", "owner");
    assert.equal(destination, "owner");
  });
  it("chat が遂行できないとき、報告先はオーナーになる", () => {
    const destination: Principal = reportDestination("chat", "owner");
    assert.equal(destination, "owner");
  });
});

describe("拡張の接続", () => {
  it("session_start でセッションのロールは manager に初期化され、ファイル操作が許可される", async () => {
    const extension = captureRoleExtension();
    await extension.fireSessionStart();
    const result = await extension.onToolCall("read");
    assert.equal(result?.block ?? false, false);
  });
  it("session_start で role は dim 色の aboveEditor widget に表示される", async () => {
    const extension = captureRoleExtension();
    await extension.fireSessionStart();
    assert.deepEqual(extension.getRoleWidget(), ["dim(🤖 role: manager)"]);
    assert.equal(extension.getRoleWidgetPlacement(), "aboveEditor");
  });
  it("role:orch コマンドで orch に切り替えると、read の tool_call がハードブロックされる", async () => {
    const extension = captureRoleExtension();
    await extension.runRoleCommand("orch");
    const result = await extension.onToolCall("read");
    assert.equal(result?.block, true);
  });
  it("role:orch コマンドで orch に切り替えても、bash の tool_call は許可される", async () => {
    const extension = captureRoleExtension();
    await extension.runRoleCommand("orch");
    const result = await extension.onToolCall("bash");
    assert.equal(result?.block ?? false, false);
  });
  it("role:chat コマンドで chat に切り替えると、web_search は許可され bash はブロックされる", async () => {
    const extension = captureRoleExtension();
    await extension.runRoleCommand("chat");
    const webSearchResult = await extension.onToolCall("web_search");
    const bashResult = await extension.onToolCall("bash");
    assert.equal(webSearchResult?.block ?? false, false);
    assert.equal(bashResult?.block, true);
  });
  it("orch ロールの before_agent_start は、システムプロンプトにファイル操作禁止を追記する", async () => {
    const extension = captureRoleExtension();
    await extension.runRoleCommand("orch");
    const basePrompt = "元のシステムプロンプト";
    const result = await extension.fireBeforeAgentStart(basePrompt);
    assert.ok(result?.systemPrompt?.startsWith(basePrompt));
    assert.ok(result?.systemPrompt?.includes("ファイル操作"));
  });
  it("manager ロールの before_agent_start は、システムプロンプトを変更しない", async () => {
    const extension = captureRoleExtension();
    await extension.runRoleCommand("manager");
    const basePrompt = "元のシステムプロンプト";
    const result = await extension.fireBeforeAgentStart(basePrompt);
    assert.equal(result?.systemPrompt ?? basePrompt, basePrompt);
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
