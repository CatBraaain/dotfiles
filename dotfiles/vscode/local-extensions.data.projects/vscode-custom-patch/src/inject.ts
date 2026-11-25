import { ensurePatched, installRoots, workbenchSearchDirs } from "./patch.ts";

declare const BUNDLED_SCM_SELECTION: string;

const failures: Record<string, string> = {
  "no-workbench": "workbench.html not found; skipping",
  unwritable: "workbench.html not writable; skipping (vscode-custom-patch reapplies at startup)",
  "backup-missing": "patch backup is missing; leaving the patch in place",
  "bundle-unwritable": "Custom patch: workbench.desktop.main.js cannot be updated; skipping",
  "bundle-invalid":
    "Custom patch: workbench.desktop.main.js has an invalid patch boundary; leaving it in place",
};

const result = ensurePatched({
  searchDirs: workbenchSearchDirs({ extraRoots: installRoots() }),
  scmSelectionSource: BUNDLED_SCM_SELECTION,
  plugins: [],
  sortExplorer: true,
});

if (result in failures) {
  console.error(failures[result]);
} else {
  const messages: Record<string, string> = {
    patched: "custom scripts patched into workbench",
    unpatched: "custom scripts patch removed from workbench",
    fresh: "workbench patch already matches",
  };
  console.log(messages[result]);
}
