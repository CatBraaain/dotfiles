// Compile cache shared by build hooks that produce standalone executables
// (bun build --compile). dist is rebuilt from scratch on every build, so the
// cached binaries live outside dist under
// <repoRoot>/.cache/compile-cache/<name>/<platform>/ and are keyed by a hash of
// the CLI source tree plus the Bun version. Entries are separated per platform
// so builds on one host (for example WSL) do not evict or reuse the binaries
// built on another host sharing the same repository (for example Windows).
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

type CompileRequest = {
  name: string;
  cliDir: string;
  entryPath: string;
  buildPath: string;
};

// Compiles entryPath into buildPath, reusing a cached binary when the source
// tree is unchanged. Cache read/write failures degrade to a plain compile.
export async function compileWithCache(request: CompileRequest): Promise<void> {
  const cacheDir = join(
    dirname(resolveDistDir()),
    ".cache",
    "compile-cache",
    request.name,
    process.platform,
  );
  const cachePath = join(cacheDir, await hashSource(request));
  try {
    await copyFile(cachePath, request.buildPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await compile(request);
  try {
    await mkdir(cacheDir, { recursive: true });
    await copyFile(request.buildPath, cachePath);
    await pruneOldEntries(cacheDir, cachePath);
  } catch {
    // A cache write failure must not fail the build.
  }
}

async function compile(request: CompileRequest): Promise<void> {
  const compiled = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--compile-autoload-package-json",
      request.entryPath,
      "--outfile",
      request.buildPath,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await compiled.exited;
  if (exitCode !== 0) {
    await rm(request.buildPath, { force: true });
    throw new Error(`bun build --compile failed for ${request.name} (exit code ${exitCode})`);
  }
}

// Hashes the compile inputs: the Bun version, the compile flags, and every
// file in the source tree keyed by its dist-relative path.
async function hashSource(request: CompileRequest): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`bun=${process.versions.bun}\n`);
  hasher.update("flags=--compile --compile-autoload-package-json\n");
  const files: string[] = [];
  async function walk(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), childRelative);
      else files.push(childRelative);
    }
  }
  await walk(request.cliDir, "");
  for (const file of files.sort()) {
    hasher.update(`${file}\n`);
    hasher.update(await readFile(join(request.cliDir, file)));
  }
  return hasher.digest("hex");
}

// Keeps only the newest binary per CLI name so repeated builds cannot grow
// the cache without bound.
async function pruneOldEntries(cacheDir: string, keepPath: string): Promise<void> {
  for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
    const entryPath = join(cacheDir, entry.name);
    if (entry.isFile() && entryPath !== keepPath) await rm(entryPath, { force: true });
  }
}

function resolveDistDir(): string {
  const value = process.env.DOTFILES_DIST_DIR;
  if (value === undefined || value === "")
    throw new Error("hook environment variable is not set: DOTFILES_DIST_DIR");
  return value;
}
