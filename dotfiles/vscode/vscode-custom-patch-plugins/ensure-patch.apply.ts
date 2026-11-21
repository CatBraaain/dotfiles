#!/usr/bin/env bun
// Apply hook: run the custom patch engine against this deployed plugins
// folder, so a finished apply guarantees injection without a VS Code round
// trip. cwd is this folder's home directory and contains cli.js and plugins.
import {
  ensurePatched,
  installRoots,
  workbenchSearchDirs,
} from "../vscode-custom-patch/patch.data.ts";

const failures: Record<string, string> = {
  "no-workbench": "workbench.html not found; skipping",
  unwritable: "workbench.html not writable; skipping (vscode-custom-patch reapplies at startup)",
  "backup-missing": "patch backup is missing; leaving the patch in place",
};

const result = ensurePatched({
  searchDirs: workbenchSearchDirs({ extraRoots: installRoots() }),
  pluginsDir: process.cwd(),
});

if (result in failures) {
  console.error(failures[result]);
} else {
  const messages: Record<string, string> = {
    patched: "custom scripts patched into workbench",
    unpatched: "custom scripts patch removed from workbench",
    fresh: "workbench patch already matches plugins",
  };
  console.log(messages[result]);
}
