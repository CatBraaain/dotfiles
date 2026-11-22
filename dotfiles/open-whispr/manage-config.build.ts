import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const distHookDir = process.cwd();
  const applyHook = join(distHookDir, "manage-config.apply.ts");
  const declarationPath = join(distHookDir, "managed-keys.data.yaml");
  const managedKeysYaml = await readFile(declarationPath, "utf8").catch(() => null);
  const { outputs } = await Bun.build({
    entrypoints: [applyHook],
    target: "bun",
    packages: "external",
    define: { EMBEDDED_MANAGED_KEYS_YAML: JSON.stringify(managedKeysYaml) },
  });
  const [script] = outputs;
  if (!script) throw new Error(`OpenWhispr apply hook build did not produce ${applyHook}`);
  await Bun.write(applyHook, script);
}

if (import.meta.main) await main();
