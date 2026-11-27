import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const withLockMainPath = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "with-lock",
  "src",
  "main.ts",
);

export function createWithLockHome(home: string): string {
  const cliDir = join(home, ".agents", "cli");
  mkdirSync(cliDir, { recursive: true });
  const shim = join(cliDir, "with-lock");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${withLockMainPath}" "$@"\n`);
  chmodSync(shim, 0o755);
  return home;
}
