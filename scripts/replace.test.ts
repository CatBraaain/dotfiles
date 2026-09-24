import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import {
  applyReplacements,
  applyReplaceSidecars,
  parseReplaceSidecar,
} from "./build.ts";

let root: string;
let distRoot: string;
let homeRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "replace-test-"));
  distRoot = join(root, "dist");
  homeRoot = join(root, "home");
  await mkdir(distRoot);
  await mkdir(homeRoot);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(baseDir: string, path: string, content: string): Promise<void> {
  const absolute = join(baseDir, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}

const autoUpdateReplacements = [
  { pattern: "(EnableAutoUpdates)=.*", replacement: "${1}=false" },
];

describe("applyReplaceSidecars", () => {
  it("renders the rendered file from home's current content and removes the sidecar", async () => {
    await put(homeRoot, "obs/config.ini", "EnableAutoUpdates=true\nOther=keep\n");
    await put(distRoot, "obs/config.ini.replace.yaml", `
replacements:
  - pattern: "(EnableAutoUpdates)=.*"
    replacement: "\${1}=false"
`);

    await applyReplaceSidecars(distRoot, homeRoot);

    assert.equal(await readFile(join(distRoot, "obs/config.ini"), "utf8"), "EnableAutoUpdates=false\nOther=keep\n");
    assert.equal(existsSync(join(distRoot, "obs/config.ini.replace.yaml")), false);
  });

  it("uses an empty input when home has no matching file", async () => {
    await put(distRoot, "generated.conf.replace.yaml", `
replacements:
  - pattern: "^"
    replacement: "seeded"
`);

    await applyReplaceSidecars(distRoot, homeRoot);

    assert.equal(await readFile(join(distRoot, "generated.conf"), "utf8"), "seeded");
  });

  it("resolves the rendered home path verbatim for plain names", async () => {
    await put(homeRoot, "dot_config/exact_kit/settings.conf", "mode=demo\n");
    await put(distRoot, "dot_config/exact_kit/settings.conf.replace.yaml", `
replacements:
  - pattern: "mode=demo"
    replacement: "mode=live"
`);

    await applyReplaceSidecars(distRoot, homeRoot);

    assert.equal(
      await readFile(join(distRoot, "dot_config/exact_kit/settings.conf"), "utf8"),
      "mode=live\n",
    );
  });

  it("rejects a sidecar without a replacements array", async () => {
    await put(distRoot, "bad.conf.replace.yaml", "replacements: {}");

    await assert.rejects(
      applyReplaceSidecars(distRoot, homeRoot),
      /must have a replacements array: bad\.conf\.replace\.yaml/,
    );
  });
});

describe("parseReplaceSidecar", () => {
  it("rejects entries whose pattern or replacement is not a string", () => {
    assert.throws(
      () => parseReplaceSidecar("replacements:\n  - pattern: 1\n    replacement: x\n", "a.yaml"),
      /must map pattern and replacement to strings/,
    );
  });
});

describe("applyReplacements", () => {
  it("applies replacements top to bottom and replaces every match", () => {
    const result = applyReplacements("a-b a-b\n", [
      { pattern: "a", replacement: "b" },
      { pattern: "-", replacement: "+" },
    ]);
    assert.equal(result, "b+b b+b\n");
  });

  it("keeps input without any match unchanged and resolves capture references", () => {
    assert.equal(applyReplacements("keep me\n", autoUpdateReplacements), "keep me\n");
    assert.equal(applyReplacements("EnableAutoUpdates=true\n", autoUpdateReplacements), "EnableAutoUpdates=false\n");
  });
});
