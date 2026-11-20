const fs = require("fs");
const vscode = require("vscode");
const locator = require("./locator");

const CUSTOM_CSS_EXTENSION_ID = "be5invis.vscode-custom-css";

function activate() {
  try {
    reapplyIfPatchMissing();
  } catch {
    // Patch detection failures must not disturb normal startup.
  }
}

function reapplyIfPatchMissing() {
  if (!vscode.extensions.getExtension(CUSTOM_CSS_EXTENSION_ID)) return;

  const htmlPath = locator.findWorkbenchHtml(
    locator.workbenchSearchDirs({
      execPath: process.execPath,
      mainFilename: require.main && require.main.filename,
      extraRoots: locator.defaultInstallRoots(),
    }),
  );
  if (!htmlPath) return;

  const html = fs.readFileSync(htmlPath, "utf-8");
  if (locator.hasPatchMarker(html)) return;

  vscode.commands.executeCommand("extension.updateCustomCSS").catch(() => {
    // The Loader shows its own error dialogs; stay quiet here.
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
