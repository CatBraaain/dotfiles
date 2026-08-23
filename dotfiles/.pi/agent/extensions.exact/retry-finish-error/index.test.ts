// 実行: bun --install=auto run index.test.ts
//
// retry-finish-error 拡張機能の振る舞いを検証する。
// 出典: ./SPEC.md
// handleFinishErrorMessage に各種 message_end イベントを渡し、
// 書き換えの有無と書き換え後の errorMessage を検証する。
// 各 it のタイトルが要件仕様。
import assert from "node:assert/strict";
import { FINISH_ERROR_PREFIX, RETRYABLE_PREFIX, handleFinishErrorMessage } from "./index";

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

const finishErrorEvent = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: `${FINISH_ERROR_PREFIX}error`,
  },
};

describe("unknown finish_reason のエラー", () => {
  it("errorMessage をリトライ可能パターンに書き換えて返す", () => {
    const result = handleFinishErrorMessage(finishErrorEvent);

    assert.ok(result);
    assert.equal(result.message.errorMessage, `${RETRYABLE_PREFIX}${FINISH_ERROR_PREFIX}error`);
    assert.equal(result.message.role, "assistant");
    assert.equal((result.message as typeof finishErrorEvent.message).stopReason, "error");
  });

  it("元メッセージは書き換えない（コピーを返す）", () => {
    handleFinishErrorMessage(finishErrorEvent);

    assert.equal(finishErrorEvent.message.errorMessage, `${FINISH_ERROR_PREFIX}error`);
  });

  it("未知の finish_reason 値でも同様に書き換える", () => {
    const event = {
      ...finishErrorEvent,
      message: {
        ...finishErrorEvent.message,
        errorMessage: `${FINISH_ERROR_PREFIX}timeout_reached`,
      },
    };

    const result = handleFinishErrorMessage(event);

    assert.ok(result);
    assert.match(result.message.errorMessage ?? "", /provider returned error/);
  });
});

describe("リトライ対象外のエラー", () => {
  it("content_filter は書き換えない", () => {
    const event = {
      ...finishErrorEvent,
      message: {
        ...finishErrorEvent.message,
        errorMessage: `${FINISH_ERROR_PREFIX}content_filter`,
      },
    };

    assert.equal(handleFinishErrorMessage(event), undefined);
  });

  it("finish_reason 由来でないエラーメッセージは書き換えない", () => {
    const event = {
      ...finishErrorEvent,
      message: { ...finishErrorEvent.message, errorMessage: "connection refused" },
    };

    assert.equal(handleFinishErrorMessage(event), undefined);
  });

  it("errorMessage がないエラーは書き換えない", () => {
    const event = {
      ...finishErrorEvent,
      message: { ...finishErrorEvent.message, errorMessage: undefined },
    };

    assert.equal(handleFinishErrorMessage(event), undefined);
  });
});

describe("エラー以外のメッセージ", () => {
  it("正常終了（stop）の assistant メッセージは書き換えない", () => {
    const event = {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop" },
    };

    assert.equal(handleFinishErrorMessage(event), undefined);
  });

  it("user メッセージは書き換えない", () => {
    const event = {
      type: "message_end",
      message: {
        role: "user",
        content: [],
        stopReason: "error",
        errorMessage: `${FINISH_ERROR_PREFIX}error`,
      },
    };

    assert.equal(handleFinishErrorMessage(event), undefined);
  });
});

for (const test of tests) {
  try {
    await test.fn();
    console.log(`✅ ${test.name}`);
  } catch (error) {
    console.error(`❌ ${test.name}`);
    throw error;
  }
}
console.log(`\n${tests.length} tests passed`);
