import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function buildProject(
  sourceDir: string,
  outputDir: string,
  packageVsix = packageExtension,
): Promise<void> {
  const plugin = await bundle("scm-collapse", {
    entrypoints: [join(sourceDir, "plugins/scm-collapse/src/entry.ts")],
    target: "browser",
    format: "iife",
  });
  const pluginText = await plugin.text();
  const define = { BUNDLED_SCM_COLLAPSE: JSON.stringify(pluginText) };
  const extension = await bundle("extension", {
    entrypoints: [join(sourceDir, "src/extension.ts")],
    target: "node",
    format: "cjs",
    external: ["vscode"],
    define,
  });
  const cli = await bundle("CLI", {
    entrypoints: [join(sourceDir, "cli.ts")],
    target: "node",
    format: "cjs",
    define,
  });
  const extensionText = await extension.text();
  const manifestText = await readFile(join(sourceDir, "package.json"), "utf8");
  const { scripts: _scripts, ...extensionManifest } = JSON.parse(manifestText);
  const packageJson = `${JSON.stringify(extensionManifest, null, 2)}\n`;
  const contentHash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([packageJson, extensionText]))
    .digest("hex");
  await mkdir(outputDir, { recursive: true });
  const packageDir = await mkdtemp(join(outputDir, ".package-"));
  try {
    await Promise.all([
      Bun.write(join(packageDir, "package.json"), packageJson),
      Bun.write(join(packageDir, "extension.js"), extensionText),
    ]);
    await packageVsix(packageDir, join(outputDir, "extension.vsix"));
    await Promise.all([
      Bun.write(join(outputDir, "content.sha256"), `${contentHash}\n`),
      Bun.write(join(outputDir, "scm-collapse.js"), pluginText),
      Bun.write(join(outputDir, "cli.js"), cli),
    ]);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
}

async function packageExtension(packageDir: string, vsixPath: string): Promise<void> {
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
    { cwd: packageDir, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0 || !(await Bun.file(vsixPath).exists())) {
    throw new Error(`vscode-custom-patch packaging failed (exit code ${proc.exitCode})`);
  }
}

async function bundle(name: string, options: Bun.BuildConfig): Promise<Bun.BuildArtifact> {
  const result = await Bun.build(options);
  const output = result.outputs[0];
  if (!result.success || !output)
    throw new Error(`bundling ${name} failed: ${result.logs.join("\n")}`);
  return output;
}

if (import.meta.main) {
  await buildProject(resolve(import.meta.dir, ".."), resolve(process.argv[2] ?? "dist"));
}
