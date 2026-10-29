import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { runUsage } from "./usage.ts";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

describe("usage execution", () => {
  it("uses only the fixed CLI and arguments with signal and timeout", async () => {
    const controller = new AbortController();
    function execute(
      command: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: Callback,
    ) {
      assert.equal(command, "usage");
      assert.deepEqual(args, ["--json"]);
      assert.deepEqual(options, {
        encoding: "utf8",
        signal: controller.signal,
        timeout: 25_000,
        killSignal: "SIGKILL",
      });
      callback(null, "[]", "fixture warning");
    }
    assert.deepEqual(await runUsage(controller.signal, execute as unknown as typeof execFile), {
      exitCode: 0,
      stdout: "[]",
    });
  });

  it("maps a missing executable to exit 127", async () => {
    function execute(
      _command: string,
      _args: string[],
      _options: ExecFileOptionsWithStringEncoding,
      callback: Callback,
    ) {
      callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "");
    }
    assert.deepEqual(await runUsage(undefined, execute as unknown as typeof execFile), {
      exitCode: 127,
      stdout: "",
    });
  });

  it.each([0, 1, 2])(
    "preserves real stdout and exit %s separately from stderr on every call",
    async (code) => {
      const directory = mkdtempSync(join(tmpdir(), "agents-usage-test-"));
      const previousPath = process.env.PATH;
      try {
        writeFileSync(
          join(directory, "usage"),
          `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== '["--json"]') process.exit(2);
console.error("fixture diagnostic");
console.log("[]");
process.exit(${code});
`,
          { mode: 0o700 },
        );
        process.env.PATH = directory;
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.deepEqual(await runUsage(), { exitCode: code, stdout: "[]\n" });
        }
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["abort", "timeout"])("rejects and kills the fixture process on %s", async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), "agents-usage-cancel-"));
    const previousPath = process.env.PATH;
    const controller = new AbortController();
    let child: ReturnType<typeof execFile> | undefined;
    try {
      writeFileSync(
        join(directory, "usage"),
        `#!${process.execPath}
console.log("started");
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      process.env.PATH = directory;
      function execute(
        command: string,
        args: string[],
        options: ExecFileOptionsWithStringEncoding,
        callback: Callback,
      ) {
        child = execFile(
          command,
          args,
          { ...options, timeout: failure === "timeout" ? 100 : options.timeout },
          callback,
        );
        if (failure === "abort") child.stdout!.once("data", () => controller.abort());
        return child;
      }
      await assert.rejects(
        runUsage(controller.signal, execute as unknown as typeof execFile),
        failure === "abort" ? /abort/i : /killed|Command failed/i,
      );
      assert.equal(child?.killed, true);
    } finally {
      child?.kill("SIGKILL");
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
