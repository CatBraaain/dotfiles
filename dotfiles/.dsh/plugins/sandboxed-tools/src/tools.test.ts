// Host-side tool-layer unit tests: the §2.3 approval notes, the §4 EROFS
// hint assembly, the ask_permission result texts, the §2.4 observation
// tracker, the §4 bash result rendering, and the §2.1 vision-delegation
// message. Tool registration itself needs a live cordis context and a bwrap
// environment and stays out of unit tests (verified manually against the
// real dsh profile instead); the §2 gate wording lives in sandbox.test.ts
// (authorizePathWithConfirm).

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { RunnerBashResult } from "./runner";
import {
  COMMAND_APPROVAL_NOTE,
  EROFS_HINT,
  NOT_BEEN_READ,
  ReadObservations,
  askPermissionOutcomeText,
  bashResultHasErofs,
  bashResultNotes,
  imageReadErrorMessage,
  renderBashResult,
  writeApprovalNote,
} from "./tools";

function bashResult(partial: Partial<RunnerBashResult>): RunnerBashResult {
  return {
    stdout: { text: "", truncated: false },
    stderr: { text: "", truncated: false },
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: 120000,
    ...partial,
  };
}

describe("§2.3 承認ノート", () => {
  it("write のファイル単体スコープのノートは spec 表の文言", () => {
    assert.equal(
      writeApprovalNote({ operation: "write", scope: "file", grantedPath: "/w/file.ts" }),
      "User approved write access via confirmation (scope: file /w/file.ts); " +
        "writable for the rest of the session, including via bash.",
    );
  });

  it("write のディレクトリスコープのノートは subtree を含む文言", () => {
    assert.equal(
      writeApprovalNote({ operation: "write", scope: "directory", grantedPath: "/w/dir" }),
      "User approved write access via confirmation (scope: directory /w/dir); " +
        "the subtree is writable for the rest of the session, including via bash.",
    );
  });

  it("コマンド承認のノート", () => {
    assert.equal(COMMAND_APPROVAL_NOTE, "User approved this command via confirmation.");
  });
});

describe("§4 EROFS ヒントとノートの追記順", () => {
  it("stdout/stderr に Read-only file system があれば EROFS と判定する", () => {
    assert.equal(
      bashResultHasErofs(bashResult({ stdout: { text: "touch: cannot touch 'x': Read-only file system", truncated: false } })),
      true,
    );
    assert.equal(
      bashResultHasErofs(bashResult({ stderr: { text: "mkdir: Read-only file system", truncated: false } })),
      true,
    );
    assert.equal(bashResultHasErofs(bashResult({})), false);
  });

  it("EROFS ヒントの後に承認ノートを追記し、ノートが最終行になる", () => {
    const result = bashResult({
      stderr: { text: "touch: Read-only file system", truncated: false },
    });
    assert.deepEqual(bashResultNotes(result, true), [EROFS_HINT, COMMAND_APPROVAL_NOTE]);
    assert.deepEqual(bashResultNotes(result, false), [EROFS_HINT]);
    assert.deepEqual(bashResultNotes(bashResult({}), true), [COMMAND_APPROVAL_NOTE]);
  });

  it("EROFS ヒントの文言は ask_permission へ誘導する", () => {
    assert.ok(EROFS_HINT.includes("ask_permission"));
  });
});

describe("§3 ask_permission の結果テキスト", () => {
  it("path の承認はディレクトリスコープの承認ノートと同じ文言", () => {
    const text = askPermissionOutcomeText({ status: "granted", grantedPath: "/w/dir" });
    assert.equal(
      text,
      writeApprovalNote({ operation: "write", scope: "directory", grantedPath: "/w/dir" }),
    );
  });

  it("path の許可済みは bash 経由の書き込み可否を伝える", () => {
    assert.equal(
      askPermissionOutcomeText({ status: "already granted", grantedPath: "/w/dir" }),
      "Already granted: /w/dir is writable for the rest of the session, including via bash.",
    );
  });

  it("path の拒否は理由行を伴い、理由なしでも成立する", () => {
    assert.equal(
      askPermissionOutcomeText({ status: "denied", grantedPath: "/w/dir", reason: "not today" }),
      "User denied write access to /w/dir.\nUser reason: not today",
    );
    assert.equal(
      askPermissionOutcomeText({ status: "denied", grantedPath: "/w/dir" }),
      "User denied write access to /w/dir.",
    );
  });

  it("command の承認は同じ bash 再送を促し、許可済みと拒否を判別できる", () => {
    assert.equal(
      askPermissionOutcomeText({ status: "granted", command: "git push" }),
      "User approved this command via ask_permission; re-send the same bash call to run it (one-shot).",
    );
    assert.equal(
      askPermissionOutcomeText({ status: "already granted", command: "git push" }),
      "No approval needed: git push is allowed by config.",
    );
    assert.equal(
      askPermissionOutcomeText({ status: "denied", command: "git push", reason: "wrong remote" }),
      "User denied this command.\nUser reason: wrong remote",
    );
  });
});

describe("§2.4 読み取り観測の管理", () => {
  it("read 観測をセッションごとに分離し、markRead 後に取得できる", () => {
    const observations = new ReadObservations();
    observations.markRead("s1", "/a", 111);
    assert.equal(observations.observedMtime("s1", "/a"), 111);
    assert.equal(observations.observedMtime("s2", "/a"), undefined);
  });

  it("write 後の mtime 更新で再編集可能な状態を保持する", () => {
    const observations = new ReadObservations();
    observations.markRead("s1", "/a", 111);
    observations.markRead("s1", "/a", 222);
    assert.equal(observations.observedMtime("s1", "/a"), 222);
  });

  it("clearSession でセッションの観測を破棄する", () => {
    const observations = new ReadObservations();
    observations.markRead("s1", "/a", 111);
    observations.clearSession("s1");
    assert.equal(observations.observedMtime("s1", "/a"), undefined);
  });

  it("未読み文言は spec §2.4 のとおり", () => {
    assert.equal(
      NOT_BEEN_READ("/a"),
      'cannot modify "/a": file has not been read — read the file, then retry',
    );
  });
});

describe("§4 bash 結果テキスト", () => {
  it("stdout、[stderr] セクション、exit マーカーを組み立てる", () => {
    const text = renderBashResult(
      bashResult({
        stdout: { text: "out", truncated: false },
        stderr: { text: "err", truncated: false },
        exitCode: 3,
      }),
    );
    assert.equal(text, "out\n[stderr]\nerr\n[exit code: 3]");
  });

  it("出力が無いときは (no output) を返す", () => {
    assert.equal(renderBashResult(bashResult({})), "(no output)");
  });

  it("タイムアウトは [timed out after Nms]、signal は [killed by signal: S]", () => {
    assert.equal(
      renderBashResult(bashResult({ timedOut: true, timeoutMs: 5000, exitCode: null, signal: "SIGKILL" })),
      "(no output)\n[timed out after 5000ms]\n[killed by signal: SIGKILL]",
    );
  });

  it("切り詰め時は spill パス（無ければ (unavailable)）を報告する", () => {
    assert.equal(
      renderBashResult(
        bashResult({
          stdout: { text: "x", truncated: true, spillPath: "/tmp/spill/stdout.txt" },
          exitCode: 0,
        }),
      ),
      "x\n[output truncated; full output: /tmp/spill/stdout.txt]",
    );
    assert.equal(
      renderBashResult(bashResult({ stdout: { text: "x", truncated: true } })),
      "x\n[output truncated; full output: (unavailable)]",
    );
  });
});

describe("§2.1 画像非対応経路のエラー文言", () => {
  it("vision 委譲と fallback を含む", () => {
    const message = imageReadErrorMessage("/img.png", "prov", "model-x");
    assert.ok(message.includes("(prov/model-x)"));
    assert.ok(message.includes("subagent"));
    assert.ok(message.includes("vision"));
    assert.ok(message.includes("with read"));
    assert.ok(message.includes("report its observation as text"));
    assert.ok(message.includes("If you cannot spawn subagents"));
    assert.ok(message.endsWith("Path: /img.png"));
  });
});
