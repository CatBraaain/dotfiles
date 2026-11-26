import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeWindowsNpmPiFixture(prefix: string, source: string): void {
  const name = "@earendil-works/pi-coding-agent";
  const directory = join(prefix, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, type: "module", bin: { pi: "cli.js" } }),
  );
  writeFileSync(join(directory, "cli.js"), source);
}
