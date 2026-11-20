// Build hook: package the scm-collapse-reapply extension source into a VSIX
// named with the reserved .data. marker (kept out of the home deployment),
// then remove the source folder so applying dist leaves no extension sources
// behind. The apply script installs the VSIX from this dist folder.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

async function main(): Promise<void> {
  const distDir = process.cwd();
  const sourceDir = join(distDir, "scm-collapse-reapply");
  const manifestPath = join(sourceDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error("missing extension source: " + manifestPath);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const vsixPath = join(distDir, `${manifest.name}-${manifest.version}.data.vsix`);
  rmSync(vsixPath, { force: true });
  const proc = Bun.spawnSync(
    [
      "bunx",
      "@vscode/vsce",
      "package",
      "--no-dependencies",
      "--allow-missing-repository",
      "-o",
      vsixPath,
    ],
    {
      cwd: sourceDir,
      // vsce must never block on an interactive prompt; missing LICENSE and
      // repository fields are warnings only.
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`vsce package failed with exit code ${proc.exitCode}`);
  }
  if (!existsSync(vsixPath)) {
    throw new Error("VSIX was not created: " + vsixPath);
  }
  rmSync(sourceDir, { recursive: true });
}

if (import.meta.main) await main();
