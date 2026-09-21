import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

describe("skills sync hook", () => {
  it("uses repository entries and run_after in the checked-in config", () => {
    const config = readFileSync(
      join(import.meta.dir, ".pre-chezmoi.skills.yaml"),
      "utf8",
    );

    assert.match(config, /code-yeongyu\/oh-my-openagent:/);
    assert.match(
      config,
      /entries:\n\s+- packages\/shared-skills\/skills\/frontend/,
    );
    assert.match(config, /run_after:/);
    assert.doesNotMatch(config, /omoFrontend|appendSkillMd/);
  });

  it("loads the new repository config shape", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-config-"));
    try {
      const result = runHook(root, "unused-config", join(root, "output"), {
        CHECK_CONFIG: "1",
        CHECK_CONFIG_PATH: join(import.meta.dir, ".pre-chezmoi.skills.yaml"),
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      const config = JSON.parse(result.stdout.toString()) as {
        repos: Array<{
          repo: string;
          entries: string[];
          runAfter: string[][];
          edits: Array<{ path: string; text: string }>;
        }>;
        localSkills: string[];
      };
      const omo = config.repos.find(
        (repo) => repo.repo === "code-yeongyu/oh-my-openagent",
      );
      assert.deepEqual(omo?.entries, [
        "packages/shared-skills/skills/frontend",
      ]);
      assert.deepEqual(omo?.runAfter, [
        [
          "node",
          "packages/omo-codex/plugin/scripts/materialize-shared-upstreams.mjs",
          "--strict",
        ],
      ]);
      const playwright = config.repos.find(
        (repo) => repo.repo === "microsoft/playwright-cli",
      );
      assert.deepEqual(playwright?.entries, ["skills/playwright-cli"]);
      assert.deepEqual(playwright?.runAfter, []);
      assert.deepEqual(
        playwright?.edits.map(({ path }) => path),
        ["skills/playwright-cli/SKILL.md"],
      );
      assert.match(playwright?.edits[0]?.text ?? "", /browse display show/);
      assert.match(playwright?.edits[0]?.text ?? "", /browse display hide/);
      assert.deepEqual(config.localSkills, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies edit append on a staging tree without changing the mirror", () => {
    for (const state of ["existing", "newline", "empty", "missing"] as const) {
      const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-edit-"));
      const mirrorRoot = join(root, "mirrors");
      const mirrorDir = join(mirrorRoot, "microsoft", "playwright-cli");
      const skillDir = join(mirrorDir, "skills", "playwright-cli");
      const outputDir = join(root, "output");
      const configPath = join(root, ".pre-chezmoi.skills.yaml");
      const appendix = "## Local browser\n\nbrowse display show\n";
      try {
        mkdirSync(skillDir, { recursive: true });
        mkdirSync(join(mirrorDir, ".git"), { recursive: true });
        if (state === "existing")
          writeFileSync(join(skillDir, "SKILL.md"), "upstream");
        if (state === "newline")
          writeFileSync(join(skillDir, "SKILL.md"), "upstream\n");
        if (state === "empty") writeFileSync(join(skillDir, "SKILL.md"), "");
        writeFileSync(
          join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
          `${Date.now()}\n`,
        );
        writeConfig(
          configPath,
          `externalSkills:\n  microsoft/playwright-cli:\n    entries:\n      - skills/playwright-cli\n    edit:\n      "skills/playwright-cli/SKILL.md.$append": ${JSON.stringify(appendix)}\n`,
        );
        const result = runHook(root, configPath, outputDir, {
          HOOK_MIRROR_ROOT: mirrorRoot,
        });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        assert.equal(
          readFileSync(join(outputDir, "playwright-cli", "SKILL.md"), "utf8"),
          state === "existing" || state === "newline"
            ? `upstream\n${appendix}`
            : appendix,
        );
        if (state === "missing") {
          assert.equal(existsSync(join(skillDir, "SKILL.md")), false);
        } else {
          assert.equal(
            readFileSync(join(skillDir, "SKILL.md"), "utf8"),
            state === "existing"
              ? "upstream"
              : state === "newline"
                ? "upstream\n"
                : "",
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects an edit target outside all entries", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-edit-outside-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(join(mirrorDir, "skills", "foo"), { recursive: true });
      mkdirSync(join(mirrorDir, "skills", "bar"), { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(mirrorDir, "skills", "foo", "SKILL.md"), "foo\n");
      writeFileSync(
        join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
        `${Date.now()}\n`,
      );
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n    edit:\n      "skills/bar/SKILL.md.$append": extra\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.equal(
        result.stderr.toString(),
        "dotfiles/.agents/skills.exact/.pre-chezmoi.ts: " +
          "edit path is not included in entries: skills/bar/SKILL.md\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an edit whose parent directory is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-edit-parent-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const skillDir = join(mirrorDir, "skills", "foo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "foo\n");
      writeFileSync(
        join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
        `${Date.now()}\n`,
      );
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n    edit:\n      "skills/missing/SKILL.md.$append": extra\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.equal(
        result.stderr.toString(),
        "dotfiles/.agents/skills.exact/.pre-chezmoi.ts: " +
          "edit path matched nothing: skills/missing/SKILL.md\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports staging edit I/O failures", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-edit-io-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const skillDir = join(mirrorDir, "skills", "foo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(join(skillDir, "SKILL.md"), { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(
        join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
        `${Date.now()}\n`,
      );
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n    edit:\n      "skills/foo/SKILL.md.$append": extra\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr.toString(),
        /edit failed for skills\/foo\/SKILL\.md: /,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies edit after a changed pull", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-edit-changed-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const skillDir = join(mirrorDir, "skills", "foo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "foo\n");
      writeFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "0\n");
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n    edit:\n      "skills/foo/SKILL.md.$append": changed\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        REVISION_SEQUENCE: "old,new",
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "foo", "SKILL.md"), "utf8"),
        "foo\nchanged",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies one edit to every matching entry copy", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-edit-entries-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const skillDir = join(mirrorDir, "skills", "foo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "foo\n");
      writeFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "0\n");
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n      - skills\n    edit:\n      "skills/foo/SKILL.md.$append": shared\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "foo", "SKILL.md"), "utf8"),
        "foo\nshared",
      );
      assert.equal(
        readFileSync(join(outputDir, "skills", "foo", "SKILL.md"), "utf8"),
        "foo\nshared",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clones a generic mirror, cleans ignored files, runs run_after, and copies generated output", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-run-after-clone-"));
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    const mirrorRoot = join(root, "mirrors");
    const cleanMarker = join(root, "ignored.marker");
    try {
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - generated/skill\n    run_after:\n      - [node, build.mjs]\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        GENERIC_CLONE_SOURCE: "1",
        BUILD_SOURCE: "1",
        CLEAN_MARKER: cleanMarker,
        CLEAN_EXPECT_ARGS: JSON.stringify([
          "-C",
          join(mirrorRoot, "owner", "repo"),
          "clean",
          "-fdX",
        ]),
        COMMAND_EXPECT_ARGS: JSON.stringify(["node", "build.mjs"]),
        COMMAND_EXPECT_CWD: join(mirrorRoot, "owner", "repo"),
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "skill", "SKILL.md"), "utf8"),
        "generated\n",
      );
      assert.equal(existsSync(cleanMarker), false);
      assert.equal(
        Number(
          readFileSync(
            join(mirrorRoot, "owner", "repo", ".git", "pre-chezmoi-pull-time"),
            "utf8",
          ),
        ) > 0,
        true,
      );
      assert.equal(result.stdout.toString(), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves local files and maps chezmoi attribute names", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-copy-"));
    const mirrorRoot = join(root, "mirrors");
    const skillDir = join(mirrorRoot, "owner", "repo", "skills", "foo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(join(skillDir, ".git"), { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "upstream\n");
      const attributeNames = [
        "after_file",
        "before_file",
        "create_file",
        "dot_file",
        "empty_file",
        "encrypted_file",
        "exact_file",
        "executable_file",
        "external_file",
        "literal_file",
        "modify_file",
        "once_file",
        "onchange_file",
        "private_file",
        "readonly_file",
        "remove_file",
        "run_file",
        "symlink_file",
      ];
      for (const name of attributeNames)
        writeFileSync(join(skillDir, name), "attribute\n");
      mkdirSync(join(skillDir, "references"), { recursive: true });
      writeFileSync(join(skillDir, "references", "guide.md"), "guide\n");
      mkdirSync(join(outputDir, "foo"), { recursive: true });
      writeFileSync(join(outputDir, "foo", "SKILL.md"), "local\n");
      writeFileSync(join(outputDir, "foo", "stale.md"), "stale\n");
      writeConfig(
        configPath,
        "externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n",
      );

      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "foo", "SKILL.md"), "utf8"),
        "local\n",
      );
      for (const name of attributeNames) {
        assert.equal(
          readFileSync(join(outputDir, "foo", `literal_${name}`), "utf8"),
          "attribute\n",
        );
      }
      assert.equal(
        readFileSync(join(outputDir, "foo", "references", "guide.md"), "utf8"),
        "guide\n",
      );
      assert.equal(
        readFileSync(join(outputDir, "foo", "stale.md"), "utf8"),
        "stale\n",
      );
      assert.equal(existsSync(join(outputDir, "foo", ".git")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs run_after after a changed pull", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-run-after-pull-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    const cleanMarker = join(root, "ignored.marker");
    try {
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      const pullTimeBefore = "123\n";
      writeFileSync(
        join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
        pullTimeBefore,
      );
      writeFileSync(cleanMarker, "remove\n");
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - generated/skill\n    run_after:\n      - [node, build.mjs]\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        REVISION_SEQUENCE: "old,new",
        BUILD_SOURCE: "1",
        CLEAN_MARKER: cleanMarker,
        CLEAN_EXPECT_ARGS: JSON.stringify(["-C", mirrorDir, "clean", "-fdX"]),
        COMMAND_EXPECT_ARGS: JSON.stringify(["node", "build.mjs"]),
        COMMAND_EXPECT_CWD: mirrorDir,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "skill", "SKILL.md"), "utf8"),
        "generated\n",
      );
      assert.equal(existsSync(cleanMarker), false);
      assert.notEqual(
        readFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "utf8"),
        pullTimeBefore,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips clean and run_after when pull leaves HEAD unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-run-after-skip-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const sourceDir = join(mirrorDir, "generated", "skill");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    const cleanMarker = join(root, "ignored.marker");
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(sourceDir, "SKILL.md"), "cached\n");
      writeFileSync(
        join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
        `${Date.now()}\n`,
      );
      writeFileSync(cleanMarker, "keep\n");
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - generated/skill\n    run_after:\n      - [node, should-not-run.mjs]\n`,
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        REVISION_SEQUENCE: "same,same",
        COMMAND_FAIL: "1",
        CLEAN_MARKER: cleanMarker,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "skill", "SKILL.md"), "utf8"),
        "cached\n",
      );
      assert.equal(existsSync(cleanMarker), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors runtime TTL and force pull while recording successful pull time", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-runtime-ttl-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const sourceDir = join(mirrorDir, "skills", "foo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    const pullMarker = join(root, "pull.marker");
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(sourceDir, "SKILL.md"), "cached\n");
      const recentPullTime = `${Date.now()}\n`;
      writeFileSync(
        join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
        recentPullTime,
      );
      writeConfig(
        configPath,
        "externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n",
      );

      const insideTtl = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        HOOK_TTL: "999999999",
        GENERIC_EXPECT_NO_PULL: "1",
      });
      assert.equal(insideTtl.exitCode, 0, insideTtl.stderr.toString());
      assert.equal(
        readFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "utf8"),
        recentPullTime,
      );

      const forced = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        HOOK_TTL: "999999999",
        HOOK_FORCE: "1",
        PULL_MARKER: pullMarker,
      });
      assert.equal(forced.exitCode, 0, forced.stderr.toString());
      assert.equal(readFileSync(pullMarker, "utf8"), "pull\n");
      assert.ok(
        Number(
          readFileSync(
            join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
            "utf8",
          ),
        ) > 0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries when the pull-time record is missing or invalid", () => {
    for (const record of ["missing", "invalid"]) {
      const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-pull-record-"));
      const mirrorRoot = join(root, "mirrors");
      const mirrorDir = join(mirrorRoot, "owner", "repo");
      const sourceDir = join(mirrorDir, "skills", "foo");
      const outputDir = join(root, "output");
      const configPath = join(root, ".pre-chezmoi.skills.yaml");
      const pullMarker = join(root, "pull.marker");
      try {
        mkdirSync(sourceDir, { recursive: true });
        mkdirSync(join(mirrorDir, ".git"), { recursive: true });
        writeFileSync(join(sourceDir, "SKILL.md"), "cached\n");
        if (record === "invalid") {
          writeFileSync(
            join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
            "invalid\n",
          );
        }
        writeConfig(
          configPath,
          "externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n",
        );
        const result = runHook(root, configPath, outputDir, {
          HOOK_MIRROR_ROOT: mirrorRoot,
          HOOK_TTL: "999999999",
          PULL_MARKER: pullMarker,
        });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        assert.equal(readFileSync(pullMarker, "utf8"), "pull\n");
        assert.ok(
          Number(
            readFileSync(
              join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
              "utf8",
            ),
          ) > 0,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("continues with cached output after a pull warning", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-pull-warning-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const sourceDir = join(mirrorDir, "generated", "skill");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(sourceDir, "SKILL.md"), "cached\n");
      writeFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "0\n");
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - generated/skill\n    run_after:\n      - [node, should-not-run.mjs]\n`,
      );
      const pullTimeBefore = readFileSync(
        join(mirrorDir, ".git", "pre-chezmoi-pull-time"),
        "utf8",
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        GENERIC_FAIL_PULL: "1",
        COMMAND_FAIL: "1",
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.match(
        result.stderr.toString(),
        /warning: git pull failed for owner\/repo/,
      );
      assert.equal(
        readFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "utf8"),
        pullTimeBefore,
      );
      assert.equal(
        readFileSync(join(outputDir, "skill", "SKILL.md"), "utf8"),
        "cached\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when git clean or run_after fails", () => {
    for (const failure of ["clean", "command"]) {
      const root = mkdtempSync(join(tmpdir(), `pre-chezmoi-${failure}-fail-`));
      const mirrorRoot = join(root, "mirrors");
      const mirrorDir = join(mirrorRoot, "owner", "repo");
      const outputDir = join(root, "output");
      const configPath = join(root, ".pre-chezmoi.skills.yaml");
      try {
        mkdirSync(join(mirrorDir, ".git"), { recursive: true });
        writeFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "0\n");
        writeConfig(
          configPath,
          `externalSkills:\n  owner/repo:\n    entries:\n      - generated/skill\n    run_after:\n      - [node, build.mjs]\n`,
        );
        const result = runHook(root, configPath, outputDir, {
          HOOK_MIRROR_ROOT: mirrorRoot,
          REVISION_SEQUENCE: "old,new",
          ...(failure === "clean"
            ? { CLEAN_FAIL: "1" }
            : { COMMAND_FAIL: "1" }),
        });
        assert.notEqual(result.exitCode, 0);
        assert.match(
          result.stderr.toString(),
          new RegExp(
            failure === "clean" ? "git clean failed" : "run_after failed",
          ),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("normalizes fatal run_after errors to one prefixed line", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-fatal-line-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(join(mirrorDir, ".git"), { recursive: true });
      writeFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "0\n");
      writeConfig(
        configPath,
        `externalSkills:\n  owner/repo:\n    entries:\n      - generated/skill\n    run_after:\n      - [node, build.mjs]\n`,
      );
      const result = runHook(root, configPath, join(root, "output"), {
        HOOK_MIRROR_ROOT: mirrorRoot,
        REVISION_SEQUENCE: "old,new",
        COMMAND_FAIL: "1",
        MULTILINE_ERROR: "1",
      });
      assert.notEqual(result.exitCode, 0);
      assert.equal(
        result.stderr.toString(),
        "dotfiles/.agents/skills.exact/.pre-chezmoi.ts: " +
          "run_after failed for owner/repo: first\\nsecond\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps generic repositories independent after one pull warning", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-independent-"));
    const mirrorRoot = join(root, "mirrors");
    const failedMirror = join(mirrorRoot, "owner", "failed");
    const healthyMirror = join(mirrorRoot, "owner", "healthy");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      for (const [mirrorDir, name, content] of [
        [failedMirror, "failed", "failed\n"],
        [healthyMirror, "healthy", "healthy\n"],
      ]) {
        mkdirSync(join(mirrorDir, "skills", name), { recursive: true });
        mkdirSync(join(mirrorDir, ".git"), { recursive: true });
        writeFileSync(join(mirrorDir, "skills", name, "SKILL.md"), content);
        writeFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "0\n");
      }
      writeConfig(
        configPath,
        "externalSkills:\n  owner/failed:\n    entries:\n      - skills/failed\n  owner/healthy:\n    entries:\n      - skills/healthy\n",
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
        GENERIC_FAIL_PULL: "1",
        GENERIC_FAIL_PULL_REPO: failedMirror,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.match(
        result.stderr.toString(),
        /warning: git pull failed for owner\/failed/,
      );
      assert.doesNotMatch(
        result.stderr.toString(),
        /warning: git pull failed for owner\/healthy/,
      );
      assert.equal(
        readFileSync(join(outputDir, "failed", "SKILL.md"), "utf8"),
        "failed\n",
      );
      assert.equal(
        readFileSync(join(outputDir, "healthy", "SKILL.md"), "utf8"),
        "healthy\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies machine localSkills and entries patches", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-machine-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorDir = join(mirrorRoot, "owner", "repo");
    const localDir = join(root, "local", "skills", "foo");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(join(mirrorDir, "skills", "foo"), { recursive: true });
      mkdirSync(join(mirrorDir, "skills", "bar"), { recursive: true });
      mkdirSync(localDir, { recursive: true });
      writeFileSync(join(mirrorDir, "skills", "foo", "SKILL.md"), "external\n");
      writeFileSync(join(mirrorDir, "skills", "bar", "SKILL.md"), "bar\n");
      writeFileSync(join(localDir, "SKILL.md"), "local\n");
      writeConfig(
        configPath,
        "externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n",
      );
      writeFileSync(
        join(root, ".pre-chezmoi.skills.machine.yaml"),
        'externalSkills:\n  "owner/repo.entries.$append":\n    - skills/bar\nlocalSkills:\n  - local/skills/foo\n',
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "foo", "SKILL.md"), "utf8"),
        "local\n",
      );
      assert.equal(
        readFileSync(join(outputDir, "bar", "SKILL.md"), "utf8"),
        "bar\n",
      );
      assert.equal(existsSync(join(outputDir, "local")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies machine remove, unset, add, and unrelated-key behavior", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-machine-ops-"));
    const mirrorRoot = join(root, "mirrors");
    const baseMirror = join(mirrorRoot, "owner", "base");
    const addedMirror = join(mirrorRoot, "owner", "added");
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    try {
      mkdirSync(join(baseMirror, "skills", "foo"), { recursive: true });
      mkdirSync(join(addedMirror, "skills", "bar"), { recursive: true });
      mkdirSync(join(baseMirror, ".git"), { recursive: true });
      mkdirSync(join(addedMirror, ".git"), { recursive: true });
      writeFileSync(join(baseMirror, "skills", "foo", "SKILL.md"), "foo\n");
      writeFileSync(join(addedMirror, "skills", "bar", "SKILL.md"), "bar\n");
      writeConfig(
        configPath,
        "externalSkills:\n  owner/base:\n    entries:\n      - skills/foo\n  owner/remove:\n    entries:\n      - skills/foo\n",
      );
      writeFileSync(
        join(root, ".pre-chezmoi.skills.machine.yaml"),
        'externalSkills:\n  "owner/base.entries.$remove":\n    - skills/foo\n  owner/added:\n    entries:\n      - skills/bar\n  "owner/remove.$unset": true\nunrelated: ignored\n',
      );
      const result = runHook(root, configPath, outputDir, {
        HOOK_MIRROR_ROOT: mirrorRoot,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "bar", "SKILL.md"), "utf8"),
        "bar\n",
      );
      assert.equal(existsSync(join(outputDir, "foo")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates the new config shape and exact schema errors", () => {
    type ExpectedError =
      string | ((configPath: string, machinePath: string) => string) | "parser";
    const invalidCases: Array<{
      config: string;
      machineLayer?: string;
      expected: ExpectedError;
    }> = [
      {
        config: "{}\n",
        expected: (configPath) =>
          `.pre-chezmoi.skills.yaml must have an externalSkills mapping: ${configPath}`,
      },
      {
        config: "externalSkills:\n  owner/repo: []\n",
        expected: "externalSkills.owner/repo must be a mapping",
      },
      {
        config: "externalSkills:\n  owner/repo: {}\n",
        expected: "externalSkills.owner/repo.entries must be an array",
      },
      {
        config: "externalSkills:\n  owner/repo:\n    entries: true\n",
        expected: "externalSkills.owner/repo.entries must be an array",
      },
      {
        config: "externalSkills:\n  owner/repo:\n    entries: [true]\n",
        expected: "externalSkills.owner/repo.entries[0] must be a path string",
      },
      {
        config:
          "externalSkills:\n  owner/repo:\n    entries: []\n    run_after: true\n",
        expected: "externalSkills.owner/repo.run_after must be an array",
      },
      {
        config:
          "externalSkills:\n  owner/repo:\n    entries: []\n    run_after: [[]]\n",
        expected:
          "externalSkills.owner/repo.run_after[0] must be a non-empty string array",
      },
      {
        config:
          "externalSkills:\n  owner/repo:\n    entries: []\n    run_after: [[true]]\n",
        expected:
          "externalSkills.owner/repo.run_after[0] must be a non-empty string array",
      },
      {
        config:
          "externalSkills:\n  owner/repo:\n    entries: []\n    edit: true\n",
        expected: "externalSkills.owner/repo.edit must be a mapping",
      },
      {
        config:
          "externalSkills:\n  owner/repo:\n    entries: []\n    edit: null\n",
        expected: "externalSkills.owner/repo.edit must be a mapping",
      },
      {
        config:
          "externalSkills:\n  owner/repo:\n    entries: []\n    edit:\n      skills/foo.txt.$replace: text\n",
        expected:
          "externalSkills.owner/repo.edit[skills/foo.txt.$replace] must be a .$append text edit",
      },
      {
        config:
          "externalSkills:\n  owner/repo:\n    entries: []\n    edit:\n      skills/foo.txt.$append: true\n",
        expected:
          "externalSkills.owner/repo.edit[skills/foo.txt.$append] must be a .$append text edit",
      },
      {
        config: "externalSkills: {}\n",
        machineLayer: "localSkills: true\n",
        expected: "localSkills must be an array",
      },
      {
        config: "externalSkills: {}\n",
        machineLayer: "localSkills:\n  - true\n",
        expected: "localSkills[0] must be a path string",
      },
      {
        config: "externalSkills: {}\n",
        machineLayer: "externalSkills: []\n",
        expected: (_configPath, machinePath) =>
          `.pre-chezmoi.skills.machine.yaml must keep an externalSkills mapping: ${machinePath}`,
      },
      { config: "externalSkills: [\n", expected: "parser" },
      {
        config: "externalSkills: {}\n",
        machineLayer: "externalSkills: [\n",
        expected: "parser",
      },
    ];

    for (const { config, machineLayer, expected } of invalidCases) {
      const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-config-errors-"));
      try {
        const configPath = join(root, ".pre-chezmoi.skills.yaml");
        const machinePath = join(root, ".pre-chezmoi.skills.machine.yaml");
        const outputDir = join(root, "output");
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(configPath, config);
        if (machineLayer !== undefined)
          writeFileSync(machinePath, machineLayer);
        const result = runHook(root, configPath, outputDir, {});
        assert.notEqual(result.exitCode, 0);
        const stderr = result.stderr.toString();
        const prefix = "dotfiles/.agents/skills.exact/.pre-chezmoi.ts: ";
        assert.ok(stderr.startsWith(prefix));
        assert.equal(stderr.split("\n").length, 2);
        if (expected === "parser") {
          assert.match(stderr, new RegExp(`^${prefix}.+\\n$`));
        } else {
          const expectedBody =
            typeof expected === "function"
              ? expected(configPath, machinePath)
              : expected;
          assert.equal(stderr, `${prefix}${expectedBody}\n`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("reports revision lookup failures before and after pull", () => {
    for (const failAt of ["0", "1"]) {
      const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-revision-fail-"));
      const mirrorRoot = join(root, "mirrors");
      const mirrorDir = join(mirrorRoot, "owner", "repo");
      const configPath = join(root, ".pre-chezmoi.skills.yaml");
      try {
        mkdirSync(join(mirrorDir, ".git"), { recursive: true });
        writeFileSync(join(mirrorDir, ".git", "pre-chezmoi-pull-time"), "0\n");
        writeConfig(
          configPath,
          "externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n",
        );
        const result = runHook(root, configPath, join(root, "output"), {
          HOOK_MIRROR_ROOT: mirrorRoot,
          REVISION_SEQUENCE: "old,new",
          REVISION_FAIL_AT: failAt,
        });
        assert.notEqual(result.exitCode, 0);
        assert.equal(
          result.stderr.toString(),
          "dotfiles/.agents/skills.exact/.pre-chezmoi.ts: " +
            "git revision lookup failed for owner/repo: revision failed\n",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("reports clone failures and path resolution failures", () => {
    const cloneRoot = mkdtempSync(join(tmpdir(), "pre-chezmoi-clone-fail-"));
    try {
      const configPath = join(cloneRoot, ".pre-chezmoi.skills.yaml");
      writeConfig(
        configPath,
        "externalSkills:\n  owner/repo:\n    entries:\n      - skills/foo\n",
      );
      const result = runHook(cloneRoot, configPath, join(cloneRoot, "output"), {
        HOOK_MIRROR_ROOT: join(cloneRoot, "mirrors"),
        GENERIC_FAIL_CLONE: "1",
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr.toString(), /git clone failed/);
    } finally {
      rmSync(cloneRoot, { recursive: true, force: true });
    }

    for (const [path, expectedMessage] of [
      ["skills/missing", "matched nothing"],
      ["skills/*", "matched multiple directories"],
      ["skills/one/SKILL.md", "matched nothing"],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-path-fail-"));
      try {
        const mirrorRoot = join(root, "mirrors");
        const mirrorDir = join(mirrorRoot, "owner", "repo");
        mkdirSync(join(mirrorDir, "skills", "one"), { recursive: true });
        if (path === "skills/*")
          mkdirSync(join(mirrorDir, "skills", "two"), { recursive: true });
        if (path === "skills/one/SKILL.md")
          writeFileSync(join(mirrorDir, "skills", "one", "SKILL.md"), "file\n");
        writeConfig(
          join(root, ".pre-chezmoi.skills.yaml"),
          `externalSkills:\n  owner/repo:\n    entries:\n      - ${path}\n`,
        );
        const result = runHook(
          root,
          join(root, ".pre-chezmoi.skills.yaml"),
          join(root, "output"),
          { HOOK_MIRROR_ROOT: mirrorRoot },
        );
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr.toString(), new RegExp(expectedMessage));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("reads force pull and exact TTL boundary behavior", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-context-"));
    try {
      const force = runHook(root, "unused-config", join(root, "output"), {
        CHECK_DEFAULT_CONTEXT: "1",
        PRE_CHEZMOI_FORCE_PULL: "1",
      });
      assert.equal(force.exitCode, 0, force.stderr.toString());
      assert.equal(force.stdout.toString(), "true");

      const ttl = 6 * 60 * 60 * 1000;
      const before = runHook(root, "unused-config", join(root, "output"), {
        CHECK_PULL_DUE: "1",
        PULL_LAST: "0",
        PULL_NOW: String(ttl - 1),
        PULL_TTL: String(ttl),
      });
      const at = runHook(root, "unused-config", join(root, "output"), {
        CHECK_PULL_DUE: "1",
        PULL_LAST: "0",
        PULL_NOW: String(ttl),
        PULL_TTL: String(ttl),
      });
      assert.equal(before.stdout.toString(), "false");
      assert.equal(at.stdout.toString(), "true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const runHookSnippet = `
const { pathToFileURL } = await import("node:url");
const { mkdir, rm, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const hook = await import(pathToFileURL(process.env.HOOK_FILE).href);
if (process.env.CHECK_DEFAULT_CONTEXT === "1") {
  process.stdout.write(String(hook.defaultContext().forcePull));
  process.exit(0);
}
if (process.env.CHECK_CONFIG === "1") {
  const config = await hook.loadSkillConfig(process.env.CHECK_CONFIG_PATH);
  process.stdout.write(JSON.stringify(config));
  process.exit(0);
}
if (process.env.CHECK_PULL_DUE === "1") {
  process.stdout.write(
    String(
      hook.isPullDue(
        Number(process.env.PULL_LAST),
        Number(process.env.PULL_NOW),
        Number(process.env.PULL_TTL),
      ),
    ),
  );
  process.exit(0);
}
let revisionIndex = 0;
await hook.main({
  configPath: process.env.HOOK_CONFIG,
  cwd: process.env.HOOK_OUTPUT,
  context: {
    mirrorRoot: process.env.HOOK_MIRROR_ROOT,
    ttlMs: process.env.HOOK_TTL ? Number(process.env.HOOK_TTL) : 0,
    forcePull: process.env.HOOK_FORCE === "1",
    runGit: async (args) => {
      if (args[0] === "clone") {
        if (process.env.GENERIC_FAIL_CLONE === "1")
          return { ok: false, stdout: "", stderr: "generic clone failed" };
        const mirrorDir = args.at(-1);
        await mkdir(join(mirrorDir, ".git"), { recursive: true });
        if (process.env.GENERIC_CLONE_SOURCE === "1") {
          const skillDir = join(mirrorDir, "generated", "skill");
          await mkdir(skillDir, { recursive: true });
          await writeFile(join(skillDir, "SKILL.md"), "generated\\n");
        }
        if (process.env.CLEAN_MARKER)
          await writeFile(process.env.CLEAN_MARKER, "ignored\\n");
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        const currentIndex = revisionIndex++;
        if (
          process.env.REVISION_FAIL === "1" ||
          Number(process.env.REVISION_FAIL_AT) === currentIndex
        )
          return { ok: false, stdout: "", stderr: "revision failed" };
        const sequence = (process.env.REVISION_SEQUENCE || "same,same").split(",");
        const stdout = sequence[Math.min(currentIndex, sequence.length - 1)];
        return { ok: true, stdout, stderr: "" };
      }
      if (args.includes("clean")) {
        if (
          process.env.CLEAN_EXPECT_ARGS &&
          JSON.stringify(args) !== process.env.CLEAN_EXPECT_ARGS
        )
          return { ok: false, stdout: "", stderr: "unexpected clean args" };
        if (process.env.CLEAN_FAIL === "1")
          return { ok: false, stdout: "", stderr: "clean failed" };
        if (process.env.CLEAN_MARKER)
          await rm(process.env.CLEAN_MARKER, { force: true });
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args.includes("pull")) {
        if (process.env.GENERIC_EXPECT_NO_PULL === "1")
          return { ok: false, stdout: "", stderr: "pull was not skipped" };
        if (
          process.env.GENERIC_FAIL_PULL === "1" &&
          (!process.env.GENERIC_FAIL_PULL_REPO ||
            args.includes(process.env.GENERIC_FAIL_PULL_REPO))
        ) {
          return { ok: false, stdout: "", stderr: "generic pull failed" };
        }
        if (process.env.PULL_MARKER)
          await writeFile(process.env.PULL_MARKER, "pull\\n");
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    runCommand: async (args, cwd) => {
      if (
        process.env.COMMAND_EXPECT_ARGS &&
        JSON.stringify(args) !== process.env.COMMAND_EXPECT_ARGS
      )
        return { ok: false, stdout: "", stderr: "unexpected command args" };
      if (process.env.COMMAND_FAIL === "1")
        return {
          ok: false,
          stdout: "",
          stderr:
            process.env.MULTILINE_ERROR === "1"
              ? "first\\nsecond"
              : "command failed",
        };
      if (process.env.COMMAND_EXPECT_CWD && cwd !== process.env.COMMAND_EXPECT_CWD)
        return { ok: false, stdout: "", stderr: "wrong command cwd" };
      if (process.env.BUILD_SOURCE === "1") {
        const sourceDir = join(cwd, "generated", "skill");
        await mkdir(sourceDir, { recursive: true });
        await writeFile(join(sourceDir, "SKILL.md"), "generated\\n");
      }
      return { ok: true, stdout: "", stderr: "" };
    },
  },
});
`;

function writeConfig(path: string, content: string): void {
  writeFileSync(path, content);
}

function runHook(
  root: string,
  configPath: string,
  outputDir: string,
  extraEnv: Record<string, string>,
) {
  return Bun.spawnSync({
    cmd: [process.execPath, "-e", runHookSnippet],
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      HOOK_FILE: join(import.meta.dir, ".pre-chezmoi.ts"),
      HOOK_CONFIG: configPath,
      HOOK_OUTPUT: outputDir,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}
