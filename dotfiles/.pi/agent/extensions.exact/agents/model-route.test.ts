import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { parse, quote } from "shell-quote";
import { runModelRoute } from "./model-route.ts";

describe("model-route execution", () => {
  it("uses the fixed command and a seconds-based timeout, preserving stdout only", async () => {
    let inputPath = "";
    let outputPath = "";
    const controller = new AbortController();
    const result = await runModelRoute(
      [
        { provider: "zai", model: "m", weight: 2 },
        { provider: "zai", model: "m", settings: [{ multiply: { provider: "zai" } }] },
      ],
      controller.signal,
      {
        async exec(command, cwd, options) {
          const args = parse(command);
          assert.equal(args[0], "model-route");
          assert.equal(args[1], "score");
          assert.deepEqual(args[3], { op: ">" });
          assert.equal(args.length, 5);
          inputPath = String(args[2]);
          outputPath = String(args[4]);
          assert.deepEqual(JSON.parse(readFileSync(inputPath, "utf8")), {
            candidates: [
              { provider: "zai", model: "m" },
              { provider: "zai", model: "m" },
            ],
          });
          assert.equal(cwd, process.cwd());
          assert.equal(options.timeout, 25);
          assert.equal(options.signal, controller.signal);
          options.onData(Buffer.from("model-route: cache save failed\n"));
          writeFileSync(outputPath, "[]");
          return { exitCode: 0 };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.equal(existsSync(inputPath), false);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(dirname(inputPath)), false);
  });

  it("preserves the exit code when the CLI is absent", async () => {
    const result = await runModelRoute([{ provider: "zai", model: "m" }], undefined, {
      async exec() {
        return { exitCode: 127 };
      },
    });
    assert.deepEqual(result, { exitCode: 127, stdout: "" });
  });

  it("cleans up temporary files when execution fails", async () => {
    let directory = "";
    await assert.rejects(
      runModelRoute([{ provider: "zai", model: "m" }], undefined, {
        async exec(command) {
          directory = dirname(String(parse(command)[2]));
          throw new Error("execution timed out");
        },
      }),
      /execution timed out/,
    );
    assert.equal(existsSync(directory), false);
  });

  it("runs the real CLI and keeps its input-order array when cache writes produce stderr", async () => {
    const directory = mkdtempSync(join(tmpdir(), "route-cli-test-"));
    const executable = join(directory, "model-route");
    const usage = join(directory, "usage");
    const cacheRoot = join(directory, "cache-is-a-file");
    const counter = join(directory, "usage-count");
    const source = fileURLToPath(
      new URL("../../../../.agents/cli.exact/model-route/src/main.ts", import.meta.url),
    );
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const rows = [
      { provider: "a", long: 50, longResetsAt: resetsAt, longWindowMinutes: 120 },
      { provider: "b", long: 25, longResetsAt: resetsAt, longWindowMinutes: 120 },
    ];
    try {
      writeFileSync(
        executable,
        `#!/usr/bin/env bash\nexec ${quote([process.execPath, source])} "$@"\n`,
      );
      writeFileSync(
        usage,
        `#!/usr/bin/env bash\nprintf 'query\\n' >> ${quote([counter])}\nprintf '%s\\n' ${quote([JSON.stringify(rows)])}\n`,
      );
      chmodSync(executable, 0o700);
      chmodSync(usage, 0o700);
      writeFileSync(cacheRoot, "not a directory");
      const operations = createLocalBashOperations();
      const injected: BashOperations = {
        exec(command, cwd, options) {
          return operations.exec(command, cwd, {
            ...options,
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH ?? ""}`,
              XDG_CACHE_HOME: cacheRoot,
            },
          });
        },
      };
      const result = await runModelRoute(
        [
          { provider: "a", model: "m" },
          { provider: "b", model: "m" },
        ],
        undefined,
        injected,
      );
      assert.equal(result.exitCode, 0);
      const scored = JSON.parse(result.stdout) as Array<{
        provider: string;
        model: string;
        urgency: number | null;
        usageState: { source: string } | null;
      }>;
      assert.deepEqual(
        scored.map(({ provider, model, urgency, usageState }) => ({
          provider,
          model,
          urgency,
          source: usageState?.source ?? null,
        })),
        [
          { provider: "a", model: "m", urgency: 1, source: "fresh" },
          { provider: "b", model: "m", urgency: 0.5, source: "fresh" },
        ],
      );
      assert.equal(readFileSync(counter, "utf8"), "query\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
