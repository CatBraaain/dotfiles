import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { run } from "./pre-chezmoi";

const fixtureRoots: string[] = [];
const script = join(import.meta.dir, "pre-chezmoi.ts");

const linuxDestinations = {
  docker: "dot_docker/desktop",
  erdtree: "dot_config/erdtree",
  "git-cliff": "dot_config/git-cliff",
  zed: "dot_config/zed",
};

const linuxUnmovedDirectories = [
  "gemini",
  "mise",
  "nushell",
  "obs-studio",
  "powershell",
  "windows-terminal",
  "roo",
  "sharex",
  "vscode",
];

const windowsDestinations = {
  docker: "AppData/Roaming/Docker",
  erdtree: "AppData/Roaming/erdtree",
  gemini: "dot_gemini",
  "git-cliff": "AppData/Roaming/git-cliff",
  mise: "dot_config/mise",
  nushell: "AppData/Roaming/nushell",
  "obs-studio": "AppData/Roaming/obs-studio",
  powershell: "Documents/PowerShell",
  "windows-terminal": "AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState",
  roo: "dot_roo",
  sharex: "Documents/ShareX",
  vscode: "AppData/Roaming/Code/User",
  zed: "AppData/Roaming/Zed",
};

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(files: Record<string, string>, prefix = "pre-chezmoi-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const json = (value: unknown) => JSON.stringify(value);

async function runCli(root: string): Promise<void> {
  const process = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });
  assert.equal(await process.exited, 0, await new Response(process.stderr).text());
}

async function expectCliError(files: Record<string, string>, message: string): Promise<void> {
  const root = await fixture(files);
  const process = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });

  assert.equal(await process.exited, 1);
  assert.equal(await new Response(process.stderr).text(), `${message}\n`);
}

describe("pre-chezmoi", () => {
  it("rebuilds dist without node_modules and moves every non-Windows directory", async () => {
    const root = await fixture({
      "dist/stale": "stale",
      "dotfiles/node_modules/ignored": "ignored",
      "dotfiles/nested/node_modules/ignored": "ignored",
      "dotfiles/.docker/desktop/replaced": "replaced",
      "dotfiles/custom/settings.json": "{}",
      "dotfiles/docker/settings-store.merge.json": "{}",
      ...Object.fromEntries(
        Object.keys(linuxDestinations).map((source) => [`dotfiles/${source}/settings.json`, "{}"]),
      ),
      ...Object.fromEntries(
        linuxUnmovedDirectories.map((source) => [`dotfiles/${source}/settings.json`, "{}"]),
      ),
    });

    await runCli(root);

    assert.equal(existsSync(join(root, "dist/stale")), false);
    assert.equal(existsSync(join(root, "dist/node_modules")), false);
    assert.equal(existsSync(join(root, "dist/nested/node_modules")), false);
    assert.equal(existsSync(join(root, "dist/custom/settings.json")), true);
    for (const destination of Object.values(linuxDestinations)) {
      assert.equal(existsSync(join(root, "dist", destination, "settings.json")), true);
    }
    for (const source of linuxUnmovedDirectories) {
      assert.equal(existsSync(join(root, "dist", source, "settings.json")), true, source);
    }
    assert.equal(existsSync(join(root, "dist/dot_docker/desktop/replaced")), false);
    assert.equal(
      existsSync(join(root, "dist/dot_docker/desktop/modify_settings-store.json")),
      true,
    );
  });

  it("moves every Windows directory and leaves non-mapped directories at the root", async () => {
    const root = await fixture({
      "dotfiles/AppData/Roaming/Docker/replaced": "replaced",
      "dotfiles/custom/settings.json": "{}",
      ...Object.fromEntries(
        Object.keys(windowsDestinations).map((source) => [
          `dotfiles/${source}/settings.json`,
          "{}",
        ]),
      ),
    });

    await run(root, "win32");

    assert.equal(existsSync(join(root, "dist/custom/settings.json")), true);
    for (const destination of Object.values(windowsDestinations)) {
      assert.equal(existsSync(join(root, "dist", destination, "settings.json")), true);
    }
    assert.equal(existsSync(join(root, "dist/AppData/Roaming/Docker/replaced")), false);
  });

  it("deep-merges normal keys before applying overwrite operations", async () => {
    const root = await fixture({
      "dotfiles/settings.json": json({
        packages: [{ source: "keep" }, { source: "remove" }],
        tags: ["keep", "remove"],
        tiers: { high: "high", low: "low" },
        enabledModels: ["old"],
        nested: { keep: true, remove: true },
        replaceMe: ["old"],
      }),
      "dotfiles/settings.overwrite.json": json({
        theme: "light",
        nested: { added: true },
        "packages.$remove": [{ source: "remove" }],
        "packages.$append": [{ source: "keep" }, { source: "added" }],
        "tags.$remove": ["remove"],
        "tags.$append": ["keep", "added"],
        "tiers.$remove": ["high"],
        "nested.remove.$unset": true,
        "missing.$unset": true,
        "enabledModels.$replace": ["zai/**", "openrouter/**"],
        "replaceMe.$append": "ignored because replace wins",
        "replaceMe.$replace": ["replacement"],
        "missing.$remove": ["anything"],
        "alsoMissing.$replace": "ignored",
      }),
    });

    await run(root);

    const expected = {
      packages: [{ source: "keep" }, { source: "added" }],
      tags: ["keep", "added"],
      tiers: { low: "low" },
      enabledModels: ["zai/**", "openrouter/**"],
      nested: { keep: true, added: true },
      replaceMe: ["replacement"],
      theme: "light",
    };
    const output = await readFile(join(root, "dist/settings.json"), "utf-8");
    assert.equal(output, `${JSON.stringify(expected, null, 2)}\n`);
    assert.equal(existsSync(join(root, "dist/settings.overwrite.json")), false);
  });

  it("replaces normal keys of non-object types in nested files", async () => {
    const root = await fixture({
      "dotfiles/nested/settings.json": json({
        scalar: "base",
        array: ["base"],
        object: { keep: true },
      }),
      "dotfiles/nested/settings.overwrite.json": json({
        scalar: { replacement: true },
        array: { replacement: true },
        object: "replacement",
      }),
    });

    await run(root);

    const output = await readFile(join(root, "dist/nested/settings.json"), "utf-8");
    assert.equal(
      output,
      `${JSON.stringify(
        { scalar: { replacement: true }, array: { replacement: true }, object: "replacement" },
        null,
        2,
      )}\n`,
    );
  });

  it("deep-merges YAML and combines repeated operation keys", async () => {
    const root = await fixture({
      "dotfiles/settings.yaml":
        "packages:\n  - source: keep\nnested:\n  keep: true\n  drop: base\ntheme: base\n",
      "dotfiles/settings.overwrite.yaml": [
        "nested:",
        "  added: true",
        "nested.drop.$unset:",
        "packages.$append:",
        "  - source: added-one",
        "packages.$append:",
        "  - source: keep",
        "  - source: added-two",
        "theme.$replace: first",
        "theme.$replace: final",
        "",
      ].join("\n"),
    });

    await run(root);

    const output = await readFile(join(root, "dist/settings.yaml"), "utf-8");
    assert.equal(
      output,
      "packages:\n  - source: keep\n  - source: added-one\n  - source: added-two\nnested:\n  keep: true\n  added: true\ntheme: final\n",
    );
  });

  it("converts merge files to JSONC and YAML modify templates", async () => {
    const root = await fixture({
      "dotfiles/settings.merge.json": '{\n  // comment\n  "theme": "dark"\n}',
      "dotfiles/settings.merge.yaml": "theme: dark\n",
    });

    await run(root);

    const jsonTemplate = await readFile(join(root, "dist/modify_settings.json"), "utf-8");
    const yamlTemplate = await readFile(join(root, "dist/modify_settings.yaml"), "utf-8");
    assert.match(jsonTemplate, /mergeOverwrite/);
    assert.match(jsonTemplate, /fromJsonc/);
    assert.match(jsonTemplate, /\/\/ comment/);
    assert.match(yamlTemplate, /mergeOverwrite/);
    assert.match(yamlTemplate, /fromYaml/);
    assert.equal(existsSync(join(root, "dist/settings.merge.json")), false);
    assert.equal(existsSync(join(root, "dist/settings.merge.yaml")), false);
  });

  it("converts nested dot entries and exact and executable directories by entry type", async () => {
    const root = await fixture({
      "dotfiles/.config/.gitconfig": "config",
      "dotfiles/.pi/agent/skills.exact/skill": "skill",
      "dotfiles/.pi.exact/agent/skill": "skill",
      "dotfiles/memo.exact": "memo",
      "dotfiles/bin/setup.executable": "setup",
      "dotfiles/bin.executable/child": "child",
      "dotfiles/.chezmoiignore": "ignored",
    });

    await run(root);

    assert.equal(existsSync(join(root, "dist/dot_config/dot_gitconfig")), true);
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/exact_skills/skill")), true);
    assert.equal(existsSync(join(root, "dist/exact_dot_pi/agent/skill")), true);
    assert.equal(existsSync(join(root, "dist/memo.exact")), true);
    assert.equal(existsSync(join(root, "dist/bin/executable_setup")), true);
    assert.equal(existsSync(join(root, "dist/bin.executable/child")), true);
    assert.equal(existsSync(join(root, "dist/.chezmoiignore")), true);
  });

  it("reports every specified overwrite error through the CLI", async () => {
    await expectCliError(
      { "dotfiles/settings.overwrite.json": "{}" },
      "overwrite target not found: dist/settings.json",
    );
    await expectCliError(
      { "dotfiles/settings.json": "{}", "dotfiles/settings.overwrite.json": '{"a.$unknown": 1}' },
      "invalid overwrite op key: a.$unknown",
    );
    await expectCliError(
      {
        "dotfiles/settings.json": "{}",
        "dotfiles/settings.overwrite.json": '{"a[0].$append": []}',
      },
      "invalid overwrite op key: a[0].$append",
    );
    await expectCliError(
      {
        "dotfiles/settings.json": '{"items": "not an array"}',
        "dotfiles/settings.overwrite.json": '{"items.$append": []}',
      },
      "overwrite append requires array at path: items",
    );
    await expectCliError(
      {
        "dotfiles/settings.json": '{"items": "not removable"}',
        "dotfiles/settings.overwrite.json": '{"items.$remove": []}',
      },
      "overwrite remove requires array or object at path: items",
    );
    await expectCliError(
      {
        "dotfiles/settings.json": '{"items": []}',
        "dotfiles/settings.overwrite.json": '{"items.$append": "no"}',
      },
      "overwrite append value must be array: items.$append",
    );
    await expectCliError(
      {
        "dotfiles/settings.json": '{"items": []}',
        "dotfiles/settings.overwrite.json": '{"items.$remove": "no"}',
      },
      "overwrite remove value must be array: items.$remove",
    );
    await expectCliError(
      {
        "dotfiles/settings.json": '{"items": {}}',
        "dotfiles/settings.overwrite.json": '{"items.$remove": [1]}',
      },
      "overwrite remove object keys must be strings: items.$remove",
    );
    await expectCliError(
      {
        "dotfiles/settings.json": "{}",
        "dotfiles/settings.overwrite.json": '{"items.$append": []}',
      },
      "overwrite append path not found: items",
    );
  });
});
