import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const installDir = process.env.CAMOUFOX_INSTALL_DIR;
globalThis.fixtureEvents.push(["pkgmanImport", installDir]);

export function camoufoxPath(downloadIfMissing = true) {
  globalThis.fixtureEvents.push(["camoufoxPath", downloadIfMissing]);
  if (downloadIfMissing) throw new Error("Fixture must not allow Camoufox downloads");
  if (!installDir) throw new Error("CAMOUFOX_INSTALL_DIR must be set before importing pkgman");

  const resolvedInstallDir = resolve(installDir);
  const metadata = JSON.parse(readFileSync(join(resolvedInstallDir, "version.json"), "utf8"));
  if (metadata.release === "1") throw new Error("Camoufox executable is outdated.");
  return resolvedInstallDir;
}
