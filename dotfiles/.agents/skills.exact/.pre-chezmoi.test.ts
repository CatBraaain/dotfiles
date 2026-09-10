import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { appendSkillMd, copySkillTree, loadSkillConfig, resolveSkillDir } from "./.pre-chezmoi.ts";

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
});
