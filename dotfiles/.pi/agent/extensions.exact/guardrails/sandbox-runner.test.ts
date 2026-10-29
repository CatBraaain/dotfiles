import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guardrail } from "./guardrail.ts";
import { SandboxRunner } from "./sandbox-runner.ts";

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
    const active = Array.from({ length: 4 }, () =>
      runner.runTool("read", { path: "/tmp/file" }, { mode: "fs" }),
    );
    await allStarted.promise;
    const controller = new AbortController();
    const waiting = runner.runTool(
      "read",
      { path: "/tmp/waiting" },
      { mode: "fs", signal: controller.signal },
    );
    controller.abort(new Error("cancelled in queue"));
    const rejection = assert.rejects(waiting, /cancelled in queue/);
    release.resolve();
    await Promise.all([...active, rejection]);
    assert.equal(starts, 4);
  });
});
