import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeNpmPlaywrightFixture(prefix: string, cliSource: string, coreSource: string) {
  const packageDir = join(prefix, "node_modules", "@playwright", "cli");
  const entry = join(packageDir, "bin", "fixture.cjs");
  const shim = join(prefix, "playwright-cli.cmd");
  const core = join(packageDir, "node_modules", "playwright-core", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(dirname(core), { recursive: true });
  writeFileSync(shim, "@exit /b 83\r\n");
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "@playwright/cli",
      bin: { "playwright-cli": "bin/fixture.cjs" },
    }),
  );
  writeFileSync(entry, cliSource);
  writeFileSync(core, coreSource);
  return { entry, shim };
}
