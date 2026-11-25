import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";

const entrypoint = fileURLToPath(new URL("./read.ts", import.meta.url));

describe("Tools read worker", () => {
  for (const body of [
    "日本語\r\n".repeat(12000),
    "\uFEFFfirst\r\nlast\r\n",
    "",
    "no final newline",
  ]) {
    it(`returns only the exact UTF-8 body of ${body.length} characters`, () => {
      const directory = mkdtempSync(join(tmpdir(), "tools-worker-"));
      try {
        const path = join(directory, "SKILL.md");
        writeFileSync(path, body);
        const cli = spawnSync("bun", [entrypoint, "read"], {
          input: JSON.stringify({ params: { path, offset: 99999, limit: 0 } }),
          encoding: "utf8",
        });
        assert.equal(cli.status, 0);
        assert.equal(cli.stderr, "");
        assert.deepEqual(JSON.parse(cli.stdout), {
          ok: true,
          result: { content: [{ type: "text", text: body }], structuredContent: body },
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("reads an extensionless image without shell commands in a direct worker", () => {
    const directory = mkdtempSync(join(tmpdir(), "tools-worker-image-"));
    try {
      const path = join(directory, "photo");
      const data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1cAAAAASUVORK5CYII=";
      writeFileSync(path, Buffer.from(data, "base64"));
      const cli = spawnSync(process.execPath, [entrypoint, "read"], {
        input: JSON.stringify({ params: { path }, executorData: { supportsImages: true } }),
        encoding: "utf8",
      });
      assert.equal(cli.status, 0);
      assert.deepEqual(JSON.parse(cli.stdout).result.content, [
        { type: "image", mimeType: "image/png", data },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns an error envelope for a missing input without a partial result", () => {
    const directory = mkdtempSync(join(tmpdir(), "tools-worker-error-"));
    try {
      const cli = spawnSync("bun", [entrypoint, "read"], {
        input: JSON.stringify({ params: { path: join(directory, "SKILL.md") } }),
        encoding: "utf8",
      });
      assert.equal(cli.status, 1);
      const response = JSON.parse(cli.stdout);
      assert.equal(response.ok, false);
      assert.match(response.error, /ENOENT/);
      assert.equal(response.result, undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
