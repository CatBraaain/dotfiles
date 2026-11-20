const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const locator = require("./locator");

const CUSTOM_CSS_EXTENSION_ID = "be5invis.vscode-custom-css";

function activate() {
  try {
    reapplyIfPatchStale();
  } catch {
    // Patch detection failures must not disturb normal startup.
  }
}

// Same variable set the Loader substitutes inside file: imports.
function patchVariables() {
  return {
    cwd: () => process.cwd(),
    userHome: () => os.homedir(),
    workspaceFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
    execPath: () => process.env.VSCODE_EXEC_PATH ?? process.execPath,
    pathSeparator: () => path.sep,
    "/": () => path.sep,
  };
}

function reapplyIfPatchStale() {
  if (!vscode.extensions.getExtension(CUSTOM_CSS_EXTENSION_ID)) return;

  const imports = vscode.workspace.getConfiguration("vscode_custom_css").imports;
  if (!Array.isArray(imports) || imports.length === 0) return;

  const htmlPath = locator.findWorkbenchHtml(
    locator.workbenchSearchDirs({
      execPath: process.execPath,
      mainFilename: require.main && require.main.filename,
      extraRoots: locator.defaultInstallRoots(),
    }),
  );
  if (!htmlPath) return;

  const html = fs.readFileSync(htmlPath, "utf-8");
  const freshness = locator.isPatchFresh(html, imports, patchVariables());
  const stale = freshness === false;
  const unpatched = freshness === null && !locator.hasPatchMarker(html);
  if (!stale && !unpatched) return;

  vscode.commands.executeCommand("extension.updateCustomCSS").catch(() => {
    // The Loader shows its own error dialogs; stay quiet here.
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
