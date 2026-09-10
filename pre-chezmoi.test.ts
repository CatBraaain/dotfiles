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

const windowsDestinations: Record<string, string> = {
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

// Resolves dist paths like real chezmoi (dot_x -> .x, exact_x -> x, per segment),
// with the trailing newline a real `chezmoi target-path` stdout carries.
const homeResolver = (root: string) => {
  const homeDir = join(root, "home");
  return (_root: string, sourcePath: string) =>
    Promise.resolve(
      `${join(
        homeDir,
        sourcePath
          .split("/")
          .map((segment) => segment.replace(/^exact_/, "").replace(/^dot_/, "."))
          .join("/"),
      )}\n`,
    );
};

async function expectMergeError(files: Record<string, string>, message: string): Promise<void> {
  const root = await fixture(files);
  await assert.rejects(run(root, "other", homeResolver(root)), { message });
}

describe("pre-chezmoi", () => {
  it("keeps only the selected LocalSend settings", async () => {
    const settings = JSON.parse(
      await readFile(join(import.meta.dir, "dotfiles/localsend/settings.merge.json"), "utf-8"),
    );

    assert.deepEqual(settings, {
      "flutter.ls_minimize_to_tray": true,
      "flutter.ls_auto_finish": true,
      "flutter.ls_quick_save": true,
      "flutter.ls_quick_save_from_favorites": false,
      "flutter.ls_advanced_settings": true,
    });
  });

  it("rebuilds dist without node_modules and stale files through the CLI", async () => {
    const root = await fixture({
      "dist/stale": "stale",
      "dotfiles/node_modules/ignored": "ignored",
      "dotfiles/nested/node_modules/ignored": "ignored",
      "dotfiles/.config/.gitconfig": "config",
      "dotfiles/.pi/agent/skills.exact/skill": "skill",
      "dotfiles/.pi.exact/agent/skill": "skill",
      "dotfiles/memo.exact": "memo",
      "dotfiles/bin/setup.executable": "setup",
      "dotfiles/bin.executable/child": "child",
      "dotfiles/.chezmoiignore": "ignored",
      "dotfiles/custom/modify_HotkeysConfig.json":
        "{{- /* chezmoi:modify-template */ -}}\n{{ fromJson .chezmoi.stdin | toPrettyJson }}\n",
    });

    const proc = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });
    assert.equal(await proc.exited, 0, await new Response(proc.stderr).text());

    assert.equal(existsSync(join(root, "dist/stale")), false);
    assert.equal(existsSync(join(root, "dist/node_modules")), false);
    assert.equal(existsSync(join(root, "dist/nested/node_modules")), false);
    assert.equal(existsSync(join(root, "dist/dot_config/dot_gitconfig")), true);
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/exact_skills/skill")), true);
    assert.equal(existsSync(join(root, "dist/exact_dot_pi/agent/skill")), true);
    assert.equal(existsSync(join(root, "dist/memo.exact")), true);
    assert.equal(existsSync(join(root, "dist/bin/executable_setup")), true);
    assert.equal(existsSync(join(root, "dist/bin.executable/child")), true);
    assert.equal(existsSync(join(root, "dist/.chezmoiignore")), true);
    assert.equal(
      await readFile(join(root, "dist/custom/modify_HotkeysConfig.json"), "utf-8"),
      "{{- /* chezmoi:modify-template */ -}}\n{{ fromJson .chezmoi.stdin | toPrettyJson }}\n",
    );
  });

  it("moves every non-Windows directory and composes the docker merge target", async () => {
    const root = await fixture({
      "dist/stale": "stale",
      "dotfiles/.docker/desktop/replaced": "replaced",
      "dotfiles/custom/settings.json": "{}",
      "dotfiles/docker/settings-store.merge.json": json({ LastLanguage: "ja" }),
      "home/.docker/desktop/settings-store.json": json({ AutoStart: false }),
      ...Object.fromEntries(
        Object.keys(linuxDestinations).map((source) => [`dotfiles/${source}/settings.json`, "{}"]),
      ),
      ...Object.fromEntries(
        linuxUnmovedDirectories.map((source) => [`dotfiles/${source}/settings.json`, "{}"]),
      ),
    });

    await run(root, "other", homeResolver(root));

    assert.equal(existsSync(join(root, "dist/stale")), false);
    assert.equal(existsSync(join(root, "dist/custom/settings.json")), true);
    for (const source of Object.keys(linuxDestinations)) {
      assert.equal(existsSync(join(root, "dist", source)), false, source);
    }
    for (const destination of Object.values(linuxDestinations)) {
      assert.equal(existsSync(join(root, "dist", destination, "settings.json")), true);
    }
    for (const source of linuxUnmovedDirectories) {
      assert.equal(existsSync(join(root, "dist", source, "settings.json")), true, source);
    }
    assert.equal(existsSync(join(root, "dist/dot_docker/desktop/replaced")), false);
    assert.equal(
      await readFile(join(root, "dist/dot_docker/desktop/settings-store.json"), "utf-8"),
      `${JSON.stringify({ AutoStart: false, LastLanguage: "ja" }, null, 2)}\n`,
    );
    assert.equal(
      existsSync(join(root, "dist/dot_docker/desktop/settings-store.merge.json")),
      false,
    );
  });

  it("moves every Windows mapped directory and leaves unmapped files", async () => {
    const skip = new Set(["gemini", "docker"]);
    const sources = Object.fromEntries(
      Object.keys(windowsDestinations)
        .filter((source) => !skip.has(source))
        .map((source) => [`dotfiles/${source}/settings.json`, "{}"]),
    );
    const root = await fixture({
      "dotfiles/AppData/Roaming/Docker/replaced": "replaced",
      "dotfiles/custom/settings.json": "{}",
      "dotfiles/unmapped": "a file, not a mapped entry",
      ...sources,
    });

    await run(root, "win32");

    assert.equal(existsSync(join(root, "dist/custom/settings.json")), true);
    assert.equal(existsSync(join(root, "dist/dot_gemini")), false);
    assert.equal(existsSync(join(root, "dist/unmapped")), true);
    for (const source of Object.keys(windowsDestinations)) {
      if (skip.has(source)) continue;
      assert.equal(existsSync(join(root, "dist", source)), false, source);
      assert.equal(
        existsSync(join(root, "dist", windowsDestinations[source], "settings.json")),
        true,
        source,
      );
    }
    // docker was not included in the fixture, so the pre-existing destination survives
    assert.equal(existsSync(join(root, "dist/AppData/Roaming/Docker/replaced")), true);
  });

  it("maps a nested file to the Linux preferences filename", async () => {
    const root = await fixture({
      "dotfiles/localsend/settings.merge.json": '{"flutter.ls_auto_finish":true}',
    });

    await run(root, "other", homeResolver(root));

    assert.equal(
      existsSync(
        join(
          root,
          "dist/dot_local/share/org.localsend.localsend_app/shared_preferences.json",
        ),
      ),
      true,
    );
    assert.equal(
      existsSync(
        join(root, "dist/dot_local/share/org.localsend.localsend_app/settings.json"),
      ),
      false,
    );
  });

  it("maps a nested file to the Windows settings filename", async () => {
    const root = await fixture({
      "dotfiles/localsend/settings.merge.json": '{"flutter.ls_auto_finish":true}',
    });

    await run(root, "win32", homeResolver(root));

    assert.equal(
      existsSync(join(root, "dist/AppData/Roaming/LocalSend/settings.json")),
      true,
    );
    assert.equal(
      existsSync(
        join(root, "dist/AppData/Roaming/LocalSend/shared_preferences.json"),
      ),
      false,
    );
  });

  it("composes home, plain base, merge, and merge.local layers in order", async () => {
    const root = await fixture({
      "home/.pi/agent/settings.json": json({
        theme: "light",
        packages: [{ source: "home" }],
        homeOnly: true,
      }),
      "dotfiles/.pi/agent/settings.json":
        '{\n  // plain base\n  "packages": [{ "source": "base" }],\n  "baseOnly": 1,\n  "replaced": ["old"]\n}',
      "dotfiles/.pi/agent/settings.merge.json": [
        "{",
        "  // shared layer",
        '  "packages.$append": [{ "source": "added" }],',
        '  "packages.$remove": [{ "source": "home" }],',
        '  "missing.$unset": true,',
        '  "replaced.$replace": { "x": 1 }',
        "}",
        "",
      ].join("\n"),
      "dotfiles/.pi/agent/settings.merge.local.json": json({
        tiers: { high: "HIGH" },
        homeOnly: [1, 2],
      }),
    });

    await run(root, "other", homeResolver(root));

    const expected = {
      theme: "light",
      packages: [{ source: "base" }, { source: "added" }],
      homeOnly: [1, 2],
      baseOnly: 1,
      replaced: { x: 1 },
      tiers: { high: "HIGH" },
    };
    assert.equal(
      await readFile(join(root, "dist/dot_pi/agent/settings.json"), "utf-8"),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/settings.merge.json")), false);
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/settings.merge.local.json")), false);
  });

  it("composes YAML layers through exact directories and combines repeated op keys", async () => {
    const root = await fixture({
      "home/.pi/agent/extensions/agents/config.yaml": "homeKey: true\ntiers:\n  low: home\n",
      "dotfiles/.pi/agent/extensions.exact/agents/config.yaml":
        "tiers:\n  high: base\n  low: base\npackages:\n  - source: base\ntheme: base\n",
      "dotfiles/.pi/agent/extensions.exact/agents/config.merge.local.yaml": [
        "tiers.$remove: [high]",
        "packages.$append:",
        "  - source: one",
        "packages.$append:",
        "  - source: two",
        "theme.$replace: first",
        "theme.$replace: final",
        "",
      ].join("\n"),
    });

    await run(root, "other", homeResolver(root));

    const output = await readFile(
      join(root, "dist/dot_pi/agent/exact_extensions/agents/config.yaml"),
      "utf-8",
    );
    assert.equal(
      output,
      [
        "homeKey: true",
        "tiers:",
        "  low: base",
        "packages:",
        "  - source: base",
        "  - source: one",
        "  - source: two",
        "theme: final",
        "",
      ].join("\n"),
    );
    assert.equal(
      existsSync(join(root, "dist/dot_pi/agent/exact_extensions/agents/config.merge.local.yaml")),
      false,
    );
  });

  it("resolves YAML aliases in merge layers", async () => {
    const root = await fixture({
      "dotfiles/settings.merge.local.yaml": [
        "command: &command 'exit 0'",
        "settings:",
        "  when: *command",
        "",
      ].join("\n"),
    });

    await run(root, "other", homeResolver(root));

    assert.equal(
      await readFile(join(root, "dist/settings.yaml"), "utf-8"),
      ["command: exit 0", "settings:", "  when: exit 0", ""].join("\n"),
    );
  });

  it("treats a missing, empty, or null home file as an empty layer", async () => {
    const root = await fixture({
      "dotfiles/missing/settings.merge.yaml": "theme: dark\n",
      "dotfiles/empty/settings.merge.yaml": "theme: dark\n",
      "home/empty/settings.yaml": "",
      "dotfiles/nullish/settings.merge.yaml": "theme: dark\n",
      "home/nullish/settings.yaml": "null\n",
    });

    await run(root, "other", homeResolver(root));

    for (const name of ["missing", "empty", "nullish"]) {
      assert.equal(
        await readFile(join(root, "dist", name, "settings.yaml"), "utf-8"),
        "theme: dark\n",
        name,
      );
    }
  });

  it("applies object removal, string matching, and same-path op precedence", async () => {
    const root = await fixture({
      "dotfiles/s.json": json({
        tiers: { high: 1, mid: 2, low: 3 },
        tags: ["keep", "remove"],
        order: ["keep"],
        nested: { drop: true, keep: true },
        replaceMe: ["old"],
      }),
      "dotfiles/s.merge.json": json({
        "tiers.$remove": ["high", "mid"],
        "tags.$remove": ["remove"],
        "tags.$append": ["keep", "new", "new"],
        "order.$remove": ["dup"],
        "order.$append": ["dup"],
        "nested.drop.$unset": true,
        "goneUnset.$unset": true,
        "goneRemove.$remove": ["anything"],
        "goneReplace.$replace": "ignored",
        "replaceMe.$replace": ["new"],
        "replaceMe.$append": ["ignored"],
        "replaceMe.$unset": true,
      }),
    });

    await run(root, "other", homeResolver(root));

    // "order" pins remove-before-append: reversed order would drop "dup"
    const expected = {
      tiers: { low: 3 },
      tags: ["keep", "keep", "new", "new"],
      order: ["keep", "dup"],
      nested: { keep: true },
      replaceMe: ["new"],
    };
    assert.equal(
      await readFile(join(root, "dist/s.json"), "utf-8"),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  });

  it("appends object elements that do not have a source property", async () => {
    const root = await fixture({
      "dotfiles/s.json": json({
        commands: [{ allow: "*" }],
      }),
      "dotfiles/s.merge.json": json({
        "commands.$append": [{ ask: ["ntn"] }],
      }),
    });

    await run(root, "other", homeResolver(root));

    const expected = {
      commands: [{ allow: "*" }, { ask: ["ntn"] }],
    };
    assert.equal(
      await readFile(join(root, "dist/s.json"), "utf-8"),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  });

  it("removes array objects only when the whole value matches", async () => {
    const root = await fixture({
      "dotfiles/s.json": json({
        packages: [
          { source: "same", extra: 1 },
          { source: "same", extra: 2 },
        ],
      }),
      "dotfiles/s.merge.json": json({
        "packages.$remove": [{ source: "same", extra: 1 }],
      }),
    });

    await run(root, "other", homeResolver(root));

    const expected = {
      packages: [{ source: "same", extra: 2 }],
    };
    assert.equal(
      await readFile(join(root, "dist/s.json"), "utf-8"),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  });

  it("reports merge errors through the CLI with stderr and a non-zero exit code", async () => {
    const root = await fixture({
      "chezmoi.yaml": "sourceDir: dist\n",
      "dotfiles/s.json": "{}",
      "dotfiles/s.merge.json": '{"a.$unknown": 1}',
    });
    const proc = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    assert.equal(exitCode, 1);
    assert.equal(stderr, "invalid merge op key: a.$unknown\n");
  });

  it("fails when chezmoi target-path fails", async () => {
    const root = await fixture({
      "chezmoi.yaml": "sourceDir: elsewhere\n",
      "dotfiles/settings.merge.json": "{}",
    });
    const proc = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /not in .*elsewhere/);
  });

  it("reports every specified merge error", async () => {
    await expectMergeError(
      { "dotfiles/s.json": "{}", "dotfiles/s.merge.json": '{"a.$unknown": 1}' },
      "invalid merge op key: a.$unknown",
    );
    await expectMergeError(
      { "dotfiles/s.json": "{}", "dotfiles/s.merge.json": '{"a[0].$append": []}' },
      "invalid merge op key: a[0].$append",
    );
    await expectMergeError(
      {
        "dotfiles/s.json": '{"items": "not an array"}',
        "dotfiles/s.merge.json": '{"items.$append": []}',
      },
      "merge append requires array at path: items",
    );
    await expectMergeError(
      {
        "dotfiles/s.json": '{"items": "not removable"}',
        "dotfiles/s.merge.json": '{"items.$remove": []}',
      },
      "merge remove requires array or object at path: items",
    );
    await expectMergeError(
      {
        "dotfiles/s.json": '{"items": []}',
        "dotfiles/s.merge.json": '{"items.$append": "no"}',
      },
      "merge append value must be array: items.$append",
    );
    await expectMergeError(
      {
        "dotfiles/s.json": '{"items": []}',
        "dotfiles/s.merge.json": '{"items.$remove": "no"}',
      },
      "merge remove value must be array: items.$remove",
    );
    await expectMergeError(
      {
        "dotfiles/s.json": '{"items": {}}',
        "dotfiles/s.merge.json": '{"items.$remove": [1]}',
      },
      "merge remove object keys must be strings: items.$remove",
    );
    await expectMergeError(
      { "dotfiles/s.json": "{}", "dotfiles/s.merge.json": '{"items.$append": []}' },
      "merge append path not found: items",
    );
    await expectMergeError(
      { "dotfiles/s.json": '{"a": [1]}', "dotfiles/s.merge.json": '{"a.b.$append": []}' },
      "merge append path not found: a.b",
    );
    await expectMergeError(
      {
        "dotfiles/s.json": '{"gone": [1]}',
        "dotfiles/s.merge.json": '{"gone.$unset": true, "gone.$append": []}',
      },
      "merge append path not found: gone",
    );
    await expectMergeError(
      { "home/s.json": "[1]", "dotfiles/s.merge.json": '{"items.$append": []}' },
      "merge append path not found: items",
    );
    await expectMergeError(
      { "dotfiles/s.json": "{}", "dotfiles/s.merge.json": '{".$append": []}' },
      "invalid merge op key: .$append",
    );
  });
});
