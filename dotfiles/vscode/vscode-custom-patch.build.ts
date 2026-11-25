import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const artifactNames = ["extension.vsix", "content.sha256", "cli.js", "inject.js"];

export async function buildCustomPatch(
  vscodeDir: string,
  distDir: string,
  buildProject = runProjectBuild,
): Promise<void> {
  const sourceDir = join(vscodeDir, "local-extensions.data.projects/vscode-custom-patch");
  const manifestText = await readFile(join(sourceDir, "package.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== "vscode-custom-patch" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("invalid vscode-custom-patch manifest name or version");
  }
  const vsixPath = join(vscodeDir, `${manifest.name}-${manifest.version}.data.vsix`);
  const inputHash = new Bun.CryptoHasher("sha256");
  inputHash.update(await readFile(import.meta.path));
  inputHash.update(`\0bun:${process.versions.bun}\0`);
  for (const path of ["package.json", "cli.ts", "scripts/build.ts"]) {
    await hashFile(inputHash, sourceDir, path);
  }
  await hashSources(inputHash, sourceDir, "src");
  const cachePath = join(
    dirname(distDir),
    ".cache/vscode-custom-patch",
    `${process.platform}-${process.arch}`,
    inputHash.digest("hex"),
  );
  if (await hasArtifacts(cachePath)) {
    await restoreArtifacts(cachePath, vscodeDir, vsixPath);
    console.log("reused cached vscode-custom-patch build");
    return;
  }

  const stage = await mkdtemp(join(vscodeDir, "vscode-custom-patch.data.stage-"));
  try {
    const artifacts = join(stage, "artifacts");
    await buildProject(sourceDir, artifacts);
    await restoreArtifacts(artifacts, vscodeDir, vsixPath);
    await saveCache(artifacts, cachePath);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function hashSources(
  hash: Bun.CryptoHasher,
  root: string,
  relativeDir: string,
): Promise<void> {
  const names = (await readdir(join(root, relativeDir))).sort();
  for (const name of names) {
    const relativePath = `${relativeDir}/${name}`;
    if ((await stat(join(root, relativePath))).isDirectory()) {
      await hashSources(hash, root, relativePath);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      await hashFile(hash, root, relativePath);
    }
  }
}

async function hashFile(hash: Bun.CryptoHasher, root: string, relativePath: string): Promise<void> {
  const bytes = await readFile(join(root, relativePath));
  hash.update(`${relativePath}\0${bytes.length}\0`);
  hash.update(bytes);
}

async function runProjectBuild(sourceDir: string, artifacts: string): Promise<void> {
  const processBuild = Bun.spawn([process.execPath, "run", "build", artifacts], {
    cwd: sourceDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processBuild.exited,
    new Response(processBuild.stdout).text(),
    new Response(processBuild.stderr).text(),
  ]);
  if (exitCode !== 0) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderr.length > 0) process.stderr.write(stderr);
    throw new Error(`vscode-custom-patch build failed (exit code ${exitCode})`);
  }
}

async function hasArtifacts(directory: string): Promise<boolean> {
  return (
    await Promise.all(artifactNames.map((name) => Bun.file(join(directory, name)).exists()))
  ).every(Boolean);
}

async function restoreArtifacts(cache: string, vscodeDir: string, vsixPath: string): Promise<void> {
  const cliDir = join(vscodeDir, "vscode-custom-patch");
  await mkdir(cliDir, { recursive: true });
  await Promise.all([
    copyFile(join(cache, "cli.js"), join(cliDir, "cli.js")),
    copyFile(join(cache, "inject.js"), join(cliDir, "inject.data.js")),
    copyFile(join(cache, "extension.vsix"), vsixPath),
    copyFile(join(cache, "content.sha256"), `${vsixPath}.sha256`),
  ]);
}

async function saveCache(artifacts: string, cachePath: string): Promise<void> {
  let stage: string | undefined;
  try {
    const parent = dirname(cachePath);
    await mkdir(parent, { recursive: true });
    stage = await mkdtemp(join(parent, ".stage-"));
    const cachedArtifacts = join(stage, "artifacts");
    await cp(artifacts, cachedArtifacts, { recursive: true });
    await rename(cachedArtifacts, cachePath);
    await pruneCache(parent, cachePath);
  } catch (error) {
    if (!(await hasArtifacts(cachePath)))
      console.warn(`could not cache vscode-custom-patch: ${error}`);
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true });
  }
}

async function pruneCache(parent: string, current: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true });
  const otherGenerations = entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => join(parent, entry.name))
    .filter((path) => path !== current);
  const dated = await Promise.all(
    otherGenerations.map(async (path) => ({
      path,
      modified: (await stat(path)).mtimeMs,
    })),
  );
  dated.sort((a, b) => b.modified - a.modified);
  await Promise.all(dated.slice(1).map(({ path }) => rm(path, { recursive: true, force: true })));
}

if (import.meta.main) {
  const distDir = process.env.DOTFILES_DIST_DIR;
  if (!distDir) throw new Error("DOTFILES_DIST_DIR is not set");
  await buildCustomPatch(process.cwd(), distDir);
}
