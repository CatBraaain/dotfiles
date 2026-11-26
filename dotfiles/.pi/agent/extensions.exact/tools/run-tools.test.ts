import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { WorkerPool } from "../guardrails/worker-pool.ts";

const entrypoint = fileURLToPath(new URL("./run-tools.ts", import.meta.url));
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1cAAAAASUVORK5CYII=";

type Tool = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";
type RunOptions = { data?: Record<string, unknown>; session?: Record<string, string> };
type Run = (
  tool: Tool,
  params: Record<string, unknown>,
  options?: RunOptions,
) => Promise<AgentToolResult<unknown>>;

function withWorker(
  test: (fixture: { directory: string; pool: WorkerPool; run: Run }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "tools-worker-"));
    const pool = new WorkerPool(
      directory,
      () => [],
      () => false,
    );
    const run: Run = (tool, params, options = {}) =>
      pool.runTool(tool, params, {
        mode: tool === "bash" ? "bash" : "fs",
        executor: { entrypoint, data: options.data },
        session: options.session,
      });
    try {
      await test({ directory, pool, run });
    } finally {
      pool.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

describe("Tools read worker", () => {
  for (const body of [
    "日本語\r\n".repeat(12000),
    "\uFEFFfirst\r\nlast\r\n",
    "",
    "no final newline",
  ]) {
    it(
      `returns only the exact UTF-8 body of a ${body.length}-character SKILL.md`,
      withWorker(async ({ directory, run }) => {
        const path = join(directory, "SKILL.md");
        writeFileSync(path, body);
        const result = await run(
          "read",
          { path, offset: 99999, limit: 0 },
          { data: { supportsImages: false } },
        );
        assert.deepEqual(result, {
          content: [{ type: "text", text: body }],
          structuredContent: body,
        });
      }),
    );
  }

  it(
    "reads an extensionless image without shell commands",
    withWorker(async ({ directory, run }) => {
      const path = join(directory, "photo");
      writeFileSync(path, Buffer.from(png, "base64"));
      const result = await run(
        "read",
        { path, offset: 999, limit: 1 },
        { data: { supportsImages: true } },
      );
      assert.deepEqual(result.content, [{ type: "image", data: png, mimeType: "image/png" }]);
    }),
  );

  it(
    "returns the delegation error instead of an image for a text-only model",
    withWorker(async ({ directory, run }) => {
      const path = join(directory, "photo");
      writeFileSync(path, Buffer.from(png, "base64"));
      const result = await run(
        "read",
        { path },
        { data: { supportsImages: false, provider: "fixture", modelId: "text" } },
      );
      assert.equal(result.isError, true);
      assert.match((result.content[0] as { text: string }).text, /fixture\/text.*vision agent/);
    }),
  );

  it(
    "returns SVG as text without an image block",
    withWorker(async ({ directory, run }) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
      const path = join(directory, "icon.svg");
      writeFileSync(path, svg);
      const result = await run("read", { path }, { data: { supportsImages: true } });
      assert.deepEqual(result.content, [{ type: "text", text: svg }]);
    }),
  );

  it(
    "fails a read of a missing file with the error message",
    withWorker(async ({ directory, run }) => {
      await assert.rejects(
        run("read", { path: join(directory, "SKILL.md") }, { data: { supportsImages: true } }),
        /ENOENT/,
      );
    }),
  );
});

describe("Tools standard definitions behind the worker", () => {
  it(
    "writes, edits, greps, finds, and lists through the pi definitions",
    withWorker(async ({ directory, run }) => {
      const config = join(directory, "config.yml");
      writeFileSync(config, "name: before\n");
      const written = join(directory, "created.txt");
      assert.equal(
        (await run("write", { path: written, content: "written by worker" })).isError,
        undefined,
      );
      assert.equal(readFileSync(written, "utf8"), "written by worker");
      assert.equal(
        (await run("edit", { path: config, edits: [{ oldText: "before", newText: "after" }] }))
          .isError,
        undefined,
      );
      assert.equal(readFileSync(config, "utf8"), "name: after\n");
      const grep = await run("grep", { pattern: "after", path: directory });
      assert.match((grep.content[0] as { text: string }).text, /config\.yml:1: name: after/);
      const find = await run("find", { pattern: "*.txt", path: directory });
      assert.match((find.content[0] as { text: string }).text, /created\.txt/);
      const ls = await run("ls", { path: directory });
      assert.match((ls.content[0] as { text: string }).text, /config\.yml/);
    }),
  );

  it(
    "exposes the session as PI_* environment variables to bash",
    withWorker(async ({ run }) => {
      const result = await run(
        "bash",
        { command: "echo session=$PI_SESSION_ID provider=$PI_PROVIDER model=$PI_MODEL" },
        { session: { sessionId: "test-session-42", provider: "fixture", modelId: "model-7" } },
      );
      assert.equal(
        (result.content[0] as { text: string }).text,
        "session=test-session-42 provider=fixture model=model-7\n",
      );
    }),
  );

  it(
    "returns the command's exit status and output",
    withWorker(async ({ run }) => {
      const result = await run("bash", { command: "printf out; printf err >&2; exit 7" });
      assert.equal(result.isError, true);
      assert.match((result.content[0] as { text: string }).text, /Command exited with code 7/);
      assert.equal((result.structuredContent as { exit_code: number }).exit_code, 7);
    }),
  );
});

describe("Tools worker protocol", () => {
  function startWorker() {
    const child = spawn("bun", [entrypoint, "--worker"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GUARDRAIL_PI_PACKAGE_DIR: getPackageDir() },
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity, terminal: false });
    return { child, exited, lines };
  }

  it("answers malformed requests with an error envelope and keeps serving", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tools-worker-protocol-"));
    const { child, exited, lines } = startWorker();
    const responses: { id: number; ok: boolean; error?: string }[] = [];
    lines.on("line", (line) => responses.push(JSON.parse(line)));
    try {
      child.stdin.write("not json\n");
      child.stdin.write(
        `${JSON.stringify({ id: 1, tool: "unknown-tool", request: { params: {} } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ id: 2, tool: "read", request: { params: "not an object" } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ id: 3, tool: "read", request: { params: { path: join(directory, "note.txt") } } })}\n`,
      );
      const deadline = Date.now() + 8_000;
      while (responses.length < 3) {
        assert.ok(Date.now() < deadline, "the worker must answer every well-formed id");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(
        responses.map((response) => [response.id, response.ok]),
        [
          [1, false],
          [2, false],
          [3, false],
        ],
      );
      assert.match(responses[0]!.error!, /Unknown tool/);
      assert.match(responses[1]!.error!, /Invalid tool request/);
      assert.match(responses[2]!.error!, /ENOENT/);
    } finally {
      child.stdin.end();
      assert.equal(await exited, 0);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores a cancel for an unknown request id", async () => {
    const { child, exited, lines } = startWorker();
    const responses: string[] = [];
    lines.on("line", (line) => responses.push(line));
    try {
      child.stdin.write(`${JSON.stringify({ id: 41, cancel: true })}\n`);
      child.stdin.write(`${JSON.stringify({ id: 42, cancel: true })}\n`);
    } finally {
      child.stdin.end();
      assert.equal(await exited, 0);
    }
    assert.deepEqual(responses, [], "a cancel must not produce a response");
  });
});
