import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export default function piDocsExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", async () => {
    const template = await readFile(new URL("./skill-template.md", import.meta.url), "utf8");
    const content = template
      .replaceAll("{{README_PATH}}", () => getReadmePath())
      .replaceAll("{{DOCS_PATH}}", () => getDocsPath())
      .replaceAll("{{EXAMPLES_PATH}}", () => getExamplesPath());
    const contentHash = createHash("sha256").update(content).digest("hex");
    const directory = join(getAgentDir(), "cache", "pi-docs", contentHash);
    const skillPath = join(directory, "SKILL.md");
    const temporaryPath = join(directory, `${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, skillPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return { skillPaths: [skillPath] };
  });
}
