import { strict as assert } from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrowser } from "./shot";
import { FORMAT, PNG_SIGNATURE, buildEnvelope, chunkBytes, insertMetadata } from "./format";

const mainPath = join(import.meta.dir, "main.ts");

const runCli = (args: string[]) => Bun.spawnSync(["bun", mainPath, ...args]);

const syntheticPng = (): Buffer => {
  const ihdrData = Buffer.from([0, 0, 5, 0, 0, 0, 3, 0, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunkBytes("IHDR", ihdrData),
    chunkBytes("IEND", Buffer.alloc(0)),
  ]);
};

const bound = (html: string): Buffer =>
  insertMetadata(syntheticPng(), buildEnvelope(html, { width: 1200, height: 800, scale: 1 }));

describe("cli", () => {
  it("prints usage and exits 1 without a subcommand", () => {
    const result = runCli([]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr.toString(), /usage:/);
  });

  it("exits 1 for an unknown subcommand", () => {
    const result = runCli(["snap"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr.toString(), /usage:/);
  });

  it("prints usage and exits 1 for an unknown option", () => {
    const result = runCli(["shot", "a.html", "--fast"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr.toString(), /usage:/);
  });

  it("extracts byte-exact html from a bound png", () => {
    const dir = mkdtempSync(join(tmpdir(), "htmlshot-cli-"));
    try {
      const html = "<h1>round-trip 🎨</h1>\n";
      const pngPath = join(dir, "a.html.png");
      writeFileSync(pngPath, bound(html));
      const result = runCli(["extract", pngPath]);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.match(result.stdout.toString(), /^extract: .*a\.html \(\d+ bytes\)/);
      assert.equal(readFileSync(join(dir, "a.html"), "utf8"), html);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with unsupported format message for old versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "htmlshot-cli-"));
    try {
      const envelope = buildEnvelope("<p>x</p>", { width: 1200, height: 800, scale: 1 });
      envelope.format = "htmlshot/v0";
      const pngPath = join(dir, "old.html.png");
      writeFileSync(pngPath, insertMetadata(syntheticPng(), envelope));
      const result = runCli(["extract", pngPath]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.toString(), /unsupported format: htmlshot\/v0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no htmlshot metadata for a plain png", () => {
    const dir = mkdtempSync(join(tmpdir(), "htmlshot-cli-"));
    try {
      const pngPath = join(dir, "plain.png");
      writeFileSync(pngPath, syntheticPng());
      const result = runCli(["extract", pngPath]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.toString(), /no htmlshot metadata/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds and re-extracts byte-exact html with a real browser", () => {
    if (resolveBrowser() === null) return;
    const dir = mkdtempSync(join(tmpdir(), "htmlshot-cli-"));
    try {
      const html = [
        "<!doctype html><meta charset='utf-8'>",
        "<body style='margin:0;background:#fff'>",
        "<div style='font:24px sans-serif;padding:20px'>図版テスト</div>",
        "</body>",
      ].join("");
      const htmlPath = join(dir, "sample.html");
      writeFileSync(htmlPath, html);
      const bind = runCli(["shot", htmlPath, "--width", "320", "--height", "200"]);
      assert.equal(bind.exitCode, 0, bind.stderr.toString());
      assert.match(bind.stdout.toString(), /shot: .*sample\.html\.png \(320x200@1x, html \d+ bytes\)/);
      const boundPng = readFileSync(join(dir, "sample.html.png"));
      assert.ok(boundPng.subarray(0, 8).equals(PNG_SIGNATURE));
      const extract = runCli(["extract", join(dir, "sample.html.png")]);
      assert.equal(extract.exitCode, 0, extract.stderr.toString());
      assert.equal(readFileSync(join(dir, "sample.html"), "utf8"), html);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
