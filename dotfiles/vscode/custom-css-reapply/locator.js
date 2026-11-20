const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const SESSION_ID_PATTERN = /<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ([0-9a-fA-F-]+) !! -->/;

const WORKBENCH_DIR_CANDIDATES = [
  path.join("vs", "code", "electron-browser", "workbench"),
  path.join("vs", "code", "electron-browser"),
  path.join("vs", "code", "electron-sandbox", "workbench"),
  path.join("vs", "code", "electron-sandbox"),
];

const HTML_FILE_CANDIDATES = ["workbench-dev.html", "workbench.esm.html", "workbench.html"];

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
  for (const base of [path.join(root, "out"), path.join(root, "resources", "app", "out")]) {
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

const PATCH_SEGMENT_PATTERN =
  /<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n([\s\S]*?)<!-- !! VSCODE-CUSTOM-CSS-END !! -->/;

const DEFAULT_READ_FILE = (filePath) => fs.readFileSync(filePath, "utf-8");

function patchSegment(html) {
  const match = html.match(PATCH_SEGMENT_PATTERN);
  return match ? match[1] : null;
}

// Mirrors the Loader's variable substitution inside file: imports
// (see be5invis.vscode-custom-css resolveVariable).
function resolveImportUrl(item, variables) {
  return String(item).replaceAll(/\$\{([^{}]+)\}/g, (substr, key) => {
    if (key in variables) return variables[key]();
    if (key.startsWith("env:")) {
      const [_, envKey, optionalDefault] = key.split(":");
      return process.env[envKey] ?? optionalDefault ?? "";
    }
    return substr;
  });
}

// Rebuilds the exact segment the Loader embeds between its markers, or null
// when an import cannot be resolved locally (freshness unknown).
function expectedPatchSegment(imports, variables, readFile = DEFAULT_READ_FILE) {
  let segment = "";
  for (const item of imports) {
    if (typeof item !== "string" || item === "") return null;
    const resolved = resolveImportUrl(item, variables);
    if (!/^file:/.test(resolved)) return null;
    let content;
    try {
      content = readFile(fileURLToPath(resolved));
    } catch {
      return null;
    }
    const extension = path.extname(resolved);
    if (extension === ".js") segment += `<script>${content}</script>`;
    else if (extension === ".css") segment += `<style>${content}</style>`;
    else return null;
  }
  return segment;
}

// true: embedded content matches the imports. false: missing or stale patch.
// null: imports cannot be resolved locally, freshness is unknown.
function isPatchFresh(html, imports, variables, readFile = DEFAULT_READ_FILE) {
  const expected = expectedPatchSegment(imports, variables, readFile);
  if (expected === null) return null;
  return patchSegment(html) === expected;
}

module.exports = {
  SESSION_ID_PATTERN,
  defaultInstallRoots,
  expectedPatchSegment,
  findWorkbenchHtml,
  hasPatchMarker,
  isPatchFresh,
  patchSegment,
  workbenchSearchDirs,
};
