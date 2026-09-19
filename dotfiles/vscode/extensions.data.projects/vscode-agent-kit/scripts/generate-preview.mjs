// Deterministic generator for the committed static preview: copies the client
// ESM build into preview/lib, writes webviewStyles to preview/app.css, and
// renders preview/index.html. Run via `npm run build`; no timestamps in output.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Client modules copied verbatim into the preview: their built locations
 * (client.js builds from src/webview/, grouping/viewMode from src/). */
const libSources = {
  "client.js": ["webview", "client.js"],
  "grouping.js": ["grouping.js"],
  "viewMode.js": ["viewMode.js"],
};

/**
 * Pure-ish content map (path -> file contents) derived from build outputs.
 * Deterministic: same build inputs produce identical output (no timestamps).
 *
 * @param {string} distWebviewDir
 * @returns {Promise<Record<string, string>>}
 */
export async function generatePreviewFiles(distWebviewDir) {
  const files = {};
  for (const [name, parts] of Object.entries(libSources)) {
    files[`preview/lib/${name}`] = await readFile(join(distWebviewDir, ...parts), "utf8");
  }
  // CJS build (dist/) so this works regardless of the ESM detection rules.
  files["preview/app.css"] = `${require("../dist/webview/webviewStyles.js").webviewStyles.trim()}\n`;
  files["preview/index.html"] = indexHtml();
  return files;
}

function indexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Sessions — Static Preview</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="preview.css">
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <main id="app">
    <header>
      <h1>Sessions</h1>
      <div class="header-actions">
        <button class="icon-button" type="button" data-action="newSession">New session</button>
        <button class="icon-button" type="button" data-action="refresh" aria-label="Refresh sessions">↻</button>
      </div>
    </header>
    <div class="mode-switch" role="group" aria-label="Session display mode">
      <button class="mode-button" type="button" data-mode="active">Active</button>
      <button class="mode-button" type="button" data-mode="all">All</button>
    </div>
    <section id="sessions" aria-live="polite"></section>
    <p id="status" role="status" aria-live="polite"></p>
  </main>
  <details class="preview-controls">
    <summary>Preview controls</summary>
    <div class="preview-controls-body">
      <button type="button" data-demo-state="sample">Sample data</button>
      <button type="button" data-demo-state="active-empty">Empty Active</button>
      <button type="button" data-demo-state="all-empty">Empty All</button>
      <button type="button" data-width="narrow">Narrow 320px</button>
      <button type="button" data-width="wide">Wide 720px</button>
    </div>
  </details>
  <script type="module" src="./preview-main.mjs"></script>
</body>
</html>
`;
}

// CLI guard: write files only when run directly (vitest imports skip this).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await generatePreviewFiles(join(repoRoot, "dist-webview"));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(repoRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  console.log(`preview: wrote ${Object.keys(files).length} files under preview/`);
}
