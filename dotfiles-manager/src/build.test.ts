import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

const autoUpdateReplacements = [{ pattern: "(EnableAutoUpdates)=.*", replacement: "${1}=false" }];

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
  it("loads external.data-machine.yaml instead of the old name and replaces the shared repo", async () => {
    const hook = await readFile(join(import.meta.dir, "../../dotfiles/external.build.ts"), "utf8");
    await put(root, "dotfiles/external.build.ts", hook);
    await put(
      root,
      "dotfiles/external.data.yaml",
      `externalSkills:
  example/repo:
    destination: shared
    entries: [shared.txt]
`,
    );
    await put(
      root,
      "dotfiles/external.data-machine.yaml",
      `externalSkills:
  example/repo:
    destination: machine
    entries: [machine.txt]
`,
    );
    await put(
      root,
      "dotfiles/external.data.machine.yaml",
      `externalSkills:
  example/repo:
    destination: old
    entries: [old.txt]
`,
    );
    await put(homeRoot, "mirrors/github.com/example/repo/shared.txt", "shared\n");
    await put(homeRoot, "mirrors/github.com/example/repo/machine.txt", "machine\n");
    await put(homeRoot, "mirrors/github.com/example/repo/old.txt", "old\n");
    await put(homeRoot, "mirrors/github.com/example/repo/.git/build-pull-time", `${Date.now()}\n`);
    await mkdir(join(root, "dotfiles-manager/node_modules"), { recursive: true });
    await symlink(
      join(import.meta.dir, "../node_modules/yaml"),
      join(root, "dotfiles-manager/node_modules/yaml"),
      "dir",
    );

    // Keep HOME and PATH scoped to the subprocess: the real hook uses HOME for its mirror.
    const build = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { main } from ${JSON.stringify(join(import.meta.dir, "build.ts"))}; await main(${JSON.stringify(root)}, "linux", ${JSON.stringify(homeRoot)});`,
      ],
      {
        env: { ...process.env, HOME: homeRoot, PATH: "", BUILD_FORCE_PULL: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(await readFile(join(distRoot, "machine/machine.txt"), "utf8"), "machine\n");
    assert.equal(existsSync(join(distRoot, "shared/shared.txt")), false);
    assert.equal(existsSync(join(distRoot, "old/old.txt")), false);
  });

  it("runs the root external hook before the path map so fetched entries are moved", async () => {
    const hook = await readFile(join(import.meta.dir, "../../dotfiles/external.build.ts"), "utf8");
    const standardHook = await readFile(
      join(import.meta.dir, "../../dotfiles/path-map.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/external.build.ts", hook);
    await put(
      root,
      "dotfiles/external.data.yaml",
      `externalSkills:
  GitAlias/gitalias:
    destination: .
    entries: [gitalias.txt]
`,
    );
    await put(root, "dotfiles/path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| gitalias.txt | .gitconfig.alias | - | - |\n",
    );
    await put(
      homeRoot,
      "mirrors/github.com/GitAlias/gitalias/gitalias.txt",
      "[alias]\nco = checkout\n",
    );
    await put(
      homeRoot,
      "mirrors/github.com/GitAlias/gitalias/.git/build-pull-time",
      `${Date.now()}\n`,
    );
    await mkdir(join(root, "dotfiles-manager/node_modules"), { recursive: true });
    await symlink(
      join(import.meta.dir, "../node_modules/yaml"),
      join(root, "dotfiles-manager/node_modules/yaml"),
      "dir",
    );

    // Keep HOME and PATH scoped to the subprocess: the real hook uses HOME for its mirror.
    const build = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { main } from ${JSON.stringify(join(import.meta.dir, "build.ts"))}; await main(${JSON.stringify(root)}, "linux", ${JSON.stringify(homeRoot)});`,
      ],
      {
        env: { ...process.env, HOME: homeRoot, PATH: "", BUILD_FORCE_PULL: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(
      await readFile(join(distRoot, ".gitconfig.alias"), "utf8"),
      "[alias]\nco = checkout\n",
    );
    assert.ok(!existsSync(join(distRoot, "gitalias.txt")));
  });
  it("skips the skill external hook whose folder the path map removes", async () => {
    const hook = await readFile(
      join(import.meta.dir, "../../dotfiles/.agents/skills.exact/external.build.ts"),
      "utf8",
    );
    const standardHook = await readFile(
      join(import.meta.dir, "../../dotfiles/path-map.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/.agents/skills.exact/external.build.ts", hook);
    await put(
      root,
      "dotfiles/.agents/skills.exact/external.data.yaml",
      `externalSkills:
  example/skill:
    destination: .agents/skills.exact
    entries: [skills/demo]
`,
    );
    await put(root, "dotfiles/path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| .agents | - |  |  |\n",
    );

    // Keep HOME and PATH scoped to the subprocess: a fetch would use HOME for its mirror.
    const build = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { main } from ${JSON.stringify(join(import.meta.dir, "build.ts"))}; await main(${JSON.stringify(root)}, "linux", ${JSON.stringify(homeRoot)});`,
      ],
      {
        env: { ...process.env, HOME: homeRoot, PATH: "", BUILD_FORCE_PULL: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    assert.equal(exitCode, 0, stderr);
    assert.ok(!existsSync(join(homeRoot, "mirrors")));
  });
  it("runs the skill external hook on linux where the path map keeps .agents", async () => {
    const hook = await readFile(
      join(import.meta.dir, "../../dotfiles/.agents/skills.exact/external.build.ts"),
      "utf8",
    );
    const standardHook = await readFile(
      join(import.meta.dir, "../../dotfiles/path-map.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/.agents/skills.exact/external.build.ts", hook);
    await put(
      root,
      "dotfiles/.agents/skills.exact/external.data.yaml",
      `externalSkills:
  example/skill:
    destination: .agents/skills.exact
    entries: [skills/demo]
`,
    );
    await put(root, "dotfiles/path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n",
    );
    await put(homeRoot, "mirrors/github.com/example/skill/skills/demo/SKILL.md", "demo\n");
    await put(homeRoot, "mirrors/github.com/example/skill/.git/build-pull-time", `${Date.now()}\n`);
    await mkdir(join(root, "dotfiles-manager/node_modules"), { recursive: true });
    await symlink(
      join(import.meta.dir, "../node_modules/yaml"),
      join(root, "dotfiles-manager/node_modules/yaml"),
      "dir",
    );

    // Keep HOME and PATH scoped to the subprocess: the real hook uses HOME for its mirror.
    const build = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { main } from ${JSON.stringify(join(import.meta.dir, "build.ts"))}; await main(${JSON.stringify(root)}, "linux", ${JSON.stringify(homeRoot)});`,
      ],
      {
        env: { ...process.env, HOME: homeRoot, PATH: "", BUILD_FORCE_PULL: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(
      await readFile(join(distRoot, ".agents/skills.exact/demo/SKILL.md"), "utf8"),
      "demo\n",
    );
  });
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

  it("skips a hook whose folder the path-map standard hook moved", async () => {
    const standardHook = await readFile(
      join(import.meta.dir, "../../dotfiles/path-map.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode | mapped-vscode | - | - |\n",
    );
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `import { writeFile } from "node:fs/promises";\nexport default async function () {\n  await writeFile("hook-ran.txt", process.cwd());\n}\n`,
    );

    await main(root, "linux", homeRoot);

    assert.ok(!existsSync(join(distRoot, "vscode/hook-ran.txt")));
    assert.ok(!existsSync(join(distRoot, "mapped-vscode/hook-ran.txt")));
  });
  it("skips a hook whose mapped folder is removed", async () => {
    const standardHook = await readFile(
      join(import.meta.dir, "../../dotfiles/path-map.build.ts"),
      "utf-8",
    );
    await put(root, "dotfiles/path-map.build.ts", standardHook);
    await put(
      root,
      "dotfiles/remap.data.md",
      "| key | linux | windows | macos |\n| --- | --- | --- | --- |\n| vscode | - | - | - |\n",
    );
    await put(
      root,
      "dotfiles/vscode/format-settings.build.ts",
      `import { writeFile } from "node:fs/promises";\nexport default async function () {\n  await writeFile("hook-ran.txt", process.cwd());\n}\n`,
    );

    await main(root, "linux", homeRoot);

    assert.ok(!existsSync(join(distRoot, "vscode")));
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
  if (line.startsWith("stage managed start "))
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
        .filter((line) => /^(Build |  Running |  [✓✗] |stage |command )/.test(line))
        .map((line) => line.replace(/\(\d+\.\d{2}s\)$/, "(TIME)"));
      assert.deepEqual(logs, [
        "Build started",
        "  Running nested/01-local.build-machine.ts",
        "  ✓ nested/01-local.build-machine.ts (TIME)",
        "  Running nested/02-shared.build.ts",
        "  ✓ nested/02-shared.build.ts (TIME)",
        "Build complete (TIME)",
        `stage ${command} start (TIME)`,
        `stage ${command} success (TIME)`,
        `command ${command} success (TIME)`,
      ]);
      assert.match(result.stdout, new RegExp(`^stage ${command} start \\(0\\.00s\\)$`, "m"));
    });
  }

  it("logs build completion without hook lines when there are no hooks", async () => {
    const result = await runManager("managed");

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Build started\nBuild complete \(\d+\.\d{2}s\)$/m);
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
    const stageStart = result.logTimes.find(({ line }) => line.startsWith("stage managed start "));
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

  it("stops after a failed build without applying", async () => {
    await put(root, "dotfiles/file.txt", "new\n");
    await put(
      root,
      "dotfiles/fail.build.ts",
      'export default function () { process.stderr.write("hook-error\\n"); throw new Error("failed"); }',
    );

    const result = await runManager("apply");

    assert.equal(result.code, 1);
    assert.match(result.stderr, /hook-error\n/);
    assert.match(result.stderr, /local build hook failed: fail\.build\.ts/);
    assert.match(result.stdout, /^Build started$/m);
    assert.match(result.stdout, /^  Running fail\.build\.ts$/m);
    assert.match(result.stdout, /^  ✗ fail\.build\.ts \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^Build failed \(\d+\.\d{2}s\)$/m);
    assert.match(result.stdout, /^command apply failure \(\d+\.\d{2}s\)$/m);
    assert.doesNotMatch(result.stdout, /^stage apply start /m);
    assert.equal(existsSync(join(homeRoot, "file.txt")), false);
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
