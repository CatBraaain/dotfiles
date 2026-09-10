import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import {
  appendSkillMd,
  copySkillTree,
  isPullDue,
  loadSkillConfig,
  markPullAt,
  readLastPullAt,
  resolveSkillDir,
} from "./.pre-chezmoi.ts";

const cleanupDirs: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skills-hook-"));
  cleanupDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  return root;
}

afterEach(async () => {
  while (cleanupDirs.length > 0) await rm(cleanupDirs.pop()!, { recursive: true, force: true });
});

describe("loadSkillConfig", () => {
  it("normalizes string and object entries", async () => {
    const configPath = join(
      await fixture({
        ".pre-chezmoi.skills.yaml": [
          "externalSkills:",
          "  anthropics/skills:",
          "    - skills/doc-coauthoring",
          "    - path: skills/skill-creator",
          "      appendSkillMd: |",
          "        ## Extra",
          "",
        ].join("\n"),
      }),
      ".pre-chezmoi.skills.yaml",
    );

    const config = await loadSkillConfig(configPath);

    assert.deepEqual(config, [
      {
        repo: "anthropics/skills",
        entries: [
          { path: "skills/doc-coauthoring" },
          { path: "skills/skill-creator", appendSkillMd: "## Extra\n" },
        ],
      },
    ]);
  });

  it("rejects config without an externalSkills mapping", async () => {
    const configPath = join(
      await fixture({ ".pre-chezmoi.skills.yaml": "other: {}\n" }),
      ".pre-chezmoi.skills.yaml",
    );

    await assert.rejects(loadSkillConfig(configPath), /externalSkills mapping/);
  });

  it("rejects entries that are not an array", async () => {
    const configPath = join(
      await fixture({
        ".pre-chezmoi.skills.yaml": "externalSkills:\n  owner/repo: skills/eli5\n",
      }),
      ".pre-chezmoi.skills.yaml",
    );

    await assert.rejects(loadSkillConfig(configPath), /owner\/repo must be an array/);
  });

  it("rejects an object entry without a string path", async () => {
    const configPath = join(
      await fixture({
        ".pre-chezmoi.skills.yaml": "externalSkills:\n  owner/repo:\n    - appendSkillMd: text\n",
      }),
      ".pre-chezmoi.skills.yaml",
    );

    await assert.rejects(loadSkillConfig(configPath), /owner\/repo\[0\] must be a path string/);
  });

  it("rejects an object entry with a non-string appendSkillMd", async () => {
    const configPath = join(
      await fixture({
        ".pre-chezmoi.skills.yaml":
          "externalSkills:\n  owner/repo:\n    - path: skills/eli5\n      appendSkillMd: 123\n",
      }),
      ".pre-chezmoi.skills.yaml",
    );

    await assert.rejects(loadSkillConfig(configPath), /appendSkillMd must be a string/);
  });

  it("rejects a config that is not parseable as YAML", async () => {
    const configPath = join(
      await fixture({ ".pre-chezmoi.skills.yaml": "externalSkills: [unclosed\n" }),
      ".pre-chezmoi.skills.yaml",
    );

    await assert.rejects(loadSkillConfig(configPath));
  });
});

describe("isPullDue", () => {
  const ttlMs = 6 * 60 * 60 * 1000;

  it("is due when no pull time is recorded", () => {
    assert.equal(isPullDue(undefined, 1_000, ttlMs), true);
  });

  it("is not due within the TTL", () => {
    assert.equal(isPullDue(0, ttlMs - 1, ttlMs), false);
  });

  it("is due at the TTL boundary", () => {
    assert.equal(isPullDue(0, ttlMs, ttlMs), true);
  });

  it("is due regardless of the last pull time when forcePull is set", () => {
    assert.equal(isPullDue(0, 0, ttlMs, true), true);
  });
});

describe("readLastPullAt / markPullAt", () => {
  it("round-trips the pull time through the mirror .git directory", async () => {
    const mirrorDir = await fixture({});

    assert.equal(await readLastPullAt(mirrorDir), undefined);

    const before = Date.now();
    await markPullAt(mirrorDir);
    const after = Date.now();
    const pullAt = await readLastPullAt(mirrorDir);
    const recordedWithinRun = pullAt !== undefined && pullAt >= before && pullAt <= after;

    assert.ok(recordedWithinRun);
  });

  it("returns undefined for a malformed pull time file", async () => {
    const mirrorDir = await fixture({});
    const pullTimePath = join(mirrorDir, ".git", "pre-chezmoi-pull-time");
    await mkdir(dirname(pullTimePath), { recursive: true });
    await writeFile(pullTimePath, "not-a-number\n");

    assert.equal(await readLastPullAt(mirrorDir), undefined);
  });
});

describe("resolveSkillDir", () => {
  it("returns the single matching directory for a glob path", async () => {
    const mirrorDir = await fixture({ "skills/tier/grilling/SKILL.md": "skill" });

    const skillDir = await resolveSkillDir(mirrorDir, "skills/*/grilling");

    assert.equal(skillDir, join(mirrorDir, "skills/tier/grilling"));
  });

  it("rejects a path matching nothing", async () => {
    const mirrorDir = await fixture({ "skills/tier/grilling/SKILL.md": "skill" });

    await assert.rejects(resolveSkillDir(mirrorDir, "skills/*/eli5"), /matched nothing/);
  });

  it("rejects a path matching multiple directories", async () => {
    const mirrorDir = await fixture({
      "skills/tier1/grilling/SKILL.md": "skill",
      "skills/tier2/grilling/SKILL.md": "skill",
    });

    await assert.rejects(resolveSkillDir(mirrorDir, "skills/*/grilling"), /matched multiple/);
  });

  it("rejects a path that only matches a file", async () => {
    const mirrorDir = await fixture({ "skills/eli5": "file" });

    await assert.rejects(resolveSkillDir(mirrorDir, "skills/eli5"), /matched nothing/);
  });
});

describe("copySkillTree", () => {
  it("copies files and subdirectories recursively", async () => {
    const sourceDir = await fixture({
      "source/SKILL.md": "skill",
      "source/scripts/run.sh": "run",
    });
    const targetDir = join(sourceDir, "target");

    await copySkillTree(join(sourceDir, "source"), targetDir);

    assert.equal(await readFile(join(targetDir, "SKILL.md"), "utf-8"), "skill");
    assert.equal(await readFile(join(targetDir, "scripts/run.sh"), "utf-8"), "run");
  });

  it("keeps existing files in the target directory", async () => {
    const sourceDir = await fixture({
      "source/SKILL.md": "upstream",
      "target/SKILL.md": "local",
    });

    await copySkillTree(join(sourceDir, "source"), join(sourceDir, "target"));

    assert.equal(await readFile(join(sourceDir, "target/SKILL.md"), "utf-8"), "local");
  });

  it("wraps names matching chezmoi attribute prefixes in literal_", async () => {
    const sourceDir = await fixture({
      "source/scripts/run_eval.py": "eval",
      "source/scripts/utils.py": "utils",
      "source/exact_dir/keep.txt": "keep",
    });
    const targetDir = join(sourceDir, "target");

    await copySkillTree(join(sourceDir, "source"), targetDir);

    assert.equal(await readFile(join(targetDir, "scripts/literal_run_eval.py"), "utf-8"), "eval");
    assert.equal(existsSync(join(targetDir, "scripts/run_eval.py")), false);
    assert.equal(await readFile(join(targetDir, "scripts/utils.py"), "utf-8"), "utils");
    assert.equal(await readFile(join(targetDir, "literal_exact_dir/keep.txt"), "utf-8"), "keep");
  });

  it("skips the .git directory at any depth", async () => {
    const sourceDir = await fixture({
      "source/SKILL.md": "skill",
      "source/.git/config": "config",
      "source/sub/.git/config": "config",
    });
    const targetDir = join(sourceDir, "target");

    await copySkillTree(join(sourceDir, "source"), targetDir);

    assert.equal(existsSync(join(targetDir, ".git")), false);
    assert.equal(existsSync(join(targetDir, "sub/.git")), false);
    assert.equal(existsSync(join(targetDir, "SKILL.md")), true);
  });

  it("adds new files into existing target subdirectories", async () => {
    const sourceDir = await fixture({
      "source/scripts/new.sh": "new",
      "target/scripts/local.sh": "local",
    });

    await copySkillTree(join(sourceDir, "source"), join(sourceDir, "target"));

    assert.equal(await readFile(join(sourceDir, "target/scripts/new.sh"), "utf-8"), "new");
    assert.equal(await readFile(join(sourceDir, "target/scripts/local.sh"), "utf-8"), "local");
  });

  it("keeps files that only exist in the target directory", async () => {
    const sourceDir = await fixture({
      "source/SKILL.md": "skill",
      "target/obsolete.txt": "obsolete",
    });

    await copySkillTree(join(sourceDir, "source"), join(sourceDir, "target"));

    assert.equal(await readFile(join(sourceDir, "target/obsolete.txt"), "utf-8"), "obsolete");
  });
});

describe("appendSkillMd", () => {
  it("appends directly when SKILL.md ends with a newline", async () => {
    const skillDir = await fixture({ "SKILL.md": "upstream\n" });

    await appendSkillMd(skillDir, "## Extra\n");

    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf-8"), "upstream\n## Extra\n");
  });

  it("inserts a newline when SKILL.md does not end with one", async () => {
    const skillDir = await fixture({ "SKILL.md": "upstream" });

    await appendSkillMd(skillDir, "## Extra\n");

    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf-8"), "upstream\n## Extra\n");
  });

  it("creates SKILL.md with the text when it does not exist", async () => {
    const skillDir = await fixture({});

    await appendSkillMd(skillDir, "## Extra\n");

    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf-8"), "## Extra\n");
  });

  it("treats an existing empty SKILL.md like a missing one", async () => {
    const skillDir = await fixture({ "SKILL.md": "" });

    await appendSkillMd(skillDir, "## Extra\n");

    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf-8"), "## Extra\n");
  });
});
