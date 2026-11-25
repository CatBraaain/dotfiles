import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, it, mock, spyOn } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import footerExtension, {
  buildFooterLines,
  collectUsageSummary,
  formatCwdForFooter,
  formatTokens,
  type FooterRenderData,
} from "./index";
import { visibleWidth } from "@earendil-works/pi-tui";

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

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

const SESSION_ID = "12345678-1234-1234-1234-abcdefabcdef";
const EMPTY_ASSIGNMENTS = { worktrees: [], ticket: null };

function createFooterHarness(mode = "tui", sessionFile: string | null = "/sessions/saved.jsonl") {
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  const schedulePoll = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
  ) => {
    const timer = {} as ReturnType<typeof setInterval>;
    timers.set(timer, callback);
    return timer;
  }) as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
    timers.delete(timer as ReturnType<typeof setInterval>);
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const queries: Array<{
    command: string;
    args: string[];
    signal: AbortSignal | undefined;
    complete: (response: unknown) => void;
    resolve: (result: ExecResult) => void;
    reject: (reason: Error) => void;
  }> = [];
  let footer: ReturnType<FooterFactory> | undefined;
  let renderRequests = 0;
  let sessionId = SESSION_ID;
  const ctx = {
    mode,
    cwd: "/workspace/project",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getSessionName: () => undefined,
      getCwd: () => "/workspace/project",
      getEntries: () => [],
    },
    getContextUsage: () => undefined,
    ui: {
      setFooter(factory: FooterFactory) {
        footer?.dispose?.();
        footer = factory({ requestRender: () => renderRequests++ } as never, plainTheme as Theme, {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          getAvailableProviderCount: () => 1,
          onBranchChange: () => () => {},
        });
      },
    },
  };

  footerExtension({
    on(event, handler) {
      handlers.set(event, handler as never);
    },
    exec(command, args, options) {
      const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
      queries.push({ command, args, signal: options?.signal, complete, resolve, reject });
      return promise;

      function complete(response: unknown): void {
        resolve({
          code: 0,
          killed: false,
          stdout: JSON.stringify(response),
          stderr: "",
        });
      }
    },
  } as ExtensionAPI);

  return {
    queries,
    schedulePoll,
    poll: () => timers.forEach((callback) => callback()),
    timerCount: () => timers.size,
    emit: (event: string, payload: unknown = {}) => handlers.get(event)!(payload, ctx),
    render: () => footer?.render(120),
    renderRequests: () => renderRequests,
    setSessionId: (id: string) => {
      sessionId = id;
    },
  };
}

function assignmentResponse(name: string) {
  return { worktrees: [`/worktrees/${name}`], ticket: null };
}

describe("extension lifecycle", () => {
  afterEach(() => mock.restore());
  it("loads the full session ID on TUI startup and redraws from the successful response", async () => {
    const harness = createFooterHarness();
    harness.emit("session_start", { reason: "resume" });

    assert.equal(harness.render()?.length, 2);
    const query = harness.queries[0]!;
    assert.equal(query.command, "pi-mux");
    assert.deepEqual(query.args, ["metadata", SESSION_ID]);
    assert.equal(harness.schedulePoll.mock.calls[0]?.[1], 5000);
    query.complete({ ...assignmentResponse("saved"), unread: false, lastViewedAt: null });
    await setImmediate();
    assert.match(harness.render()?.[0] ?? "", /  worktree: saved  /);
    assert.equal(harness.renderRequests(), 1);
    assert.equal(harness.queries.length, 1);
  });

  it("does not install the footer or make a query outside the TUI", () => {
    const harness = createFooterHarness("print");
    harness.emit("session_start");
    assert.equal(harness.render(), undefined);
    assert.equal(harness.queries.length, 0);
    assert.equal(harness.timerCount(), 0);
  });

  it("skips the CLI for an in-memory session", () => {
    const harness = createFooterHarness("tui", null);
    harness.emit("session_start");
    assert.equal(harness.render()?.length, 2);
    assert.equal(harness.queries.length, 0);
    assert.equal(harness.timerCount(), 0);
  });

  it("replaces displayed values on a timer, including when metadata becomes empty", async () => {
    const harness = createFooterHarness();
    harness.emit("session_start");
    harness.queries[0]!.complete(assignmentResponse("saved"));
    await setImmediate();
    assert.match(harness.render()?.[0] ?? "", /  worktree: saved  /);
    assert.equal(harness.queries.length, 1);

    const latest = { worktrees: [], ticket: { project: "project", id: "ticket" } };
    harness.poll();
    harness.queries[1]!.complete(latest);
    await setImmediate();
    assert.match(harness.render()?.[0] ?? "", /  ticket: project\/ticket  /);

    harness.poll();
    harness.queries[2]!.complete(latest);
    await setImmediate();
    assert.equal(harness.renderRequests(), 2);

    harness.poll();
    harness.queries[3]!.complete(EMPTY_ASSIGNMENTS);
    await setImmediate();
    assert.doesNotMatch(harness.render()?.[0] ?? "", /(?:worktree|ticket):/);
    assert.equal(harness.renderRequests(), 3);
  });

  it("skips timer ticks while a query is pending", async () => {
    const harness = createFooterHarness();
    harness.emit("session_start");
    harness.poll();
    harness.poll();
    assert.equal(harness.queries.length, 1);

    harness.queries[0]!.complete(assignmentResponse("first"));
    await setImmediate();
    assert.match(harness.render()?.[0] ?? "", /  worktree: first  /);
    assert.equal(harness.queries.length, 1);

    harness.poll();
    harness.queries[1]!.complete(assignmentResponse("latest"));
    await setImmediate();
    assert.match(harness.render()?.[0] ?? "", /  worktree: latest  /);
  });

  it("cancels a pending query on switch and never shows the old session's assignments in the next footer", async () => {
    const harness = createFooterHarness();
    harness.emit("session_start");
    harness.queries[0]!.complete(assignmentResponse("old"));
    await setImmediate();
    assert.match(harness.render()?.[0] ?? "", /  worktree: old  /);
    harness.poll();
    const pending = harness.queries[1]!;
    harness.setSessionId("new-session");
    harness.emit("session_start", { reason: "fork" });
    assert.equal(pending.signal?.aborted, true);
    assert.equal(harness.timerCount(), 1);
    assert.deepEqual(harness.queries[2]!.args, ["metadata", "new-session"]);
    assert.doesNotMatch(harness.render()?.[0] ?? "", /worktree:/);

    pending.complete(assignmentResponse("too-late"));
    await setImmediate();
    assert.equal(harness.renderRequests(), 1);
    assert.doesNotMatch(harness.render()?.[0] ?? "", /worktree:/);

    harness.emit("session_shutdown");
    assert.equal(harness.timerCount(), 0);
    assert.equal(harness.queries[2]!.signal?.aborted, true);
    harness.poll();
    assert.equal(harness.queries.length, 3);
  });

  it("silently retains a valid response when later CLI invocations or payloads fail", async () => {
    const harness = createFooterHarness();
    harness.emit("session_start");
    const missingCli = harness.queries[0]!;
    missingCli.reject(new Error("command not found"));
    await setImmediate();
    assert.equal(harness.render()?.length, 2);

    harness.poll();
    harness.queries[1]!.complete(assignmentResponse("retained"));
    await setImmediate();

    const failures: Array<(query: (typeof harness.queries)[number]) => void> = [
      (query) => query.resolve({ code: 1, killed: false, stdout: "", stderr: "error" }),
      (query) => query.resolve({ code: 0, killed: false, stdout: "{", stderr: "" }),
      (query) => query.complete({ worktrees: [], ticket: { project: "project", id: 12 } }),
      (query) => query.complete({ worktrees: ["relative/path"], ticket: null }),
    ];
    for (const fail of failures) {
      harness.poll();
      fail(harness.queries.at(-1)!);
      await setImmediate();
      assert.match(harness.render()?.[0] ?? "", /  worktree: retained  /);
    }
    assert.equal(harness.renderRequests(), 1);
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

  it("keeps all session fields in order on one line when they fit", () => {
    const left =
      "/workspace/project (main)  worktree: zeta, alpha  ticket: project/ticket  Example title";
    const session = `session: ${SESSION_ID}`;
    const width = visibleWidth(left) + 2 + visibleWidth(session);
    const lines = buildFooterLines(
      width,
      renderData({
        sessionName: "Example title",
        assignments: {
          worktrees: ["/worktrees/zeta", "/worktrees/alpha"],
          ticket: { project: "project", id: "ticket" },
        },
      }),
      plainTheme,
    );

    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${left}  ${session}`);
    assert.match(lines[1]!, /^↑57k/);
  });

  it("wraps the first field that does not fit in visible columns and keeps later fields in order", () => {
    const width = 75;
    const lines = buildFooterLines(
      width,
      renderData({
        sessionName: "新規作業",
        extensionStatuses: new Map([["alpha", "alpha status"]]),
        assignments: {
          worktrees: ["/worktrees/feature"],
          ticket: { project: "project", id: "ticket" },
        },
      }),
      plainTheme,
    );

    assert.equal(lines[0], "/workspace/project (main)  worktree: feature  ticket: project/ticket");
    assert.match(lines[1]!, /^新規作業 {2,}session: 12345678-1234-1234-1234-abcdefabcdef$/);
    assert.equal(visibleWidth(lines[1]!), width);
    assert.match(lines[2]!, /^↑57k/);
    assert.equal(lines[3], "alpha status");
    assert.equal(lines.length, 4);
  });

  it("keeps the full session ID on its own line when it does not fit with the preceding field", () => {
    const width = 45;
    const lines = buildFooterLines(width, renderData({ sessionName: "Example title" }), plainTheme);

    assert.equal(lines[0], "/workspace/project (main)  Example title");
    assert.equal(lines[1], `session: ${SESSION_ID}`);
    assert.match(lines[2]!, /^↑57k/);
  });

  it("escapes assignment characters that could affect the terminal or break a line", () => {
    const lines = buildFooterLines(
      140,
      renderData({
        assignments: {
          worktrees: ["/worktrees/a\u001b[2J\nb"],
          ticket: { project: "p\u202e", id: "t\u2028" },
        },
      }),
      plainTheme,
    );
    assert.match(lines[0]!, /worktree: a\\u001b\[2J\\u000ab  ticket: p\\u202e\/t\\u2028/);
  });

  it("truncates a field that is too wide for a line of its own", () => {
    const width = 18;
    const lines = buildFooterLines(
      width,
      renderData({ assignments: assignmentResponse("日本語の担当") }),
      plainTheme,
    );
    assert.equal(stripVTControlCharacters(lines[1]!), "worktree: 日本...");
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
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

  it("uses only dim on every line, including wrapped session fields", () => {
    const lines = buildFooterLines(
      65,
      renderData({ extensionStatuses: new Map([["alpha", "alpha status"]]) }),
      taggingTheme,
    );

    assert.equal(lines.length, 4);
    const dimCode = "\x1B[2m";
    for (const line of lines) {
      assert.ok(line.includes(dimCode), `dim color missing in: ${JSON.stringify(line)}`);
      const withoutDim = line.replaceAll(dimCode, "").replaceAll("\x1B[0m", "");
      assert.ok(!withoutDim.includes("\x1B"), `non-dim color used in: ${JSON.stringify(line)}`);
    }
  });
});
