import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guardrail } from "./guardrail.ts";
import { SandboxRunner } from "./sandbox-runner.ts";
import { sanitizeSandboxEnvironment } from "./config.ts";

describe("sandbox executors", () => {
  it("uses the existing fs mounts, environment, cwd, argv, and request envelope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-executor-"));
    try {
      const config = join(directory, "config.yaml");
      const masked = join(directory, "secret");
      writeFileSync(masked, "never disclose");
      writeFileSync(config, `read:\n  - allow: "*"\n  - deny: "${masked}"\n`);
      const entrypoint = join(directory, "executor.ts");
      writeFileSync(
        entrypoint,
        `
        import { readFileSync, writeFileSync } from "node:fs";
        const request = JSON.parse(readFileSync(0, "utf8"));
        let secret;
        try { secret = readFileSync(request.params.masked, "utf8"); } catch { secret = "masked"; }
        let writeError;
        try { writeFileSync(request.params.output, "blocked"); } catch (error) { writeError = error.code; }
        console.log(JSON.stringify({ok:true,result:{content:[],details:{
          request, secret, writeError, cwd:process.cwd(), tool:process.argv[2], path:process.env.PATH
        }}}));
      `,
      );
      const policy = new Guardrail(directory, config);
      const runner = new SandboxRunner(directory, (mode) => {
        assert.equal(mode, "fs");
        return policy.buildArgs(mode);
      });
      const params = { masked, output: join(directory, "output") };
      const result = await runner.runTool("read", params, {
        mode: "fs",
        executor: { entrypoint },
        session: { sessionId: "fixture" },
      });
      assert.equal(result.details.cwd, directory);
      assert.equal(result.details.tool, "read");
      assert.equal(result.details.path, sanitizeSandboxEnvironment(process.env).PATH);
      assert.deepEqual(result.details.request, {
        toolCallId: "cli",
        params,
        session: { sessionId: "fixture" },
      });
      assert.notEqual(result.details.secret, "never disclose");
      assert.equal(result.details.writeError, "EROFS");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const entrypoint of ["relative.ts", "", "/tmp/invalid\u0000.ts"]) {
    it(`rejects an invalid executor path ${JSON.stringify(entrypoint)} before building mounts`, async () => {
      let builds = 0;
      const runner = new SandboxRunner(process.cwd(), () => {
        builds++;
        return [];
      });
      await assert.rejects(
        runner.runTool("read", {}, { mode: "fs", executor: { entrypoint } }),
        /absolute file path/,
      );
      assert.equal(builds, 0);
    });
  }

  for (const [name, source, errorPattern] of [
    ["missing", undefined, /not found|Cannot find|ModuleNotFound/],
    ["invalid JSON", 'console.log("invalid")', /exited with code 0/],
    [
      "masked worker",
      "console.log(JSON.stringify({ok:true,result:{content:[]}}))",
      /EACCES|ENOENT/,
    ],
    [
      "worker error",
      'console.log(JSON.stringify({ok:false,error:"fixture failed"})); process.exit(1)',
      /fixture failed/,
    ],
    [
      "nonzero success",
      "console.log(JSON.stringify({ok:true,result:{content:[]}})); process.exit(1)",
      /exited with code 1/,
    ],
  ] as const) {
    it(`fails closed for ${name} without a standard read fallback`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "sandbox-fail-"));
      try {
        const config = join(directory, "config.yaml");
        const path = join(directory, "input.txt");
        writeFileSync(path, "standard read would succeed");
        const entrypoint = join(directory, "executor.ts");
        writeFileSync(
          config,
          `read:\n  - allow: "*"\n${name === "masked worker" ? `  - deny: "${entrypoint}"\n` : ""}`,
        );
        if (source !== undefined) writeFileSync(entrypoint, source);
        const policy = new Guardrail(directory, config);
        const runner = new SandboxRunner(directory, (mode) => policy.buildArgs(mode));
        await assert.rejects(
          runner.runTool("read", { path }, { mode: "fs", executor: { entrypoint } }),
          errorPattern,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("kills a supplied executor after its first progress output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "executor-abort-"));
    const controller = new AbortController();
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, 'read:\n  - allow: "*"\n');
      const entrypoint = join(directory, "executor.ts");
      writeFileSync(entrypoint, 'process.stderr.write("ready"); await new Promise(() => {});');
      const policy = new Guardrail(directory, config);
      const runner = new SandboxRunner(directory, (mode) => policy.buildArgs(mode));
      let started = false;
      const pending = runner.runTool(
        "read",
        {},
        {
          mode: "fs",
          executor: { entrypoint },
          signal: controller.signal,
          onData(data, stream) {
            if (stream === "stderr" && data.toString().includes("ready")) {
              started = true;
              controller.abort();
            }
          },
        },
      );
      await assert.rejects(pending, /aborted/);
      assert.equal(started, true);
    } finally {
      controller.abort();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("sandbox cancellation", () => {
  it("aborts a running bwrap child after receiving its progress", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-abort-"));
    const controller = new AbortController();
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, 'read:\n  - allow: "*"\nwrite:\n  - allow: /tmp\n');
      const policy = new Guardrail(directory, config);
      const runner = new SandboxRunner(directory, (mode) => policy.buildArgs(mode));
      let receivedProgress = false;
      const pending = runner.runTool(
        "bash",
        { command: "echo started >&2; sleep 3" },
        {
          mode: "bash",
          signal: controller.signal,
          onData(data, stream) {
            if (stream !== "stderr" || !data.toString().includes("started")) return;
            receivedProgress = true;
            controller.abort();
          },
        },
      );
      await assert.rejects(pending, /aborted/);
      assert.equal(receivedProgress, true);
    } finally {
      controller.abort();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never starts an already aborted request", async () => {
    let mountBuilds = 0;
    const runner = new SandboxRunner(process.cwd(), () => {
      mountBuilds++;
      return [];
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before sandbox"));
    await assert.rejects(
      runner.runTool("read", { path: "/tmp/file" }, { mode: "fs", signal: controller.signal }),
      /cancelled before sandbox/,
    );
    assert.equal(mountBuilds, 0);
  });

  it("does not spawn a cancelled request after it waited for a sandbox slot", async () => {
    const release = Promise.withResolvers<void>();
    const allStarted = Promise.withResolvers<void>();
    const runner = new SandboxRunner(process.cwd(), () => []);
    let starts = 0;
    const runtime = runner as unknown as {
      runSandboxProcess: () => Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>;
    };
    runtime.runSandboxProcess = async () => {
      starts++;
      if (starts === 4) allStarted.resolve();
      await release.promise;
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({ ok: true, result: { content: [], details: {} } })),
        stderr: Buffer.alloc(0),
      };
    };
    const active = Array.from({ length: 4 }, (_, index) =>
      runner.runTool(
        "read",
        { path: "/tmp/file" },
        {
          mode: "fs",
          executor: index % 2 === 0 ? { entrypoint: "/tmp/fixture.ts" } : undefined,
        },
      ),
    );
    await allStarted.promise;
    const controller = new AbortController();
    const waiting = runner.runTool(
      "read",
      { path: "/tmp/waiting" },
      { mode: "fs", signal: controller.signal, executor: { entrypoint: "/tmp/fixture.ts" } },
    );
    controller.abort(new Error("cancelled in queue"));
    const rejection = assert.rejects(waiting, /cancelled in queue/);
    release.resolve();
    await Promise.all([...active, rejection]);
    assert.equal(starts, 4);
  });
});
