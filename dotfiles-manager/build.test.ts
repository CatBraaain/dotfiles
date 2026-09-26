import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
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

  it("runs parent hooks before child folders in UTF-16 name order with their dist folder as cwd", async () => {
    await put(
      root,
      "dotfiles/10-late.build.ts",
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
export default async function () {
  await appendFile("log.txt", "late\\n");
}
`,
    );
    await put(
      root,
      "dotfiles/02-early.build.ts",
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
export default async function () {
  await appendFile("log.txt", "early\\n");
}
`,
    );
    await put(
      root,
      "dotfiles/sub/marker.build.ts",
      `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
export default async function () {
  await writeFile("marker.txt", "ran\\n");
}
`,
    );
    const orderFile = join(root, "path-order.txt");
    for (const [path, label] of [
      ["z.build.ts", "root-z"],
      ["\uE000.build.ts", "root-bmp"],
      ["\u{10000}.build.ts", "root-astral"],
      ["\uE000/child.build.ts", "bmp-child"],
      ["\u{10000}/child.build.ts", "astral-child"],
      ["a-/before.build.ts", "a-before"],
      ["a/deep/grandchild.build.ts", "a-grandchild"],
      ["a/z-parent.build.ts", "a-parent"],
      ["a/child.build.ts", "a-child"],
      ["a.build.ts", "root-a"],
    ]) {
      await put(
        root,
        `dotfiles/${path}`,
        `import { appendFile } from "node:fs/promises";\nexport default async function () {\n  await appendFile(${JSON.stringify(orderFile)}, ${JSON.stringify(`${label}\n`)});\n}`,
      );
    }

    await run(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "log.txt"), "utf8"), "early\nlate\n");
    assert.equal(await readFile(join(distRoot, "sub/marker.txt"), "utf8"), "ran\n");
    assert.equal(existsSync(join(distRoot, "marker.txt")), false);
    assert.equal(
      await readFile(orderFile, "utf8"),
      "root-a\nroot-z\nroot-astral\nroot-bmp\na-child\na-parent\na-grandchild\na-before\nastral-child\nbmp-child\n",
    );
  });

  it("runs machine and shared build hooks in filename order from their dist folder", async () => {
    await put(
      root,
      "dotfiles/nested/02-shared.build.ts",
      `import { appendFile } from "node:fs/promises";
export default async function () {
  await appendFile("order.txt", "shared\\n");
}`,
    );
    await put(
      root,
      "dotfiles/nested/01-local.build-machine.ts",
      `import { appendFile } from "node:fs/promises";
export default async function () {
  await appendFile("order.txt", "machine\\n");
}`,
    );

    await run(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "nested/order.txt"), "utf8"), "machine\nshared\n");
    assert.equal(existsSync(join(distRoot, "order.txt")), false);
  });

  it("runs a collected hook even after an earlier hook removes it", async () => {
    const orderFile = join(root, "hook-order.txt");
    await put(
      root,
      "dotfiles/01-prune.build.ts",
      `import { rm, appendFile } from "node:fs/promises";\nexport default async function () {\n  await rm("doomed", { recursive: true, force: true });\n  await appendFile(${JSON.stringify(orderFile)}, "prune\\n");\n}`,
    );
    await put(
      root,
      "dotfiles/doomed/boom.build.ts",
      `import { appendFile } from "node:fs/promises";\nexport default async function () {\n  await appendFile(${JSON.stringify(orderFile)}, "collected\\n");\n}`,
    );
    await put(root, "dotfiles/doomed/keep.txt", "x\n");

    await run(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "doomed/keep.txt")), false);
    assert.equal(await readFile(orderFile, "utf8"), "prune\ncollected\n");
  });

  it("preserves existing empty ancestors after executing a removed nested hook", async () => {
    const orderFile = join(root, "hook-order.txt");
    await put(
      root,
      "dotfiles/01-prune.build.ts",
      `import { rm } from "node:fs/promises";\nexport default async function () {\n  await rm("doomed/sub", { recursive: true, force: true });\n}`,
    );
    await put(
      root,
      "dotfiles/doomed/sub/late.build.ts",
      `import { appendFile } from "node:fs/promises";\nexport default async function () {\n  await appendFile(${JSON.stringify(orderFile)}, "ran\\n");\n}`,
    );
    await put(root, "dotfiles/doomed/keep.txt", "keep\n");

    await run(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "doomed/keep.txt"), "utf8"), "keep\n");
    assert.equal(existsSync(join(distRoot, "doomed/sub")), false);
    assert.equal(await readFile(orderFile, "utf8"), "ran\n");
  });

  it("fails when a hook exits non-zero", async () => {
    await put(
      root,
      "dotfiles/fail.build.ts",
      `#!/usr/bin/env bun
export default async function () {
  await Promise.resolve();
  throw new Error("boom");
}
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

  for (const { format, serialize, parse } of [
    {
      format: "json",
      serialize: (values: Record<string, string>) => JSON.stringify(values),
      parse: JSON.parse,
    },
    {
      format: "yaml",
      serialize: (values: Record<string, string>) =>
        Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join(""),
      parse: parseYaml,
    },
    {
      format: "toml",
      serialize: (values: Record<string, string>) =>
        Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join(""),
      parse: parseToml,
    },
  ]) {
    it(`composes a standalone ${format} machine merge layer over home`, async () => {
      await put(homeRoot, `kit/settings.${format}`, serialize({ mode: "home" }));
      await put(root, `dotfiles/kit/settings.merge-machine.${format}`, serialize({ mode: "machine" }));

      await run(root, "linux", homeRoot);

      assert.equal(parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8")).mode, "machine");
      assert.equal(existsSync(join(distRoot, `kit/settings.merge-machine.${format}`)), false);
    });

    it(`applies ${format} home, plain base, shared merge, then machine merge`, async () => {
      await put(homeRoot, `kit/settings.${format}`, serialize({ home: "present", homeVsPlain: "home" }));
      await put(root, `dotfiles/kit/settings.${format}`, serialize({
        plain: "present", homeVsPlain: "plain", plainVsShared: "plain",
      }));
      await put(root, `dotfiles/kit/settings.merge.${format}`, serialize({
        shared: "present", plainVsShared: "shared", sharedVsMachine: "shared",
      }));
      await put(root, `dotfiles/kit/settings.merge-machine.${format}`, serialize({
        machine: "present", sharedVsMachine: "machine",
      }));

      await run(root, "linux", homeRoot);

      const output = parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8"));
      assert.deepEqual({ ...output }, {
        home: "present",
        plain: "present",
        shared: "present",
        machine: "present",
        homeVsPlain: "plain",
        plainVsShared: "shared",
        sharedVsMachine: "machine",
      });
      assert.equal(existsSync(join(distRoot, `kit/settings.merge.${format}`)), false);
      assert.equal(existsSync(join(distRoot, `kit/settings.merge-machine.${format}`)), false);
    });

    it(`does not recognize ${format} .machine as a merge sidecar`, async () => {
      const oldSidecar = `kit/settings.machine.${format}`;
      const content = serialize({ mode: "old" });
      await put(root, `dotfiles/${oldSidecar}`, content);

      await run(root, "linux", homeRoot);

      assert.equal(existsSync(join(distRoot, `kit/settings.${format}`)), false);
      assert.equal(await readFile(join(distRoot, oldSidecar), "utf8"), content);
    });
  }

  it("ignores an old machine sidecar even when a shared merge sidecar exists", async () => {
    await put(root, "dotfiles/settings.merge.json", '{"mode":"shared"}');
    await put(root, "dotfiles/settings.machine.json", '{"mode":"old"}');

    await run(root, "linux", homeRoot);

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "settings.json"), "utf8")), {
      mode: "shared",
    });
    assert.equal(await readFile(join(distRoot, "settings.machine.json"), "utf8"), '{"mode":"old"}');
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

  it("loads external.data-machine.yaml instead of the old name and replaces the shared repo", async () => {
    const hook = await readFile(join(import.meta.dir, "../dotfiles/01-external.build.ts"), "utf8");
    await put(root, "dotfiles/01-external.build.ts", hook);
    await put(root, "dotfiles/external.data.yaml", `externalSkills:
  example/repo:
    destination: shared
    entries: [shared.txt]
`);
    await put(root, "dotfiles/external.data-machine.yaml", `externalSkills:
  example/repo:
    destination: machine
    entries: [machine.txt]
`);
    await put(root, "dotfiles/external.data.machine.yaml", `externalSkills:
  example/repo:
    destination: old
    entries: [old.txt]
`);
    await put(homeRoot, "mirrors/github.com/example/repo/shared.txt", "shared\n");
    await put(homeRoot, "mirrors/github.com/example/repo/machine.txt", "machine\n");
    await put(homeRoot, "mirrors/github.com/example/repo/old.txt", "old\n");
    await put(homeRoot, "mirrors/github.com/example/repo/.git/build-pull-time", `${Date.now()}\n`);
    await mkdir(join(root, "dotfiles-manager/node_modules"), { recursive: true });
    await symlink(
      join(import.meta.dir, "node_modules/yaml"),
      join(root, "dotfiles-manager/node_modules/yaml"),
      "dir",
    );

    // Keep HOME and PATH scoped to the subprocess: the real hook uses HOME for its mirror.
    const build = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { run } from ${JSON.stringify(join(import.meta.dir, "build.ts"))}; await run(${JSON.stringify(root)}, "linux", ${JSON.stringify(homeRoot)});`,
      ],
      {
        env: { ...process.env, HOME: homeRoot, PATH: "", BUILD_FORCE_PULL: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(await readFile(join(distRoot, "machine/machine.txt"), "utf8"), "machine\n");
    assert.equal(existsSync(join(distRoot, "shared/shared.txt")), false);
    assert.equal(existsSync(join(distRoot, "old/old.txt")), false);
  });

  it("appends the machine layer with the sample machine build hook", async () => {
    const hook = await readFile(
      join(import.meta.dir, "../dotfiles/.gitconfig.build-machine.ts.sample"),
      "utf-8",
    );
    await put(root, "dotfiles/.gitconfig.build-machine.ts", hook);
    await put(root, "dotfiles/.gitconfig", "[core]\neditor = code --wait\n");

    await run(root, "linux", homeRoot);

    assert.equal(
      await readFile(join(distRoot, ".gitconfig"), "utf8"),
      "[core]\neditor = code --wait\n\n[user]\nname = USERNAME\nemail = xxxxxxxxxx+USERNAME@users.noreply.github.com # https://github.com/settings/emails\n",
    );
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
  it("runs a TypeScript hook in its dist folder without requiring a shebang", async () => {
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `import { writeFile } from "node:fs/promises";\nexport default async function () {\n  await writeFile("hook-cwd.txt", JSON.stringify([process.cwd(), import.meta.dir]));\n}\n`,
    );
    await run(root, "linux", homeRoot);
    const hookCwd = JSON.parse(await readFile(join(distRoot, "vscode/hook-cwd.txt"), "utf8"));
    assert.deepEqual(hookCwd, [join(distRoot, "vscode"), join(distRoot, "vscode")]);
  });

  it("resolves root hook paths using file segment mapping without checking home files", async () => {
    await put(
      root,
      "dotfiles/paths.build.ts",
      [
        `import { writeFile } from "node:fs/promises";`,
        `export default async function (context: { resolvePaths(path: string): { distPath: string; homePath: string } }) {`,
        `  const paths = [`,
        `    "missing.txt",`,
        `    ".agents/config.exact/agents.yaml",`,
        `    "bin/tool.executable",`,
        `    "links/current.symlink",`,
        `  ];`,
        `  const resolvedPaths = paths.map((path) => context.resolvePaths(path));`,
        `  await writeFile("paths.json", JSON.stringify(resolvedPaths));`,
        `}`,
      ].join("\n"),
    );

    await run(root, "linux", relative(process.cwd(), homeRoot));

    const paths = JSON.parse(await readFile(join(distRoot, "paths.json"), "utf8"));
    assert.deepEqual(paths, [
      { distPath: join(distRoot, "missing.txt"), homePath: join(homeRoot, "missing.txt") },
      {
        distPath: join(distRoot, ".agents/config.exact/agents.yaml"),
        homePath: join(homeRoot, ".agents/config/agents.yaml"),
      },
      { distPath: join(distRoot, "bin/tool.executable"), homePath: join(homeRoot, "bin/tool") },
      {
        distPath: join(distRoot, "links/current.symlink"),
        homePath: join(homeRoot, "links/current"),
      },
    ]);
    assert.equal(existsSync(join(homeRoot, "missing.txt")), false);
  });

  it("resolves nested hook paths from their dist cwd, including dist siblings", async () => {
    await put(
      root,
      "dotfiles/vscode/paths.build.ts",
      [
        `import { writeFile } from "node:fs/promises";`,
        `export default async function (context: { resolvePaths(path: string): { distPath: string; homePath: string } }) {`,
        `  const paths = ["settings.json", "../sibling.txt"].map((path) => context.resolvePaths(path));`,
        `  await writeFile("paths.json", JSON.stringify(paths));`,
        `}`,
      ].join("\n"),
    );

    await run(root, "linux", homeRoot);

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "vscode/paths.json"), "utf8")), [
      {
        distPath: join(distRoot, "vscode/settings.json"),
        homePath: join(homeRoot, "vscode/settings.json"),
      },
      { distPath: join(distRoot, "sibling.txt"), homePath: join(homeRoot, "sibling.txt") },
    ]);
  });

  for (const path of ["/outside.txt", "../../outside.txt"]) {
    it(`rejects a build hook path outside dist: ${path}`, async () => {
      await put(
        root,
        "dotfiles/vscode/invalid.build.ts",
        [
          `export default function (context: { resolvePaths(path: string): { distPath: string; homePath: string } }) {`,
          `  context.resolvePaths(${JSON.stringify(path)});`,
          `}`,
        ].join("\n"),
      );

      await assert.rejects(
        run(root, "linux", homeRoot),
        /local build hook failed: vscode\/invalid\.build\.ts/,
      );
    });
  }

  it("runs a hook after the path-map standard hook moves its folder", async () => {
    const standardHook = await readFile(
      join(import.meta.dir, "../dotfiles/02-path-map.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/02-path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode | mapped-vscode | - | - |\n",
    );
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `import { writeFile } from "node:fs/promises";\nexport default async function () {\n  await writeFile("hook-ran.txt", process.cwd());\n}\n`
    );

    await run(root, "linux", homeRoot);

    assert.equal(
      await readFile(join(distRoot, "vscode/hook-ran.txt"), "utf8"),
      join(distRoot, "vscode"),
    );
    assert.ok(!existsSync(join(distRoot, "vscode/format-settings.build.ts")));
  });

  it("runs a collected formatter hook after its mapped folder is removed", async () => {
    const standardHook = await readFile(
      join(import.meta.dir, "../dotfiles/02-path-map.build.ts"),
      "utf-8",
    );
    const formatHook = await readFile(
      join(import.meta.dir, "../dotfiles/vscode/format-settings.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/02-path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode | - | - | - |\n",
    );
    await put(root, "dotfiles/vscode/format-settings.build.ts", formatHook);

    await run(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "vscode")), false);
  });

  it("rejects a machine hook with an unsupported extension during discovery", async () => {
    await put(root, "dotfiles/vscode/local.build-machine.sh", "echo hook output\n");
    await assert.rejects(
      run(root, "linux", homeRoot),
      /build hook has unsupported extension: vscode\/local\.build-machine\.sh/,
    );
  });

  it("rejects a hook with an unsupported extension", async () => {
    await put(distRoot, "vscode/format-settings.build.sh", "echo hook output\n");
    await assert.rejects(
      runHooks(
        [
          {
            absolutePath: join(distRoot, "vscode/format-settings.build.sh"),
            relativeParent: "vscode",
            name: "format-settings.build.sh",
            contents: "echo hook output\n",
          },
        ],
        distRoot,
        homeRoot,
      ),
      /build hook has unsupported extension: vscode\/format-settings\.build\.sh/,
    );
  });
});

async function runManager(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = `import { main } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))};
try { process.exitCode = await main([${JSON.stringify(command)}], ${JSON.stringify(root)}, ${JSON.stringify(homeRoot)}); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("manager CLI", () => {
  it("builds before applying and runs apply scripts", async () => {
    await put(root, "dotfiles/file.txt", "new\n");
    await put(root, "dotfiles/done.apply.ts", 'import { writeFile } from "node:fs/promises"; await writeFile("done.txt", "ran\\n");');
    await put(distRoot, "old.txt", "stale\n");

    const result = await runManager("apply");

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(homeRoot, "file.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(homeRoot, "done.txt"), "utf8"), "ran\n");
    assert.equal(existsSync(join(distRoot, "old.txt")), false);
  });

  it("builds before diff without writing to home or running apply scripts", async () => {
    await put(root, "dotfiles/file.txt", "new\n");
    await put(root, "dotfiles/done.apply.ts", 'import { writeFile } from "node:fs/promises"; await writeFile("done.txt", "ran");');
    await put(homeRoot, "file.txt", "old\n");

    const result = await runManager("diff");

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /file\.txt/);
    assert.equal(await readFile(join(distRoot, "file.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(homeRoot, "file.txt"), "utf8"), "old\n");
    assert.equal(existsSync(join(homeRoot, "done.txt")), false);
  });

  it("builds before listing managed paths without writing to home", async () => {
    await put(root, "dotfiles/new.txt", "content\n");

    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "new.txt\n");
    assert.equal(existsSync(join(homeRoot, "new.txt")), false);
  });

  it("stops after a failed build without applying", async () => {
    await put(root, "dotfiles/file.txt", "new\n");
    await put(root, "dotfiles/fail.build.ts", 'export default function () { throw new Error("failed"); }');

    const result = await runManager("apply");

    assert.equal(result.code, 1);
    assert.match(result.stderr, /local build hook failed: fail\.build\.ts/);
    assert.equal(existsSync(join(homeRoot, "file.txt")), false);
  });

  it("rejects unknown commands before rebuilding dist", async () => {
    await put(distRoot, "sentinel.txt", "keep\n");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "unknown"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    assert.equal(code, 1);
    assert.match(stderr, /usage: bun dotfiles-manager\/cli\.ts/);
    assert.equal(await readFile(join(distRoot, "sentinel.txt"), "utf8"), "keep\n");
  });
});
