const fs = require("fs");
const path = require("path");

const SESSION_ID_PATTERN = /<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ([0-9a-fA-F-]+) !! -->/;

const WORKBENCH_DIR_CANDIDATES = [
  path.join("vs", "code", "electron-browser", "workbench"),
  path.join("vs", "code", "electron-browser"),
  path.join("vs", "code", "electron-sandbox", "workbench"),
  path.join("vs", "code", "electron-sandbox"),
];

const HTML_FILE_CANDIDATES = [
  "workbench-dev.html",
  "workbench.esm.html",
  "workbench.html",
];

function listDirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function pushAppOutBases(dirs, seen, root) {
  for (const base of [
    path.join(root, "out"),
    path.join(root, "resources", "app", "out"),
  ]) {
    if (seen.has(base)) continue;
    seen.add(base);
    dirs.push(base);
  }
}

function defaultInstallRoots() {
  const roots = [];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code"));
  }
  roots.push("/usr/share/code", "/usr/share/code-insiders", "/snap/code/current/usr/share/code");
  return roots;
}

// The active extension host runs inside the VS Code installation that must be
// patched. Layouts covered here:
//   <install>/Code.exe + <install>/resources/app/out/...
//   <install>/Code.exe + <install>/<commit>/resources/app/out/...  (self-update)
//   <install>/<commit>/Code.exe + <install>/<commit>/out/...
function workbenchSearchDirs({ execPath, mainFilename, extraRoots } = {}) {
  const dirs = [];
  const seen = new Set();

  let dir = execPath ? path.dirname(execPath) : null;
  for (let depth = 0; dir && depth < 3; depth += 1) {
    pushAppOutBases(dirs, seen, dir);
    for (const child of listDirectories(dir)) pushAppOutBases(dirs, seen, child);
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }

  if (mainFilename) {
    pushAppOutBases(dirs, seen, path.dirname(mainFilename));
    pushAppOutBases(dirs, seen, path.dirname(path.dirname(mainFilename)));
  }

  for (const root of extraRoots ?? []) pushAppOutBases(dirs, seen, root);

  return dirs;
}

function findWorkbenchHtml(searchDirs) {
  for (const dir of searchDirs) {
    for (const workbench of WORKBENCH_DIR_CANDIDATES) {
      const workbenchDir = path.join(dir, workbench);
      for (const html of HTML_FILE_CANDIDATES) {
        const candidate = path.join(workbenchDir, html);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function hasPatchMarker(html) {
  return SESSION_ID_PATTERN.test(html);
}

module.exports = {
  SESSION_ID_PATTERN,
  defaultInstallRoots,
  findWorkbenchHtml,
  hasPatchMarker,
  workbenchSearchDirs,
};
