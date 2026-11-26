export function spawnFixtureCli(args: string[], homeDir: string, env = process.env) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import { run } from "./main";
process.exit(await run(process.argv.slice(1), { cwd: process.cwd(), homeDir: ${JSON.stringify(homeDir)} }));`,
      "--",
      ...args,
    ],
    { cwd: import.meta.dir, env },
  );
}
