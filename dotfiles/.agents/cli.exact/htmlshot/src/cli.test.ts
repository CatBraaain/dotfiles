import { strict as assert } from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrowser, resolveScale } from "./shot";
import {
  FORMAT,
  PNG_SIGNATURE,
  buildEnvelope,
  chunkBytes,
  insertMetadata,
  verifyPng,
} from "./format";

const mainPath = join(import.meta.dir, "main.ts");

const BROWSER_TEST_TIMEOUT_MS = 30000;
const MAX_DOM_OUTPUT_BYTES = 16 * 1024 * 1024;
const hasBrowser = resolveBrowser() !== null;

type RgbaImage = { width: number; height: number; pixels: Buffer };

function runCli(args: string[], environment: Record<string, string> = {}) {
  return Bun.spawnSync(["bun", mainPath, ...args], {
    env: { ...process.env, ...environment },
  });
}

function readRgbaImage(pngPath: string): RgbaImage {
  const browserPath = resolveBrowser();
  assert.ok(browserPath);
  const imageUrl = `data:image/png;base64,${readFileSync(pngPath).toString("base64")}`;
  const html = `<!doctype html><body><script>
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const rgba = btoa(Array.from(pixels, byte => String.fromCharCode(byte)).join(""));
      document.body.textContent = JSON.stringify({ width: image.width, height: image.height, rgba });
    };
    image.src = ${JSON.stringify(imageUrl)};
  </script>`;
  const result = Bun.spawnSync(
    [
      browserPath,
      "--headless",
      "--dump-dom",
      "--virtual-time-budget=5000",
      `data:text/html,${encodeURIComponent(html)}`,
    ],
    { timeout: BROWSER_TEST_TIMEOUT_MS, maxBuffer: MAX_DOM_OUTPUT_BYTES },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const body = result.stdout.toString().match(/<body>([^<]+)<\/body>/)?.[1];
  assert.ok(body, "browser did not return decoded RGBA pixels");
  const decoded = JSON.parse(body) as { width: number; height: number; rgba: string };
  return {
    width: decoded.width,
    height: decoded.height,
    pixels: Buffer.from(decoded.rgba, "base64"),
  };
}

function pixelAt(image: RgbaImage, x: number, y: number): number[] {
  const rgbaChannels = 4;
  const offset = (y * image.width + x) * rgbaChannels;
  return [...image.pixels.subarray(offset, offset + rgbaChannels)];
}

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

describe("background rendering", () => {
  const backgrounds = [
    { name: "unspecified", css: "", expected: [0, 0, 0, 0] },
    { name: "transparent", css: "html,body{background:transparent}", expected: [0, 0, 0, 0] },
    { name: "white", css: "body{background:white}", expected: [255, 255, 255, 255] },
    { name: "body color", css: "body{background:#123456}", expected: [18, 52, 86, 255] },
    { name: "root color", css: "html{background:#654321}", expected: [101, 67, 33, 255] },
  ];

  for (const { name, css, expected } of backgrounds) {
    it.skipIf(!hasBrowser)(
      `renders the ${name} background without extra options`,
      () => {
        const dir = mkdtempSync(join(tmpdir(), "htmlshot-background-"));
        try {
          const htmlPath = join(dir, "sample.html");
          writeFileSync(
            htmlPath,
            `<!doctype html><style>body{margin:0}${css}</style><body></body>`,
          );
          const result = runCli([
            "shot",
            htmlPath,
            "--width",
            "320",
            "--height",
            "200",
            "--scale",
            "2",
          ]);
          assert.equal(result.exitCode, 0, result.stderr.toString());
          const pngPath = join(dir, "sample.html.png");
          const rendered = verifyPng(readFileSync(pngPath));
          assert.equal(rendered.envelope.format, FORMAT);
          assert.deepEqual(rendered.envelope.render, { width: 320, height: 200, scale: 2 });
          assert.equal(rendered.pixelWidth, 640);
          assert.equal(rendered.pixelHeight, 400);
          const image = readRgbaImage(pngPath);
          assert.deepEqual([image.width, image.height], [640, 400]);
          assert.deepEqual(pixelAt(image, 0, 0), expected);
          assert.deepEqual(pixelAt(image, image.width - 1, image.height - 1), expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  const transparentHtml = Buffer.from(
    [
      "\ufeff<!doctype html><meta charset='utf-8'><title>round-trip 🎨</title>",
      "<style>body{margin:0}.mark{position:absolute;top:20px;width:20px;height:20px}",
      ".opaque{left:20px;background:#00ff00}.translucent{left:60px;background:rgba(255,0,0,0.5)}</style>",
      "<body><div class='mark opaque'></div><div class='mark translucent'></div></body>",
    ].join("\r\n"),
  );

  it.skipIf(!hasBrowser)(
    "preserves opaque and translucent elements on a transparent canvas",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "htmlshot-alpha-"));
      try {
        const htmlPath = join(dir, "sample.html");
        writeFileSync(htmlPath, transparentHtml);
        const result = runCli([
          "shot",
          htmlPath,
          "--width",
          "320",
          "--height",
          "200",
          "--scale",
          "2",
        ]);
        assert.equal(result.exitCode, 0, result.stderr.toString());
        const image = readRgbaImage(join(dir, "sample.html.png"));
        assert.deepEqual(pixelAt(image, 0, 0), [0, 0, 0, 0]);
        assert.deepEqual(pixelAt(image, 60, 60), [0, 255, 0, 255]);
        assert.deepEqual(pixelAt(image, 140, 60), [255, 0, 0, 128]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasBrowser)(
    "re-shoots extracted HTML with byte-exact source and identical RGBA pixels",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "htmlshot-reshot-"));
      try {
        const htmlPath = join(dir, "original.html");
        const originalPngPath = join(dir, "original.html.png");
        const extractedPath = join(dir, "extracted.html");
        const reshotPath = join(dir, "reshot.html.png");
        const renderArgs = ["--width", "320", "--height", "200", "--scale", "2"];
        writeFileSync(htmlPath, transparentHtml);
        const original = runCli(["shot", htmlPath, ...renderArgs]);
        assert.equal(original.exitCode, 0, original.stderr.toString());
        const verified = runCli(["verify", originalPngPath]);
        assert.equal(verified.exitCode, 0, verified.stderr.toString());
        assert.match(verified.stdout.toString(), /320x200@2x, 640x400 px, format htmlshot\/v1/);
        const metadata = verifyPng(readFileSync(originalPngPath)).envelope;
        assert.deepEqual(Object.keys(metadata).sort(), ["checksum", "format", "html", "render"]);
        const extracted = runCli(["extract", originalPngPath, "-o", extractedPath]);
        assert.equal(extracted.exitCode, 0, extracted.stderr.toString());
        assert.deepEqual(readFileSync(extractedPath), transparentHtml);
        const reshot = runCli(["shot", extractedPath, "-o", reshotPath, ...renderArgs]);
        assert.equal(reshot.exitCode, 0, reshot.stderr.toString());
        assert.deepEqual(readRgbaImage(reshotPath), readRgbaImage(originalPngPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});

describe("cli constraints", () => {
  const violations = [
    { name: "scripts", html: "<script>void 0</script>", kind: /script/ },
    {
      name: "external references",
      html: "<a href='https://example.invalid/'>link</a>",
      kind: /external-ref/,
    },
  ];

  for (const { name, html, kind } of violations) {
    it(`rejects ${name} before resolving a browser`, () => {
      const dir = mkdtempSync(join(tmpdir(), "htmlshot-constraints-"));
      try {
        const htmlPath = join(dir, "sample.html");
        writeFileSync(htmlPath, `<!doctype html><body>${html}</body>`);
        const result = runCli(["shot", htmlPath], {
          HTMLSHOT_BROWSER: join(dir, "missing-browser"),
        });
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr.toString(), kind);
        assert.doesNotMatch(result.stderr.toString(), /HTMLSHOT_BROWSER/);
        assert.equal(existsSync(join(dir, "sample.html.png")), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(!hasBrowser)(
      `renders ${name} with warnings when --unsafe is given`,
      () => {
        const dir = mkdtempSync(join(tmpdir(), "htmlshot-unsafe-"));
        try {
          const htmlPath = join(dir, "sample.html");
          writeFileSync(htmlPath, `<!doctype html><body>${html}</body>`);
          const result = runCli([
            "shot",
            htmlPath,
            "--unsafe",
            "--width",
            "320",
            "--height",
            "200",
            "--scale",
            "1",
          ]);
          assert.equal(result.exitCode, 0, result.stderr.toString());
          assert.match(result.stderr.toString(), kind);
          const rendered = verifyPng(readFileSync(join(dir, "sample.html.png")));
          assert.deepEqual(rendered.envelope.render, { width: 320, height: 200, scale: 1 });
          assert.equal(rendered.envelope.html, `<!doctype html><body>${html}</body>`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
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
      assert.match(
        bind.stdout.toString(),
        /shot: .*sample\.html\.png \(320x200@1x, html \d+ bytes\)/,
      );
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
      const html =
        "<!doctype html><meta charset='utf-8'><body style='margin:0;background:#fff'></body>";
      const htmlPath = join(dir, "sample.html");
      writeFileSync(htmlPath, html);
      const bind = runCli(["shot", htmlPath, "--width", "320", "--height", "200"]);
      assert.equal(bind.exitCode, 0, bind.stderr.toString());
      assert.match(
        bind.stdout.toString(),
        /shot: .*sample\.html\.png \(320x200@3x, html \d+ bytes\)/,
      );
      const rendered = verifyPng(readFileSync(join(dir, "sample.html.png")));
      assert.deepEqual(rendered.envelope.render, { width: 320, height: 200, scale: 3 });
      assert.equal(rendered.pixelWidth, 960);
      assert.equal(rendered.pixelHeight, 600);
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
