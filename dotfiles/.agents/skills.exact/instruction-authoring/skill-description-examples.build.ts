// Builds references/skill-description-examples.md, the few-shot corpus of
// every description field in the anthropics/skills mirror that
// SKILL.md §SKILL.mdについて points to as the canonical examples. Runs as a
// local build hook on every build so the examples track upstream without
// manual curation. The extraction lives in a sibling file executed as a child
// bun process: gray-matter is resolved by Bun auto-install at runtime, which
// tsc cannot see, so this hook stays free of that import. The extractor rides
// along into dist just for this hook and is removed after the run so it never
// reaches home.

import { $ } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const { buildHookContext } = await import(
    `${process.env.DOTFILES_MANAGER_SRC}/hook-context.ts`,
  );
  const { syncGithubMirror } = await buildHookContext();
  const mirror = await syncGithubMirror("anthropics/skills");
  const output = join(process.cwd(), "references", "skill-description-examples.md");
  const extractor = join(import.meta.dir, "skill-description-examples.extract.ts");
  try {
    await $`bun ${extractor} ${mirror} ${output}`.quiet();
  } finally {
    // The extractor rode along into dist just for this hook; drop it so it
    // never reaches home.
    await rm(extractor);
  }
}

if (import.meta.main) await main();
