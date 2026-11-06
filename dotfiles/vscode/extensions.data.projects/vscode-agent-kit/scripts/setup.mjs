// Downloads the fixed-version Linux VS Code build used by the e2e tests.
// Usage: bun run setup

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Fixed VS Code version for reproducible e2e tests. Bump manually to update.
const VSCODE_VERSION = "1.138.0";

const CACHE_DIR = path.join(homedir(), ".cache", "pi-sessions-screenshots");
const VSCODE_DIR = path.join(CACHE_DIR, `vscode-${VSCODE_VERSION}`);
const VSCODE_EXECUTABLE = path.join(VSCODE_DIR, "VSCode-linux-x64", "code");

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function ensureVSCode() {
  if (existsSync(VSCODE_EXECUTABLE)) {
    return;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const tarball = path.join(CACHE_DIR, `vscode-${VSCODE_VERSION}.tar.gz`);
  console.error(`Downloading VS Code ${VSCODE_VERSION} ...`);
  await downloadFile(
    `https://update.code.visualstudio.com/${VSCODE_VERSION}/linux-x64/stable`,
    tarball,
  );
  rmSync(VSCODE_DIR, { recursive: true, force: true });
  mkdirSync(VSCODE_DIR, { recursive: true });
  const extract = spawnSync("tar", ["xzf", tarball, "-C", VSCODE_DIR], { stdio: "pipe" });
  if (extract.status !== 0) {
    throw new Error(`Failed to extract VS Code tarball: ${String(extract.stderr)}`);
  }
  if (!existsSync(VSCODE_EXECUTABLE)) {
    throw new Error(`VS Code executable not found after extraction: ${VSCODE_EXECUTABLE}`);
  }
}

await ensureVSCode();
console.log(VSCODE_EXECUTABLE);
