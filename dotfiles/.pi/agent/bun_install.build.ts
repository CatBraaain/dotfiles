import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILES = ["package.json", "bun.lock"];
const INSTALL_STAMP = "node_modules/.bun-build-install-hash";

function main(): void {
  prepareBuildDependencies(process.cwd());
}

export function prepareBuildDependencies(agentDir: string): string {
  const buildDir = join(agentDir, ".build-deps");
  mkdirSync(buildDir, { recursive: true });
  const hash = createHash("sha256");
  for (const name of MANIFEST_FILES) {
    const source = join(agentDir, name);
    hash.update(name).update("\0").update(readFileSync(source)).update("\0");
    copyFileSync(source, join(buildDir, name));
  }
  const manifest = JSON.parse(readFileSync(join(buildDir, "package.json"), "utf8"));
  const packages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const fingerprint = hash.digest("hex");
  const stamp = join(buildDir, INSTALL_STAMP);
  const installed = packages.every((name) =>
    existsSync(join(buildDir, "node_modules", name, "package.json")),
  );
  if (installed && existsSync(stamp) && readFileSync(stamp, "utf8") === fingerprint) {
    return buildDir;
  }

  rmSync(stamp, { force: true });
  const result = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
    cwd: buildDir,
    env: { ...process.env, NODE_ENV: "development" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Pi build dependency installation failed in ${buildDir}: exit ${result.exitCode}`,
    );
  }
  const missing = packages.filter(
    (name) => !existsSync(join(buildDir, "node_modules", name, "package.json")),
  );
  if (missing.length > 0) {
    throw new Error(
      `Pi build dependency installation incomplete in ${buildDir}: ${missing.join(", ")}`,
    );
  }
  writeFileSync(stamp, fingerprint);
  return buildDir;
}

if (import.meta.main) main();
