import { readFileSync } from "node:fs";
import { ensurePatched, installRoots, workbenchSearchDirs } from "./patch.ts";

declare const BUNDLED_SCM_SELECTION: string;

const pluginPath = process.argv[2];
if (!pluginPath) throw new Error("usage: bun run inject <plugin.js>");

const failures: Record<string, string> = {
  "no-workbench": "workbench.html not found; skipping",
  unwritable: "workbench.html not writable; skipping (vscode-custom-patch reapplies at startup)",
  "backup-missing": "patch backup is missing; leaving the patch in place",
  "bridge-unwritable": "SCM bridge: workbench.desktop.main.js cannot be updated; skipping",
  "bridge-invalid":
    "SCM bridge: workbench.desktop.main.js has an invalid patch boundary; leaving it in place",
};

const result = ensurePatched({
  searchDirs: workbenchSearchDirs({ extraRoots: installRoots() }),
  scmSelectionSource: BUNDLED_SCM_SELECTION,
  plugins: [
    {
      name: "scm-collapse.js",
      content: readFileSync(pluginPath, "utf8"),
    },
  ],
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
