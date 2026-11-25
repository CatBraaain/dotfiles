import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function main(): Promise<void> {
  const distHookDir = process.cwd();
  const library = join(distHookDir, "library.data.ts");
  if (!existsSync(library)) return;

  const applyHook = join(distHookDir, "spec.apply.ts");
  const librarySource = readFileSync(library, "utf8");
  const { outputs } = await Bun.build({
    entrypoints: [applyHook],
    target: "bun",
    packages: "external",
    define: { EMBEDDED_LIBRARY_SOURCE: JSON.stringify(librarySource) },
  });
  const [script] = outputs;
  if (!script) throw new Error(`OpenUI apply hook build did not produce ${applyHook}`);
  await Bun.write(applyHook, script);
}

if (import.meta.main) await main();
