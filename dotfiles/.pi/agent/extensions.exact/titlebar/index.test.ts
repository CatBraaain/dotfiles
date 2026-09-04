import assert from "node:assert/strict";
import { afterAll, describe, it } from "bun:test";
import titlebar, { __timers, buildTitle, SPINNER_FRAMES, spinnerFrame } from "./index";

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

afterAll(() => {
  Object.assign(__timers, originalTimers);
});

type Mode = "tui" | "rpc" | "json" | "print";

function captureTitleExtension(
  sessionName: string | undefined,
  mode: Mode = "tui",
): {
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
  const ctx = { mode, ui: { setTitle: (title: string) => titleCalls.push(title) } };

  const invoke = (event: string, nowMs: number, eventObj: Record<string, unknown> = {}): void => {
    fakeNowMs = nowMs;
    handlers.get(event)!(eventObj, ctx);
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
      assert.ok(
        code >= 0x2800 && code <= 0x28ff,
        `${frame} は点字ブロック (U+2800–U+28FF) に含まれる`,
      );
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

describe("入力待ち", () => {
  it("入力ダイアログの表示中は ⏸ を先頭に付けた表示へ切り替わる", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");
    invoke("agent_start", 0);

    invoke("ui_prompt_start", 500);

    assert.equal(titleCalls.at(-1), "⏸ π - session-a");
  });

  it("入力待ちの間はタイマーが進んでも表示が変わらない", () => {
    const { titleCalls, invoke } = captureTitleExtension(undefined);
    invoke("agent_start", 0);
    const spinnerTimer = startedTimers.at(-1)!;
    invoke("ui_prompt_start", 0);
    titleCalls.length = 0;

    fakeNowMs = 1500;
    spinnerTimer.callback();

    assert.equal(titleCalls.at(-1), "⏸ π");
  });

  it("プロンプトの種別はタイトルに含めない", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");
    invoke("agent_start", 0);

    invoke("ui_prompt_start", 0, { kind: "select", title: "choose one" });

    assert.equal(titleCalls.at(-1), "⏸ π - session-a");
  });

  it("入力ダイアログの終了でスピナー表示へ戻る", () => {
    const { titleCalls, invoke } = captureTitleExtension(undefined);
    invoke("agent_start", 0);
    invoke("ui_prompt_start", 0);

    invoke("ui_prompt_end", 700);

    assert.equal(titleCalls.at(-1), "⠧ π");
  });

  it("入力待ちのまま agent_end になった場合は待機中タイトルへ戻す", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");
    invoke("agent_start", 0);
    invoke("ui_prompt_start", 0);

    invoke("agent_end", 500);

    assert.equal(titleCalls.at(-1), "π - session-a");
  });

  it("入力待ちのまま session_shutdown になった場合は待機中タイトルへ戻す", () => {
    const { titleCalls, invoke } = captureTitleExtension("session-a");
    invoke("agent_start", 0);
    invoke("ui_prompt_start", 0);

    invoke("session_shutdown", 500);

    assert.equal(titleCalls.at(-1), "π - session-a");
  });
});

describe("非 TUI モード", () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    it(`${mode} モードではどのイベントでも setTitle を呼ばない`, () => {
      const { titleCalls, invoke } = captureTitleExtension("session-a", mode);

      invoke("session_start", 0);
      invoke("agent_start", 0);
      invoke("ui_prompt_start", 0, { kind: "confirm" });
      invoke("ui_prompt_end", 100);
      invoke("agent_end", 500);
      invoke("session_shutdown", 500);

      assert.deepEqual(titleCalls, []);
    });

    it(`${mode} モードでは agent_start でもタイマーが起動しない`, () => {
      const { invoke } = captureTitleExtension("session-a", mode);
      const timersBefore = startedTimers.length;

      invoke("agent_start", 0);

      assert.equal(startedTimers.length, timersBefore);
    });
  }
});
