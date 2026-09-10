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
  delete process.env.PRE_CHEZMOI_HOOK_ENV_TEST;
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

const readJson = async (root: string, path: string): Promise<unknown> =>
  JSON.parse(await readFile(join(root, path), "utf-8"));

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
    const skip = new Set(["docker"]);
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
      "home/.pi/agent/config/agents.yaml": "homeKey: true\ntiers:\n  low: home\n",
      "dotfiles/.pi/agent/config.exact/agents.yaml":
        "tiers:\n  high: base\n  low: base\npackages:\n  - source: base\ntheme: base\n",
      "dotfiles/.pi/agent/config.exact/agents.merge.local.yaml": [
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
      join(root, "dist/dot_pi/agent/exact_config/agents.yaml"),
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
      existsSync(join(root, "dist/dot_pi/agent/exact_config/agents.merge.local.yaml")),
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

  it("runs hooks parent-first and skips node_modules", async () => {
    const root = await fixture({
      "dotfiles/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("_order.log", "root\\n");`,
      "dotfiles/.pi/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("../_order.log", "pi\\n");`,
      "dotfiles/.pi/agent/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("../../_order.log", "agent\\n");`,
      "dotfiles/B/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("../_order.log", "B\\n");`,
      "dotfiles/a/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("../_order.log", "a\\n");`,
      "dotfiles/node_modules/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("../_order.log", "node_modules\\n");`,
      "dotfiles/x/node_modules/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("../_order.log", "nested node_modules\\n");`,
    });

    await run(root, "other", homeResolver(root));

    // Same parent folder: UTF-16 order ("B" < "a"); nested folders come first.
    assert.equal(
      await readFile(join(root, "dist/_order.log"), "utf-8"),
      "root\npi\nagent\nB\na\n",
    );
    assert.equal(existsSync(join(root, "dist/node_modules")), false);
    assert.equal(existsSync(join(root, "dist/x/node_modules")), false);
  });

  it("runs each hook with its own dist folder, the source path, and inherited env", async () => {
    process.env.PRE_CHEZMOI_HOOK_ENV_TEST = "inherited";
    const hook = [
      `import { writeFile } from "node:fs/promises";`,
      `await writeFile("meta.json", JSON.stringify({`,
      `  cwd: process.cwd(),`,
      `  source: import.meta.dir,`,
      `  env: process.env.PRE_CHEZMOI_HOOK_ENV_TEST,`,
      `}));`,
      "",
    ].join("\n");
    const root = await fixture({
      "dotfiles/.pre-chezmoi.ts": hook,
      "dotfiles/.pi/agent/.pre-chezmoi.ts": hook,
    });

    await run(root, "other", homeResolver(root));

    assert.deepEqual(await readJson(root, "dist/meta.json"), {
      cwd: join(root, "dist"),
      source: join(root, "dotfiles"),
      env: "inherited",
    });
    assert.deepEqual(await readJson(root, "dist/dot_pi/agent/meta.json"), {
      cwd: join(root, "dist/.pi/agent"),
      source: join(root, "dotfiles/.pi/agent"),
      env: "inherited",
    });
  });

  it("applies every existing conversion to hook output", async () => {
    const root = await fixture({
      "dotfiles/.pre-chezmoi.ts": [
        `import { mkdir, writeFile } from "node:fs/promises";`,
        `await mkdir(".config/hooks", { recursive: true });`,
        `await writeFile(".config/hooks/setup.sh.executable", "echo hi\\n");`,
        `await writeFile(".hidden", "x");`,
        `await writeFile("run_before_setup.sh", "echo setup\\n");`,
        `await mkdir("generated.exact", { recursive: true });`,
        `await writeFile("generated.exact/config", "value\\n");`,
        `await mkdir("docker", { recursive: true });`,
        `await writeFile("docker/hooks.json", "{}");`,
        "",
      ].join("\n"),
      "dotfiles/.pi/agent/.pre-chezmoi.ts": [
        `import { writeFile } from "node:fs/promises";`,
        `await writeFile("settings.json", JSON.stringify({ base: true }));`,
        `await writeFile("settings.merge.json", JSON.stringify({ "extra.$append": [1] }));`,
        "",
      ].join("\n"),
      "home/.pi/agent/settings.json": json({ keep: "home", extra: [] }),
    });

    await run(root, "other", homeResolver(root));

    assert.equal(existsSync(join(root, "dist/dot_config/hooks/executable_setup.sh")), true);
    assert.equal(existsSync(join(root, "dist/dot_hidden")), true);
    assert.equal(existsSync(join(root, "dist/run_before_setup.sh")), true);
    assert.equal(existsSync(join(root, "dist/exact_generated/config")), true);
    assert.equal(existsSync(join(root, "dist/dot_docker/desktop/hooks.json")), true);
    const expected = { keep: "home", extra: [1], base: true };
    assert.equal(
      await readFile(join(root, "dist/dot_pi/agent/settings.json"), "utf-8"),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/settings.merge.json")), false);
  });

  it("keeps hook files in dist without dot conversion", async () => {
    const root = await fixture({
      "dotfiles/.pi/agent/.pre-chezmoi.ts": [
        `import { mkdir, writeFile } from "node:fs/promises";`,
        `await mkdir("sub", { recursive: true });`,
        `await writeFile("sub/.pre-chezmoi.ts", "// generated\\n");`,
        "",
      ].join("\n"),
    });

    await run(root, "other", homeResolver(root));

    assert.equal(existsSync(join(root, "dist/dot_pi/agent/.pre-chezmoi.ts")), true);
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/sub/.pre-chezmoi.ts")), true);
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/dot_pre-chezmoi.ts")), false);
    assert.equal(existsSync(join(root, "dist/dot_pi/agent/sub/dot_pre-chezmoi.ts")), false);
  });

  it("does not run hooks generated by hooks", async () => {
    const root = await fixture({
      "dotfiles/.pre-chezmoi.ts": [
        `import { mkdir, writeFile } from "node:fs/promises";`,
        `await mkdir("gen", { recursive: true });`,
        `await writeFile("gen/.pre-chezmoi.ts", "process.exit(1);\\n");`,
        "",
      ].join("\n"),
    });
    const proc = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(existsSync(join(root, "dist/gen/.pre-chezmoi.ts")), true);
  });

  it("forwards hook stdout and stderr through the parent process", async () => {
    const root = await fixture({
      "dotfiles/.pre-chezmoi.ts": `console.log("hook stdout");\nconsole.error("hook stderr");`,
    });
    const proc = Bun.spawn(["bun", script], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /hook stdout/);
    assert.match(stderr, /hook stderr/);
  });

  it("stops on hook failure with a relative path and skips the rest", async () => {
    const root = await fixture({
      "dotfiles/a/.pre-chezmoi.ts": `process.exit(3);`,
      "dotfiles/b/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("hook-ran", "b\\n");`,
      "dotfiles/.config/settings": "value",
    });
    const proc = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /local pre-chezmoi hook failed: a\/\.pre-chezmoi\.ts \(exit code 3\)/);
    assert.equal(existsSync(join(root, "dist/b/hook-ran")), false);
    assert.equal(existsSync(join(root, "dist/.config/settings")), true);
  });

  it("reports a hook killed by a signal as a failure", async () => {
    const root = await fixture({
      "dotfiles/a/.pre-chezmoi.ts": `process.kill(process.pid, "SIGKILL");`,
      "dotfiles/b/.pre-chezmoi.ts": `import { appendFile } from "node:fs/promises";\nawait appendFile("hook-ran", "b\\n");`,
    });
    const proc = Bun.spawn(["bun", script], { cwd: root, stderr: "pipe", stdout: "ignore" });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /local pre-chezmoi hook failed: a\/\.pre-chezmoi\.ts \(signal SIGKILL\)/);
    assert.equal(existsSync(join(root, "dist/b/hook-ran")), false);
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
