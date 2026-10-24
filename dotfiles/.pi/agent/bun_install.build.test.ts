import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuildDependencies } from "./bun_install.build";

const fixtureRoots: string[] = [];
const STAMP_FILE = "node_modules/.bun-build-install-hash";

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-build-deps-"));
  fixtureRoots.push(directory);
  const dependencies: Record<string, string> = {};
  for (const name of ["runtime", "build-tool"]) {
    const path = join(directory, "packages", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0" }),
    );
    dependencies[name] = `file:${path}`;
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "pi-build-fixture",
      private: true,
      dependencies: { "@fixture/runtime": dependencies.runtime },
      devDependencies: { "@fixture/build-tool": dependencies["build-tool"] },
    }),
  );
  const lock = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], {
    cwd: directory,
    env: { ...process.env, NODE_ENV: "development" },
  });
  assert.equal(lock.exitCode, 0, lock.stderr.toString());
  assert.equal(existsSync(join(directory, "node_modules")), false);
  mkdirSync(join(directory, ".build-deps"));
  symlinkSync(join(directory, "packages"), join(directory, ".build-deps", "packages"), "dir");
  return directory;
}

describe("shared pi build dependencies", () => {
  it("installs runtime and development dependencies using the fixed lockfile", () => {
    const directory = createFixture();
    const buildDir = prepareBuildDependencies(directory);
    assert.equal(buildDir, join(directory, ".build-deps"));
    for (const name of ["runtime", "build-tool"]) {
      assert.ok(existsSync(join(buildDir, "node_modules", "@fixture", name, "package.json")));
    }
    assert.equal(existsSync(join(directory, "node_modules")), false);
    assert.equal(
      readFileSync(join(buildDir, "bun.lock"), "utf8"),
      readFileSync(join(directory, "bun.lock"), "utf8"),
    );
  });

  it("skips installation when manifests and installed dependencies are unchanged", () => {
    const directory = createFixture();
    const buildDir = prepareBuildDependencies(directory);
    const stamp = join(buildDir, STAMP_FILE);
    const before = statSync(stamp, { bigint: true }).mtimeNs;
    prepareBuildDependencies(directory);
    assert.equal(statSync(stamp, { bigint: true }).mtimeNs, before);
  });

  it("reinstalls when package.json changes", () => {
    const directory = createFixture();
    const buildDir = prepareBuildDependencies(directory);
    const stamp = join(buildDir, STAMP_FILE);
    const before = readFileSync(stamp, "utf8");
    const manifestPath = join(directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, description: "Updated fixture" }));
    prepareBuildDependencies(directory);
    assert.notEqual(readFileSync(stamp, "utf8"), before);
  });

  it("reinstalls when the lockfile changes", () => {
    const directory = createFixture();
    const buildDir = prepareBuildDependencies(directory);
    const stamp = join(buildDir, STAMP_FILE);
    const before = readFileSync(stamp, "utf8");
    const lockPath = join(directory, "bun.lock");
    writeFileSync(lockPath, readFileSync(lockPath, "utf8") + "\n");
    prepareBuildDependencies(directory);
    assert.notEqual(readFileSync(stamp, "utf8"), before);
  });

  it("repairs a missing dependency even when the install stamp matches", () => {
    const directory = createFixture();
    const buildDir = prepareBuildDependencies(directory);
    const packageDir = join(buildDir, "node_modules", "@fixture", "build-tool");
    rmSync(packageDir, { recursive: true });
    prepareBuildDependencies(directory);
    assert.ok(existsSync(join(packageDir, "package.json")));
  });

  it("clears the success stamp after failure and retries on the next run", () => {
    const directory = createFixture();
    const buildDir = prepareBuildDependencies(directory);
    const lockPath = join(directory, "bun.lock");
    const originalLock = readFileSync(lockPath, "utf8");
    writeFileSync(lockPath, "invalid lockfile");
    assert.throws(() => prepareBuildDependencies(directory), /dependency installation failed/);
    assert.equal(existsSync(join(buildDir, STAMP_FILE)), false);
    assert.equal(readFileSync(lockPath, "utf8"), "invalid lockfile");
    writeFileSync(lockPath, originalLock);
    prepareBuildDependencies(directory);
    assert.ok(existsSync(join(buildDir, STAMP_FILE)));
  });

  it("runs automatically as a parent build hook even with NODE_ENV=production", () => {
    const directory = createFixture();
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "bun_install.build.ts")],
      {
        cwd: directory,
        env: { ...process.env, NODE_ENV: "production" },
      },
    );
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.ok(
      existsSync(
        join(directory, ".build-deps", "node_modules", "@fixture", "build-tool", "package.json"),
      ),
    );
  });

  it("returns nonzero without a success stamp when the parent hook cannot install", () => {
    const directory = createFixture();
    writeFileSync(join(directory, "bun.lock"), "invalid lockfile");
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "bun_install.build.ts")],
      {
        cwd: directory,
      },
    );
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("dependency installation failed"));
    assert.equal(existsSync(join(directory, ".build-deps", STAMP_FILE)), false);
  });
});
