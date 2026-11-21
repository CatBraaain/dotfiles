// Build hook: bundle the extension entry and the standalone CLI, package the
// extension into a VSIX named with the reserved .data. marker (kept out of
// the home deployment), and stage the manifest inside a .data. folder that is
// removed after packaging. cli.js and plugins/ stay in dist and deploy to
// home, where the CLI also serves as a manually runnable entry point.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

async function main(): Promise<void> {
  const folder = process.cwd();
  const manifestPath = join(folder, "manifest.data.json");
  if (!existsSync(manifestPath)) throw new Error("missing manifest: " + manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  const extension = await Bun.build({
    entrypoints: [join(folder, "extension.data.ts")],
    target: "node",
    format: "cjs",
    external: ["vscode"],
  });
  if (!extension.success) {
    throw new Error(`bundling extension failed: ${extension.logs.join("\n")}`);
  }
  const extensionBundle = extension.outputs[0];
  if (!extensionBundle) throw new Error("extension bundle produced no output");

  const cli = await Bun.build({
    entrypoints: [join(folder, "cli.data.ts")],
    target: "node",
    format: "cjs",
  });
  if (!cli.success) throw new Error(`bundling cli failed: ${cli.logs.join("\n")}`);
  const cliBundle = cli.outputs[0];
  if (!cliBundle) throw new Error("cli bundle produced no output");
  await Bun.write(join(folder, "cli.js"), cliBundle);

  const stageDir = join(folder, "ext.data");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  await Bun.write(join(stageDir, "extension.js"), extensionBundle);
  await Bun.write(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const vsixPath = join(dirname(folder), `${manifest.name}-${manifest.version}.data.vsix`);
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
      cwd: stageDir,
      // vsce must never block on an interactive prompt; missing LICENSE and
      // repository fields are warnings only.
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (proc.exitCode !== 0) throw new Error(`vsce package failed with exit code ${proc.exitCode}`);
  if (!existsSync(vsixPath)) throw new Error("VSIX was not created: " + vsixPath);
  rmSync(stageDir, { recursive: true });
}

if (import.meta.main) await main();
