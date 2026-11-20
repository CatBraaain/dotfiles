import { rm } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const sourceDir = join(process.cwd(), "scm-collapse");
  const result = await Bun.build({
    entrypoints: [join(sourceDir, "src/entry.ts")],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!result.success) {
    throw new Error(`bundling scm-collapse failed: ${result.logs.join("\n")}`);
  }
  const output = result.outputs[0];
  if (!output) throw new Error("bundle produced no output");
  await Bun.write(join(process.cwd(), "scm-collapse.js"), output);
  // Remove the source folder so applying dist leaves no TypeScript sources behind.
  await rm(sourceDir, { recursive: true });
}

if (import.meta.main) await main();
