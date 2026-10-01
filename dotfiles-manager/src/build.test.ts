import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { applyReplacements, applyReplaceSidecars, parseReplaceSidecar } from "./build-replace.ts";
import { runHooks } from "./build-hooks.ts";
import { main } from "./build.ts";

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

async function gitConfig(configPath: string, key: string, all = false): Promise<string> {
  const proc = Bun.spawn(
    ["git", "config", "--file", configPath, all ? "--get-all" : "--get", key],
    {
      env: {
        ...process.env,
        HOME: homeRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(homeRoot, "missing-global-config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  assert.equal(code, 0, stderr);
  return stdout.trimEnd();
}

const autoUpdateReplacements = [{ pattern: "(EnableAutoUpdates)=.*", replacement: "${1}=false" }];

async function runBuildInSubprocess(platform: "linux" | "windows" | "darwin"): Promise<string> {
  const build = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { main } from ${JSON.stringify(join(import.meta.dir, "build.ts"))}; await main(${JSON.stringify(root)}, ${JSON.stringify(platform)}, ${JSON.stringify(homeRoot)});`,
    ],
    {
      env: { ...process.env, HOME: homeRoot, PATH: "", BUILD_FORCE_PULL: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  assert.equal(exitCode, 0, stderr);
  return stderr;
}

describe("run", () => {
  it("rebuilds dist as a copy of dotfiles", async () => {
    await put(root, "dotfiles/plain.txt", "plain\n");
    await put(root, "dotfiles/nested/dir/file.txt", "nested\n");
    await put(distRoot, "stale-from-previous-build.txt", "stale\n");

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "plain.txt"), "utf8"), "plain\n");
    assert.equal(await readFile(join(distRoot, "nested/dir/file.txt"), "utf8"), "nested\n");
    assert.equal(existsSync(join(distRoot, "stale-from-previous-build.txt")), false);
  });

  it("removes glob and exact targets and moves remaining entries from the selected column", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| .agents | - |  |  |\n| config | - |  |  |\n| **/*.sample | - |  |  |\n| legacy.txt | mapped.txt | - | - |\n",
    );
    await put(root, "dotfiles/.agents/keep.yaml", "removed\n");
    await put(root, "dotfiles/config.exact/agents.yaml", "removed\n");
    await put(root, "dotfiles/nested/config.sample", "removed\n");
    await put(root, "dotfiles/legacy.txt", "mapped\n");

    await main(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, ".agents")), false);
    assert.equal(existsSync(join(distRoot, "config.exact")), false);
    assert.equal(existsSync(join(distRoot, "nested/config.sample")), false);
    assert.equal(existsSync(join(distRoot, "legacy.txt")), false);
    assert.equal(await readFile(join(distRoot, "mapped.txt"), "utf8"), "mapped\n");
    assert.equal(existsSync(join(distRoot, "remap.data.md")), true);
  });

  it("merges a sidecar at its mapped Windows destination", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode |  | AppData/Roaming/Code/User | - |\n",
    );
    await put(root, "dotfiles/vscode/settings.merge.json", '{"new":true}');
    await put(homeRoot, "AppData/Roaming/Code/User/settings.json", '{"old":true}');

    await main(root, "windows", homeRoot);

    assert.deepEqual(
      JSON.parse(await readFile(join(distRoot, "AppData/Roaming/Code/User/settings.json"), "utf8")),
      { old: true, new: true },
    );
    assert.equal(existsSync(join(distRoot, "vscode")), false);
  });

  it("skips node_modules directories without excluding files of the same name", async () => {
    await put(root, "dotfiles/node_modules/pkg/index.js", "excluded\n");
    await put(root, "dotfiles/nested/node_modules/pkg/index.js", "excluded\n");
    await put(root, "dotfiles/other/node_modules", "kept\n");

    await main(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "node_modules")), false);
    assert.equal(existsSync(join(distRoot, "nested/node_modules")), false);
    assert.equal(await readFile(join(distRoot, "other/node_modules"), "utf8"), "kept\n");
  });

  it("skips entries ending in .ignore", async () => {
    await put(root, "dotfiles/plain.txt", "plain\n");
    await put(root, "dotfiles/zed.ignore/settings.json", "archived\n");
    await put(root, "dotfiles/nested/skip.ignore/inside.txt", "archived\n");
    await put(root, "dotfiles/note.ignore", "archived\n");
    await put(root, "dotfiles/note.ignore.txt", "kept\n");

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "plain.txt"), "utf8"), "plain\n");
    assert.equal(existsSync(join(distRoot, "zed.ignore")), false);
    assert.equal(existsSync(join(distRoot, "nested/skip.ignore")), false);
    assert.equal(existsSync(join(distRoot, "note.ignore")), false);
    assert.equal(await readFile(join(distRoot, "note.ignore.txt"), "utf8"), "kept\n");
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

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "log.txt"), "utf8"), "early\nlate\n");
    assert.equal(await readFile(join(distRoot, "sub/marker.txt"), "utf8"), "ran\n");
    assert.equal(existsSync(join(distRoot, "marker.txt")), false);
    assert.equal(
      await readFile(orderFile, "utf8"),
      "root-a\nroot-z\nroot-astral\nroot-bmp\na-child\na-parent\na-grandchild\na-before\nastral-child\nbmp-child\n",
    );
  });

  it("does not execute hooks generated after the initial detection", async () => {
    await put(
      root,
      "dotfiles/01-generate.build.ts",
      `import { writeFile } from "node:fs/promises";\nexport default async function () {\n  await writeFile("02-late.build.ts", 'export default () => Bun.write("ran.txt", "ran");');\n}`,
    );

    await main(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "02-late.build.ts")), true);
    assert.equal(existsSync(join(distRoot, "ran.txt")), false);
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

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "nested/order.txt"), "utf8"), "machine\nshared\n");
    assert.equal(existsSync(join(distRoot, "order.txt")), false);
  });

  it("skips a collected hook after an earlier hook removes it", async () => {
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

    await main(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "doomed/keep.txt")), false);
    assert.equal(await readFile(orderFile, "utf8"), "prune\n");
  });

  it("keeps ancestors and skips a nested hook whose folder an earlier hook removed", async () => {
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

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "doomed/keep.txt"), "utf8"), "keep\n");
    assert.equal(existsSync(join(distRoot, "doomed/sub")), false);
    assert.equal(existsSync(orderFile), false);
  });

  it("fails when a hook exits non-zero", async () => {
    await put(
      root,
      "dotfiles/fail.build.ts",
      `#!/usr/bin/env bun
export default function () {
  throw new Error("boom");
}
`,
    );

    await assert.rejects(main(root, "linux", homeRoot), /local build hook failed: fail\.build\.ts/);
  });

  it("preserves the hook's final formatting of completed merge layers", async () => {
    await put(homeRoot, "settings.json", '{"home":true,"value":"home"}');
    await put(root, "dotfiles/settings.json", '{"plain":true,"value":"plain"}');
    await put(root, "dotfiles/settings.merge.json", '{"shared":true,"value":"shared"}');
    await put(root, "dotfiles/settings.merge-machine.json", '{"machine":true,"value":"machine"}');
    await put(
      root,
      "dotfiles/format.build.ts",
      `import assert from "node:assert/strict";
import { existsSync } from "node:fs";
export default async function () {
  assert.equal(existsSync("settings.merge.json"), false);
  assert.equal(existsSync("settings.merge-machine.json"), false);
  const completed = await Bun.file("settings.json").json();
  await Bun.write("settings.json", JSON.stringify(completed));
}`,
    );

    await main(root, "linux", homeRoot);

    assert.equal(
      await readFile(join(distRoot, "settings.json"), "utf8"),
      '{"home":true,"value":"machine","plain":true,"shared":true,"machine":true}',
    );
    assert.equal(
      await readFile(join(homeRoot, "settings.json"), "utf8"),
      '{"home":true,"value":"home"}',
    );
  });

  it("preserves the hook's final formatting of completed replacements", async () => {
    const homeContent = " mode = home \n keep = yes \n";
    await put(homeRoot, "app.conf", homeContent);
    await put(root, "dotfiles/app.conf", "plain content must not win\n");
    await put(
      root,
      "dotfiles/app.conf.replace.yaml",
      "replacements:\n  - pattern: home\n    replacement: replaced\n",
    );
    await put(
      root,
      "dotfiles/format.build.ts",
      `import assert from "node:assert/strict";
import { existsSync } from "node:fs";
export default async function () {
  assert.equal(existsSync("app.conf.replace.yaml"), false);
  const completed = await Bun.file("app.conf").text();
  await Bun.write("app.conf", completed.trim().replaceAll(" ", ""));
}`,
    );

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "app.conf"), "utf8"), "mode=replaced\nkeep=yes");
    assert.equal(await readFile(join(homeRoot, "app.conf"), "utf8"), homeContent);
  });

  for (const { phase, path, content, error, completedPhases } of [
    {
      phase: "copy-time path map",
      path: "remap.data.md",
      content: "invalid table",
      error: /remap\.data\.md must have columns:/,
      completedPhases: [],
    },
    {
      phase: "second path map",
      path: "bad-map.txt",
      content: "invalid table",
      error: /remap\.data\.md must have columns:/,
      completedPhases: ["rebuild dist"],
    },
    {
      phase: "externals",
      path: "external.data.yaml",
      content: "repos: []",
      error: /external\.data\.yaml must have a repos mapping:/,
      completedPhases: ["rebuild dist", "path map"],
    },
    {
      phase: "merge",
      path: "settings.merge.json",
      content: "{ invalid json",
      error: /merge target failed: settings\.json:/,
      completedPhases: ["rebuild dist", "path map", "externals"],
    },
    {
      phase: "replace",
      path: "app.conf.replace.yaml",
      content: "replacements: {}",
      error: /replace target failed: app\.conf:/,
      completedPhases: ["rebuild dist", "path map", "externals", "merge"],
    },
  ]) {
    it(`does not run hooks or later phases after ${phase} fails`, async () => {
      await put(root, `dotfiles/${path}`, content);
      if (phase === "second path map") {
        await put(
          root,
          "dotfiles/remap.data.md",
          "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| bad-map.txt | nested/remap.data.md |  |  |\n",
        );
      }
      await put(
        root,
        "dotfiles/marker.build.ts",
        'export default () => Bun.write("ran.txt", "ran");',
      );
      const phases: string[] = [];
      const hookEvents: string[] = [];

      await assert.rejects(
        main(
          root,
          "linux",
          homeRoot,
          (path, status) => hookEvents.push(`${path}:${status}`),
          (phase) => phases.push(phase),
        ),
        error,
      );

      assert.deepEqual(phases, completedPhases);
      assert.deepEqual(hookEvents, []);
      assert.equal(existsSync(join(distRoot, "ran.txt")), false);
    });
  }

  for (const generatesMap of [false, true]) {
    it(`does not remap hook-generated entries with a ${generatesMap ? "hook-generated" : "source"} map`, async () => {
      const map =
        "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| generated.txt | moved.txt |  |  |\n";
      if (!generatesMap) await put(root, "dotfiles/remap.data.md", map);
      await put(
        root,
        "dotfiles/generate.build.ts",
        `export default async function () {
  await Bun.write("generated.txt", "generated");
  ${generatesMap ? `await Bun.write("remap.data.md", ${JSON.stringify(map)});` : ""}
}`,
      );

      await main(root, "linux", homeRoot);

      assert.equal(await readFile(join(distRoot, "generated.txt"), "utf8"), "generated");
      assert.equal(await readFile(join(distRoot, "remap.data.md"), "utf8"), map);
      assert.equal(existsSync(join(distRoot, "moved.txt")), false);
    });
  }

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

    await main(root, "linux", homeRoot);

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
        Object.entries(values)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
          .join(""),
      parse: parseYaml,
    },
    {
      format: "toml",
      serialize: (values: Record<string, string>) =>
        Object.entries(values)
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`)
          .join(""),
      parse: parseToml,
    },
  ]) {
    it(`composes a standalone ${format} machine merge layer over home`, async () => {
      await put(homeRoot, `kit/settings.${format}`, serialize({ mode: "home" }));
      await put(
        root,
        `dotfiles/kit/settings.merge-machine.${format}`,
        serialize({ mode: "machine" }),
      );

      await main(root, "linux", homeRoot);

      assert.equal(
        parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8")).mode,
        "machine",
      );
      assert.equal(existsSync(join(distRoot, `kit/settings.merge-machine.${format}`)), false);
    });

    it(`applies ${format} home, plain base, shared merge, then machine merge`, async () => {
      await put(
        homeRoot,
        `kit/settings.${format}`,
        serialize({ home: "present", homeVsPlain: "home" }),
      );
      await put(
        root,
        `dotfiles/kit/settings.${format}`,
        serialize({
          plain: "present",
          homeVsPlain: "plain",
          plainVsShared: "plain",
        }),
      );
      await put(
        root,
        `dotfiles/kit/settings.merge.${format}`,
        serialize({
          shared: "present",
          plainVsShared: "shared",
          sharedVsMachine: "shared",
        }),
      );
      await put(
        root,
        `dotfiles/kit/settings.merge-machine.${format}`,
        serialize({
          machine: "present",
          sharedVsMachine: "machine",
        }),
      );

      await main(root, "linux", homeRoot);

      const output = parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8"));
      assert.deepEqual(
        { ...output },
        {
          home: "present",
          plain: "present",
          shared: "present",
          machine: "present",
          homeVsPlain: "plain",
          plainVsShared: "shared",
          sharedVsMachine: "machine",
        },
      );
      assert.equal(existsSync(join(distRoot, `kit/settings.merge.${format}`)), false);
      assert.equal(existsSync(join(distRoot, `kit/settings.merge-machine.${format}`)), false);
    });

    it(`does not recognize ${format} .machine as a merge sidecar`, async () => {
      const oldSidecar = `kit/settings.machine.${format}`;
      const content = serialize({ mode: "old" });
      await put(root, `dotfiles/${oldSidecar}`, content);

      await main(root, "linux", homeRoot);

      assert.equal(existsSync(join(distRoot, `kit/settings.${format}`)), false);
      assert.equal(await readFile(join(distRoot, oldSidecar), "utf8"), content);
    });
  }

  it("writes an empty TOML merge result with one trailing newline", async () => {
    await put(root, "dotfiles/empty.merge.toml", "");

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "empty.toml"), "utf8"), "\n");
    assert.equal(existsSync(join(distRoot, "empty.merge.toml")), false);
  });

  it("writes a nonempty TOML merge result with one trailing newline", async () => {
    await put(root, "dotfiles/settings.toml", 'mode = "plain"\n');
    await put(root, "dotfiles/settings.merge.toml", 'mode = "merged"\n');

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "settings.toml"), "utf8"), 'mode = "merged"\n');
    assert.equal(existsSync(join(distRoot, "settings.merge.toml")), false);
  });

  it("reports the home-relative target for an invalid merge operation", async () => {
    await put(root, "dotfiles/config.exact/agents.merge.json", '{"missing.$append": [1]}');

    await assert.rejects(
      main(root, "linux", homeRoot),
      /merge target failed: config\/agents\.json: merge append path not found: missing/,
    );
  });

  it("reports the home-relative target for a malformed merge layer", async () => {
    await put(root, "dotfiles/config.exact/agents.merge.json", "{ invalid json");

    await assert.rejects(
      main(root, "linux", homeRoot),
      /merge target failed: config\/agents\.json:/,
    );
  });

  it("ignores an old machine sidecar even when a shared merge sidecar exists", async () => {
    await put(root, "dotfiles/settings.merge.json", '{"mode":"shared"}');
    await put(root, "dotfiles/settings.machine.json", '{"mode":"old"}');

    await main(root, "linux", homeRoot);

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

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "app.conf"), "utf8"), "EnableAutoUpdates=false\n");
    assert.equal(existsSync(join(distRoot, "app.conf.replace.yaml")), false);
  });
  it("ignores external machine overlays in the root and arbitrary nested folders", () => {
    const repoRoot = join(import.meta.dir, "../..");
    for (const path of [
      "dotfiles/external.data-machine.yaml",
      "dotfiles/rime/external.data-machine.yaml",
      "dotfiles/.agents/skills.exact/external.data-machine.yaml",
      "dotfiles/other/nested/external.data-machine.yaml",
    ]) {
      const result = Bun.spawnSync([
        "git",
        "-C",
        repoRoot,
        "check-ignore",
        "--no-index",
        "-q",
        path,
      ]);
      assert.equal(result.exitCode, 0, `${path}: ${result.stderr.toString()}`);
    }
    const shared = Bun.spawnSync([
      "git",
      "-C",
      repoRoot,
      "check-ignore",
      "--no-index",
      "-q",
      "dotfiles/rime/external.data.yaml",
    ]);
    assert.equal(shared.exitCode, 1);
  });

  it("prefers external.data-machine.yaml and ignores the obsolete machine filename", async () => {
    await put(
      root,
      "dotfiles/external.data.yaml",
      `repos:
  example/repo:
    destination: shared
    entries: [shared.txt]
`,
    );
    await put(
      root,
      "dotfiles/external.data-machine.yaml",
      `repos:
  example/repo:
    destination: machine
    entries: [machine.txt]
`,
    );
    await put(
      root,
      "dotfiles/external.data.machine.yaml",
      `repos:
  example/repo:
    destination: old
    entries: [old.txt]
`,
    );
    await put(homeRoot, "mirrors/github.com/example/repo/shared.txt", "shared\n");
    await put(homeRoot, "mirrors/github.com/example/repo/machine.txt", "machine\n");
    await put(homeRoot, "mirrors/github.com/example/repo/old.txt", "old\n");
    await put(homeRoot, "mirrors/github.com/example/repo/.git/build-pull-time", `${Date.now()}\n`);

    await runBuildInSubprocess("linux");

    assert.equal(await readFile(join(distRoot, "machine/machine.txt"), "utf8"), "machine\n");
    assert.equal(existsSync(join(distRoot, "shared/shared.txt")), false);
    assert.equal(existsSync(join(distRoot, "old/old.txt")), false);
  });

  it("applies parent and child remaps before writing nested external destinations", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| parent | relocated |  |  |\n",
    );
    await put(
      root,
      "dotfiles/parent/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| marker.txt | child/marker.txt |  |  |\n| downloads/payload.txt | remapped-payload.txt |  |  |\n",
    );
    await put(root, "dotfiles/parent/marker.txt", "marker\n");
    await put(
      root,
      "dotfiles/parent/external.data.yaml",
      `repos:
  example/nested:
    destination: downloads
    entries: [payload.txt]
`,
    );
    await put(homeRoot, "mirrors/github.com/example/nested/payload.txt", "external\n");
    await put(
      homeRoot,
      "mirrors/github.com/example/nested/.git/build-pull-time",
      `${Date.now()}\n`,
    );

    await runBuildInSubprocess("linux");

    assert.equal(await readFile(join(distRoot, "relocated/child/marker.txt"), "utf8"), "marker\n");
    assert.equal(
      await readFile(join(distRoot, "relocated/downloads/payload.txt"), "utf8"),
      "external\n",
    );
    assert.equal(existsSync(join(distRoot, "relocated/remapped-payload.txt")), false);
    assert.equal(existsSync(join(distRoot, "parent")), false);
  });

  it("leaves hook-generated external, merge, and replace sidecars unprocessed after remapping", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| nested | moved |  |  |\n",
    );
    await put(
      root,
      "dotfiles/nested/generate.build.ts",
      `export default async function () {
  await Bun.write("external.data.yaml", "repos:\\n  example/generated:\\n    destination: output\\n    entries: [file.txt]\\n");
  await Bun.write("settings.merge.json", '{"late":true}');
  await Bun.write("app.conf.replace.yaml", 'replacements:\\n  - pattern: home\\n    replacement: late\\n');
}`,
    );
    await put(homeRoot, "moved/settings.json", '{"home":true}');
    await put(root, "dotfiles/nested/settings.merge.json", '{"early":true}');
    await put(homeRoot, "moved/app.conf", "mode=home\n");
    await put(
      root,
      "dotfiles/nested/app.conf.replace.yaml",
      "replacements:\n  - pattern: home\n    replacement: early\n",
    );
    await put(homeRoot, "mirrors/github.com/example/generated/file.txt", "generated\n");
    await put(
      homeRoot,
      "mirrors/github.com/example/generated/.git/build-pull-time",
      `${Date.now()}\n`,
    );

    await runBuildInSubprocess("linux");

    assert.equal(existsSync(join(distRoot, "moved/output/file.txt")), false);
    assert.equal(
      await readFile(join(distRoot, "moved/external.data.yaml"), "utf8"),
      "repos:\n  example/generated:\n    destination: output\n    entries: [file.txt]\n",
    );
    assert.equal(
      await readFile(join(distRoot, "moved/settings.merge.json"), "utf8"),
      '{"late":true}',
    );
    assert.equal(
      await readFile(join(distRoot, "moved/settings.json"), "utf8"),
      '{\n  "home": true,\n  "early": true\n}\n',
    );
    assert.equal(
      await readFile(join(distRoot, "moved/app.conf.replace.yaml"), "utf8"),
      "replacements:\n  - pattern: home\n    replacement: late\n",
    );
    assert.equal(await readFile(join(distRoot, "moved/app.conf"), "utf8"), "mode=early\n");
    assert.equal(existsSync(join(distRoot, "nested")), false);
  });

  it("executes only source hook snapshots despite external additions and overwrites", async () => {
    const sourceHook = `import { appendFile } from "node:fs/promises";
export default async function () {
  const payload = await Bun.file("payload.txt").text();
  await appendFile("snapshot.txt", "source:" + payload);
  await Bun.write("settings.json", JSON.stringify(await Bun.file("settings.json").json()));
  await Bun.write("app.conf", (await Bun.file("app.conf").text()).trim());
}`;
    const replacementHook = 'export default () => Bun.write("overwritten-ran.txt", "external");';
    await put(root, "dotfiles/source.build.ts", sourceHook);
    await put(
      root,
      "dotfiles/external.data.yaml",
      "repos:\n  example/hooks:\n    destination: .\n    entries: [source.build.ts, added.build.ts, payload.txt, settings.merge.json, app.conf.replace.yaml]\n",
    );
    await put(homeRoot, "mirrors/github.com/example/hooks/source.build.ts", replacementHook);
    await put(
      homeRoot,
      "mirrors/github.com/example/hooks/added.build.ts",
      'export default () => Bun.write("added-ran.txt", "external");',
    );
    await put(homeRoot, "mirrors/github.com/example/hooks/payload.txt", "external payload\n");
    await put(
      homeRoot,
      "mirrors/github.com/example/hooks/settings.merge.json",
      '{"external":true}',
    );
    await put(
      homeRoot,
      "mirrors/github.com/example/hooks/app.conf.replace.yaml",
      "replacements:\n  - pattern: home\n    replacement: external\n",
    );
    await put(homeRoot, "settings.json", '{"home":true}');
    await put(homeRoot, "app.conf", "mode=home\n");
    await put(homeRoot, "mirrors/github.com/example/hooks/.git/build-pull-time", `${Date.now()}\n`);

    await runBuildInSubprocess("linux");

    assert.equal(await readFile(join(distRoot, "source.build.ts"), "utf8"), replacementHook);
    assert.equal(existsSync(join(distRoot, "added.build.ts")), true);
    assert.equal(
      await readFile(join(distRoot, "snapshot.txt"), "utf8"),
      "source:external payload\n",
    );
    assert.equal(existsSync(join(distRoot, "overwritten-ran.txt")), false);
    assert.equal(existsSync(join(distRoot, "added-ran.txt")), false);
    assert.equal(
      await readFile(join(distRoot, "settings.json"), "utf8"),
      '{"home":true,"external":true}',
    );
    assert.equal(await readFile(join(distRoot, "app.conf"), "utf8"), "mode=external");
    assert.equal(existsSync(join(distRoot, "settings.merge.json")), false);
    assert.equal(existsSync(join(distRoot, "app.conf.replace.yaml")), false);
  });

  it("places edited directory entries under a nested destination", async () => {
    await put(
      root,
      "dotfiles/parent/external.data.yaml",
      `repos:
  example/edited:
    destination: out/nested
    entries: [skills/demo]
    edit:
      skills/demo/SKILL.md.$append: appended
`,
    );
    await put(homeRoot, "mirrors/github.com/example/edited/skills/demo/SKILL.md", "demo\n");
    await put(
      homeRoot,
      "mirrors/github.com/example/edited/.git/build-pull-time",
      `${Date.now()}\n`,
    );

    await runBuildInSubprocess("linux");

    assert.equal(
      await readFile(join(distRoot, "parent/out/nested/demo/SKILL.md"), "utf8"),
      "demo\nappended",
    );
  });

  it("fetches skills on linux and skips them when .agents is removed", async () => {
    await put(
      root,
      "dotfiles/.agents/skills.exact/external.data.yaml",
      `repos:
  example/skill:
    destination: .
    entries: [skills/demo]
`,
    );
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| .agents |  | - | - |\n",
    );
    await put(homeRoot, "mirrors/github.com/example/skill/skills/demo/SKILL.md", "demo\n");
    await put(homeRoot, "mirrors/github.com/example/skill/.git/build-pull-time", `${Date.now()}\n`);

    for (const platform of ["linux", "windows", "darwin"] as const) {
      await runBuildInSubprocess(platform);
      if (platform === "linux") {
        assert.equal(
          await readFile(join(distRoot, ".agents/skills.exact/demo/SKILL.md"), "utf8"),
          "demo\n",
        );
      } else {
        assert.equal(existsSync(join(distRoot, ".agents")), false);
      }
    }
  });

  // win32 path.relative joins segments with "\", which failed to match the
  // "/"-separated remap keys. A file name containing a literal "\" reproduces
  // that shape on posix; such a name is illegal on Windows, so skip there.
  it.skipIf(process.platform === "win32")(
    "matches separator-bearing remap keys regardless of platform path separators",
    async () => {
      const scriptName = "vscode\\sync_vscode_extensions.apply.ts";
      await put(
        root,
        "dotfiles/remap.data.md",
        "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode/sync_vscode_extensions.apply.ts |  | - |  |\n",
      );
      await put(root, `dotfiles/${scriptName}`, "await main();\n");

      await runBuildInSubprocess("linux");
      assert.equal(existsSync(join(distRoot, scriptName)), true);

      await runBuildInSubprocess("windows");
      assert.equal(existsSync(join(distRoot, scriptName)), false);
    },
  );

  it("moves external Rime entries on linux and windows and skips them on macOS", async () => {
    await put(
      root,
      "dotfiles/rime/external.data.yaml",
      `repos:
  rimeinn/rime-kagiroi:
    destination: .
    entries: [dictionary.txt]
`,
    );
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| rime | .local/share/fcitx5/rime | AppData/Roaming/Rime | - |\n",
    );
    await put(homeRoot, "mirrors/github.com/rimeinn/rime-kagiroi/dictionary.txt", "rime\n");
    await put(
      homeRoot,
      "mirrors/github.com/rimeinn/rime-kagiroi/.git/build-pull-time",
      `${Date.now()}\n`,
    );

    for (const [platform, destination] of [
      ["linux", ".local/share/fcitx5/rime"],
      ["windows", "AppData/Roaming/Rime"],
    ] as const) {
      await runBuildInSubprocess(platform);
      assert.equal(await readFile(join(distRoot, destination, "dictionary.txt"), "utf8"), "rime\n");
    }

    await runBuildInSubprocess("darwin");
    assert.equal(existsSync(join(distRoot, ".local/share/fcitx5/rime")), false);
    assert.equal(existsSync(join(distRoot, "AppData/Roaming/Rime")), false);
    assert.equal(existsSync(join(distRoot, "rime")), false);
  });

  it("appends real GitAlias collisions while preserving hand-written alias values on Linux", async () => {
    const sourceConfigPath = join(import.meta.dir, "../../dotfiles/.gitconfig");
    const sourceConfig = await readFile(sourceConfigPath, "utf8");
    const hook = await readFile(
      join(import.meta.dir, "../../dotfiles/.gitconfig.build.ts"),
      "utf8",
    );
    await put(root, "dotfiles/.gitconfig.build.ts", hook);
    await put(root, "dotfiles/.gitconfig", sourceConfig);
    const upstreamAliases = `[alias]
s = status
ss = status --short
init-empty = "!f() { git init && git commit --allow-empty --allow-empty-message --message ''; }; f"
clone-lean = clone --depth 1 --filter=combine:blob:none+tree:0 --no-checkout
co = checkout
`;
    await put(homeRoot, "mirrors/github.com/GitAlias/gitalias/gitalias.txt", upstreamAliases);
    await put(
      homeRoot,
      "mirrors/github.com/GitAlias/gitalias/.git/build-pull-time",
      `${Date.now()}\n`,
    );

    await runBuildInSubprocess("linux");

    const outputPath = join(distRoot, ".gitconfig");
    const output = await readFile(outputPath, "utf8");
    assert.ok(output.startsWith(sourceConfig + upstreamAliases));
    assert.equal(existsSync(join(distRoot, ".gitconfig.alias")), false);
    assert.equal(await gitConfig(outputPath, "include.path", true), ".gitconfig.local");
    for (const key of ["s", "ss", "init-empty", "clone-lean"]) {
      assert.equal(
        await gitConfig(outputPath, `alias.${key}`),
        await gitConfig(sourceConfigPath, `alias.${key}`),
        key,
      );
    }
    assert.equal(await gitConfig(outputPath, "alias.co"), "checkout");
  });

  it("appends gitalias on Windows and leaves the real config unchanged on macOS", async () => {
    const hook = await readFile(
      join(import.meta.dir, "../../dotfiles/.gitconfig.build.ts"),
      "utf8",
    );
    const hookPath = join(root, "dotfiles/.gitconfig.build.ts");
    const sourceConfig = await readFile(join(import.meta.dir, "../../dotfiles/.gitconfig"), "utf8");
    await put(root, "dotfiles/.gitconfig.build.ts", hook);
    await put(
      homeRoot,
      "mirrors/github.com/GitAlias/gitalias/gitalias.txt",
      "[alias]\ns = status\nco = checkout\n",
    );
    await put(
      homeRoot,
      "mirrors/github.com/GitAlias/gitalias/.git/build-pull-time",
      `${Date.now()}\n`,
    );

    for (const platform of ["win32", "darwin"] as const) {
      await put(root, "dotfiles/.gitconfig", sourceConfig);
      const proc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import build from ${JSON.stringify(hookPath)}; Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} }); await build();`,
        ],
        {
          env: { ...process.env, HOME: homeRoot, PATH: "", BUILD_FORCE_PULL: "0" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      assert.equal(exitCode, 0, stderr);
      const outputPath = join(root, "dotfiles/.gitconfig");
      const output = await readFile(outputPath, "utf8");
      if (platform === "darwin") {
        assert.equal(output, sourceConfig);
      } else {
        assert.ok(output.startsWith(sourceConfig + "[alias]\ns = status\nco = checkout\n"));
        assert.equal(await gitConfig(outputPath, "alias.s"), "switch");
        assert.equal(await gitConfig(outputPath, "alias.co"), "checkout");
      }
    }
  });

  for (const { name, ageHours, force, fail, pulls } of [
    { name: "fresh TTL", ageHours: 0, force: false, fail: false, pulls: 0 },
    { name: "expired TTL", ageHours: 7, force: false, fail: false, pulls: 1 },
    { name: "forced pull", ageHours: 0, force: true, fail: false, pulls: 1 },
    { name: "failed pull", ageHours: 7, force: false, fail: true, pulls: 1 },
  ]) {
    it(`uses the isolated GitAlias mirror with ${name}`, async () => {
      const hook = await readFile(
        join(import.meta.dir, "../../dotfiles/.gitconfig.build.ts"),
        "utf8",
      );
      await put(root, "dotfiles/.gitconfig.build.ts", hook);
      await put(root, "dotfiles/.gitconfig", "[core]\neditor = code\n");
      await put(
        homeRoot,
        "mirrors/github.com/GitAlias/gitalias/gitalias.txt",
        "[alias]\nco = checkout\n",
      );
      const lastPull = Date.now() - ageHours * 60 * 60 * 1000;
      const pullTimePath = "mirrors/github.com/GitAlias/gitalias/.git/build-pull-time";
      await put(homeRoot, pullTimePath, `${lastPull}\n`);
      const gitCalls = join(root, "git-calls.txt");
      const fakeGit = join(root, "bin/git");
      await put(
        root,
        "bin/git",
        `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(gitCalls)}, process.argv.slice(2).join(" ") + "\\n");\nif (process.env.TEST_GIT_FAIL === "1") { console.error("offline"); process.exit(1); }\n`,
      );
      await chmod(fakeGit, 0o755);

      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import build from ${JSON.stringify(join(root, "dotfiles/.gitconfig.build.ts"))}; await build();`,
        ],
        {
          env: {
            ...process.env,
            HOME: homeRoot,
            PATH: join(root, "bin"),
            BUILD_FORCE_PULL: force ? "1" : "0",
            TEST_GIT_FAIL: fail ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      assert.equal(code, 0, stderr);
      assert.equal(
        await readFile(join(root, "dotfiles/.gitconfig"), "utf8"),
        "[core]\neditor = code\n[alias]\nco = checkout\n",
      );
      const calls = existsSync(gitCalls) ? (await readFile(gitCalls, "utf8")).trimEnd() : "";
      assert.equal(
        calls,
        pulls
          ? `-C ${join(homeRoot, "mirrors/github.com/GitAlias/gitalias")} pull --ff-only --quiet`
          : "",
      );
      if (fail) assert.match(stderr, /warning: git pull failed.*offline/);
      else assert.equal(stderr, "");
      const recordedPull = Number((await readFile(join(homeRoot, pullTimePath), "utf8")).trim());
      if (pulls === 1 && !fail) assert.ok(recordedPull > lastPull);
      else assert.equal(recordedPull, lastPull);
    });
  }

  it("appends the machine layer with the sample machine build hook", async () => {
    const hook = await readFile(
      join(import.meta.dir, "../../dotfiles/.gitconfig.build-machine.ts.sample"),
      "utf-8",
    );
    await put(root, "dotfiles/.gitconfig.build-machine.ts", hook);
    await put(root, "dotfiles/.gitconfig", "[core]\neditor = code --wait\n");

    await main(root, "linux", homeRoot);

    assert.equal(
      await readFile(join(distRoot, ".gitconfig"), "utf8"),
      "[core]\neditor = code --wait\n\n[user]\nname = USERNAME\nemail = xxxxxxxxxx+USERNAME@users.noreply.github.com # https://github.com/settings/emails\n",
    );
  });
});

describe("applyReplaceSidecars", () => {
  it("renders the rendered file from home's current content and removes the sidecar", async () => {
    await put(homeRoot, "obs/config.ini", "EnableAutoUpdates=true\nOther=keep\n");
    await put(
      distRoot,
      "obs/config.ini.replace.yaml",
      `
replacements:
  - pattern: "(EnableAutoUpdates)=.*"
    replacement: "\${1}=false"
`,
    );

    await applyReplaceSidecars(distRoot, homeRoot);

    assert.equal(
      await readFile(join(distRoot, "obs/config.ini"), "utf8"),
      "EnableAutoUpdates=false\nOther=keep\n",
    );
    assert.equal(existsSync(join(distRoot, "obs/config.ini.replace.yaml")), false);
  });

  it("uses an empty input when home has no matching file", async () => {
    await put(
      distRoot,
      "generated.conf.replace.yaml",
      `
replacements:
  - pattern: "^"
    replacement: "seeded"
`,
    );

    await applyReplaceSidecars(distRoot, homeRoot);

    assert.equal(await readFile(join(distRoot, "generated.conf"), "utf8"), "seeded");
  });

  it("resolves the rendered home path verbatim for plain names", async () => {
    await put(homeRoot, "dot_config/exact_kit/settings.conf", "mode=demo\n");
    await put(
      distRoot,
      "dot_config/exact_kit/settings.conf.replace.yaml",
      `
replacements:
  - pattern: "mode=demo"
    replacement: "mode=live"
`,
    );

    await applyReplaceSidecars(distRoot, homeRoot);

    assert.equal(
      await readFile(join(distRoot, "dot_config/exact_kit/settings.conf"), "utf8"),
      "mode=live\n",
    );
  });

  it("reports the home-relative target for an invalid replacement", async () => {
    await put(distRoot, "config.exact/bad.conf.replace.yaml", "replacements: {}");

    await assert.rejects(
      applyReplaceSidecars(distRoot, homeRoot),
      /replace target failed: config\/bad\.conf: replace sidecar must have a replacements array: config\.exact\/bad\.conf\.replace\.yaml/,
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
    assert.equal(
      applyReplacements("EnableAutoUpdates=true\n", autoUpdateReplacements),
      "EnableAutoUpdates=false\n",
    );
  });
});

describe("local build hooks", () => {
  it("runs a TypeScript hook in its dist folder without requiring a shebang", async () => {
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `import { writeFile } from "node:fs/promises";\nexport default async function () {\n  await writeFile("hook-cwd.txt", JSON.stringify([process.cwd(), import.meta.dir]));\n}\n`,
    );
    await main(root, "linux", homeRoot);
    const hookCwd = JSON.parse(await readFile(join(distRoot, "vscode/hook-cwd.txt"), "utf8"));
    assert.deepEqual(hookCwd, [join(distRoot, "vscode"), join(distRoot, "vscode")]);
  });

  it("resolves absent root hook files and maps exact, executable, and symlink names", async () => {
    await put(
      root,
      "dotfiles/paths.build.ts",
      [
        `import { writeFile } from "node:fs/promises";`,
        `export default async function (context: { resolvePaths(path: string): { distPath: string; homePath: string } }) {`,
        `  const paths = ["missing.txt", ".agents/config.exact/agents.yaml", "bin/tool.executable", "links/current.symlink"];`,
        `  await writeFile("paths.json", JSON.stringify(paths.map((path) => context.resolvePaths(path))));`,
        `}`,
      ].join("\n"),
    );

    await main(root, "linux", relative(process.cwd(), homeRoot));

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "paths.json"), "utf8")), [
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

  it("resolves a sibling in dist without writing outside the hook cwd", async () => {
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

    await main(root, "linux", homeRoot);

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "vscode/paths.json"), "utf8")), [
      {
        distPath: join(distRoot, "vscode/settings.json"),
        homePath: join(homeRoot, "vscode/settings.json"),
      },
      { distPath: join(distRoot, "sibling.txt"), homePath: join(homeRoot, "sibling.txt") },
    ]);
    assert.equal(existsSync(join(distRoot, "sibling.txt")), false);
  });

  for (const path of ["", ".", "..", "file/", "/outside.txt", "../../outside.txt"]) {
    it(`rejects invalid hook file path ${JSON.stringify(path)}`, async () => {
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
        main(root, "linux", homeRoot),
        /local build hook failed: vscode\/invalid\.build\.ts/,
      );
    });
  }

  it("copies .edit.ts as an ordinary file even without a target", async () => {
    await put(root, "dotfiles/missing.edit.ts", `throw new Error("must not execute");`);

    await main(root, "linux", homeRoot);

    assert.equal(
      await readFile(join(distRoot, "missing.edit.ts"), "utf8"),
      `throw new Error("must not execute");`,
    );
  });

  it("resolves home and cwd from the final folder after both path maps", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode | staged-vscode | - | - |\n| staged-vscode | mapped-vscode.exact | - | - |\n",
    );
    await put(homeRoot, "vscode/settings.json", '{"location":"source"}');
    await put(homeRoot, "staged-vscode/settings.json", '{"location":"staged"}');
    await put(homeRoot, "mapped-vscode/settings.json", '{"location":"final"}');
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `export default async function (context: { resolvePaths(path: string): { distPath: string; homePath: string } }) {
  const paths = context.resolvePaths("settings.json");
  const homeContent = await Bun.file(paths.homePath).text();
  await Bun.write("hook-ran.txt", JSON.stringify({ cwd: process.cwd(), paths, homeContent }));
}`,
    );
    const hookEvents: string[] = [];

    await main(root, "linux", homeRoot, (path, status) => hookEvents.push(`${path}:${status}`));

    assert.equal(existsSync(join(distRoot, "vscode")), false);
    assert.equal(existsSync(join(distRoot, "staged-vscode")), false);
    assert.deepEqual(hookEvents, [
      "mapped-vscode.exact/format-settings.build.ts:start",
      "mapped-vscode.exact/format-settings.build.ts:success",
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(distRoot, "mapped-vscode.exact/hook-ran.txt"), "utf8")),
      {
        cwd: join(distRoot, "mapped-vscode.exact"),
        paths: {
          distPath: join(distRoot, "mapped-vscode.exact/settings.json"),
          homePath: join(homeRoot, "mapped-vscode/settings.json"),
        },
        homeContent: '{"location":"final"}',
      },
    );
  });

  it("isolates cwd, environment, and memory mutations between hooks", async () => {
    await put(
      root,
      "dotfiles/01-mutate.build.ts",
      `export default async function () {
  await Bun.write("mutated.txt", "ran");
  process.chdir("..");
  process.env.BUILD_HOOK_ISOLATION = "changed";
  (globalThis as Record<string, unknown>).buildHookMemory = "changed";
}`,
    );
    await put(
      root,
      "dotfiles/nested/02-observe.build.ts",
      `export default async function () {
  await Bun.write("state.json", JSON.stringify({
    cwd: process.cwd(),
    environment: process.env.BUILD_HOOK_ISOLATION ?? null,
    memory: (globalThis as Record<string, unknown>).buildHookMemory ?? null,
  }));
}`,
    );

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "mutated.txt"), "utf8"), "ran");
    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "nested/state.json"), "utf8")), {
      cwd: join(distRoot, "nested"),
      environment: process.env.BUILD_HOOK_ISOLATION ?? null,
      memory: null,
    });
  });

  it("runs the real vscode formatter in the remapped folder on Windows", async () => {
    const hook = await readFile(
      join(import.meta.dir, "../../dotfiles/vscode/format-settings.build.ts"),
      "utf8",
    );
    const map = await readFile(join(import.meta.dir, "../../dotfiles/remap.data.md"), "utf8");
    await put(root, "dotfiles/remap.data.md", map);
    await put(root, "dotfiles/vscode/format-settings.build.ts", hook);
    await put(root, "dotfiles/vscode/settings.json", '{"editor.fontSize":12}');
    const hookEvents: string[] = [];

    await main(root, "windows", homeRoot, (path, status) => {
      if (status === "success") hookEvents.push(path);
    });

    const movedPath = join(distRoot, "AppData/Roaming/Code/User");
    assert.deepEqual(hookEvents, ["AppData/Roaming/Code/User/format-settings.build.ts"]);
    assert.equal(existsSync(join(distRoot, "vscode")), false);
    // Nested exact removal inside the moved folder is applied at copy time.
    assert.equal(existsSync(join(movedPath, "sync_vscode_extensions.apply.ts")), false);
    assert.equal(
      await readFile(join(movedPath, "settings.json"), "utf8"),
      '{ "editor.fontSize": 12 }\n',
    );
  });

  it("does not copy or run hooks of a mapped folder removed on macOS", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode |  | mapped-vscode | - |\n",
    );
    const hookEvents: string[] = [];
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `import { writeFile } from "node:fs/promises";\nexport default async function () { await writeFile("hook-ran.txt", "ran\\n"); }`,
    );

    await main(root, "darwin", homeRoot, (path, status) => {
      if (status === "start") hookEvents.push(path);
    });

    assert.deepEqual(hookEvents, []);
    assert.equal(existsSync(join(distRoot, "vscode")), false);
  });
  it("rejects a machine hook with an unsupported extension during discovery", async () => {
    await put(root, "dotfiles/vscode/local.build-machine.sh", "echo hook output\n");
    await assert.rejects(
      main(root, "linux", homeRoot),
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

async function runManager(
  args: string | string[],
  captureLogTimes = false,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  logTimes: { line: string; time: number }[];
}> {
  const commands = typeof args === "string" ? [args] : args;
  const instrumentation = captureLogTimes
    ? `const logTimes: { line: string; time: number }[] = [];
const originalLog = console.log;
console.log = (...data) => {
  const line = String(data[0] ?? "");
  logTimes.push({ line, time: performance.now() });
  if (line.startsWith("stage managed start"))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
  originalLog(...data);
};
`
    : "const logTimes: { line: string; time: number }[] = [];\n";
  const script = `import { main } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))};
${instrumentation}
try { process.exitCode = await main(${JSON.stringify(commands)}, ${JSON.stringify(root)}, ${JSON.stringify(homeRoot)}); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
process.stderr.write("\\n__LOG_TIMES__" + JSON.stringify(logTimes));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderrOutput] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const marker = stderrOutput.lastIndexOf("\n__LOG_TIMES__");
  const logTimes = marker === -1 ? [] : JSON.parse(stderrOutput.slice(marker + 14));
  const stderr = marker === -1 ? stderrOutput : stderrOutput.slice(0, marker);
  return { code, stdout, stderr, logTimes };
}

describe("manager CLI", () => {
  for (const command of ["apply", "diff", "managed"]) {
    it(`logs each stage and build hook in order for ${command}`, async () => {
      await put(
        root,
        "dotfiles/nested/01-local.build-machine.ts",
        "export default function () {};",
      );
      await put(root, "dotfiles/nested/02-shared.build.ts", "export default function () {};");
      await put(root, "dotfiles/new.txt", "content\n");

      const result = await runManager(command);

      assert.equal(result.code, 0, result.stderr);
      const logs = result.stdout
        .split("\n")
        .filter((line) =>
          /^(Build |  (?:rebuild dist |path map |externals |merge |replace |Running |[✓✗] )|stage |command )/.test(
            line,
          ),
        )
        .map((line) => line.replace(/\(\d+\.\d{2}s\)$/, "(TIME)"));
      assert.deepEqual(logs, [
        "Build started",
        "  rebuild dist (TIME)",
        "  path map (TIME)",
        "  externals (TIME)",
        "  merge (TIME)",
        "  replace (TIME)",
        "  Running nested/01-local.build-machine.ts",
        "  ✓ nested/01-local.build-machine.ts (TIME)",
        "  Running nested/02-shared.build.ts",
        "  ✓ nested/02-shared.build.ts (TIME)",
        "Build complete (TIME)",
        `stage ${command} start`,
        `stage ${command} success (TIME)`,
        `command ${command} success (TIME)`,
      ]);
      assert.doesNotMatch(result.stdout, new RegExp(`^stage ${command} start \\(`, "m"));
    });
  }

  it("logs build completion without hook lines when there are no hooks", async () => {
    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /^Build started\n  rebuild dist \(\d+\.\d{2}s\)\n  path map \(\d+\.\d{2}s\)\n  externals \(\d+\.\d{2}s\)\n  merge \(\d+\.\d{2}s\)\n  replace \(\d+\.\d{2}s\)\nBuild complete \(\d+\.\d{2}s\)$/m,
    );
    assert.doesNotMatch(result.stdout, /^  (?:Running|[✓✗]) /m);
  });

  it("does not add a blank line when a hook writes no stdout", async () => {
    await put(root, "dotfiles/quiet.build.ts", "export default function () {};");

    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert.equal(
      lines.slice(0, -1).some((line) => line === ""),
      false,
      result.stdout,
    );
  });

  it("logs hook success immediately after newline-terminated stdout", async () => {
    await put(
      root,
      "dotfiles/output.build.ts",
      'export default function () { process.stdout.write("hook-output\\n"); }',
    );

    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.split("\n");
    const outputLine = lines.indexOf("hook-output");
    assert.ok(outputLine >= 0, result.stdout);
    assert.match(lines[outputLine + 1], /^  ✓ output\.build\.ts \(\d+\.\d{2}s\)$/);
  });

  for (const fails of [false, true]) {
    it(`logs a hook ${fails ? "failure" : "success"} on its own line after unterminated stdout`, async () => {
      await put(
        root,
        "dotfiles/output.build.ts",
        `export default function () { process.stdout.write("hook-output"); ${fails ? 'throw new Error("failed");' : ""} }`,
      );

      const result = await runManager("managed");

      assert.equal(result.code, fails ? 1 : 0, result.stderr);
      const lines = result.stdout.split("\n");
      const outputLine = lines.indexOf("hook-output");
      assert.equal(outputLine >= 0, true, result.stdout);
      assert.match(
        lines[outputLine + 1],
        new RegExp(`^  ${fails ? "✗" : "✓"} output\\.build\\.ts \\(\\d+\\.\\d{2}s\\)$`),
      );
    });
  }

  it("reports a managed stage duration matching its measured log interval", async () => {
    await put(root, "dotfiles/new.txt", "content\n");

    const result = await runManager("managed", true);

    assert.equal(result.code, 0, result.stderr);
    const stageStart = result.logTimes.find(({ line }) => line.startsWith("stage managed start"));
    const stageSuccess = result.logTimes.find(({ line }) =>
      line.startsWith("stage managed success "),
    );
    assert.ok(stageStart, "missing managed stage start timestamp");
    assert.ok(stageSuccess, "missing managed stage success timestamp");
    const reported = result.stdout.match(/^stage managed success \((\d+\.\d{2})s\)$/m);
    assert.ok(reported, `missing managed stage success log: ${result.stdout}`);
    const reportedSeconds = Number(reported[1]);
    const measuredSeconds = (stageSuccess.time - stageStart.time) / 1000;
    assert.ok(measuredSeconds >= 0.08, `managed stage measured only ${measuredSeconds}s`);
    assert.ok(reportedSeconds >= 0.08, `managed stage reported only ${reportedSeconds}s`);
    assert.ok(
      Math.abs(reportedSeconds - measuredSeconds) <= 0.03,
      `managed stage reports ${reportedSeconds}s for a measured ${measuredSeconds.toFixed(3)}s interval`,
    );
  });

  it("reports nonzero elapsed seconds for a delayed hook, build, and command", async () => {
    await put(
      root,
      "dotfiles/delayed.build.ts",
      "export default async function () { await new Promise((resolve) => setTimeout(resolve, 150)); }",
    );

    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    for (const pattern of [
      /^  ✓ delayed\.build\.ts \((\d+\.\d{2})s\)$/m,
      /^Build complete \((\d+\.\d{2})s\)$/m,
      /^command managed success \((\d+\.\d{2})s\)$/m,
    ]) {
      const elapsed = result.stdout.match(pattern);
      assert.ok(elapsed, `missing success log matching ${pattern}: ${result.stdout}`);
      const seconds = Number(elapsed[1]);
      assert.ok(seconds >= 0.1, `${pattern} elapsed ${seconds}s is below 0.10s`);
    }
  });

  it("builds before applying and runs apply scripts", async () => {
    await put(root, "dotfiles/file.txt", "new\n");
    await put(
      root,
      "dotfiles/done.apply.ts",
      'import { writeFile } from "node:fs/promises"; await writeFile("done.txt", "ran\\n");',
    );
    await put(distRoot, "old.txt", "stale\n");

    const result = await runManager("apply");

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(homeRoot, "file.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(homeRoot, "done.txt"), "utf8"), "ran\n");
    assert.equal(existsSync(join(distRoot, "old.txt")), false);
  });

  it("builds before diff without writing to home or running apply scripts", async () => {
    await put(root, "dotfiles/file.txt", "new\n");
    await put(
      root,
      "dotfiles/done.apply.ts",
      'import { writeFile } from "node:fs/promises"; await writeFile("done.txt", "ran");',
    );
    await put(homeRoot, "file.txt", "old\n");

    const result = await runManager("diff");

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /file\.txt/);
    assert.match(result.stdout, /old/);
    assert.match(result.stdout, /new/);
    assert.equal(await readFile(join(distRoot, "file.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(homeRoot, "file.txt"), "utf8"), "old\n");
    assert.equal(existsSync(join(homeRoot, "done.txt")), false);
  });

  it("builds before listing managed paths without writing to home", async () => {
    await put(root, "dotfiles/new.txt", "content\n");

    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^new\.txt$/m);
    assert.match(result.stdout, /^command managed success \(\d+\.\d{2}s\)$/m);
    assert.equal(existsSync(join(homeRoot, "new.txt")), false);
  });

  it("stops later hooks and command processing after a failed hook", async () => {
    await put(root, "dotfiles/file.txt", "new\n");
    await put(
      root,
      "dotfiles/01-fail.build.ts",
      'export default function () { process.stderr.write("hook-error\\n"); throw new Error("failed"); }',
    );
    await put(
      root,
      "dotfiles/02-late.build.ts",
      'export default () => Bun.write("late.txt", "ran");',
    );
    await put(root, "dotfiles/done.apply.ts", 'await Bun.write("done.txt", "ran");');

    const result = await runManager("apply");

    assert.equal(result.code, 1);
    assert.match(result.stderr, /hook-error\n/);
    assert.match(result.stderr, /local build hook failed: 01-fail\.build\.ts/);
    assert.match(result.stdout, /^Build started$/m);
    assert.match(result.stdout, /^  Running 01-fail\.build\.ts$/m);
    assert.match(result.stdout, /^  ✗ 01-fail\.build\.ts \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^Build failed \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^command apply failure \(\d+\.\d{2}s\)$/m);
    assert.doesNotMatch(result.stdout, /^  Running 02-late\.build\.ts$/m);
    assert.doesNotMatch(result.stdout, /^stage apply start$/m);
    assert.equal(existsSync(join(distRoot, "late.txt")), false);
    assert.equal(existsSync(join(homeRoot, "file.txt")), false);
    assert.equal(existsSync(join(homeRoot, "done.txt")), false);
  });

  it("logs a later stage failure and the command failure", async () => {
    await put(root, "dotfiles/new.txt", "content\n");
    await rm(homeRoot, { recursive: true });
    await writeFile(homeRoot, "not a directory");

    const result = await runManager("diff");

    assert.equal(result.code, 1);
    assert.match(result.stderr, /home root is not a directory:/);
    assert.match(result.stdout, /^Build complete \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^stage diff failure \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^command diff failure \(\d+\.\d{2}s\)$/m);
  });

  it("rejects invalid arguments without logs or rebuilding dist", async () => {
    await put(distRoot, "sentinel.txt", "keep\n");
    for (const args of [[], ["unknown"], ["apply", "extra"]]) {
      const result = await runManager(args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /usage: bun dotfiles-manager/);
      assert.equal(result.stdout, "");
      assert.equal(await readFile(join(distRoot, "sentinel.txt"), "utf8"), "keep\n");
    }
  });
});
