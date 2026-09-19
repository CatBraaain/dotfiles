// Takes a screenshot of the Agent Sessions view for visual review.
// Usage: npm run screenshot
//
// Downloads a fixed-version Linux build of VS Code on first run, launches it
// with this extension loaded via Playwright's Electron launcher, opens the
// Agent Sessions view showing three dummy active sessions in an isolated
// PI_CODING_AGENT_DIR, and saves a full-window screenshot to .screenshots/.

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { buildDummyDataDir } from "./dummyData.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fixed VS Code version for reproducible screenshots. Bump manually to update.
const VSCODE_VERSION = "1.138.0";

const CACHE_DIR = path.join(homedir(), ".cache", "pi-sessions-screenshots");
const VSCODE_DIR = path.join(CACHE_DIR, `vscode-${VSCODE_VERSION}`);
const VSCODE_EXECUTABLE = path.join(VSCODE_DIR, "VSCode-linux-x64", "code");
const OUTPUT_DIR = path.join(REPO_ROOT, ".screenshots");

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
    throw new Error(`Failed to extract VS Code tarball: ${extract.stderr}`);
  }
  if (!existsSync(VSCODE_EXECUTABLE)) {
    throw new Error(`VS Code executable not found after extraction: ${VSCODE_EXECUTABLE}`);
  }
}

function prepareUserDataDir() {
  const userDataDir = path.join(tmpdir(), "pi-sessions-screenshot-user-data");
  const settingsDir = path.join(userDataDir, "User");
  mkdirSync(settingsDir, { recursive: true });
  // Keep VS Code away from ~/.vscode, which may not be writable in
  // sandboxed environments.
  mkdirSync(path.join(userDataDir, "extensions"), { recursive: true });
  // Keep the captured window clean: no welcome tab, no update popups.
  writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({
      "workbench.startupEditor": "none",
      "update.mode": "none",
      "extensions.ignoreRecommendations": true,
    }),
  );
  return userDataDir;
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${ymd}-${hms}`;
}

async function main() {
  await ensureVSCode();
  const userDataDir = prepareUserDataDir();
  const dataDir = buildDummyDataDir();
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${timestamp()}.png`);

  const app = await electron.launch({
    executablePath: VSCODE_EXECUTABLE,
    // Override both agent-dir variables so the extension can only see the
    // dummy data, regardless of what the invoking shell exports.
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: dataDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(dataDir, "sessions"),
    },
    args: [
      // The extracted chrome-sandbox helper is not configured (not setuid
      // root), so Electron refuses to start without this flag.
      "--no-sandbox",
      "--extensionDevelopmentPath=" + REPO_ROOT,
      "--disable-workspace-trust",
      "--user-data-dir=" + userDataDir,
      "--extensions-dir=" + path.join(userDataDir, "extensions"),
      "--new-window",
      "--window-size=1280,800",
      REPO_ROOT,
    ],
    timeout: 120_000,
  });

  try {
    const window = await app.firstWindow();
    await window.waitForSelector(".monaco-workbench", { timeout: 120_000 });

    const viewButton = window.locator(
      '.activitybar .action-item .action-label[aria-label="Agent Sessions"]',
    );
    await viewButton.waitFor({ timeout: 60_000 });
    await viewButton.click();

    // Wait for the Agent Sessions viewlet to mount and the tree to settle.
    await window.waitForSelector(".part.sidebar .composite.viewlet", {
      timeout: 60_000,
      state: "attached",
    });

    // Dismiss notification toasts and close the secondary sidebar so the
    // capture shows only the workbench and the Agent Sessions view.
    const clearToasts = window.locator(
      ".notifications-toasts .action-label.codicon-notifications-clear",
    );
    if (await clearToasts.first().isVisible().catch(() => false)) {
      await clearToasts.first().click().catch(() => {});
    }
    const hideAuxiliaryBar = window.locator(
      '.part.auxiliarybar .action-label[aria-label^="Hide Secondary Side Bar"]',
    );
    if (await hideAuxiliaryBar.isVisible().catch(() => false)) {
      await hideAuxiliaryBar.click().catch(() => {});
    }
    await window.waitForTimeout(1_000);

    await window.screenshot({ path: outputPath });
    console.log(outputPath);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
