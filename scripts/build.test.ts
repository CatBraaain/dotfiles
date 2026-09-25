import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import {
  applyReplacements,
  applyReplaceSidecars,
  parseReplaceSidecar,
  run,
  runHooks,
} from "./build.ts";

let root: string;
let distRoot: string;
let homeRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "build-test-"));
  distRoot = join(root, "dist");
  homeRoot = join(root, "home");
  await mkdir(join(root, "dotfiles"));
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

describe("run", () => {
  it("rebuilds dist as a copy of dotfiles without node_modules", async () => {
    await put(root, "dotfiles/plain.txt", "plain\n");
    await put(root, "dotfiles/nested/dir/file.txt", "nested\n");
    await put(root, "dotfiles/node_modules/pkg/index.js", "skipped\n");
    await put(distRoot, "stale-from-previous-build.txt", "stale\n");

    await run(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "plain.txt"), "utf8"), "plain\n");
    assert.equal(await readFile(join(distRoot, "nested/dir/file.txt"), "utf8"), "nested\n");
    assert.equal(existsSync(join(distRoot, "node_modules")), false);
    assert.equal(existsSync(join(distRoot, "stale-from-previous-build.txt")), false);
  });

  it("runs local hooks from dist in name order with their dist folder as cwd", async () => {
    await put(
      root,
      "dotfiles/10-late.build.ts",
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
await appendFile("log.txt", "late\\n");
`,
    );
    await put(
      root,
      "dotfiles/02-early.build.ts",
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
await appendFile("log.txt", "early\\n");
`,
    );
    await put(
      root,
      "dotfiles/sub/marker.build.ts",
      `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
await writeFile("marker.txt", "ran\\n");
`,
    );

    await run(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "log.txt"), "utf8"), "early\nlate\n");
    assert.equal(await readFile(join(distRoot, "sub/marker.txt"), "utf8"), "ran\n");
    assert.equal(existsSync(join(distRoot, "marker.txt")), false);
  });

  it("does not run hooks that earlier hooks removed from dist", async () => {
    await put(
      root,
      "dotfiles/01-prune.build.ts",
      `#!/usr/bin/env bun
import { rm } from "node:fs/promises";
await rm("doomed", { recursive: true, force: true });
`,
    );
    await put(
      root,
      "dotfiles/doomed/boom.build.ts",
      `#!/usr/bin/env bun
process.exit(1);
`,
    );
    await put(root, "dotfiles/doomed/keep.txt", "x\n");

    await run(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "doomed")), false);
  });

  it("fails when a hook exits non-zero", async () => {
    await put(
      root,
      "dotfiles/fail.build.ts",
      `#!/usr/bin/env bun
throw new Error("boom");
`,
    );

    await assert.rejects(run(root, "linux", homeRoot), /local build hook failed: fail\.build\.ts/);
  });

  it("composes merge sidecars over the current home content", async () => {
    await put(
      homeRoot,
      "kit/settings.json",
      JSON.stringify({ mode: "home", keep: true, extra: ["home"] }),
    );
    await put(
      root,
      "dotfiles/kit/settings.json",
      JSON.stringify({ mode: "plain", plainOnly: true }),
    );
    await put(
      root,
      "dotfiles/kit/settings.merge.json",
      JSON.stringify({ "extra.$append": ["merged"] }),
    );

    await run(root, "linux", homeRoot);

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "kit/settings.json"), "utf8")), {
      mode: "plain",
      keep: true,
      plainOnly: true,
      extra: ["home", "merged"],
    });
    assert.equal(existsSync(join(distRoot, "kit/settings.merge.json")), false);
  });

  it("renders replace sidecars from the current home content", async () => {
    await put(homeRoot, "app.conf", "EnableAutoUpdates=true\n");
    await put(
      root,
      "dotfiles/app.conf.replace.yaml",
      `
replacements:
  - pattern: "(EnableAutoUpdates)=.*"
    replacement: "\${1}=false"
`,
    );

    await run(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "app.conf"), "utf8"), "EnableAutoUpdates=false\n");
    assert.equal(existsSync(join(distRoot, "app.conf.replace.yaml")), false);
  });
});

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

describe("local build hooks", () => {
  it("runs a shebang hook as a child process in the dist folder it belongs to", async () => {
    await put(root, "dotfiles/vscode/format-settings.build.sh", "#!/bin/sh\npwd > hook-cwd.txt\n");
    await run(root, "linux", homeRoot);
    const hookCwd = (await readFile(join(distRoot, "vscode/hook-cwd.txt"), "utf8")).trim();
    assert.equal(hookCwd, join(distRoot, "vscode"));
  });

  it("does not run a hook the path-map standard hook removed from dist", async () => {
    const standardHook = await readFile(
      join(import.meta.dir, "../dotfiles/02-path-map.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/02-path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/.build-map.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode/format-settings.build.sh | - | - | - |\n",
    );
    await put(root, "dotfiles/vscode/format-settings.build.sh", "#!/bin/sh\ntouch hook-ran.txt\n");

    await run(root, "linux", homeRoot);

    assert.ok(!existsSync(join(distRoot, "vscode/hook-ran.txt")));
    assert.ok(!existsSync(join(distRoot, "vscode/format-settings.build.sh")));
  });

  it("aborts on a hook without a shebang", async () => {
    await put(distRoot, "vscode/format-settings.build.sh", "echo hook output\n");
    await assert.rejects(
      runHooks(
        [
          {
            absolutePath: join(distRoot, "vscode/format-settings.build.sh"),
            relativeParent: "vscode",
            name: "format-settings.build.sh",
          },
        ],
        distRoot,
      ),
      /build hook has no shebang: vscode\/format-settings\.build\.sh/,
    );
  });
});
