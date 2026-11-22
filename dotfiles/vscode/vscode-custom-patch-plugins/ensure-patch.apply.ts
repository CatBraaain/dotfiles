#!/usr/bin/env bun
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
