import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LIBRARY_FILE = "library.data.ts";
const DISPLAY_ONLY_FILE = "display-only.ts";
const COMPONENTS_FILE = "supported-components.ts";
const PROMPT_FILE = "prompt.ts";
const SKILL_FILE = join("skills", "openui-preview", "SKILL.md");
const SPEC_FILE = "spec.json";
const PROMPT_OPTIONS_FILE = "prompt-options.json";
const LOCK_FILE = "bun.lock";
const STAMP_FILE = "spec-gen-stamp";
const GENERATION_DIR = ".spec-gen";
const CLI_ENTRY_SEGMENTS = ["@openuidev", "cli", "dist", "index.js"];

async function main(): Promise<void> {
  const homeHookDir = process.cwd();
  // The hook snapshot runs from the dist-side extension folder
  // (dotfiles-manager SPEC.md §apply スクリプト), so dist files resolve here.
  const distHookDir = import.meta.dirname;
  const librarySource = join(distHookDir, LIBRARY_FILE);
  if (!existsSync(librarySource)) return;

  const fingerprint = hashFiles([
    librarySource,
    join(distHookDir, DISPLAY_ONLY_FILE),
    join(distHookDir, COMPONENTS_FILE),
    join(distHookDir, PROMPT_FILE),
    join(distHookDir, "..", "..", LOCK_FILE),
  ]);
  const stampPath = join(homeHookDir, STAMP_FILE);
  const outputsExist = [SPEC_FILE, PROMPT_OPTIONS_FILE, SKILL_FILE].every((file) =>
    existsSync(join(homeHookDir, file)),
  );
  if (outputsExist && existsSync(stampPath) && readFileSync(stampPath, "utf8") === fingerprint) {
    return;
  }

  const nodeModules = findNodeModules(homeHookDir);
  const cli = nodeModules === undefined ? undefined : join(nodeModules, ...CLI_ENTRY_SEGMENTS);
  if (cli === undefined || !existsSync(cli)) {
    throw new Error(
      `OpenUI CLI is missing under ${homeHookDir}; run "bun install" in ~/.pi/agent first`,
    );
  }

  const generationDir = join(homeHookDir, GENERATION_DIR);
  mkdirSync(generationDir, { recursive: true });
  let preserveBackups = false;
  try {
    for (const file of [LIBRARY_FILE, DISPLAY_ONLY_FILE, COMPONENTS_FILE, PROMPT_FILE]) {
      copyFileSync(join(distHookDir, file), join(generationDir, file));
    }
    const library = join(generationDir, LIBRARY_FILE);
    const generated = Bun.spawnSync(
      [
        process.execPath,
        cli,
        "generate",
        library,
        "--spec",
        "--out",
        join(generationDir, SPEC_FILE),
        "--no-telemetry",
      ],
      { cwd: generationDir, stdout: "inherit", stderr: "inherit" },
    );
    if (generated.exitCode !== 0) {
      throw new Error(`openui generate failed with exit code ${generated.exitCode}`);
    }

    const { promptOptions } = await import(library);
    await Bun.write(
      join(generationDir, PROMPT_OPTIONS_FILE),
      JSON.stringify(promptOptions, null, 2) + "\n",
    );
    const { opuiSkill } = await import(join(generationDir, PROMPT_FILE));
    const stagedSkillPath = join(generationDir, SKILL_FILE);
    mkdirSync(dirname(stagedSkillPath), { recursive: true });
    writeFileSync(stagedSkillPath, opuiSkill(generationDir));
    writeFileSync(join(generationDir, STAMP_FILE), fingerprint);

    const outputs = [SKILL_FILE, SPEC_FILE, PROMPT_OPTIONS_FILE, STAMP_FILE].map((file) => {
      const destination = join(homeHookDir, file);
      const backup = existsSync(destination) ? join(generationDir, "backups", file) : undefined;
      mkdirSync(dirname(destination), { recursive: true });
      if (backup) {
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(destination, backup);
      }
      return { source: join(generationDir, file), destination, backup };
    });
    const attempted: typeof outputs = [];
    try {
      for (const output of outputs) {
        attempted.push(output);
        copyFileSync(output.source, output.destination);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const output of attempted.reverse()) {
        try {
          if (output.backup) renameSync(output.backup, output.destination);
          else rmSync(output.destination, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        preserveBackups = true;
        throw new AggregateError(
          [error, ...rollbackErrors],
          `OpenUI output rollback failed; backups remain in ${generationDir}`,
        );
      }
      throw error;
    }
  } finally {
    if (!preserveBackups) rmSync(generationDir, { recursive: true, force: true });
  }
}

function findNodeModules(startDir: string): string | undefined {
  let current = startDir;
  for (;;) {
    const candidate = join(current, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function hashFiles(paths: string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

if (import.meta.main) await main();
