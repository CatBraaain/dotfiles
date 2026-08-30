// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import titlebar, { __timers, buildTitle, SPINNER_FRAMES, spinnerFrame } from "./index";

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

type SpinnerTimer = { id: number; callback: () => void; intervalMs: number };

let fakeNowMs: number | undefined;
const startedTimers: SpinnerTimer[] = [];
const clearedTimerIds: number[] = [];
let nextTimerId = 1;

const originalTimers = { ...__timers };
__timers.set = (callback, intervalMs) => {
  const spinnerTimer = { id: nextTimerId++, callback, intervalMs };
  startedTimers.push(spinnerTimer);
  return spinnerTimer.id as never;
};
__timers.clear = (timer) => {
  clearedTimerIds.push(timer as unknown as number);
};
__timers.now = () => fakeNowMs ?? originalTimers.now();

function captureTitleExtension(sessionName: string | undefined): {
  titleCalls: string[];
  invoke: (event: string, nowMs: number) => void;
} {
  const handlers = new Map<string, Handler>();
  const titleCalls: string[] = [];
  titlebar({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    getSessionName: () => sessionName,
  } as never);
  const ctx = { ui: { setTitle: (title: string) => titleCalls.push(title) } };

  const invoke = (event: string, nowMs: number): void => {
    fakeNowMs = nowMs;
    handlers.get(event)!({}, ctx);
    fakeNowMs = undefined;
  };
  return { titleCalls, invoke };
}

describe("スピナー", () => {
  it("0.1 秒ごとに点字スピナーのフレームが順に切り替わる", () => {
    assert.equal(spinnerFrame(0), "⠋");
    assert.equal(spinnerFrame(100), "⠙");
    assert.equal(spinnerFrame(200), "⠹");
    assert.equal(spinnerFrame(300), "⠸");
  });

  it("10 フレーム目で先頭のフレームへ循環する", () => {
    assert.equal(spinnerFrame(1000), "⠋");
    assert.equal(spinnerFrame(1100), "⠙");
  });

  it("すべてのフレームは点字ブロックの1文字で横幅が等しい", () => {
    assert.ok(SPINNER_FRAMES.length > 0, "フレームが空でない");
    assert.equal(new Set(SPINNER_FRAMES).size, SPINNER_FRAMES.length, "フレームが重複しない");
    for (const frame of SPINNER_FRAMES) {
      const code = frame.codePointAt(0)!;
      assert.ok(frame.length === 1, `${frame} は 1 文字である`);
      assert.ok(code >= 0x2800 && code <= 0x28ff, `${frame} は点字ブロック (U+2800–U+28FF) に含まれる`);
    }
  });
});

describe("タイトルの構成", () => {
  it("待機中はセッション名付きで π - {セッション名} を表示する", () => {
    assert.equal(buildTitle("session-a"), "π - session-a");
  });

  it("待機中でセッション名がない場合は π のみを表示する", () => {
    assert.equal(buildTitle(undefined), "π");
  });

  it("動作中はスピナーフレームを先頭に付ける", () => {
    assert.equal(buildTitle("session-a", "⠋"), "⠋ π - session-a");
  });

  it("動作中でセッション名がない場合はスピナーと π のみを表示する", () => {
    assert.equal(buildTitle(undefined, "⠙"), "⠙ π");
  });
});

describe("状態遷移", () => {
  it("session_start で待機中タイトルを設定する", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");

    invoke("session_start", 1000);

    assert.equal(titleCalls.at(-1), "π - session-a");
  });

  it("agent_start でスピナー付きタイトルを即時に表示する", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");

    invoke("agent_start", 200);

    assert.equal(titleCalls.at(-1), "⠹ π - session-a");
  });

  it("agent_start は 0.1 秒間隔のタイマーを起動する", () => {
    const { invoke } = captureTitleExtension("session-a");

    invoke("agent_start", 0);

    assert.equal(startedTimers.at(-1)?.intervalMs, 100);
  });

  it("タイマーの起動ごとにスピナーフレームが進む", () => {
    const { titleCalls, invoke } = captureTitleExtension(undefined);
    invoke("agent_start", 0);
    const spinnerTimer = startedTimers.at(-1)!;

    fakeNowMs = 150;
    spinnerTimer.callback();

    assert.equal(titleCalls.at(-1), "⠙ π");
  });

  it("agent_end でタイマーを停止して待機中タイトルへ戻す", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");
    invoke("agent_start", 0);
    const spinnerTimerId = startedTimers.at(-1)!.id;

    invoke("agent_end", 500);

    assert.equal(titleCalls.at(-1), "π - session-a");
    assert.equal(clearedTimerIds.at(-1), spinnerTimerId);
  });

  it("session_shutdown でタイマーを停止して待機中タイトルへ戻す", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");
    invoke("agent_start", 0);
    const spinnerTimerId = startedTimers.at(-1)!.id;

    invoke("session_shutdown", 500);

    assert.equal(titleCalls.at(-1), "π - session-a");
    assert.equal(clearedTimerIds.at(-1), spinnerTimerId);
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

Object.assign(__timers, originalTimers);

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
