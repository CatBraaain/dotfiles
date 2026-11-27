import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseIni } from "js-ini";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { applyDifferences } from "./apply.ts";
import { applyPathMap } from "./build-path-map.ts";
import { applyReplacements, applyReplaceSidecars, parseReplaceSidecar } from "./build-replace.ts";
import { collectHooks, runHooks } from "./build-hooks.ts";
import { main } from "./build.ts";
import { collectDifferences } from "./diff.ts";
import { adoptHomeLnkBytes, convertLnkDeclarations } from "./lnk.ts";

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

async function put(baseDir: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(baseDir, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}

async function gitConfig(configPath: string, key: string): Promise<string> {
  const proc = Bun.spawn(["git", "config", "--file", configPath, "--get", key], {
    env: {
      ...process.env,
      HOME: homeRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(homeRoot, "missing-global-config"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
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

  it("copies only the target platform file under its unqualified name", async () => {
    const variants = ["linux", "windows", "macos"] as const;
    for (const variant of variants) {
      await put(root, `dotfiles/nested/config.${variant}.json`, variant);
    }
    await put(root, "dotfiles/nested/keep.windows.txt/file.txt", "directory");
    await put(root, "dotfiles/nested/optional.bsd.txt", "unqualified");

    for (const [platform, variant] of [
      ["linux", "linux"],
      ["windows", "windows"],
      ["darwin", "macos"],
    ] as const) {
      await main(root, platform, homeRoot);

      assert.equal(await readFile(join(distRoot, "nested/config.json"), "utf8"), variant);
      assert.equal(
        await readFile(join(distRoot, "nested/keep.windows.txt/file.txt"), "utf8"),
        "directory",
      );
      assert.equal(
        await readFile(join(distRoot, "nested/optional.bsd.txt"), "utf8"),
        "unqualified",
      );
      for (const suffix of variants) {
        assert.equal(existsSync(join(distRoot, `nested/config.${suffix}.json`)), false);
      }
    }
  });

  it("prefers the target platform file and uses the common file on other platforms", async () => {
    await put(root, "dotfiles/config.txt", "common");
    await put(root, "dotfiles/config.linux.txt", "linux");

    await main(root, "linux", homeRoot);
    assert.equal(await readFile(join(distRoot, "config.txt"), "utf8"), "linux");

    await main(root, "windows", homeRoot);
    assert.equal(await readFile(join(distRoot, "config.txt"), "utf8"), "common");
  });

  it("respects remap rules for both the source file name and the normalized dist path", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      [
        "| key | linux | windows | macos |",
        "| --- | --- | --- | --- |",
        "| move.windows.txt | | moved.txt | |",
        "| skip.windows.txt | | - | |",
        "| hidden.txt | | - | |",
      ].join("\n"),
    );
    await put(root, "dotfiles/move.txt", "common");
    await put(root, "dotfiles/move.windows.txt", "windows");
    await put(root, "dotfiles/skip.txt", "common");
    await put(root, "dotfiles/skip.windows.txt", "windows");
    await put(root, "dotfiles/hidden.windows.txt", "windows");

    await main(root, "windows", homeRoot);

    assert.equal(await readFile(join(distRoot, "move.txt"), "utf8"), "common");
    assert.equal(await readFile(join(distRoot, "moved.txt"), "utf8"), "windows");
    assert.equal(await readFile(join(distRoot, "skip.txt"), "utf8"), "common");
    assert.equal(existsSync(join(distRoot, "hidden.txt")), false);
  });

  it("keeps an explicit remap when an implicit platform file has the same destination", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      [
        "| key | linux | windows | macos |",
        "| --- | --- | --- | --- |",
        "| a/source.txt | | first.txt | |",
        "| z/source.txt | | second.txt | |",
        "| directory | | folder.txt | |",
      ].join("\n"),
    );
    await put(root, "dotfiles/a/source.txt", "explicit first");
    await put(root, "dotfiles/first.windows.txt", "implicit");
    await put(root, "dotfiles/second.windows.txt", "implicit");
    await put(root, "dotfiles/z/source.txt", "explicit second");
    await put(root, "dotfiles/directory/file.txt", "explicit directory");
    await put(root, "dotfiles/folder.windows.txt", "implicit");

    await main(root, "windows", homeRoot);

    assert.equal(await readFile(join(distRoot, "first.txt"), "utf8"), "explicit first");
    assert.equal(await readFile(join(distRoot, "second.txt"), "utf8"), "explicit second");
    assert.equal(
      await readFile(join(distRoot, "folder.txt/file.txt"), "utf8"),
      "explicit directory",
    );
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

  it.each(["trigger.txt", "trigger.linux.txt"])(
    "moves %s from a nested path map to the dist root directory",
    async (fileName) => {
      await put(root, `dotfiles/nested/${fileName}`, "trigger\n");
      await put(
        root,
        "dotfiles/nested/remap.data.md",
        "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| trigger.txt | ../inside.txt |  |  |\n",
      );

      await main(root, "linux", homeRoot);

      assert.equal(await readFile(join(distRoot, "inside.txt"), "utf8"), "trigger\n");
      assert.equal(existsSync(join(distRoot, "nested/trigger.txt")), false);
    },
  );

  it("continues remap reapplication when a file replaces an unvisited sibling directory", async () => {
    await put(root, "dotfiles/nested/trigger.linux.txt", "trigger\n");
    await put(root, "dotfiles/z-last/previous.txt", "previous\n");
    await put(
      root,
      "dotfiles/nested/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| trigger.txt | ../z-last |  |  |\n",
    );

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "z-last"), "utf8"), "trigger\n");
  });

  it.each([
    ["earlier", true],
    ["relocated", false],
  ] as const)("reapplies a moved directory's map at %s", async (destination, hasExistingMap) => {
    const header = "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n";
    if (hasExistingMap) await put(root, `dotfiles/${destination}/remap.data.md`, header);
    await put(root, "dotfiles/remap.data.md", header + "| seed | holder/renamed |  |  |\n");
    await put(
      root,
      "dotfiles/holder/remap.data.md",
      header + `| renamed | ../${destination} |  |  |\n`,
    );
    await put(root, "dotfiles/seed/remap.data.md", header + "| entry.txt | moved.txt |  |  |\n");
    await put(root, "dotfiles/seed/entry.linux.txt", "entry\n");

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, destination, "moved.txt"), "utf8"), "entry\n");
  });

  it("does not reapply an earlier map after a cross-directory remap", async () => {
    const header = "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n";
    await put(
      root,
      "dotfiles/earlier/remap.data.md",
      header + "| stage.txt | finished.txt |  |  |\n| start.txt | stage.txt |  |  |\n",
    );
    await put(root, "dotfiles/earlier/start.linux.txt", "start\n");
    await put(
      root,
      "dotfiles/nested/remap.data.md",
      header + "| trigger.txt | ../inside.txt |  |  |\n",
    );
    await put(root, "dotfiles/nested/trigger.linux.txt", "trigger\n");

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "earlier/stage.txt"), "utf8"), "start\n");
  });

  it("does not reapply a map when its processed directory is moved", async () => {
    const header = "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n";
    await put(
      distRoot,
      "earlier/remap.data.md",
      header + "| stage.txt | finished.txt |  |  |\n| start.txt | stage.txt |  |  |\n",
    );
    await put(distRoot, "earlier/start.txt", "start\n");
    await mkdir(join(distRoot, "target"));
    const targetName = existsSync(join(distRoot, "TARGET")) ? "TARGET" : "target";
    await put(
      distRoot,
      "mover/remap.data.md",
      header + `| ../earlier | ../${targetName}/moved |  |  |\n`,
    );

    await applyPathMap(distRoot, "linux");

    assert.equal(await readFile(join(distRoot, "target/moved/stage.txt"), "utf8"), "start\n");
  });

  it("rejects a copy-time remap destination that leaves dist", async () => {
    await put(root, "dotfiles/plain.txt", "plain\n");
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| plain.txt | ../escaped.txt |  |  |\n",
    );

    await assert.rejects(
      main(root, "linux", homeRoot),
      /remap\.data\.md has a destination outside dist for plain\.txt:/,
    );
    assert.equal(existsSync(join(root, "escaped.txt")), false);
  });

  it("rejects a second-application remap destination that leaves dist", async () => {
    await put(root, "dotfiles/plain.txt", "plain\n");
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| plain.txt | nested/plain.txt |  |  |\n| nested/plain.txt | ../escaped.txt |  |  |\n",
    );
    const phases: string[] = [];

    await assert.rejects(
      main(root, "linux", homeRoot, { onPhase: (phase) => phases.push(phase) }),
      /remap\.data\.md has a destination outside dist for nested\/plain\.txt:/,
    );
    assert.deepEqual(phases, ["rebuild dist"]);
    assert.equal(existsSync(join(root, "escaped.txt")), false);
  });

  it("rejects a nested remap destination that reaches outside dist through a symlink", async () => {
    await put(
      distRoot,
      "nested/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| plain.txt | ../escape-link/plain.txt |  |  |\n",
    );
    await put(distRoot, "nested/plain.txt", "plain\n");
    await mkdir(join(root, "outside-dir"));
    await symlink(join(root, "outside-dir"), join(distRoot, "escape-link"), "dir");

    await assert.rejects(
      applyPathMap(distRoot, "linux"),
      /remap\.data\.md has a destination reaching outside dist via a symlink for plain\.txt:/,
    );
    assert.equal(existsSync(join(root, "outside-dir", "plain.txt")), false);
  });

  it.each(["trigger.txt", "trigger.linux.txt"])(
    "rejects using the dist root itself as the remap destination for %s",
    async (fileName) => {
      await put(root, `dotfiles/nested/${fileName}`, "trigger\n");
      await put(
        root,
        "dotfiles/nested/remap.data.md",
        "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| trigger.txt | .. |  |  |\n",
      );

      await assert.rejects(main(root, "linux", homeRoot), /cannot replace the dist root/);
      assert.equal(existsSync(distRoot), true);
    },
  );

  it("rejects replacing an ancestor of the source during remap reapplication", async () => {
    await put(root, "dotfiles/parent/nested/trigger.linux.txt", "trigger\n");
    const ancestor = existsSync(join(root, "dotfiles/PARENT")) ? "../../PARENT" : "..";
    await put(
      root,
      "dotfiles/parent/nested/remap.data.md",
      `| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| trigger.txt | ${ancestor} |  |  |\n`,
    );

    await assert.rejects(
      main(root, "linux", homeRoot),
      /cannot replace the source or its ancestor/,
    );
    assert.equal(await readFile(join(distRoot, "parent/nested/trigger.txt"), "utf8"), "trigger\n");
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

  it("applies windows-merge only on the Windows build and removes it otherwise", async () => {
    await put(root, "dotfiles/settings.merge.json", '{"shared":true,"tools":"both"}');
    await put(root, "dotfiles/settings.windows-merge.json", '{"tools":"windows","mux":false}');
    await put(homeRoot, "settings.json", '{"old":true}');

    await main(root, "windows", homeRoot);

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "settings.json"), "utf8")), {
      old: true,
      shared: true,
      tools: "windows",
      mux: false,
    });
    assert.equal(existsSync(join(distRoot, "settings.windows-merge.json")), false);
    assert.equal(existsSync(join(distRoot, "settings.merge.json")), false);

    await main(root, "linux", homeRoot);

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "settings.json"), "utf8")), {
      old: true,
      shared: true,
      tools: "both",
    });
    assert.equal(existsSync(join(distRoot, "settings.windows-merge.json")), false);
  });

  it.each([
    ["darwin", "macos"],
    ["linux", "shared"],
    ["windows", "shared"],
  ] as const)(
    "selects the macOS YAML merge sidecar only for macOS (%s)",
    async (platform, source) => {
      await put(root, "dotfiles/settings.merge.yaml", "source: shared\nshared: true\n");
      await put(root, "dotfiles/settings.macos-merge.yaml", "source: macos\n");

      await main(root, platform, homeRoot);

      assert.deepEqual(parseYaml(await readFile(join(distRoot, "settings.yaml"), "utf8")), {
        source,
        shared: true,
      });
      assert.equal(existsSync(join(distRoot, "settings.macos-merge.yaml")), false);
    },
  );

  it.each([
    ["linux", "linux"],
    ["windows", "windows"],
    ["darwin", "macos"],
  ] as const)(
    "collects shared, machine and matching OS build hooks on %s",
    async (platform, modifier) => {
      const hookPrefixes = [
        "common.",
        "hook.linux-",
        "hook.windows-",
        "hook.macos-",
        "machine.machine-",
        `unrecognized.${modifier}-machine-`,
      ];
      await Promise.all(
        hookPrefixes.flatMap((prefix) => [
          put(distRoot, `${prefix}build.ts`, ""),
          put(distRoot, `${prefix}postbuild.ts`, ""),
        ]),
      );

      const hooks = await collectHooks(distRoot, platform);

      assert.deepEqual(
        hooks.map((hook) => hook.name),
        [
          "common.build.ts",
          `hook.${modifier}-build.ts`,
          "machine.machine-build.ts",
          "common.postbuild.ts",
          `hook.${modifier}-postbuild.ts`,
          "machine.machine-postbuild.ts",
        ],
      );
    },
  );

  it("runs a windows-build hook only on the Windows build", async () => {
    await put(
      root,
      "dotfiles/windows-hook.windows-build.ts",
      `import { appendFile } from "node:fs/promises";\nif (import.meta.main) {\n  await appendFile("ran.txt", "windows\\n");\n}`,
    );

    await main(root, "linux", homeRoot);
    assert.equal(existsSync(join(distRoot, "ran.txt")), false);

    await main(root, "windows", homeRoot);
    assert.equal(await readFile(join(distRoot, "ran.txt"), "utf8"), "windows\n");
  });

  it("copies node_modules when no remap rule excludes it", async () => {
    await put(root, "dotfiles/node_modules/pkg/index.js", "kept\n");
    await put(root, "dotfiles/nested/node_modules/pkg/index.js", "kept\n");
    await put(root, "dotfiles/other/node_modules", "kept\n");

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "node_modules/pkg/index.js"), "utf8"), "kept\n");
    assert.equal(
      await readFile(join(distRoot, "nested/node_modules/pkg/index.js"), "utf8"),
      "kept\n",
    );
    assert.equal(await readFile(join(distRoot, "other/node_modules"), "utf8"), "kept\n");
  });

  it.each(["linux", "windows", "darwin"] as const)(
    "excludes paths matching the node_modules remap glob during the copy on %s",
    async (platform) => {
      await put(
        root,
        "dotfiles/remap.data.md",
        "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| **/node_modules | - | - | - |\n",
      );
      const excludedPaths = ["node_modules", "nested/node_modules", "other/node_modules"];
      await put(root, "dotfiles/node_modules/pkg/index.js", "excluded\n");
      await put(root, "dotfiles/nested/node_modules/pkg/index.js", "excluded\n");
      await put(root, "dotfiles/other/node_modules", "excluded\n");

      let copiedPaths: string[] | undefined;
      await main(root, platform, homeRoot, {
        onPhase(phase) {
          if (phase === "rebuild dist")
            copiedPaths = excludedPaths.filter((path) => existsSync(join(distRoot, path)));
        },
      });

      assert.deepEqual(copiedPaths, []);
    },
  );

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
if (import.meta.main) {
  await appendFile("log.txt", "late\\n");
}
`,
    );
    await put(
      root,
      "dotfiles/02-early.build.ts",
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
if (import.meta.main) {
  await appendFile("log.txt", "early\\n");
}
`,
    );
    await put(
      root,
      "dotfiles/sub/marker.build.ts",
      `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
if (import.meta.main) {
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
        `import { appendFile } from "node:fs/promises";\nif (import.meta.main) {\n  await appendFile(${JSON.stringify(orderFile)}, ${JSON.stringify(`${label}\n`)});\n}`,
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
      `import { writeFile } from "node:fs/promises";\nif (import.meta.main) {\n  await writeFile("02-late.build.ts", 'if (import.meta.main) await Bun.write("ran.txt", "ran");');\n}`,
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
if (import.meta.main) {
  await appendFile("order.txt", "shared\\n");
}`,
    );
    await put(
      root,
      "dotfiles/nested/01-local.machine-build.ts",
      `import { appendFile } from "node:fs/promises";
if (import.meta.main) {
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
      `import { rm, appendFile } from "node:fs/promises";\nif (import.meta.main) {\n  await rm("doomed", { recursive: true, force: true });\n  await appendFile(${JSON.stringify(orderFile)}, "prune\\n");\n}`,
    );
    await put(
      root,
      "dotfiles/doomed/boom.build.ts",
      `import { appendFile } from "node:fs/promises";\nif (import.meta.main) {\n  await appendFile(${JSON.stringify(orderFile)}, "collected\\n");\n}`,
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
      `import { rm } from "node:fs/promises";\nif (import.meta.main) {\n  await rm("doomed/sub", { recursive: true, force: true });\n}`,
    );
    await put(
      root,
      "dotfiles/doomed/sub/late.build.ts",
      `import { appendFile } from "node:fs/promises";\nif (import.meta.main) {\n  await appendFile(${JSON.stringify(orderFile)}, "ran\\n");\n}`,
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
if (import.meta.main) {
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
    await put(root, "dotfiles/settings.machine-merge.json", '{"machine":true,"value":"machine"}');
    await put(
      root,
      "dotfiles/format.build.ts",
      `import assert from "node:assert/strict";
import { existsSync } from "node:fs";
if (import.meta.main) {
  assert.equal(existsSync("settings.merge.json"), false);
  assert.equal(existsSync("settings.machine-merge.json"), false);
  const completed = await Bun.file("settings.json").json();
  await Bun.write("settings.json", JSON.stringify(completed));
}`,
    );

    await main(root, "linux", homeRoot);

    assert.equal(
      await readFile(join(distRoot, "settings.json"), "utf8"),
      '{"plain":true,"value":"machine","shared":true,"machine":true}',
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
if (import.meta.main) {
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
        'if (import.meta.main) await Bun.write("ran.txt", "ran");',
      );
      const phases: string[] = [];
      const hookEvents: string[] = [];

      await assert.rejects(
        main(root, "linux", homeRoot, {
          onHookEvent: (path, status) => hookEvents.push(`${path}:${status}`),
          onPhase: (phase) => phases.push(phase),
        }),
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
        `if (import.meta.main) {
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

  it("composes merge sidecars over the plain base without home content", async () => {
    await put(
      homeRoot,
      "kit/settings.json",
      JSON.stringify({ mode: "home", keep: true, extra: ["home"] }),
    );
    await put(
      root,
      "dotfiles/kit/settings.json",
      JSON.stringify({ mode: "plain", plainOnly: true, extra: ["plain"] }),
    );
    await put(
      root,
      "dotfiles/kit/settings.merge.json",
      JSON.stringify({ "extra.$append": ["merged"] }),
    );

    await main(root, "linux", homeRoot);

    assert.deepEqual(JSON.parse(await readFile(join(distRoot, "kit/settings.json"), "utf8")), {
      mode: "plain",
      plainOnly: true,
      extra: ["plain", "merged"],
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
    {
      format: "ini",
      serialize: (values: Record<string, string>) =>
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      parse: parseIni,
    },
  ]) {
    it(`composes a standalone ${format} machine merge layer over home`, async () => {
      await put(
        homeRoot,
        `kit/settings.${format}`,
        serialize({ mode: "home", homeOnly: "present" }),
      );
      await put(
        root,
        `dotfiles/kit/settings.machine-merge.${format}`,
        serialize({ mode: "machine" }),
      );

      await main(root, "linux", homeRoot);

      const output = parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8"));
      assert.deepEqual({ ...output }, { mode: "machine", homeOnly: "present" });
      assert.equal(existsSync(join(distRoot, `kit/settings.machine-merge.${format}`)), false);
    });

    for (const hasBase of [false, true]) {
      it(`applies ${format} sidecars in priority order over ${hasBase ? "plain base without home" : "home without plain base"}`, async () => {
        await put(
          homeRoot,
          `kit/settings.${format}`,
          serialize({ homeOnly: "present", baseVsShared: "home" }),
        );
        if (hasBase) {
          await put(
            root,
            `dotfiles/kit/settings.${format}`,
            serialize({ plainOnly: "present", baseVsShared: "plain" }),
          );
        }
        await put(
          root,
          `dotfiles/kit/settings.merge.${format}`,
          serialize({
            shared: "present",
            baseVsShared: "shared",
            sharedVsExisting: "shared",
          }),
        );
        await put(
          root,
          `dotfiles/kit/settings.merge-existing.${format}`,
          serialize({
            existing: "present",
            sharedVsExisting: "existing",
            existingVsMachine: "existing",
          }),
        );
        await put(
          root,
          `dotfiles/kit/settings.machine-merge.${format}`,
          serialize({
            machine: "present",
            existingVsMachine: "machine",
            machineVsExistingMachine: "machine",
          }),
        );
        await put(
          root,
          `dotfiles/kit/settings.machine-merge-existing.${format}`,
          serialize({
            existingMachine: "present",
            machineVsExistingMachine: "existing-machine",
          }),
        );

        await main(root, "linux", homeRoot);

        const output = parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8"));
        const expected = {
          ...(hasBase ? { plainOnly: "present" } : { homeOnly: "present" }),
          shared: "present",
          existing: "present",
          machine: "present",
          existingMachine: "present",
          baseVsShared: "shared",
          sharedVsExisting: "existing",
          existingVsMachine: "machine",
          machineVsExistingMachine: "existing-machine",
        };
        assert.deepEqual({ ...output }, expected);
        for (const suffix of [
          "merge",
          "merge-existing",
          "machine-merge",
          "machine-merge-existing",
        ]) {
          assert.equal(existsSync(join(distRoot, `kit/settings.${suffix}.${format}`)), false);
        }
      });

      it(`skips malformed ${format} conditional sidecars without home ${hasBase ? "and preserves plain base" : "or output"}`, async () => {
        const plainContent = serialize({ plainOnly: "present" });
        if (hasBase) await put(root, `dotfiles/kit/settings.${format}`, plainContent);
        await put(root, `dotfiles/kit/settings.merge-existing.${format}`, "[");
        await put(root, `dotfiles/kit/settings.machine-merge-existing.${format}`, "[");

        await main(root, "linux", homeRoot);

        const outputPath = join(distRoot, `kit/settings.${format}`);
        assert.equal(existsSync(outputPath), hasBase);
        if (hasBase) assert.equal(await readFile(outputPath, "utf8"), plainContent);
        assert.equal(existsSync(join(distRoot, `kit/settings.merge-existing.${format}`)), false);
        assert.equal(
          existsSync(join(distRoot, `kit/settings.machine-merge-existing.${format}`)),
          false,
        );
      });
    }

    it(`ignores malformed ${format} home content when a plain base exists`, async () => {
      await put(homeRoot, `kit/settings.${format}`, "[");
      await put(root, `dotfiles/kit/settings.${format}`, serialize({ plainOnly: "present" }));
      await put(root, `dotfiles/kit/settings.merge.${format}`, serialize({ shared: "present" }));

      await main(root, "linux", homeRoot);

      const output = parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8"));
      assert.deepEqual({ ...output }, { plainOnly: "present", shared: "present" });
      assert.equal(await readFile(join(homeRoot, `kit/settings.${format}`), "utf8"), "[");
    });

    it(`uses an empty ${format} plain base instead of home content`, async () => {
      await put(homeRoot, `kit/settings.${format}`, serialize({ homeOnly: "present" }));
      await put(root, `dotfiles/kit/settings.${format}`, "");
      await put(root, `dotfiles/kit/settings.merge.${format}`, serialize({ shared: "present" }));

      await main(root, "linux", homeRoot);

      const output = parse(await readFile(join(distRoot, `kit/settings.${format}`), "utf8"));
      assert.deepEqual({ ...output }, { shared: "present" });
    });

    it(`copies a standalone ${format} plain base without changing its content`, async () => {
      const plainContent = `\n${serialize({ plainOnly: "present" })}\n`;
      await put(homeRoot, `kit/settings.${format}`, "[");
      await put(root, `dotfiles/kit/settings.${format}`, plainContent);

      await main(root, "linux", homeRoot);

      assert.equal(await readFile(join(distRoot, `kit/settings.${format}`), "utf8"), plainContent);
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
  it("merges a machine data sidecar after moving its folder", async () => {
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| source | moved |  |  |\n",
    );
    await put(
      root,
      "dotfiles/source/settings.data.yaml",
      "nested: {shared: true}\nitems: [base]\n",
    );
    await put(
      root,
      "dotfiles/source/settings.data.machine-merge.yaml",
      "nested: {machine: true}\nitems.$append: [machine]\n",
    );

    await main(root, "linux", homeRoot);

    const merged = parseYaml(await readFile(join(distRoot, "moved/settings.data.yaml"), "utf8"));
    assert.deepEqual(merged, {
      nested: { shared: true, machine: true },
      items: ["base", "machine"],
    });
    assert.equal(existsSync(join(distRoot, "moved/settings.data.machine-merge.yaml")), false);
  });

  it("does not read a machine data sidecar when its base is absent from dist", async () => {
    await put(homeRoot, "settings.data.yaml", "from: home\n");
    await put(root, "dotfiles/settings.data.machine-merge.yaml", "[\n");

    await main(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "settings.data.yaml")), false);
  });

  it("does not use the early sidecar in a later merge that creates its base", async () => {
    await put(root, "dotfiles/settings.data.machine-merge.yaml", "[\n");
    await put(root, "dotfiles/settings.data.merge.yaml", "from: late\n");

    await main(root, "linux", homeRoot);

    const merged = parseYaml(await readFile(join(distRoot, "settings.data.yaml"), "utf8"));
    assert.deepEqual(merged, { from: "late" });
  });

  it("stops before external acquisition when a machine data sidecar is invalid", async () => {
    await put(root, "dotfiles/settings.data.yaml", "shared: true\n");
    await put(root, "dotfiles/settings.data.machine-merge.yaml", "[\n");
    const phases: string[] = [];

    await assert.rejects(
      main(root, "linux", homeRoot, { onPhase: (phase) => phases.push(phase) }),
      /machine data merge failed: settings\.data\.machine-merge\.yaml/,
    );
    assert.deepEqual(phases, ["rebuild dist", "path map"]);
  });

  it("uses the dedicated external data merge for acquisition without reinterpreting edit keys", async () => {
    await put(
      root,
      "dotfiles/external.data.yaml",
      `repos:
  example/edited:
    destination: output
    entries: []
    entries.$append: [files]
    entries.$append: [extra.txt]
    edit:
      files/info.txt.$append: shared info
      files/other.txt.$append: shared other
    edit_markdown:
      files/readme.md:
        sections:
          Note.$replace: machine notes
          "20": twenty
          "3": three
`,
    );
    await put(
      root,
      "dotfiles/external.data.machine-merge.yaml",
      `repos:
  example/edited:
    exclude: [files/skip.txt]
    edit:
      files/info.txt.$append: machine info
    edit_markdown:
      files/readme.md:
        sections:
          "1": &local_text updated text
          "3": *local_text
`,
    );
    const mirror = "mirrors/github.com/example/edited";
    await put(homeRoot, `${mirror}/extra.txt`, "extra\n");
    await put(homeRoot, `${mirror}/files/info.txt`, "info\n");
    await put(homeRoot, `${mirror}/files/other.txt`, "other\n");
    await put(homeRoot, `${mirror}/files/skip.txt`, "skip\n");
    await put(homeRoot, `${mirror}/files/readme.md`, "## Note.$replace\n\nshared notes\n");
    await put(homeRoot, `${mirror}/.git/build-pull-time`, `${Date.now()}\n`);

    await runBuildInSubprocess("linux");

    assert.equal(
      await readFile(join(distRoot, "output/files/info.txt"), "utf8"),
      "info\nmachine info",
    );
    assert.equal(
      await readFile(join(distRoot, "output/files/other.txt"), "utf8"),
      "other\nshared other",
    );
    assert.equal(
      await readFile(join(distRoot, "output/files/readme.md"), "utf8"),
      "## Note.$replace\n\nmachine notes\n\n## 20\n\ntwenty\n\n## 3\n\nupdated text\n\n## 1\n\nupdated text\n",
    );
    assert.equal(await readFile(join(distRoot, "output/extra.txt"), "utf8"), "extra\n");
    assert.equal(existsSync(join(distRoot, "output/files/skip.txt")), false);
    assert.equal(existsSync(join(distRoot, "external.data.machine-merge.yaml")), false);
  });

  it("rejects duplicate literal edit keys in a dedicated external data sidecar", async () => {
    await put(root, "dotfiles/external.data.yaml", "repos: {}\n");
    await put(
      root,
      "dotfiles/external.data.machine-merge.yaml",
      `repos:
  example/edited:
    edit_markdown:
      files/readme.md:
        sections:
          Note.$replace: first
          Note.$replace: second
`,
    );

    await assert.rejects(
      main(root, "linux", homeRoot),
      /machine data merge failed: external\.data\.machine-merge\.yaml: duplicate external config key: Note\.\$replace/,
    );
  });

  it("keeps the shared external data sidecar and its patch operations after acquisition", async () => {
    await put(
      root,
      "dotfiles/external.data.yaml",
      `repos:
  example/edited:
    destination: shared
    entries: [files]
    edit_markdown:
      files/README:
        sections: {Title: shared}
`,
    );
    await put(
      root,
      "dotfiles/external.data.machine-merge.yaml",
      "repos: {example/edited: {destination: early}}\n",
    );
    await put(
      root,
      "dotfiles/external.data.merge.yaml",
      `repos:
  example/edited:
    destination: late
    edit_markdown:
      files/README:
        sections:
          Title.$replace: late
`,
    );
    const mirror = "mirrors/github.com/example/edited";
    await put(homeRoot, `${mirror}/files/README`, "# Title\n\nbase\n");
    await put(homeRoot, `${mirror}/.git/build-pull-time`, `${Date.now()}\n`);

    await runBuildInSubprocess("linux");

    assert.equal(
      await readFile(join(distRoot, "early/files/README"), "utf8"),
      "# Title\n\nshared\n",
    );
    assert.equal(existsSync(join(distRoot, "late")), false);
    const merged = parseYaml(await readFile(join(distRoot, "external.data.yaml"), "utf8"));
    assert.deepEqual(merged.repos["example/edited"].edit_markdown["files/README"].sections, {
      Title: "late",
    });
  });

  it("ignores machine data sidecars in the root and arbitrary nested folders", () => {
    const repoRoot = join(import.meta.dir, "../..");
    for (const path of [
      "dotfiles/external.machine-data.yaml",
      "dotfiles/rime/external.machine-data.yaml",
      "dotfiles/.agents/skills.exact/external.machine-data.yaml",
      "dotfiles/other/nested/external.machine-data.yaml",
      "dotfiles/external.data.machine-merge.yaml",
      "dotfiles/other/nested/settings.data.machine-merge.yaml",
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

  it("prefers external.machine-data.yaml over a dedicated data merge and the obsolete name", async () => {
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
      "dotfiles/external.data.machine-merge.yaml",
      "repos: {example/repo: {exclude: [machine.txt]}}\n",
    );
    await put(
      root,
      "dotfiles/external.machine-data.yaml",
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

  it.each([
    ["darwin", "macos", "shared"],
    ["linux", "shared", "macos"],
    ["windows", "shared", "macos"],
  ] as const)(
    "selects external.macos-data.yaml only for macOS (%s)",
    async (platform, selected, ignored) => {
      await put(
        root,
        "dotfiles/external.data.yaml",
        "repos:\n  example/repo:\n    destination: shared\n    entries: [payload.txt]\n",
      );
      await put(
        root,
        "dotfiles/external.macos-data.yaml",
        "repos:\n  example/repo:\n    destination: macos\n    entries: [payload.txt]\n",
      );
      await put(homeRoot, "mirrors/github.com/example/repo/payload.txt", "payload\n");
      await put(
        homeRoot,
        "mirrors/github.com/example/repo/.git/build-pull-time",
        `${Date.now()}\n`,
      );

      await runBuildInSubprocess(platform);

      assert.equal(await readFile(join(distRoot, selected, "payload.txt"), "utf8"), "payload\n");
      assert.equal(existsSync(join(distRoot, ignored, "payload.txt")), false);
    },
  );

  it("does not use combined OS and machine names as external or merge inputs", async () => {
    await put(root, "dotfiles/external.data.yaml", "repos: {}\n");
    await put(root, "dotfiles/settings.merge.yaml", "from: shared\n");
    await put(homeRoot, "settings.yaml", "home: true\n");
    const ordinaryNames = [
      "external.linux-machine-data.yaml",
      "settings.linux-machine-merge.yaml",
      "settings.linux-machine-merge-existing.yaml",
    ];
    for (const name of ordinaryNames) await put(root, `dotfiles/${name}`, "[\n");

    await main(root, "linux", homeRoot);

    assert.deepEqual(parseYaml(await readFile(join(distRoot, "settings.yaml"), "utf8")), {
      home: true,
      from: "shared",
    });
    for (const name of ordinaryNames)
      assert.equal(await readFile(join(distRoot, name), "utf8"), "[\n", name);
  });

  for (const { name, mode } of [
    { name: "runs run_after after a successful isolated external clone", mode: "clone" },
    {
      name: "aborts an isolated external clone failure without running run_after",
      mode: "clone-failure",
    },
    { name: "runs run_after when an isolated external pull changes HEAD", mode: "updated" },
    {
      name: "skips run_after when an isolated external pull leaves HEAD unchanged",
      mode: "unchanged",
    },
  ] as const) {
    it(name, async () => {
      const fixtureParent = "/tmp/work/dotfiles";
      await mkdir(fixtureParent, { recursive: true });
      const fixtureRoot = await mkdtemp(join(fixtureParent, "external-sync-test-"));
      try {
        const fixtureHome = join(fixtureRoot, "home");
        const mirrorDir = join(fixtureHome, "mirrors/github.com/example/fixture");
        const gitCalls = join(fixtureRoot, "git-calls.jsonl");
        const binDir = join(fixtureRoot, "bin");
        const isClone = mode === "clone" || mode === "clone-failure";
        const shouldRunAfter = mode === "clone" || mode === "updated";
        await mkdir(fixtureHome);
        if (!isClone) {
          await put(mirrorDir, "payload.txt", "source\n");
          await put(mirrorDir, ".git/fixture-head", "before\n");
          await put(mirrorDir, ".git/build-pull-time", "0\n");
        }
        const runAfterScript = `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(gitCalls)}, JSON.stringify(["run_after", process.cwd()]) + "\\n");
appendFileSync("run-after.txt", "ran\\n");
writeFileSync("payload.txt", "processed\\n");`;
        await put(
          fixtureRoot,
          "dotfiles/external.data.yaml",
          JSON.stringify({
            repos: {
              "example/fixture": {
                destination: "output",
                entries: ["payload.txt"],
                run_after: [[process.execPath, "-e", runAfterScript]],
              },
            },
          }),
        );
        await put(
          fixtureRoot,
          "bin/git",
          `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const rawArgs = process.argv.slice(2);
appendFileSync(${JSON.stringify(gitCalls)}, JSON.stringify(rawArgs) + "\\n");
const args =
  rawArgs[0] === "-c" && rawArgs[1] === "core.longpaths=true" ? rawArgs.slice(2) : rawArgs;
if (args[0] === "clone") {
  if (process.env.TEST_EXTERNAL_MODE === "clone-failure") {
    console.error("fixture clone failure");
    process.exit(1);
  }
  const mirror = args.at(-1);
  mkdirSync(join(mirror, ".git"), { recursive: true });
  writeFileSync(join(mirror, "payload.txt"), "source\\n");
} else if (args[0] === "-C" && args[2] === "rev-parse") {
  process.stdout.write(readFileSync(join(args[1], ".git/fixture-head"), "utf8"));
} else if (args[0] === "-C" && args[2] === "pull") {
  if (process.env.TEST_EXTERNAL_MODE === "updated") {
    writeFileSync(join(args[1], ".git/fixture-head"), "after\\n");
  }
} else if (args[0] !== "-C" || args[2] !== "clean") {
  console.error("unexpected fixture git command");
  process.exit(1);
}
`,
        );
        await chmod(join(binDir, "git"), 0o755);
        const startedAt = Date.now();
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `import { main } from ${JSON.stringify(join(import.meta.dir, "build.ts"))}; await main(${JSON.stringify(fixtureRoot)}, "linux", ${JSON.stringify(fixtureHome)});`,
          ],
          {
            cwd: fixtureRoot,
            env: {
              ...process.env,
              HOME: fixtureHome,
              TMPDIR: fixtureRoot,
              PATH: binDir,
              BUILD_FORCE_PULL: "0",
              TEST_EXTERNAL_MODE: mode,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        const calls = (await readFile(gitCalls, "utf8"))
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        const longPathArgs = ["-c", "core.longpaths=true"];
        const expectedCalls: string[][] = isClone
          ? [
              [
                ...longPathArgs,
                "clone",
                "--depth",
                "1",
                "--quiet",
                "https://github.com/example/fixture.git",
                mirrorDir,
              ],
            ]
          : [
              [...longPathArgs, "-C", mirrorDir, "rev-parse", "HEAD"],
              [...longPathArgs, "-C", mirrorDir, "pull", "--ff-only", "--quiet"],
              [...longPathArgs, "-C", mirrorDir, "rev-parse", "HEAD"],
            ];
        if (shouldRunAfter)
          expectedCalls.push(
            [...longPathArgs, "-C", mirrorDir, "clean", "-fdX"],
            ["run_after", mirrorDir],
          );
        assert.deepEqual(calls, expectedCalls);
        const outputPath = join(fixtureRoot, "dist/output/payload.txt");
        const runAfterPath = join(mirrorDir, "run-after.txt");
        if (mode === "clone-failure") {
          assert.notEqual(code, 0);
          assert.match(stderr, /git clone failed.*fixture clone failure/);
          assert.equal(existsSync(mirrorDir), false);
          assert.equal(existsSync(outputPath), false);
          assert.equal(existsSync(runAfterPath), false);
          return;
        }
        assert.equal(code, 0, stderr);
        assert.equal(stderr, "");
        const expectedPayload = shouldRunAfter ? "processed\n" : "source\n";
        assert.equal(await readFile(outputPath, "utf8"), expectedPayload);
        assert.equal(existsSync(runAfterPath), shouldRunAfter);
        if (shouldRunAfter) assert.equal(await readFile(runAfterPath, "utf8"), "ran\n");
        const recordedPull = Number(
          await readFile(join(mirrorDir, ".git/build-pull-time"), "utf8"),
        );
        assert.ok(recordedPull >= startedAt);
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });
  }

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
      `if (import.meta.main) {
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
if (import.meta.main) {
  const payload = await Bun.file("payload.txt").text();
  await appendFile("snapshot.txt", "source:" + payload);
  await Bun.write("settings.json", JSON.stringify(await Bun.file("settings.json").json()));
  await Bun.write("app.conf", (await Bun.file("app.conf").text()).trim());
}`;
    const replacementHook =
      'if (import.meta.main) await Bun.write("overwritten-ran.txt", "external");';
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
      'if (import.meta.main) await Bun.write("added-ran.txt", "external");',
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
      const scriptName = "vscode\\extensions.apply.ts";
      await put(
        root,
        "dotfiles/remap.data.md",
        "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode/extensions.apply.ts |  | - |  |\n",
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
      const platformShim = join(root, "platform-shim.ts");
      await put(
        root,
        "platform-shim.ts",
        `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`,
      );
      const proc = Bun.spawn(
        [
          process.execPath,
          "--preload",
          platformShim,
          "--preload",
          join(import.meta.dir, "hook-context.ts"),
          join(root, "dotfiles/.gitconfig.build.ts"),
        ],
        {
          env: {
            ...process.env,
            HOME: homeRoot,
            PATH: "",
            BUILD_FORCE_PULL: "0",
            DOTFILES_DIST_DIR: join(root, "dist"),
            DOTFILES_HOME_ROOT: homeRoot,
            DOTFILES_MANAGER_SRC: import.meta.dir,
          },
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

      const child = Bun.spawn([process.execPath, join(root, "dotfiles/.gitconfig.build.ts")], {
        env: {
          ...process.env,
          HOME: homeRoot,
          PATH: join(root, "bin"),
          BUILD_FORCE_PULL: force ? "1" : "0",
          TEST_GIT_FAIL: fail ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
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
      join(import.meta.dir, "../../dotfiles/.gitconfig.machine-build.ts.sample"),
      "utf-8",
    );
    await put(root, "dotfiles/.gitconfig.machine-build.ts", hook);
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
  function mergeCall(path: string, patch: Record<string, unknown>, expectedError?: RegExp): string {
    const call = `merge(${JSON.stringify(path)}, ${JSON.stringify(patch)})`;
    return `
      import assert from "node:assert/strict";
      const { merge } = await loadHookContext();
      await ${expectedError ? `assert.rejects(async () => ${call}, ${expectedError})` : call};
    `;
  }

  const mergeCases = [
    {
      format: "json",
      base: '{ // retained settings\n "nested": { "keep": 10.00 }, "items": [1] }',
      patch: { nested: { added: true }, "items.$append": [2] },
      expected:
        '{\n  "nested": {\n    "keep": 10.00,\n    "added": true\n  },\n  "items": [\n    1,\n    2\n  ]\n}\n',
    },
    {
      format: "yaml",
      base: "nested:\n  keep: yes\nitems: [1]\n",
      patch: { nested: { added: true }, "items.$append": [2] },
      expected: "nested:\n  keep: yes\n  added: true\nitems:\n  - 1\n  - 2\n",
    },
    {
      format: "toml",
      base: 'items = [1]\n[nested]\nkeep = "yes"\n',
      patch: { nested: { added: true }, "items.$append": [2] },
      expected: 'items = [ 1, 2 ]\n\n[nested]\nkeep = "yes"\nadded = true\n',
    },
    {
      format: "ini",
      base: "[Nested]\nKeep=yes\nDelete=old\n",
      patch: { Nested: { Added: "new", "Delete.$unset": "true" } },
      expected: "[Nested]\nKeep=yes\nAdded=new\n",
    },
  ];

  for (const { format, base, patch, expected } of mergeCases) {
    it(`merges a ${format} patch into the dist target using sidecar rules`, async () => {
      const target = `settings.${format}`;
      await put(root, `dotfiles/app/${target}`, base);
      await put(root, "dotfiles/app/patch.build.ts", mergeCall(target, patch));

      await main(root, "linux", homeRoot);

      assert.equal(await readFile(join(distRoot, "app", target), "utf8"), expected);
    });
  }

  it("keeps the order of TOML operations across root and table keys", async () => {
    await put(root, "dotfiles/settings.toml", 'keep = "yes"\n[nested]\nitems = [1]\n');
    await put(
      root,
      "dotfiles/patch.build.ts",
      mergeCall("settings.toml", { nested: { "items.$append": [2] }, "nested.$unset": true }),
    );

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "settings.toml"), "utf8"), 'keep = "yes"\n');
  });

  for (const platform of ["windows", "linux"] as const) {
    it(`builds the shared Playwright config for ${platform}`, async () => {
      const source = join(import.meta.dir, "..", "..", "dotfiles");
      for (const path of [
        "remap.data.md",
        ".playwright/cli.config.json",
        ".playwright/cli.config.windows-build.ts",
      ]) {
        await put(root, `dotfiles/${path}`, await readFile(join(source, path)));
      }
      const target = join(".playwright", "cli.config.json");
      await put(homeRoot, target, '{"outputDir":"stale"}');

      await main(root, platform, homeRoot);

      const expectedDir = platform === "windows" ? join(tmpdir(), "playwright") : "/tmp/playwright";
      assert.deepEqual(await Bun.file(join(distRoot, target)).json(), { outputDir: expectedDir });
      assert.equal(await Bun.file(join(homeRoot, target)).text(), '{"outputDir":"stale"}');
    });
  }

  it("rejects a merge target with an unsupported extension", async () => {
    await put(root, "dotfiles/settings.conf", "unchanged\n");
    await put(
      root,
      "dotfiles/patch.build.ts",
      mergeCall("settings.conf", {}, /unsupported merge format.*settings\.conf/),
    );

    await main(root, "linux", homeRoot);
    assert.equal(await readFile(join(distRoot, "settings.conf"), "utf8"), "unchanged\n");
  });

  it("does not create a missing merge target", async () => {
    await put(
      root,
      "dotfiles/patch.build.ts",
      mergeCall("missing.json", { added: true }, /ENOENT.*missing\.json/),
    );

    await main(root, "linux", homeRoot);
    assert.equal(existsSync(join(distRoot, "missing.json")), false);
  });

  it("rejects a target outside the hook directory", async () => {
    await put(root, "dotfiles/settings.json", "{}\n");
    await put(
      root,
      "dotfiles/app/patch.build.ts",
      mergeCall("../settings.json", { added: true }, /outside the hook directory/),
    );

    await main(root, "linux", homeRoot);
    assert.equal(await readFile(join(distRoot, "settings.json"), "utf8"), "{}\n");
  });

  it("runs a transform hook that rewrites a dist file's content with normalized trailing newline", async () => {
    await put(root, "dotfiles/app.conf", "mode=dev");
    await put(
      root,
      "dotfiles/app.conf.build.ts",
      [
        `if (import.meta.main) {`,
        `  const { transform } = await loadHookContext();`,
        `  await transform("app.conf", (content: string) => content + "mode=prod\\n");`,
        `}`,
      ].join("\n"),
    );

    await main(root, "linux", homeRoot);

    assert.equal(await readFile(join(distRoot, "app.conf"), "utf8"), "mode=dev\nmode=prod\n");
  });

  it("skips transform when the dist-side target does not exist", async () => {
    await put(
      root,
      "dotfiles/minify.build.ts",
      [
        `if (import.meta.main) {`,
        `  const { transform } = await loadHookContext();`,
        `  await transform("missing.json", (content: string) => content);`,
        `}`,
      ].join("\n"),
    );

    await main(root, "linux", homeRoot);

    assert.equal(existsSync(join(distRoot, "missing.json")), false);
  });

  it("runs a TypeScript hook in its dist folder without requiring a shebang", async () => {
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `import { writeFile } from "node:fs/promises";\nif (import.meta.main) {\n  await writeFile("hook-cwd.txt", JSON.stringify([process.cwd(), import.meta.dir]));\n}\n`,
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
        `if (import.meta.main) {`,
        `  const context = await loadHookContext();`,
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
        `if (import.meta.main) {`,
        `  const context = await loadHookContext();`,
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
          `if (import.meta.main) {`,
          `  const context = await loadHookContext();`,
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
      `if (import.meta.main) {
  const context = await loadHookContext();
  const paths = context.resolvePaths("settings.json");
  const homeContent = await Bun.file(paths.homePath).text();
  await Bun.write("hook-ran.txt", JSON.stringify({ cwd: process.cwd(), paths, homeContent }));
}`,
    );
    const hookEvents: string[] = [];

    await main(root, "linux", homeRoot, {
      onHookEvent: (path, status) => hookEvents.push(`${path}:${status}`),
    });

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
      `if (import.meta.main) {
  await Bun.write("mutated.txt", "ran");
  process.chdir("..");
  process.env.BUILD_HOOK_ISOLATION = "changed";
  (globalThis as Record<string, unknown>).buildHookMemory = "changed";
}`,
    );
    await put(
      root,
      "dotfiles/nested/02-observe.build.ts",
      `if (import.meta.main) {
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
      `import { writeFile } from "node:fs/promises";\nif (import.meta.main) { await writeFile("hook-ran.txt", "ran\\n"); }`,
    );

    await main(root, "darwin", homeRoot, {
      onHookEvent: (path, status) => {
        if (status === "start") hookEvents.push(path);
      },
    });

    assert.deepEqual(hookEvents, []);
    assert.equal(existsSync(join(distRoot, "vscode")), false);
  });
  it("rejects a machine hook with an unsupported extension during discovery", async () => {
    await put(root, "dotfiles/vscode/local.machine-build.sh", "echo hook output\n");
    await assert.rejects(
      main(root, "linux", homeRoot),
      /build hook has unsupported extension: vscode\/local\.machine-build\.sh/,
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
  {
    captureLogTimes = false,
    stdin,
    onOutput,
  }: {
    captureLogTimes?: boolean;
    stdin?: string;
    onOutput?: (channel: "stdout" | "stderr", output: string) => Promise<void>;
  } = {},
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
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderrOutput] = await Promise.all([
    child.exited,
    readOutput(child.stdout, "stdout"),
    readOutput(child.stderr, "stderr"),
  ]);
  const marker = stderrOutput.lastIndexOf("\n__LOG_TIMES__");
  const logTimes = marker === -1 ? [] : JSON.parse(stderrOutput.slice(marker + 14));
  const stderr = marker === -1 ? stderrOutput : stderrOutput.slice(0, marker);
  return { code, stdout, stderr, logTimes };

  async function readOutput(
    stream: ReadableStream<Uint8Array>,
    channel: "stdout" | "stderr",
  ): Promise<string> {
    if (!onOutput) return new Response(stream).text();
    let output = "";
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      output += chunk;
      await onOutput(channel, output);
    }
    return output;
  }
}

describe("manager CLI", () => {
  for (const command of ["diff", "managed"]) {
    it(`logs each stage and build hook in order for ${command}`, async () => {
      await put(root, "dotfiles/nested/01-local.machine-build.ts", "if (import.meta.main) {};");
      await put(root, "dotfiles/nested/02-shared.build.ts", "if (import.meta.main) {};");
      await put(root, "dotfiles/new.txt", "content\n");

      const result = await runManager(command);

      assert.equal(result.code, 0, result.stderr);
      const logs = result.stdout
        .split("\n")
        .filter((line) => /^(\[build\] |  \[|\[apply\] |stage |command )/.test(line))
        .map((line) => line.replace(/\(\d+\.\d{2}s\)$/, "(TIME)"));
      assert.deepEqual(logs, [
        "[build] Started",
        "  [build] rebuild dist (TIME)",
        "  [build] path map (TIME)",
        "  [build] externals (TIME)",
        "  [build] merge (TIME)",
        "  [build] replace (TIME)",
        "  [nested/01-local.machine-build.ts] Started",
        "  [nested/01-local.machine-build.ts] ✓ Complete (TIME)",
        "  [nested/02-shared.build.ts] Started",
        "  [nested/02-shared.build.ts] ✓ Complete (TIME)",
        "[build] Complete (TIME)",
        `stage ${command} start`,
        `stage ${command} success (TIME)`,
        `command ${command} success (TIME)`,
      ]);
      assert.doesNotMatch(result.stdout, new RegExp(`^stage ${command} start \\(`, "m"));
    });
  }

  it("groups timed build steps separately from compact hook outcomes", async () => {
    await put(root, "dotfiles/alpha/cli.build.ts", 'console.log("cache reused");');
    await put(root, "dotfiles/beta/cli.build.ts", "");
    await put(root, "dotfiles/gitconfig.machine-build.ts", "");
    await put(root, "dotfiles/sync.apply.ts", 'process.stdout.write("unchanged");');
    await put(homeRoot, "alpha/ignored.txt", "keep");
    await put(homeRoot, "beta/ignored.txt", "keep");

    const result = await runManager("apply");

    assert.equal(result.code, 0, result.stderr);
    const output = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) =>
        line
          .replace(/\d+\.\d{2}s/g, "TIME")
          .replace(/ {2,}(?=\S)/g, " ")
          .trim(),
      );
    assert.deepEqual(output, [
      "Build",
      "Steps",
      "rebuild dist TIME",
      "path map TIME",
      "externals TIME",
      "merge TIME",
      "replace TIME",
      "Hooks",
      "gitconfig.machine TIME",
      "alpha/cli",
      "cache reused",
      "complete TIME",
      "beta/cli TIME",
      "✓ Build complete TIME",
      "",
      "Apply",
      "Check differences (TIME)",
      "No managed file changes",
      "Hooks",
      "sync",
      "unchanged",
      "complete TIME",
      "✓ Apply complete TIME",
      "",
      "✓ Done TIME",
    ]);
  });

  it("keeps the hook paths when normal and post hook names would collide", async () => {
    await put(root, "dotfiles/tool/refresh.apply.ts", "");
    await put(root, "dotfiles/tool/refresh.postapply.ts", "");

    const result = await runManager("apply");

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /tool\/refresh\.apply\.ts +\d+\.\d{2}s/);
    assert.match(result.stdout, /tool\/refresh\.postapply\.ts +\d+\.\d{2}s/);
  });

  it("preserves multiline or long hook stdout and forwards hook stderr", async () => {
    const longLine = "x".repeat(81);
    await put(
      root,
      "dotfiles/multiline.build.ts",
      'process.stdout.write("fir"); await Bun.sleep(30); process.stdout.write("st\\n\\n  second");',
    );
    await put(
      root,
      "dotfiles/long.apply.ts",
      "console.log(" + JSON.stringify(longLine) + '); console.error("warning");',
    );

    const result = await runManager("apply");

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /^    multiline\n      first\n      \n        second\n      complete +\d+\.\d{2}s$/m,
    );
    assert.ok(result.stdout.includes("    long\n      " + longLine + "\n"), result.stdout);
    assert.equal(result.stderr, "    long\n      warning\n");
  });

  it("retains errors and the full path when an apply hook fails", async () => {
    await put(
      root,
      "dotfiles/broken.apply.ts",
      'console.log("diagnostics"); console.error("original error"); process.exit(9);',
    );
    await put(root, "dotfiles/after.postapply.ts", 'console.log("ran");');

    const result = await runManager("apply");

    assert.equal(result.code, 1);
    assert.match(result.stdout, /^    broken\n      diagnostics\n      ✗ Failed +\d+\.\d{2}s/m);
    assert.ok(result.stdout.includes(join(distRoot, "broken.apply.ts")), result.stdout);
    assert.match(result.stdout, /^    after\n      ran\n      complete +\d+\.\d{2}s$/m);
    assert.match(result.stdout, /^✗ Apply failed +\d+\.\d{2}s$/m);
    assert.match(result.stdout, /^✗ Failed +\d+\.\d{2}s$/m);
    assert.equal(
      result.stderr,
      "    broken\n      original error\napply script failed: broken.apply.ts (exit code 9)\n",
    );
  });

  it("preserves the original hook stdout when cleanup fails after a successful process", async () => {
    await put(
      root,
      "dotfiles/cleanup.apply.ts",
      `import { mkdir, unlink } from "node:fs/promises";
await unlink(import.meta.path);
await mkdir(import.meta.path);
process.stdout.write("child finished\\r\\n");`,
    );

    const result = await runManager("apply");

    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes("    cleanup\n      child finished\r\n"), result.stdout);
    assert.match(result.stderr, /apply script failed: cleanup\.apply\.ts: copy cleanup failed:/);
  });

  it("streams nested stdout and stderr before parallel hooks can finish", async () => {
    const stdoutSeen = join(root, "stdout-seen");
    const stderrSeen = join(root, "stderr-seen");
    const waitForMarker =
      'async function waitForMarker(path) { const deadline = Date.now() + 3000; while (!(await Bun.file(path).exists())) { if (Date.now() > deadline) throw new Error("output was not streamed"); await Bun.sleep(10); } }';
    await put(
      root,
      "dotfiles/first.apply.ts",
      waitForMarker +
        '\nconsole.log("first line"); await waitForMarker(' +
        JSON.stringify(stderrSeen) +
        '); console.log("last line");',
    );
    await put(
      root,
      "dotfiles/second.apply.ts",
      waitForMarker +
        "\nawait waitForMarker(" +
        JSON.stringify(stdoutSeen) +
        '); console.error("warning"); await waitForMarker(' +
        JSON.stringify(stderrSeen) +
        ");",
    );

    const result = await runManager("apply", {
      onOutput: async (channel, output) => {
        if (channel === "stdout" && output.includes("    first\n      first line\n")) {
          await writeFile(stdoutSeen, "");
        }
        if (channel === "stderr" && output.includes("    second\n      warning\n")) {
          await writeFile(stderrSeen, "");
        }
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /^    first\n      first line\n[\s\S]*^    first\n      last line$/m,
    );
    assert.match(result.stdout, /^    second\n      complete +\d+\.\d{2}s$/m);
    assert.equal(result.stderr, "    second\n      warning\n");
  });

  it("logs build completion without hook lines when there are no hooks", async () => {
    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /^\[build\] Started\n  \[build\] rebuild dist \(\d+\.\d{2}s\)\n  \[build\] path map \(\d+\.\d{2}s\)\n  \[build\] externals \(\d+\.\d{2}s\)\n  \[build\] merge \(\d+\.\d{2}s\)\n  \[build\] replace \(\d+\.\d{2}s\)\n\[build\] Complete \(\d+\.\d{2}s\)$/m,
    );
    assert.doesNotMatch(result.stdout, /^  \[(?!build\])/m);
  });

  it("does not add a blank line when a hook writes no stdout", async () => {
    await put(root, "dotfiles/quiet.build.ts", "if (import.meta.main) {};");

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
      'if (import.meta.main) { process.stdout.write("hook-output\\n"); }',
    );

    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.split("\n");
    const outputLine = lines.indexOf("  [output.build.ts] hook-output");
    assert.ok(outputLine >= 0, result.stdout);
    assert.match(lines[outputLine + 1], /^  \[output\.build\.ts\] ✓ Complete \(\d+\.\d{2}s\)$/);
  });

  for (const fails of [false, true]) {
    it(`logs a hook ${fails ? "failure" : "success"} on its own line after unterminated stdout`, async () => {
      await put(
        root,
        "dotfiles/output.build.ts",
        `if (import.meta.main) { process.stdout.write("hook-output"); ${fails ? 'throw new Error("failed");' : ""} }`,
      );

      const result = await runManager("managed");

      assert.equal(result.code, fails ? 1 : 0, result.stderr);
      const lines = result.stdout.split("\n");
      const outputLine = lines.indexOf("  [output.build.ts] hook-output");
      assert.equal(outputLine >= 0, true, result.stdout);
      assert.match(
        lines[outputLine + 1],
        new RegExp(
          `^  \\[output\\.build\\.ts\\] ${fails ? "✗ Failed" : "✓ Complete"} \\(\\d+\\.\\d{2}s\\)$`,
        ),
      );
    });
  }

  it("reports a managed stage duration matching its measured log interval", async () => {
    await put(root, "dotfiles/new.txt", "content\n");

    const result = await runManager("managed", { captureLogTimes: true });

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
      "if (import.meta.main) { await new Promise((resolve) => setTimeout(resolve, 150)); }",
    );

    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    for (const pattern of [
      /^  \[delayed\.build\.ts\] ✓ Complete \((\d+\.\d{2})s\)$/m,
      /^\[build\] Complete \((\d+\.\d{2})s\)$/m,
      /^command managed success \((\d+\.\d{2})s\)$/m,
    ]) {
      const elapsed = result.stdout.match(pattern);
      assert.ok(elapsed, `missing success log matching ${pattern}: ${result.stdout}`);
      const seconds = Number(elapsed[1]);
      assert.ok(seconds >= 0.1, `${pattern} elapsed ${seconds}s is below 0.10s`);
    }
  });

  for (const flags of [[], ["--yes"], ["--ask"]]) {
    const args = ["apply", ...flags];
    const shouldAsk = flags.includes("--ask");
    it(`${args.join(" ")} builds, displays the diff and applies ${shouldAsk ? "after confirmation" : "without confirmation"}`, async () => {
      await put(root, "dotfiles/file.txt", "new\n");
      await put(root, "dotfiles/done.apply.ts", 'await Bun.write("done.txt", "ran\\n");');
      await put(distRoot, "old.txt", "stale\n");

      const result = await runManager(args, shouldAsk ? { stdin: "y\n" } : {});

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Check differences [\s\S]*file\.txt/);
      assert.match(result.stdout, /^  1 added$/m);
      assert.doesNotMatch(result.stdout, /0 (?:changed|removed)|surplus \(ignored\)/);
      assert.equal(result.stdout.includes("Apply? [y/N]"), shouldAsk);
      if (shouldAsk) assert.match(result.stdout, /^Apply\? \[y\/N\] \n  1 added$/m);
      assert.equal(await readFile(join(homeRoot, "file.txt"), "utf8"), "new\n");
      assert.equal(await readFile(join(homeRoot, "done.txt"), "utf8"), "ran\n");
      assert.equal(existsSync(join(distRoot, "old.txt")), false);
    });
  }

  for (const command of [["diff"], ["apply", "--dry-run"]]) {
    it(`${command.join(" ")} builds and displays the diff without writing to home or running apply scripts`, async () => {
      await put(root, "dotfiles/file.txt", "new\n");
      await put(root, "dotfiles/done.apply.ts", 'await Bun.write("done.txt", "ran");');
      await put(homeRoot, "file.txt", "old\n");

      const result = await runManager(command);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^stage diff start$/m);
      assert.match(
        result.stdout,
        command[0] === "apply" ? /^✓ Done +\d+\.\d{2}s$/m : /^command diff success /m,
      );
      assert.match(result.stdout, /file\.txt/);
      assert.match(result.stdout, /old/);
      assert.match(result.stdout, /new/);
      assert.doesNotMatch(result.stdout, /Apply\? \[y\/N\]/);
      assert.equal(await readFile(join(distRoot, "file.txt"), "utf8"), "new\n");
      assert.equal(await readFile(join(homeRoot, "file.txt"), "utf8"), "old\n");
      assert.equal(existsSync(join(homeRoot, "done.txt")), false);
    });
  }

  for (const stdin of ["n\n", undefined]) {
    it(`apply --ask does not apply ${stdin ? "when declined" : "at end of input"}`, async () => {
      await put(root, "dotfiles/file.txt", "new\n");
      await put(root, "dotfiles/done.apply.ts", 'await Bun.write("done.txt", "ran");');
      await put(homeRoot, "file.txt", "old\n");

      const result = await runManager(["apply", "--ask"], { stdin });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Check differences .*1 changed/);
      assert.match(result.stdout, /file\.txt[\s\S]*Apply\? \[y\/N\][\s\S]*apply aborted/);
      assert.equal(await readFile(join(homeRoot, "file.txt"), "utf8"), "old\n");
      assert.equal(existsSync(join(homeRoot, "done.txt")), false);
    });
  }

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
      'if (import.meta.main) { process.stderr.write("hook-error\\n"); throw new Error("failed"); }',
    );
    await put(
      root,
      "dotfiles/02-late.build.ts",
      'if (import.meta.main) await Bun.write("late.txt", "ran");',
    );
    await put(root, "dotfiles/done.apply.ts", 'await Bun.write("done.txt", "ran");');

    const result = await runManager("apply");

    assert.equal(result.code, 1);
    assert.match(result.stderr, /hook-error\n/);
    assert.match(result.stderr, /local build hook failed: 01-fail\.build\.ts/);
    assert.match(result.stdout, /^Build$/m);
    assert.match(result.stdout, /^    01-fail\n      ✗ Failed +\d+\.\d{2}s /m);
    assert.ok(result.stdout.includes(join(distRoot, "01-fail.build.ts")), result.stdout);
    assert.match(result.stdout, /^✗ Build failed +\d+\.\d{2}s$/m);
    assert.match(result.stdout, /^✗ Failed +\d+\.\d{2}s$/m);
    assert.doesNotMatch(result.stdout, /02-late/);
    assert.doesNotMatch(result.stdout, /^Apply$/m);
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
    assert.match(result.stdout, /^\[build\] Complete \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^stage diff failure \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^command diff failure \(\d+\.\d{2}s\)$/m);
  });

  it("rejects invalid arguments without logs or rebuilding dist", async () => {
    await put(distRoot, "sentinel.txt", "keep\n");
    for (const args of [
      [],
      ["unknown"],
      ["apply", "extra"],
      ["apply", "--ask", "--dry-run"],
      ["apply", "--invalid"],
      ["diff", "--ask"],
      ["managed", "--dry-run"],
      ["diff", "--yes"],
    ]) {
      const result = await runManager(args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /usage: bun dotfiles-manager/);
      assert.equal(result.stdout, "");
      assert.equal(await readFile(join(distRoot, "sentinel.txt"), "utf8"), "keep\n");
    }
  });
});

describe("lnk declarations", () => {
  it.each([
    ["Tools.exact", "tools/EDIT.LNK..executable"],
    ["Tools.exact", "tools/EDIT.LNK .executable"],
    ["Tools.exact", "tools .exact/EDIT.LNK.executable"],
    ["ToolsΣ.exact", "toolsσ/EDIT.LNK.executable"],
  ])(
    "rejects a Windows home path collision between %s and %s",
    async (directory, conflictingPath) => {
      const declarationPath = `${directory}/Edit.lnk`;
      await put(distRoot, declarationPath, "target: invalid\n");
      await put(distRoot, conflictingPath, "other entry\n");

      await assert.rejects(convertLnkDeclarations(distRoot, "windows"), {
        message: `lnk ${declarationPath}: home path collision with ${conflictingPath}: ${directory.slice(0, -".exact".length)}/Edit.lnk`,
      });
    },
  );

  it.each(["linux", "darwin"] as const)(
    "removes unparsed declarations for %s",
    async (platform) => {
      const source = join(root, "dotfiles");
      const invalidDeclaration = Uint8Array.of(0xff);
      const binaryLink = lnkBytes("pwsh.exe", "-Command menu");
      await put(source, "Remove.LNK", invalidDeclaration);
      await put(source, "Keep.lnk", binaryLink);

      await main(root, platform, homeRoot);

      await assert.rejects(readFile(join(distRoot, "Remove.LNK")), { code: "ENOENT" });
      assert.deepEqual(new Uint8Array(await readFile(join(distRoot, "Keep.lnk"))), binaryLink);
      assert.deepEqual(
        new Uint8Array(await readFile(join(source, "Remove.LNK"))),
        invalidDeclaration,
      );
    },
  );
});

describe("lnk adoption", () => {
  it("does not descend through a linked home directory", async () => {
    const linkPath = "Menu/Edit.lnk";
    const distBytes = lnkBytes("pwsh.exe", "-Command menu", 1000n);
    const outside = join(root, "outside");
    await put(distRoot, `Tools.exact/${linkPath}`, distBytes);
    await put(outside, linkPath, lnkBytes("pwsh.exe", "-Command menu", 2000n));
    await symlink(outside, join(homeRoot, "Tools"), "junction");

    await adoptHomeLnkBytes(distRoot, homeRoot, new Set());

    assert.deepEqual(
      new Uint8Array(await readFile(join(distRoot, `Tools.exact/${linkPath}`))),
      distBytes,
    );
  });

  it("does not adopt a link through a mapped parent reference", async () => {
    const distBytes = lnkBytes("pwsh.exe", "-Command menu", 1000n);
    const distPath = "...exact/Edit.lnk";
    await put(distRoot, distPath, distBytes);
    await put(root, "Edit.lnk", lnkBytes("pwsh.exe", "-Command menu", 2000n));

    await adoptHomeLnkBytes(distRoot, homeRoot, new Set());

    assert.deepEqual(new Uint8Array(await readFile(join(distRoot, distPath))), distBytes);
  });

  it("leaves declaration-generated links as generated during build adoption", async () => {
    const name = "Edit.lnk";
    const generated = lnkBytes("pwsh.exe", "-Command menu", 1000n);
    await put(distRoot, name, generated);
    await put(homeRoot, name, lnkBytes("pwsh.exe", "-Command menu", 2000n));

    await adoptHomeLnkBytes(distRoot, homeRoot, new Set([name]));

    assert.deepEqual(new Uint8Array(await readFile(join(distRoot, name))), generated);
  });

  it.skipIf(process.platform !== "win32" || process.env.DOTFILES_TEST_PWSH_ALIAS !== "1")(
    "compares generated PowerShell alias settings without replacing matching files",
    async () => {
      const windowsApps = join(process.env.LOCALAPPDATA!, "Microsoft", "WindowsApps");
      const packageAlias = join(windowsApps, "Microsoft.PowerShell_8wekyb3d8bbwe", "pwsh.exe");
      const records = [
        { name: "Match.lnk", declaration: {} },
        { name: "Arguments.lnk", declaration: { arguments: "-NoLogo" } },
        { name: "WindowStyle.lnk", declaration: { windowStyle: "normal" } },
        {
          name: "Target.lnk",
          declaration: {
            target: join(
              process.env.SystemRoot!,
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
          },
        },
        { name: "RunAs.lnk", declaration: {} },
        { name: "UnknownBlock.lnk", declaration: {} },
      ];
      const defaults = { arguments: "-NoProfile", windowStyle: "minimized" };
      const source = join(root, "dotfiles");
      for (const { name, declaration } of records) {
        await put(homeRoot, name, JSON.stringify({ target: packageAlias, ...defaults }));
        await put(
          source,
          name,
          JSON.stringify({ target: "powershell", ...defaults, ...declaration }),
        );
      }
      await convertLnkDeclarations(homeRoot, "windows");
      const runAsName = "RunAs.lnk";
      const runAsBytes = await readFile(join(homeRoot, runAsName));
      const linkFlags = 0x14;
      const runAsUser = 0x2000;
      runAsBytes.writeUInt32LE(runAsBytes.readUInt32LE(linkFlags) | runAsUser, linkFlags);
      await put(homeRoot, runAsName, runAsBytes);

      const unknownBlockName = "UnknownBlock.lnk";
      const unknownBlockBytes = await readFile(join(homeRoot, unknownBlockName));
      const terminal = unknownBlockBytes.subarray(-4);
      assert.equal(terminal.readUInt32LE(), 0);
      const unknownBlock = Buffer.from("08000000ffff00a0", "hex");
      await put(
        homeRoot,
        unknownBlockName,
        Buffer.concat([unknownBlockBytes.subarray(0, -4), unknownBlock, terminal]),
      );

      const oldPath = process.env.Path;
      process.env.Path = `${windowsApps};${oldPath ?? ""}`;
      try {
        const generated = await main(root, "windows", homeRoot);
        const distPath = join(distRoot, "Match.lnk");
        const homePath = join(homeRoot, "Match.lnk");
        const distBefore = await readFile(distPath);
        const homeBefore = await readFile(homePath);
        assert.notDeepEqual(distBefore, homeBefore);
        const differences = await collectDifferences(distRoot, homeRoot, "win32", generated);
        assert.deepEqual(
          differences.unchanged.map(({ homePath }) => homePath),
          ["Match.lnk"],
        );
        assert.deepEqual(
          differences.changed.map(({ homePath }) => homePath),
          ["Arguments.lnk", "RunAs.lnk", "Target.lnk", "UnknownBlock.lnk", "WindowStyle.lnk"],
        );

        const applied = await applyDifferences(distRoot, homeRoot, differences, "win32");

        assert.deepEqual(
          applied.changed,
          differences.changed.map(({ homePath }) => homePath),
        );
        assert.deepEqual(await readFile(distPath), distBefore);
        assert.deepEqual(await readFile(homePath), homeBefore);
      } finally {
        if (oldPath === undefined) delete process.env.Path;
        else process.env.Path = oldPath;
      }
    },
    30000,
  );

  it("adopts matching home link bytes into dist during build", async () => {
    await put(join(root, "dotfiles"), "Main.ahk.lnk", lnkBytes("pwsh.exe", "-Command main", 1000n));
    await put(homeRoot, "Main.ahk.lnk", lnkBytes("pwsh.exe", "-Command main", 2000n));

    await main(root, "windows", homeRoot);

    const homeBytes = new Uint8Array(await readFile(join(homeRoot, "Main.ahk.lnk")));
    assert.deepEqual(new Uint8Array(await readFile(join(distRoot, "Main.ahk.lnk"))), homeBytes);
  });

  it("adopts a link under an .exact directory through the mapped home path", async () => {
    await put(
      join(root, "dotfiles"),
      "conf.exact/Menu.lnk",
      lnkBytes("pwsh.exe", "-Command menu", 1000n),
    );
    await put(homeRoot, "conf/Menu.lnk", lnkBytes("pwsh.exe", "-Command menu", 2000n));

    await main(root, "windows", homeRoot);

    const homeBytes = new Uint8Array(await readFile(join(homeRoot, "conf/Menu.lnk")));
    assert.deepEqual(
      new Uint8Array(await readFile(join(distRoot, "conf.exact/Menu.lnk"))),
      homeBytes,
    );
  });

  it("keeps binary link bytes when the readable text differs", async () => {
    const distBytes = lnkBytes("pwsh.exe", "-Command new");
    await put(join(root, "dotfiles"), "Main.ahk.lnk", distBytes);
    await put(homeRoot, "Main.ahk.lnk", lnkBytes("pwsh.exe", "-Command old"));

    await main(root, "windows", homeRoot);

    assert.deepEqual(new Uint8Array(await readFile(join(distRoot, "Main.ahk.lnk"))), distBytes);
  });

  it("keeps binary link bytes when neither side has readable strings", async () => {
    const distBytes = lnkBytes("", "", 1000n);
    await put(join(root, "dotfiles"), "tool.lnk", distBytes);
    await put(homeRoot, "tool.lnk", lnkBytes("", "", 2000n));

    await main(root, "windows", homeRoot);

    assert.deepEqual(new Uint8Array(await readFile(join(distRoot, "tool.lnk"))), distBytes);
  });
});

function lnkBytes(relativePath: string, commandLineArguments: string, timeValue = 0n): Uint8Array {
  const header = new Uint8Array(0x4c);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, header.length, true);
  header.set(Buffer.from("0114020000000000c000000000000046", "hex"), 4);
  headerView.setUint32(0x14, 0xa8, true);
  headerView.setBigInt64(0x1c, timeValue, true);
  headerView.setBigInt64(0x24, timeValue, true);
  headerView.setBigInt64(0x2c, timeValue, true);
  const strings = [relativePath, commandLineArguments].map((text) => {
    const bytes = new Uint8Array(2 + text.length * 2 + 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, text.length + 1, true);
    for (let index = 0; index < text.length; index++) {
      view.setUint16(2 + index * 2, text.charCodeAt(index), true);
    }
    return bytes;
  });
  const total = 0x4c + strings.reduce((sum, bytes) => sum + bytes.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of [header, ...strings]) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
