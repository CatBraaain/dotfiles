import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("playwright-cli skill sync config", () => {
  it("documents browse display commands", () => {
    const config = readFileSync(join(import.meta.dir, ".pre-chezmoi.skills.yaml"), "utf8");

    assert.ok(config.includes("browse display show"));
    assert.ok(config.includes("browse display hide"));
    assert.ok(!config.includes("x11vnc -display :99 -R"));
  });

  it("appends the display commands to the generated skill", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-chezmoi-skills-"));
    const mirrorRoot = join(root, "mirrors");
    const mirrorSkillDir = join(
      mirrorRoot,
      "microsoft",
      "playwright-cli",
      "skills",
      "playwright-cli",
    );
    const outputDir = join(root, "output");
    const configPath = join(root, ".pre-chezmoi.skills.yaml");
    const appendText =
      "## CAPTCHA\n\n" +
      "bun ~/.agents/cli/browse display show\n" +
      "bun ~/.agents/cli/browse display hide\n";
    try {
      mkdirSync(mirrorSkillDir, { recursive: true });
      writeFileSync(join(mirrorSkillDir, "SKILL.md"), "# upstream skill\n");
      writeFileSync(
        configPath,
        `externalSkills:\n  microsoft/playwright-cli:\n    - path: skills/playwright-cli\n      appendSkillMd: ${JSON.stringify(appendText)}\n`,
      );

      // The hook imports `yaml`, which resolves outside bun test, so run it in
      // a plain bun subprocess with paths passed via environment variables.
      const result = Bun.spawnSync({
        cmd: [process.execPath, "-e", runHookSnippet],
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          HOOK_FILE: join(import.meta.dir, ".pre-chezmoi.ts"),
          HOOK_CONFIG: configPath,
          HOOK_MIRROR_ROOT: mirrorRoot,
          HOOK_OUTPUT: outputDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(
        readFileSync(join(outputDir, "playwright-cli", "SKILL.md"), "utf8"),
        `# upstream skill\n${appendText}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const runHookSnippet = `
const { pathToFileURL } = await import("node:url");
const hook = await import(pathToFileURL(process.env.HOOK_FILE).href);
await hook.main({
  configPath: process.env.HOOK_CONFIG,
  cwd: process.env.HOOK_OUTPUT,
  context: {
    mirrorRoot: process.env.HOOK_MIRROR_ROOT,
    ttlMs: 0,
    forcePull: false,
    runGit: async () => ({ ok: true, stderr: "" }),
  },
});
`;
