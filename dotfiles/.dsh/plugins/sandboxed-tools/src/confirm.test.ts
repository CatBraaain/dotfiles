// §2.3 dialog-layer unit tests over a fake userQuestions seam: label sets are
// built by the Sandbox flows (sandbox.test.ts); here the seam adapter itself
// is verified — the question shape it sends, the selected/custom/cancel
// mapping, the denial-reason follow-up, and the matched-pattern line.

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  DENIAL_REASON_PROMPT,
  askChoice,
  askDenialReason,
  matchedPatternNote,
  type ConfirmUi,
} from "./confirm";

type SentQuestion = {
  id: string;
  question: string;
  detail?: string;
  options?: { label: string }[];
};

type SentRequest = { questions: SentQuestion[]; agent?: unknown; signal?: AbortSignal };

/** A fake seam: records every sent question and answers by question id. */
function fakeUi(script: {
  choice?: { selected?: string[]; custom?: string } | { error: Error };
  reason?: string | { error: Error };
}): { ui: ConfirmUi; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const ui: ConfirmUi = {
    async ask(request) {
      sent.push({
        questions: request.questions.map((question) => ({
          id: question.id,
          question: question.question,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          ...(question.options === undefined ? {} : { options: question.options }),
        })),
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const id = request.questions[0]!.id;
      const answer = id === "confirm" ? script.choice : script.reason;
      if (answer instanceof Error) throw answer;
      if (id === "confirm") {
        const choice = answer as { selected?: string[]; custom?: string } | undefined;
        return {
          answers: [
            {
              id,
              selected: choice?.selected ?? [],
              ...(choice?.custom === undefined ? {} : { custom: choice.custom }),
            },
          ],
        };
      }
      return {
        answers: [
          {
            id,
            selected: [],
            ...(typeof answer === "string" ? { custom: answer } : {}),
          },
        ],
      };
    },
  };
  return { ui, sent };
}

describe("§2.3 askChoice（seam アダプタ）", () => {
  it("選択肢を label の配列で送り、選択された label を返す", async () => {
    const { ui, sent } = fakeUi({ choice: { selected: ["Yes, allow"] } });
    const agent = { marker: "agent" };
    const signal = new AbortController().signal;
    const outcome = await askChoice(ui, {
      question: "Allow read access?",
      detail: "/a\nmatched: /a",
      options: ["Yes, allow", "No, deny (reason next)"],
      agent,
      signal,
    });
    assert.deepEqual(outcome, { kind: "selected", label: "Yes, allow" });
    const request = sent[0]!;
    assert.equal(request.questions.length, 1);
    assert.equal(request.questions[0]!.question, "Allow read access?");
    assert.equal(request.questions[0]!.detail, "/a\nmatched: /a");
    assert.deepEqual(request.questions[0]!.options, [
      { label: "Yes, allow" },
      { label: "No, deny (reason next)" },
    ]);
    assert.equal(request.agent, agent);
    assert.equal(request.signal, signal);
  });

  it("自由記述（custom）回答は選択肢外のため拒否として扱う", async () => {
    const { ui } = fakeUi({ choice: { custom: "do something else" } });
    const outcome = await askChoice(ui, {
      question: "q",
      detail: "d",
      options: ["Yes, allow"],
    });
    assert.deepEqual(outcome, { kind: "denied" });
  });

  it("回答なし（skip）と ask の失敗（キャンセル・中断）も拒否として扱う", async () => {
    const skipped = fakeUi({ choice: {} });
    assert.deepEqual(
      await askChoice(skipped.ui, { question: "q", detail: "d", options: ["Yes, allow"] }),
      { kind: "denied" },
    );
    const interrupted = fakeUi({ choice: { error: new Error("ASK_ABORTED") } });
    assert.deepEqual(
      await askChoice(interrupted.ui, { question: "q", detail: "d", options: ["Yes, allow"] }),
      { kind: "denied" },
    );
  });
});

describe("§2.3 拒否理由の追問", () => {
  it("自由記述の理由を trim して返す", async () => {
    const { ui, sent } = fakeUi({ reason: "  not today  " });
    const agent = { marker: "agent" };
    assert.equal(await askDenialReason(ui, { agent }), "not today");
    assert.equal(sent[0]!.questions.length, 1);
    assert.equal(sent[0]!.questions[0]!.question, DENIAL_REASON_PROMPT);
    assert.equal(sent[0]!.questions[0]!.options, undefined);
    assert.equal(sent[0]!.agent, agent);
  });

  it("空欄・回答なし・キャンセルは理由なし（undefined）として扱う", async () => {
    assert.equal(await askDenialReason(fakeUi({ reason: "   " }).ui, {}), undefined);
    assert.equal(await askDenialReason(fakeUi({ reason: undefined }).ui, {}), undefined);
    assert.equal(
      await askDenialReason(fakeUi({ reason: { error: new Error("NO_PROVIDER") } }).ui, {}),
      undefined,
    );
  });
});

describe("§2.3 設定パターン行", () => {
  it("一致パターンと未設定で文言が変わる", () => {
    assert.equal(matchedPatternNote("/allowed/*"), "matched: /allowed/*");
    assert.equal(matchedPatternNote(undefined), "no matching pattern (default ask)");
  });
});
