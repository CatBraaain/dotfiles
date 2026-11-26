import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { cliExecutableName, createCliCommand, runCliViaBash } from "./cli.ts";

function frame(stdout = "", stderr = "", code = 0): string {
  return [
    "PI_CLI_V1:" + code,
    Buffer.from(stdout).toString("base64"),
    Buffer.from(stderr).toString("base64"),
    "PI_CLI_END",
    "",
  ].join("\n");
}

function response(output: string, overrides: Record<string, unknown> = {}) {
  return {
    toolCall: { type: "toolCall" as const, id: "nested", name: "bash", arguments: {} },
    isError: false,
    result: {
      content: [{ type: "text" as const, text: output }],
      details: {},
      structuredContent: { output, truncated: false, exit_code: 0, ...overrides },
    },
  };
}

const params = { executable: "/cli", args: [] };

describe("Windows CLI execution", () => {
  it("uses the deployed executable name on Windows only", () => {
    assert.equal(cliExecutableName("ticket", "win32"), "ticket.exe");
    assert.equal(cliExecutableName("browse", "linux"), "browse");
  });

  it("passes Git Bash paths and preserves literal arguments for native programs", () => {
    const command = createCliCommand(
      {
        executable: "C:\\Agent Home\\日本語\\ticket.exe",
        cwd: "\\\\server\\share\\作業 場所",
        args: [String.raw`\exact\argument`, "/literal/item", "日本語's"],
      },
      "win32",
    );
    assert.ok(command.includes("cd -- '//server/share/作業 場所' || exit"));
    assert.match(command, /cli_tmp=\$\(MSYS2_ARG_CONV_EXCL='\*' bun .*cli-capture\.ts' 'create'/);
    assert.ok(
      command.includes(
        "MSYS2_ARG_CONV_EXCL='*' 'C:/Agent Home/日本語/ticket.exe' '\\exact\\argument' '/literal/item' '日本語'\\''s'",
      ),
    );
  });

  it("keeps a carriage return as an ANSI-C escape and a line feed as a quoted newline", () => {
    const command = createCliCommand({ executable: "cli.exe", args: ["a\rb\rc", "d\ne"] }, "win32");
    assert.ok(command.includes(String.raw`'cli.exe' 'a'$'\r''b'$'\r''c' 'd` + "\ne'"));
  });

  it.skipIf(process.platform !== "win32")(
    "recovers native executable output from Git Bash without changing literal argv",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pi CLI 日本語 "));
      const bash = createBashTool(cwd);
      const tempPaths = new Set<string>();
      const context = {
        async executeTool(name: string, input: unknown, options?: { signal?: AbortSignal }) {
          assert.equal(name, "bash");
          const result = await bash.execute("windows", input as never, options?.signal);
          const savedPath = result.details?.fullOutputPath;
          if (savedPath) tempPaths.add(savedPath);
          return { toolCall: response("").toolCall, result, isError: result.isError ?? false };
        },
      };
      try {
        const stdout = "本文\r\n".repeat(140_000);
        const args = [
          "/literal/argument",
          "日本語 空白",
          "\\\\server\\share\\日本語 空白",
          "literal\\\\path\\\\",
          'double quote" after a backslash\\',
          "first\r\nsecond\rthird\n",
        ];
        const outcome = await runCliViaBash({
          context,
          params: {
            executable: process.execPath,
            args: [
              "-e",
              'process.stdout.write(JSON.stringify([process.cwd(), ...process.argv.slice(1)]) + "本文\\r\\n".repeat(140000)); process.stderr.write("診断\\r\\n"); process.exitCode = 23;',
              "--",
              ...args,
            ],
            cwd,
          },
        });
        assert.equal(
          outcome.status,
          "completed",
          String(outcome.status === "failed" && outcome.error),
        );
        assert.deepEqual(outcome.cli, {
          stdout: JSON.stringify([cwd, ...args]) + stdout,
          stderr: "診断\r\n",
          code: 23,
        });
        assert.ok(tempPaths.size > 0);
      } finally {
        await Promise.all([...tempPaths].map((path) => rm(path, { force: true })));
        await rm(cwd, { recursive: true, force: true });
      }
    },
    30_000,
  );

  for (const [path, shellPath] of [
    [
      "C:\\Users\\User Name\\一時'temp\\pi-output.log",
      "C:/Users/User Name/一時'\\''temp/pi-output.log",
    ],
    ["\\\\server\\share\\名前 空白\\pi-output.log", "//server/share/名前 空白/pi-output.log"],
    ["/tmp/名前 空白/pi-output.log", "/tmp/名前 空白/pi-output.log"],
  ] as const) {
    it("recovers the complete UTF-8 result through registered Bash from " + path, async () => {
      const cli = { stdout: " 本文\r\n", stderr: "診断\r\n", code: 23 };
      const output = frame(cli.stdout, cli.stderr, cli.code);
      const signal = new AbortController().signal;
      const original = response("partial", { truncated: true, full_output_path: path });
      const calls: string[] = [];
      const context = {
        async executeTool(name: string, input: unknown, options?: { signal?: AbortSignal }) {
          assert.equal(name, "bash");
          assert.equal(options?.signal, signal);
          calls.push((input as { command: string }).command);
          if (calls.length === 1) return original;
          if (calls.length === 2) return response(String(output.length));
          return response(output);
        },
      };
      const outcome = await runCliViaBash({ context, params, platform: "win32", signal });
      assert.equal(outcome.status, "completed");
      assert.deepEqual(outcome.cli, cli);
      assert.strictEqual(outcome.result, original.result);
      assert.equal(calls.length, 3);
      const exclusion = path.startsWith("/") ? "" : "*";
      const prefix = `MSYS2_ARG_CONV_EXCL='${exclusion}' bun `;
      assert.ok(calls[1]!.startsWith(prefix));
      assert.ok(calls[1]!.endsWith(`cli-capture.ts' 'size' '${shellPath}'`));
      assert.ok(calls[2]!.startsWith(prefix));
      assert.ok(calls[2]!.endsWith(`cli-capture.ts' 'read' '${shellPath}' '0' '${output.length}'`));
    });
  }

  for (const path of [
    String.raw`C:relative\output.log`,
    String.raw`\current-drive\output.log`,
    String.raw`\\server`,
    String.raw`\\?\C:\temp\output.log`,
    "C:/bad\0path",
  ]) {
    it("does not attempt to recover an invalid path: " + JSON.stringify(path), async () => {
      let calls = 0;
      const context = {
        async executeTool() {
          calls++;
          return response("partial", { truncated: true, full_output_path: path });
        },
      };
      const outcome = await runCliViaBash({ context, params, platform: "win32" });
      assert.equal(outcome.status, "failed");
      assert.match(String(outcome.error), /no valid full_output_path/);
      assert.equal(calls, 1);
    });
  }
});

it.skipIf(process.platform === "win32")(
  "recovers separate CLI streams using a PATH with Bun but no coreutils",
  async () => {
    const bin = await mkdtemp(join(tmpdir(), "pi-cli-bin-"));
    const savedPaths = new Set<string>();
    try {
      await symlink(process.execPath, join(bin, "bun"));
      const bash = createBashTool(tmpdir(), {
        spawnHook: (config) => ({ ...config, env: { ...config.env, PATH: bin } }),
      });
      const context = {
        async executeTool(name: string, input: unknown, options?: { signal?: AbortSignal }) {
          assert.equal(name, "bash");
          const result = await bash.execute("test", input as never, options?.signal);
          const path = result.details?.fullOutputPath;
          if (path) savedPaths.add(path);
          return { toolCall: response("").toolCall, result, isError: result.isError ?? false };
        },
      };
      const outcome = await runCliViaBash({
        context,
        params: {
          executable: process.execPath,
          args: [
            "-e",
            'process.stdout.write("本文\\r\\n".repeat(200000)); process.stderr.write(" 診断\\n"); process.exitCode = 23;',
          ],
        },
      });
      assert.equal(
        outcome.status,
        "completed",
        outcome.status === "failed" ? String(outcome.error) : "Expected CLI completion",
      );
      assert.deepEqual(outcome.cli, {
        stdout: "本文\r\n".repeat(200_000),
        stderr: " 診断\n",
        code: 23,
      });
      assert.ok(savedPaths.size > 0);
    } finally {
      await Promise.all([...savedPaths].map((path) => rm(path, { force: true })));
      await rm(bin, { recursive: true, force: true });
    }
  },
  30_000,
);

describe("runCliViaBash CLI input", () => {
  it("uses only the requested timeout and keeps cwd inside the authorized command", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const context = {
      async executeTool(name: string, args: unknown) {
        assert.equal(name, "bash");
        calls.push(args as Record<string, unknown>);
        return response(frame());
      },
    };
    const first = await runCliViaBash({ context, params: { ...params, cwd: "/tmp/a'\nb" } });
    assert.equal(first.status, "completed");
    assert.deepEqual(Object.keys(calls[0]!), ["command"]);
    assert.ok(String(calls[0]!.command).includes("cd -- '/tmp/a'\\''\nb' || exit"));
    assert.match(String(calls[0]!.command), /'\/cli' >"\$cli_tmp\/stdout"/);
    await runCliViaBash({ context, params: { ...params, timeout: 300 } });
    assert.equal(calls[1]!.timeout, 300);
    assert.equal(String(calls[1]!.command).includes("cd --"), false);
  });

  for (const unsafe of [
    { executable: "/bad\0path", args: [] },
    { executable: "/cli", args: ["bad\0arg"] },
    { executable: "/cli", args: [], cwd: "/bad\0cwd" },
  ]) {
    it("rejects NUL bytes before invoking Bash: " + JSON.stringify(unsafe), async () => {
      let calls = 0;
      const context = {
        async executeTool() {
          calls++;
          return response(frame());
        },
      };
      const outcome = await runCliViaBash({ context, params: unsafe });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") assert.match(String(outcome.error), /NUL/);
      assert.equal(calls, 0);
    });
  }

  it("does not invoke Bash for an already aborted signal", async () => {
    let calls = 0;
    const context = {
      async executeTool() {
        calls++;
        return response(frame());
      },
    };
    const reason = new Error("cancelled");
    const outcome = await runCliViaBash({ context, params, signal: AbortSignal.abort(reason) });
    assert.equal(outcome.status, "aborted");
    if (outcome.status === "aborted") assert.strictEqual(outcome.reason, reason);
    assert.equal(calls, 0);
  });

  it("preserves a thrown context error without retry or fallback", async () => {
    let calls = 0;
    const error = new Error("Expired context");
    const context = {
      async executeTool(): Promise<never> {
        calls++;
        throw error;
      },
    };
    const outcome = await runCliViaBash({ context, params });
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.strictEqual(outcome.error, error);
    assert.equal(calls, 1);
  });

  for (const output of [
    "PI_CLI_V1:256\n\n\nPI_CLI_END\n",
    "PI_CLI_V1:0\n====\n\nPI_CLI_END\n",
    "PI_CLI_V1:0\n",
    frame() + "extra",
  ]) {
    it(
      "retains the original response for a malformed frame: " + JSON.stringify(output),
      async () => {
        const original = response(output);
        const context = {
          async executeTool() {
            return original;
          },
        };
        const outcome = await runCliViaBash({ context, params });
        assert.equal(outcome.status, "failed");
        if (outcome.status === "failed") {
          assert.match(String(outcome.error), /invalid|Invalid/);
          assert.strictEqual(outcome.result, original.result);
          assert.equal(outcome.isError, false);
        }
      },
    );
  }

  for (const overrides of [
    { output: undefined },
    { truncated: undefined },
    { exit_code: undefined },
  ]) {
    it("fails closed for missing structured fields: " + Object.keys(overrides)[0], async () => {
      const context = {
        async executeTool() {
          return response(frame(), overrides);
        },
      };
      const outcome = await runCliViaBash({ context, params });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") assert.match(String(outcome.error), /invalid structured/);
    });
  }

  for (const location of ["outer", "inner", "exit"] as const) {
    it("retains the failed Bash response for " + location + " failure", async () => {
      const original = response(frame(), location === "exit" ? { exit_code: 2 } : {});
      original.isError = location === "outer";
      const result = { ...original.result, isError: location === "inner" };
      const context = {
        async executeTool() {
          return { ...original, result };
        },
      };
      const outcome = await runCliViaBash({ context, params });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") {
        assert.strictEqual(outcome.result, result);
        assert.equal(outcome.isError, original.isError);
      }
    });
  }

  it("returns nonzero CLI exit codes without treating them as Bash failure", async () => {
    const original = response(frame(" \nvalue\n\n", "error\n\n", 23));
    const context = {
      async executeTool() {
        return original;
      },
    };
    const outcome = await runCliViaBash({ context, params });
    assert.equal(outcome.status, "completed");
    if (outcome.status === "completed") {
      assert.deepEqual(outcome.cli, { stdout: " \nvalue\n\n", stderr: "error\n\n", code: 23 });
      assert.strictEqual(outcome.result, original.result);
    }
  });

  it("forwards cancellation and timeout during recovery and stops before the next chunk", async () => {
    const controller = new AbortController();
    const output = frame("x".repeat(800_000));
    const cancelled = response(output.slice(0, 524_288));
    let calls = 0;
    const context = {
      async executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }) {
        assert.equal(name, "bash");
        assert.equal(options?.signal, controller.signal);
        assert.equal((args as { timeout: number }).timeout, 300);
        calls++;
        if (calls === 1)
          return response("partial", { truncated: true, full_output_path: "/tmp/output" });
        if (calls === 2) return response(String(output.length));
        controller.abort("cancelled");
        return cancelled;
      },
    };
    const outcome = await runCliViaBash({
      context,
      params: { ...params, timeout: 300 },
      signal: controller.signal,
    });
    assert.equal(outcome.status, "aborted");
    if (outcome.status === "aborted") {
      assert.equal(outcome.reason, "cancelled");
      assert.strictEqual(outcome.result, cancelled.result);
    }
    assert.equal(calls, 3);
  });

  it("recovers complete output without a timeout or rerunning the CLI and retains the first response", async () => {
    const output = frame("x".repeat(800_000));
    const original = response("partial", { truncated: true, full_output_path: "/tmp/output" });
    let calls = 0;
    const context = {
      async executeTool(_name: string, args: unknown) {
        assert.equal(Object.hasOwn(args as object, "timeout"), false);
        calls++;
        if (calls === 1) return original;
        assert.doesNotMatch((args as { command: string }).command, /'\/cli' >|\b(wc|dd)\b/);
        if (calls === 2) return response(String(output.length));
        return response(output.slice((calls - 3) * 524_288, (calls - 2) * 524_288));
      },
    };
    const outcome = await runCliViaBash({ context, params });
    assert.equal(outcome.status, "completed");
    if (outcome.status === "completed") {
      assert.equal(outcome.cli?.stdout, "x".repeat(800_000));
      assert.strictEqual(outcome.result, original.result);
    }
    assert.equal(calls, 2 + Math.ceil(output.length / 524_288));
  });

  for (const failure of ["response", "throw"] as const) {
    it("retains the correct response when recovery fails with " + failure, async () => {
      const original = response("partial", { truncated: true, full_output_path: "/tmp/output" });
      const failed = { ...response("denied"), isError: true };
      const error = new Error("context expired");
      let calls = 0;
      const context = {
        async executeTool() {
          calls++;
          if (calls === 1) return original;
          if (calls === 2) return response("100");
          if (failure === "throw") throw error;
          return failed;
        },
      };
      const outcome = await runCliViaBash({ context, params });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") {
        assert.strictEqual(
          outcome.result,
          failure === "response" ? failed.result : original.result,
        );
        assert.equal(outcome.isError, failure === "response");
        if (failure === "throw") assert.strictEqual(outcome.error, error);
      }
      assert.equal(calls, 3);
    });
  }
});
