import assert from "node:assert/strict";
import { it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliOutput } from "./cli.ts";

const captureScript = fileURLToPath(new URL("./cli-capture.ts", import.meta.url));

function capture(...args: string[]) {
  return Bun.spawnSync([process.execPath, "--no-install", "--no-env-file", captureScript, ...args]);
}

it("creates a capture directory and frames independent UTF-8 streams", () => {
  const created = capture("create");
  assert.equal(created.exitCode, 0, created.stderr.toString());
  const directory = created.stdout.toString();
  try {
    const stdout = "marker PI_CLI_END\n 日本語 \r\n".repeat(5_000);
    const stderr = " diagnostic \n";
    writeFileSync(join(directory, "stdout"), stdout);
    writeFileSync(join(directory, "stderr"), stderr);
    const framed = capture("frame", directory, "23");
    assert.equal(framed.exitCode, 0, framed.stderr.toString());
    assert.deepEqual(parseCliOutput(framed.stdout.toString()), { stdout, stderr, code: 23 });
  } finally {
    const cleaned = capture("cleanup", directory);
    assert.equal(cleaned.exitCode, 0, cleaned.stderr.toString());
    assert.equal(existsSync(directory), false);
  }
});

it("does not clean up a directory outside the capture namespace", () => {
  const directory = mkdtempSync(join(tmpdir(), "not-a-cli-capture-"));
  try {
    const result = capture("cleanup", directory);
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(directory), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reads an exact byte range and rejects a short range", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-range-"));
  try {
    const path = join(directory, "日本語 '$() output.log");
    const bytes = Buffer.from("あ\r\nz");
    writeFileSync(path, bytes);
    const size = capture("size", path);
    assert.equal(size.exitCode, 0, size.stderr.toString());
    assert.equal(size.stdout.toString(), String(bytes.length));
    const range = capture("read", path, "1", "3");
    assert.equal(range.exitCode, 0, range.stderr.toString());
    assert.deepEqual(range.stdout, bytes.subarray(1, 4));
    const incomplete = capture("read", path, "1", String(bytes.length));
    assert.notEqual(incomplete.exitCode, 0);
    assert.match(incomplete.stderr.toString(), /Incomplete CLI output range/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
