// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import footerExtension, {
  buildFooterLines,
  collectUsageSummary,
  formatCwdForFooter,
  formatTokens,
  type FooterRenderData,
} from "./index";
import { visibleWidth } from "@earendil-works/pi-tui";

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

const plainTheme: Pick<Theme, "fg"> = {
  fg: (_color, text) => text,
};

const ansiCodes: Record<string, string> = {
  dim: "\x1B[2m",
  error: "\x1B[91m",
  warning: "\x1B[93m",
};

const taggingTheme: Pick<Theme, "fg"> = {
  fg: (color, text) => `${ansiCodes[color] ?? "\x1B[39m"}${text}\x1B[0m`,
};

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number,
): Record<string, unknown> {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function messageEntry(role: string, messageUsage?: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id: role,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, usage: messageUsage },
  } as never;
}

function renderData(overrides: Partial<FooterRenderData> = {}): FooterRenderData {
  return {
    cwd: "/workspace/project",
    home: undefined,
    branch: "main",
    sessionName: undefined,
    sessionId: "12345678-1234-1234-1234-abcdefabcdef",
    usage: {
      totals: { input: 57000, output: 1800, cacheRead: 94000, cacheWrite: 0, cost: 0.015 },
      latestCacheHitRate: 88.7,
    },
    contextUsage: { tokens: 56000, contextWindow: 272000, percent: 20.6 },
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      reasoning: true,
      contextWindow: 272000,
    },
    thinkingLevel: "high",
    availableProviderCount: 2,
    extensionStatuses: new Map(),
    ...overrides,
  };
}

function entryWithUsage(
  type: "compaction" | "branch_summary",
  entryUsage: Record<string, unknown>,
): SessionEntry {
  return {
    type,
    id: type,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    usage: entryUsage,
  } as never;
}

describe("formatting", () => {
  it("標準フッターと同じ単位でトークン数を短縮する", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1234), "1.2k");
    assert.equal(formatTokens(12345), "12k");
    assert.equal(formatTokens(1234567), "1.2M");
    assert.equal(formatTokens(12345678), "12M");
  });

  it("ホームディレクトリ配下の作業ディレクトリを ~ で表示する", () => {
    assert.equal(formatCwdForFooter("/home/user/project", "/home/user"), "~/project");
    assert.equal(formatCwdForFooter("/workspace/project", "/home/user"), "/workspace/project");
  });
});

describe("usage", () => {
  it("assistant、tool result、compaction の usage を累積する", () => {
    const summary = collectUsageSummary([
      messageEntry("assistant", usage(50000, 1000, 90000, 1000, 0.01)),
      messageEntry("toolResult", usage(7000, 800, 4000, 0, 0.002)),
      entryWithUsage("compaction", usage(0, 0, 0, 0, 0.003)),
    ]);

    assert.deepEqual(summary.totals, {
      input: 57000,
      output: 1800,
      cacheRead: 94000,
      cacheWrite: 1000,
      cost: 0.015,
    });
    assert.equal(summary.latestCacheHitRate, (90000 / 141000) * 100);
  });
});

describe("extension lifecycle", () => {
  it("TUI の session_start でカスタムフッターを登録する", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    let setFooterCalls = 0;
    footerExtension({
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        handlers.set(event, handler);
      },
    } as never);

    handlers.get("session_start")!({}, { mode: "tui", ui: { setFooter: () => setFooterCalls++ } });

    assert.equal(setFooterCalls, 1);
  });

  it("TUI 以外ではカスタムフッターを登録しない", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    let setFooterCalls = 0;
    footerExtension({
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        handlers.set(event, handler);
      },
    } as never);

    handlers.get("session_start")!(
      {},
      { mode: "print", ui: { setFooter: () => setFooterCalls++ } },
    );

    assert.equal(setFooterCalls, 0);
  });
});

describe("footer", () => {
  it("作業ディレクトリ、セッションID、usage、context、model を表示する", () => {
    const lines = buildFooterLines(140, renderData(), plainTheme);

    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\/workspace\/project \(main\)/);
    assert.match(lines[0]!, /session: 12345678-1234-1234-1234-abcdefabcdef$/);
    assert.match(lines[1]!, /↑57k ↓1.8k R94k W0 CH88\.7% \$0\.015 20\.6%\/272k/);
    assert.match(lines[1]!, /\(openai-codex\) gpt-5\.6-luna • high$/);
    assert.equal(visibleWidth(lines[0]!), 140);
    assert.equal(visibleWidth(lines[1]!), 140);
  });

  it("extension status をキーのアルファベット順に3行目へ表示する", () => {
    const lines = buildFooterLines(
      100,
      renderData({
        extensionStatuses: new Map([
          ["zeta", "zeta"],
          ["alpha", "alpha"],
        ]),
      }),
      plainTheme,
    );

    assert.equal(lines[2], "alpha zeta");
  });

  it("context usage が不明な場合は ? と上限を表示する", () => {
    const lines = buildFooterLines(
      100,
      renderData({ contextUsage: { tokens: null, contextWindow: 272000, percent: null } }),
      plainTheme,
    );

    assert.match(lines[1]!, /\?\/272k/);
  });

  it("usage がすべて0でも各項目を0で表示する", () => {
    const lines = buildFooterLines(
      140,
      renderData({
        usage: {
          totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          latestCacheHitRate: undefined,
        },
      }),
      plainTheme,
    );

    assert.match(lines[1]!, /^↑0 ↓0 R0 W0 CH0\.0% \$0\.000 /);
  });

  it("表示幅が不足してもすべての行を端末幅以内に収める", () => {
    const width = 36;
    const lines = buildFooterLines(width, renderData(), plainTheme);

    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  });

  it("すべての行を dim だけで表示する", () => {
    const lines = buildFooterLines(
      140,
      renderData({ extensionStatuses: new Map([["alpha", "alpha status"]]) }),
      taggingTheme,
    );

    assert.equal(lines.length, 3);
    for (const line of lines) {
      const withoutDim = line.replaceAll("\x1B[2m", "").replaceAll("\x1B[0m", "");
      assert.ok(!withoutDim.includes("\x1B"), `non-dim color used in: ${JSON.stringify(line)}`);
    }
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
