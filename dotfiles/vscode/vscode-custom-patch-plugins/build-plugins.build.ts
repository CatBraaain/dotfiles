// Build hook: bundle every plugin folder (src/entry.ts) into a sibling
// <name>.js bundle, then remove the source folders so applying dist leaves
// no plugin sources behind.
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const pluginsDir = process.cwd();
  const pluginFolders = (await readdir(pluginsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name);

  for (const name of pluginFolders) {
    const sourceDir = join(pluginsDir, name);
    const entrypoint = join(sourceDir, "src", "entry.ts");
    if (!existsSync(entrypoint)) {
      throw new Error(`plugin folder has no src/entry.ts: ${name}`);
    }
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "browser",
      format: "iife",
      minify: false,
    });
    if (!result.success) {
      throw new Error(`bundling plugin ${name} failed: ${result.logs.join("\n")}`);
    }
    const output = result.outputs[0];
    if (!output) throw new Error(`bundling plugin ${name} produced no output`);
    await Bun.write(join(pluginsDir, `${name}.js`), output);
    await rm(sourceDir, { recursive: true });
  }
}

if (import.meta.main) await main();
