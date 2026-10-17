// Extracts the description field from every SKILL.md in the anthropics/skills
// mirror and writes the few-shot list that SKILL.md §SKILL.mdについて points to
// (references/skill-description-examples.md). This file is deliberately not
// named *.build.ts: gray-matter is resolved by Bun auto-install at runtime
// (this repo has no root package.json, so tsc cannot see it and must not
// include this file), and the version is pinned in the import against
// upstream breaking changes.
// usage: bun skill-description-examples.extract.ts <mirrorPath> <outputPath>

import matter from "gray-matter@4.0.3";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mirror, output] = process.argv.slice(2) as (string | undefined)[];
if (mirror === undefined || output === undefined) {
  console.error("usage: bun skill-description-examples.extract.ts <mirrorPath> <outputPath>");
  process.exitCode = 1;
} else {
  const skillsDir = join(mirror, "skills");
  const names = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const sections: string[] = [];
  for (const name of names) {
    const text = await readFile(join(skillsDir, name, "SKILL.md"), "utf8");
    const description = String(matter(text).data.description ?? "").trim();
    if (description.length === 0) continue;
    const quoted = description.includes("\n")
      ? description.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">")).join("\n")
      : `> ${description}`;
    sections.push(
      `- [\`${name}\`](https://github.com/anthropics/skills/tree/main/skills/${name})\n\n${quoted}`,
    );
  }
  const markdown = [
    "# Skill description examples",
    "",
    "Anthropic 公式 skills（[anthropics/skills](https://github.com/anthropics/skills)）の description を全件抽出した一覧。skill の description を書く・調整するときの few-shot として使う。原文のまま引用し、省略・要約はしない。",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
  await mkdir(join(output, ".."), { recursive: true });
  await writeFile(output, markdown);
}
