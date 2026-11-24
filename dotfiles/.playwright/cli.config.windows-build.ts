import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

async function main(): Promise<void> {
  const tempDirectory = tmpdir();
  if (!isAbsolute(tempDirectory)) {
    throw new Error("The temporary directory must be an absolute path");
  }
  const { buildHookContext } = await import(`${process.env.DOTFILES_MANAGER_SRC}/hook-context.ts`);
  const { merge } = await buildHookContext();
  await merge("cli.config.json", { outputDir: join(tempDirectory, "playwright") });
}

if (import.meta.main) await main();
