import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

async function main(): Promise<void> {
  const tempDirectory = tmpdir();
  if (!isAbsolute(tempDirectory)) {
    throw new Error("The temporary directory must be an absolute path");
  }
  const { merge } = await loadHookContext();
  await merge("cli.config.json", { outputDir: join(tempDirectory, "playwright") });
}

if (import.meta.main) await main();
