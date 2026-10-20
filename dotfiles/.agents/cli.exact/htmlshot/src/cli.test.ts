import { strict as assert } from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrowser, resolveScale } from "./shot";
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

describe("resolveScale", () => {
  it("uses the requested scale when given", () => {
    assert.equal(resolveScale(320, 200, 1), 1);
    assert.equal(resolveScale(960, 540, 3), 3);
  });

  it("picks the auto scale from FHD width for landscape and square images", () => {
    assert.equal(resolveScale(2400, 1400), 1, "width 2400 -> round(0.8)");
    assert.equal(resolveScale(960, 540), 2, "width 960 -> round(2)");
    assert.equal(resolveScale(1000, 1000), 2, "square width 1000 -> round(1.92)");
    assert.equal(resolveScale(1200, 800), 2, "width 1200 -> round(1.6)");
    assert.equal(resolveScale(600, 400), 3, "width 600 -> round(3.2)");
  });

  it("picks the auto scale from FHD height for portrait images", () => {
    assert.equal(resolveScale(800, 1200), 1, "height 1200 -> round(0.9)");
    assert.equal(resolveScale(500, 1000), 1, "height 1000 -> round(1.08)");
    assert.equal(resolveScale(200, 320), 3, "height 320 -> round(3.375)");
  });

  it("keeps the auto scale within 1 to 3", () => {
    assert.equal(resolveScale(320, 200), 3, "landscape width 320 -> round(6) clamped");
    assert.equal(resolveScale(100, 200), 3, "portrait height 200 -> round(5.4) clamped");
    assert.equal(resolveScale(5000, 3000), 1, "landscape width 5000 -> round(0.4) clamped");
  });
});

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
      const bind = runCli(["shot", htmlPath, "--width", "320", "--height", "200", "--scale", "1"]);
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

  it("auto-selects the render scale from the canvas size with a real browser", () => {
    if (resolveBrowser() === null) return;
    const dir = mkdtempSync(join(tmpdir(), "htmlshot-cli-"));
    try {
      const html = "<!doctype html><meta charset='utf-8'><body style='margin:0;background:#fff'></body>";
      const htmlPath = join(dir, "sample.html");
      writeFileSync(htmlPath, html);
      const bind = runCli(["shot", htmlPath, "--width", "320", "--height", "200"]);
      assert.equal(bind.exitCode, 0, bind.stderr.toString());
      assert.match(bind.stdout.toString(), /shot: .*sample\.html\.png \(320x200@3x, html \d+ bytes\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports render settings and pixel size in verify output", () => {
    const dir = mkdtempSync(join(tmpdir(), "htmlshot-cli-"));
    try {
      const pngPath = join(dir, "a.html.png");
      writeFileSync(pngPath, bound("<p>x</p>"));
      const result = runCli(["verify", pngPath]);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.match(
        result.stdout.toString(),
        /verify: .*a\.html\.png ok \(1200x800@1x, 1280x768 px, format htmlshot\/v1, html \d+ bytes\)/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
