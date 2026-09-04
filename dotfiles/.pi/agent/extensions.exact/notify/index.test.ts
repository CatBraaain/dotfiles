import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notifyExtension, { notify, selectProtocol, testHooks } from "./index";

type SettledHandler = (event: unknown, ctx: { mode: string }) => void;

type ExecFileCall = { file: string; args: string[] };

const OSC99_START = `\x1b]99;i=1:d=0;Pi\x1b\\`;
const OSC99_DONE = `\x1b]99;i=1:p=1;Ready for input\x1b\\`;
const OSC777 = `\x1b]777;notify;Pi;Ready for input\x07`;

/** Clears terminal-specific env vars so protocol selection is deterministic. */
const NO_TERMINAL_ENV = {
  WT_SESSION: undefined,
  KITTY_WINDOW_ID: undefined,
  TERM_PROGRAM: undefined,
};

function createPiStub() {
  const handlers = new Map<string, SettledHandler>();
  return {
    on(event: string, handler: SettledHandler) {
      handlers.set(event, handler);
    },
    handler(name: string) {
      return handlers.get(name);
    },
  };
}

function settledHandlerOf(mode: string): SettledHandler {
  const stub = createPiStub();
  notifyExtension(stub as unknown as ExtensionAPI);
  const handler = stub.handler("agent_settled");
  assert.ok(handler);
  return (event, ctx) => handler(event, { ...ctx, mode });
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved: [string, string | undefined][] = [];
  for (const [key, value] of Object.entries(env)) {
    saved.push([key, process.env[key]]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureStdout() {
  const outputs: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    outputs.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    outputs,
    restore() {
      process.stdout.write = original;
    },
  };
}

describe("selectProtocol", () => {
  it("WT_SESSION があれば Windows トースト（最優先）", () => {
    assert.equal(selectProtocol({ WT_SESSION: "abc" }), "windows");
    assert.equal(selectProtocol({ WT_SESSION: "abc", KITTY_WINDOW_ID: "1" }), "windows");
  });

  it("KITTY_WINDOW_ID があれば OSC 99", () => {
    assert.equal(selectProtocol({ KITTY_WINDOW_ID: "1" }), "osc99");
  });

  it("TERM_PROGRAM が vscode なら OSC 99", () => {
    assert.equal(selectProtocol({ TERM_PROGRAM: "vscode" }), "osc99");
  });

  it("いずれの条件にも一致しなければ OSC 777", () => {
    assert.equal(selectProtocol({}), "osc777");
    assert.equal(selectProtocol({ TERM_PROGRAM: "ghostty" }), "osc777");
  });
});

describe("notify", () => {
  it("osc99 は d=0 のタイトル、p=1 の本文を順に書き出す", () => {
    const outputs: string[] = [];
    notify({
      protocol: "osc99",
      title: "Pi",
      body: "Ready for input",
      write: (output) => outputs.push(output),
      execFile: () => {},
    });

    assert.deepEqual(outputs, [OSC99_START, OSC99_DONE]);
  });

  it("osc777 は BEL 終端のシーケンスを書き出す", () => {
    const outputs: string[] = [];
    notify({
      protocol: "osc777",
      title: "Pi",
      body: "Ready for input",
      write: (output) => outputs.push(output),
      execFile: () => {},
    });

    assert.deepEqual(outputs, [OSC777]);
  });

  it("windows は powershell.exe -NoProfile -Command でトーストスクリプトを実行する", () => {
    const calls: { file: string; args: string[] }[] = [];
    notify({
      protocol: "windows",
      title: "Pi",
      body: "Ready for input",
      write: () => {},
      execFile: (file, args, callback) => {
        calls.push({ file, args });
        callback(null);
      },
    });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.file, "powershell.exe");
    assert.deepEqual(call.args.slice(0, 2), ["-NoProfile", "-Command"]);
    // 本文がトースト表示内容、タイトルが AppId（通知元識別）として含まれる
    const script = call.args[2] ?? "";
    assert.match(script, /Ready for input/);
    assert.match(script, /'Pi'/);
  });

  it("windows の execFile がエラーで終了しても throw しない", () => {
    assert.doesNotThrow(() => {
      notify({
        protocol: "windows",
        title: "Pi",
        body: "Ready for input",
        write: () => {},
        execFile: (_file, _args, callback) => {
          callback(new Error("spawn powershell.exe ENOENT"));
        },
      });
    });
  });
});

describe("notifyExtension", () => {
  it("agent_settled にハンドラを登録する（agent_end には登録しない）", () => {
    const stub = createPiStub();
    notifyExtension(stub as unknown as ExtensionAPI);

    assert.ok(stub.handler("agent_settled"));
    assert.equal(stub.handler("agent_end"), undefined);
  });

  it("tui モードでは標準出力へ通知シーケンスを書き出す", () => {
    const handler = settledHandlerOf("tui");
    const captured = captureStdout();
    try {
      withEnv(NO_TERMINAL_ENV, () => {
        handler({ type: "agent_settled" }, { mode: "tui" });
      });
    } finally {
      captured.restore();
    }

    assert.deepEqual(captured.outputs, [OSC777]);
  });

  it("rpc モードでは標準出力へ書き出さない", () => {
    const handler = settledHandlerOf("rpc");
    const captured = captureStdout();
    try {
      withEnv(NO_TERMINAL_ENV, () => {
        handler({ type: "agent_settled" }, { mode: "rpc" });
      });
    } finally {
      captured.restore();
    }

    assert.deepEqual(captured.outputs, []);
  });

  it("json モードでは標準出力へ書き出さない", () => {
    const handler = settledHandlerOf("json");
    const captured = captureStdout();
    try {
      withEnv(NO_TERMINAL_ENV, () => {
        handler({ type: "agent_settled" }, { mode: "json" });
      });
    } finally {
      captured.restore();
    }

    assert.deepEqual(captured.outputs, []);
  });

  it("print モードでは標準出力へ書き出さない", () => {
    const handler = settledHandlerOf("print");
    const captured = captureStdout();
    try {
      withEnv(NO_TERMINAL_ENV, () => {
        handler({ type: "agent_settled" }, { mode: "print" });
      });
    } finally {
      captured.restore();
    }

    assert.deepEqual(captured.outputs, []);
  });

  it("tui モード + WT_SESSION 環境でも標準出力へ書き出さない（Windows トースト経由）", () => {
    const execFileCalls: ExecFileCall[] = [];
    const originalExecFile = testHooks.execFile;
    testHooks.execFile = (file, args, callback) => {
      execFileCalls.push({ file, args });
      callback(null);
    };
    const handler = settledHandlerOf("tui");
    const captured = captureStdout();
    try {
      withEnv({ WT_SESSION: "abc" }, () => {
        handler({ type: "agent_settled" }, { mode: "tui" });
      });
    } finally {
      captured.restore();
      testHooks.execFile = originalExecFile;
    }

    assert.deepEqual(captured.outputs, []);

    assert.equal(execFileCalls.length, 1);
    const call = execFileCalls[0]!;
    assert.equal(call.file, "powershell.exe");
    assert.deepEqual(call.args.slice(0, 2), ["-NoProfile", "-Command"]);
    const script = call.args[2] ?? "";
    assert.match(script, /Ready for input/);
    assert.match(script, /'Pi'/);
  });
});
