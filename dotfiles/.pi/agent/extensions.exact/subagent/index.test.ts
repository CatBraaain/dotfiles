// 実行: bun --install=auto run index.test.ts

import subagentExtension, { __spawn, deriveLabel, formatToolCall } from "./index";
import { Container, Text } from "@earendil-works/pi-tui";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";

// ponytail: 自作ランナー（vitest は bun auto-install 非互換のため逐次実行）。
const tests: { name: string; fn: () => void }[] = [];
let group = "";
function describe(name: string, fn: () => void): void {
  const prev = group;
  group = name;
  fn();
  group = prev;
}
function it(name: string, fn: () => void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}


const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// --- 子プロセスのフェイク (pi の JSON モード出力を stdout で再現) ---

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd?: string };
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killHistory: string[] = [];
  ignoreTerm = false;

  kill(signal: string = "SIGTERM"): boolean {
    this.killHistory.push(signal);
    const fatal = signal === "SIGKILL" || !this.ignoreTerm;
    if (fatal) {
      this.killed = true;
      setImmediate(() => this.emit("close", 1));
    }
    return true;
  }
}

function mockSpawn(): {
  calls: SpawnCall[];
  children: FakeChild[];
  respond: (fn: (child: FakeChild, call: SpawnCall) => void) => void;
  restore: () => void;
} {
  const original = __spawn.current;
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  let responder: (child: FakeChild, call: SpawnCall) => void = () => {};
  // execute が stdout/close リスナを登録した後にイベントを流すため setImmediate で遅延させる。
  __spawn.current = ((command: string, args: string[], options: { cwd?: string }) => {
    const child = new FakeChild();
    calls.push({ command, args, options });
    children.push(child);
    setImmediate(() => responder(child, { command, args, options }));
    return child;
  }) as unknown as typeof __spawn.current;
  return {
    calls,
    children,
    respond: (fn) => {
      responder = fn;
    },
    restore: () => {
      __spawn.current = original;
    },
  };
}

function piLine(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

function assistantTextMessage(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], ...extra },
  };
}

function assistantToolCallMessage(toolName: string, args: Record<string, unknown>): unknown {
  return { role: "assistant", content: [{ type: "toolCall", name: toolName, arguments: args }] };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function childrenText(container: Container): string {
  return container.children.map((child) => (child instanceof Text ? child.text : "")).join("\n");
}

// 登録されたツールを取り出す
function captureRegisteredTool(): {
  execute: (...args: unknown[]) => Promise<unknown>;
  renderResult: (...args: unknown[]) => unknown;
} {
  let registered:
    | {
        execute: (...args: unknown[]) => Promise<unknown>;
        renderResult: (...args: unknown[]) => unknown;
      }
    | undefined;
  subagentExtension({ registerTool: (tool) => (registered = tool) } as never);
  return registered as {
    execute: (...args: unknown[]) => Promise<unknown>;
    renderResult: (...args: unknown[]) => unknown;
  };
}

const tool = captureRegisteredTool();

const fakeTheme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
  bold: (text: string) => `*${text}*`,
} as unknown as { fg: (color: string, text: string) => string; bold: (text: string) => string };

describe("サブエージェントの単一モード実行", () => {
  it("タスクを渡すと子エージェントを1つ起動し、その最終テキスト出力を親に返す", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => {
      child.stdout.emit("data", Buffer.from(piLine(assistantTextMessage("最終回答"))));
      child.emit("close", 0);
    });
    try {
      const result = (await tool.execute("call-1", { task: "何かやって" }, undefined, undefined, {
        cwd: "/parent",
      })) as {
        content: Array<{ type: string; text: string }>;
      };

      assert.equal(spawnMock.calls.length, 1, "子プロセスは1つだけ起動する");
      assert.equal(textOf(result), "最終回答", "子の最終テキスト出力を親に返す");
    } finally {
      spawnMock.restore();
    }
  });

  it("作業ディレクトリを省略すると親の作業ディレクトリで子を動かす", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => child.emit("close", 0));
    try {
      await tool.execute("call-1", { task: "何かやって" }, undefined, undefined, {
        cwd: "/parent/dir",
      });

      const spawnOptions = spawnMock.calls[0].options;
      assert.equal(spawnOptions.cwd, "/parent/dir", "cwd 省略時は親の cwd で子を動かす");
    } finally {
      spawnMock.restore();
    }
  });

  it("作業ディレクトリを指定するとそのディレクトリで子を動かす", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => child.emit("close", 0));
    try {
      await tool.execute(
        "call-1",
        { task: "何かやって", cwd: "/child/dir" },
        undefined,
        undefined,
        { cwd: "/parent/dir" },
      );

      const spawnOptions = spawnMock.calls[0].options;
      assert.equal(spawnOptions.cwd, "/child/dir", "cwd 指定時はそのディレクトリで子を動かす");
    } finally {
      spawnMock.restore();
    }
  });
});

describe("子プロセスのオプション", () => {
  it("model を指定するとそのモデルで子を動かす", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => child.emit("close", 0));
    try {
      await tool.execute(
        "call-1",
        { task: "何かやって", model: "claude-sonnet" },
        undefined,
        undefined,
        { cwd: "/parent" },
      );

      const spawnArgs = spawnMock.calls[0].args;
      assert.ok(spawnArgs.includes("--model"), "model を指定すると --model フラグを渡す");
      assert.ok(spawnArgs.includes("claude-sonnet"), "model を指定するとそのモデル名を渡す");
    } finally {
      spawnMock.restore();
    }
  });
});

describe("リアルタイムのストリーミング表示", () => {
  it("子の思考テキストを到着順にユーザーへストリーミングする", async () => {
    const spawnMock = mockSpawn();
    const streamedTexts: string[] = [];
    spawnMock.respond((child) => {
      child.stdout.emit("data", Buffer.from(piLine(assistantTextMessage("一段階目の思考"))));
      child.stdout.emit("data", Buffer.from(piLine(assistantTextMessage("二段階目の思考"))));
      child.emit("close", 0);
    });
    try {
      await tool.execute(
        "call-1",
        { task: "考えて" },
        undefined,
        (update: unknown) =>
          streamedTexts.push(textOf(update as { content: Array<{ type: string; text: string }> })),
        { cwd: "/parent" },
      );

      assert.deepEqual(
        streamedTexts,
        ["一段階目の思考", "二段階目の思考"],
        "到着順にユーザーへストリーミングする",
      );
    } finally {
      spawnMock.restore();
    }
  });

  it("実行中のツールコールはすべて同じ汎用の1行プレビューで描画する", () => {
    const themeFg = (color: string, text: string) => `[${color}]${text}`;

    const bashPreview = formatToolCall("bash", { command: "ls -la" }, themeFg);
    const readPreview = formatToolCall("read", { file_path: "/etc/hosts" }, themeFg);

    assert.equal(
      bashPreview,
      `[accent]bash[dim] ${JSON.stringify({ command: "ls -la" })}`,
      "bash も汎用フォーマット（$ 接頭辞なし）",
    );
    assert.equal(
      readPreview,
      `[accent]read[dim] ${JSON.stringify({ file_path: "/etc/hosts" })}`,
      "read も汎用フォーマット（パス専用表示なし）",
    );
  });

  it("折りたたみ表示と展開表示をユーザーが切り替えられる", () => {
    const details = {
      results: [
        {
          label: "task",
          task: "何かやって",
          exitCode: 0,
          messages: [assistantToolCallMessage("bash", { command: "ls" })],
          stderr: "",
          stopReason: "end",
        },
      ],
    };

    const collapsed = tool.renderResult(
      { content: [], details },
      { expanded: false },
      fakeTheme,
      undefined,
    ) as unknown;
    const expanded = tool.renderResult(
      { content: [], details },
      { expanded: true },
      fakeTheme,
      undefined,
    ) as unknown;

    assert.ok(collapsed instanceof Text, "折りたたみ表示は1つの Text");
    assert.ok(expanded instanceof Container, "展開表示は複数行を束ねる Container");
    assert.ok(
      childrenText(expanded as Container).includes("─── Task ───"),
      "展開表示にはタスク本文セクションが含まれる",
    );
  });
});

describe("ユーザーと親の間の出力分離", () => {
  it("実行中、子の思考出力すべてをユーザーに見せる", async () => {
    const spawnMock = mockSpawn();
    const userUpdates: Array<{ details: { results: Array<{ messages: unknown[] }> } }> = [];
    spawnMock.respond((child) => {
      child.stdout.emit("data", Buffer.from(piLine(assistantTextMessage("一段階目の思考"))));
      child.stdout.emit("data", Buffer.from(piLine(assistantTextMessage("二段階目の思考"))));
      child.emit("close", 0);
    });
    try {
      await tool.execute(
        "call-1",
        { task: "考えて" },
        undefined,
        (update: unknown) =>
          userUpdates.push(update as { details: { results: Array<{ messages: unknown[] }> } }),
        { cwd: "/parent" },
      );

      const lastUpdateMessages = userUpdates[userUpdates.length - 1].details.results[0].messages;
      assert.equal(lastUpdateMessages.length, 2, "実行中の思考出力をすべてユーザーに見せる");
    } finally {
      spawnMock.restore();
    }
  });

  it("子の最終テキスト出力だけを親エージェントに渡す", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => {
      child.stdout.emit("data", Buffer.from(piLine(assistantTextMessage("途中の推論"))));
      child.stdout.emit("data", Buffer.from(piLine(assistantTextMessage("最終回答"))));
      child.emit("close", 0);
    });
    try {
      const result = (await tool.execute("call-1", { task: "答えて" }, undefined, undefined, {
        cwd: "/parent",
      })) as {
        content: Array<{ type: string; text: string }>;
      };

      assert.equal(textOf(result), "最終回答", "親には最終テキストのみ渡す");
      assert.equal(result.content.length, 1, "親への出力は途中の推論を含まない1つのテキストだけ");
    } finally {
      spawnMock.restore();
    }
  });
});

describe("結果のラベル", () => {
  it("model を指定したときはそのモデル名をラベルにする", () => {
    assert.equal(deriveLabel({ model: "claude-sonnet" }), "claude-sonnet", "モデル名がラベルになる");
  });

  it("model がないときは汎用のラベルに落ちる", () => {
    assert.equal(deriveLabel({}), "task", "汎用のラベルに落ちる");
  });
});

describe("キャンセルの伝播", () => {
  it("親の実行がキャンセルされたら子プロセスを止める", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond(() => {
      // キャンセルで kill されるまで子は生存し続ける
    });
    const controller = new AbortController();
    try {
      const execPromise = tool.execute(
        "call-1",
        { task: "長いタスク" },
        controller.signal,
        undefined,
        { cwd: "/parent" },
      );
      await nextTick();
      controller.abort();

      await assert.rejects(execPromise, /aborted/, "親のキャンセルで子の実行はエラー終了する");
      assert.ok(
        spawnMock.children[0].killHistory.includes("SIGTERM"),
        "キャンセル時に SIGTERM で子を止める",
      );
    } finally {
      spawnMock.restore();
    }
  });

  it("タイムアウトは設けず、親のキャンセル時だけ子を止める", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => child.emit("close", 0));
    try {
      await tool.execute("call-1", { task: "タスク" }, undefined, undefined, { cwd: "/parent" });

      assert.equal(
        spawnMock.children[0].killHistory.length,
        0,
        "キャンセルしなければタイムアウトでも kill しない",
      );
    } finally {
      spawnMock.restore();
    }
  });

  it("穏当な終了シグナルから数秒経っても子が止まらないときは強制 kill にエスカレートする", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => {
      child.ignoreTerm = true; // SIGTERM を無視する強情な子
    });
    const realSetTimeout = globalThis.setTimeout;
    // 5秒待たずにエスカレーション時刻を即時発火させる
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    const controller = new AbortController();
    try {
      const execPromise = tool.execute(
        "call-1",
        { task: "強情なタスク" },
        controller.signal,
        undefined,
        { cwd: "/parent" },
      );
      await nextTick();
      controller.abort();

      await assert.rejects(execPromise, /aborted/, "最終的に子の実行はエラー終了する");
      assert.ok(
        spawnMock.children[0].killHistory.includes("SIGTERM"),
        "まず穏当な SIGTERM を送る",
      );
      assert.ok(
        spawnMock.children[0].killHistory.includes("SIGKILL"),
        "SIGKILL にエスカレートする",
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      spawnMock.restore();
    }
  });
});

describe("入力とプロセス出力の境界", () => {
  it("JSON 行が複数の stdout チャンクに分割されても処理する", async () => {
    const spawnMock = mockSpawn();
    const output = piLine(assistantTextMessage("分割された回答"));
    spawnMock.respond((child) => {
      const splitAt = Math.floor(output.length / 2);
      child.stdout.emit("data", Buffer.from(output.slice(0, splitAt)));
      child.stdout.emit("data", Buffer.from(output.slice(splitAt)));
      child.emit("close", 0);
    });
    try {
      const result = (await tool.execute("call-1", { task: "答えて" }, undefined, undefined, {
        cwd: "/parent",
      })) as { content: Array<{ type: string; text: string }> };
      assert.equal(textOf(result), "分割された回答", "分割された JSON 行も処理する");
    } finally {
      spawnMock.restore();
    }
  });

  it("tool_result_end をユーザー向け更新に含める", async () => {
    const spawnMock = mockSpawn();
    const updates: Array<{ details: { results: Array<{ messages: unknown[] }> } }> = [];
    spawnMock.respond((child) => {
      child.stdout.emit(
        "data",
        Buffer.from(
          piLine({
            type: "tool_result_end",
            message: assistantToolCallMessage("bash", { command: "pwd" }),
          }),
        ),
      );
      child.emit("close", 0);
    });
    try {
      await tool.execute(
        "call-1",
        { task: "実行して" },
        undefined,
        (update: unknown) => updates.push(update as (typeof updates)[number]),
        { cwd: "/parent" },
      );
      assert.equal(updates.at(-1)?.details.results[0].messages.length, 1, "ツール結果を更新へ含める");
    } finally {
      spawnMock.restore();
    }
  });

  it("子が異常終了したとき stderr を含むエラー結果を返す", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => {
      child.stderr.emit("data", Buffer.from("子プロセスの失敗"));
      child.emit("close", 7);
    });
    try {
      const result = (await tool.execute("call-1", { task: "失敗して" }, undefined, undefined, {
        cwd: "/parent",
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      assert.equal(result.isError, true, "異常終了はエラー結果にする");
      assert.equal(textOf(result), "Child failed: 子プロセスの失敗", "stderr をエラーに含める");
    } finally {
      spawnMock.restore();
    }
  });

  it("実行可能なスクリプトから起動すると現在のランタイムとスクリプトを使う", async () => {
    const spawnMock = mockSpawn();
    spawnMock.respond((child) => child.emit("close", 0));
    try {
      await tool.execute("call-1", { task: "起動して" }, undefined, undefined, { cwd: "/parent" });
      assert.equal(spawnMock.calls[0].command, process.execPath, "現在のランタイムで起動する");
      assert.equal(spawnMock.calls[0].args[0], process.argv[1], "現在のスクリプトを渡す");
    } finally {
      spawnMock.restore();
    }
  });

  it("空のタスクを拒否し、子プロセスを起動しない", async () => {
    const spawnMock = mockSpawn();
    try {
      const result = (await tool.execute("call-1", { task: "" }, undefined, undefined, {
        cwd: "/parent",
      })) as { content: Array<{ type: string; text: string }> };
      assert.equal(textOf(result), "Invalid parameters. Provide a task.", "空タスクを拒否する");
      assert.equal(spawnMock.calls.length, 0, "空タスクでは子を起動しない");
    } finally {
      spawnMock.restore();
    }
  });
});

let passed = 0;
const failures: string[] = [];
for (const t of tests) {
  try {
    await t.fn();
    passed++;
  } catch (err) {
    failures.push(
      `  \u2717 ${t.name}\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
