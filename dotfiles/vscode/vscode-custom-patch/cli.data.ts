// Standalone CLI for the custom patch engine, deployed beside the plugins
// folder so it can also be run manually outside apply.
// Usage: cli.js [ensure|remove] [pluginsDir]
import { dirname, join, resolve } from "node:path";
import { ensurePatched, installRoots, workbenchSearchDirs } from "./patch.data.ts";

const command = process.argv[2] ?? "ensure";
if (command !== "ensure" && command !== "remove") {
  console.error(`unknown command: ${command} (expected ensure or remove)`);
  process.exit(1);
}
// import.meta.url is statically inlined by the bundler, so argv[1] is the
// reliable script location. The plugins folder is the CLI's sibling folder.
const scriptPath = process.argv[1] ? resolve(process.argv[1]) : "cli.js";
const pluginsDir =
  process.argv[3] ?? join(dirname(scriptPath), "..", "vscode-custom-patch-plugins");

const result = ensurePatched({
  searchDirs: workbenchSearchDirs({ extraRoots: installRoots() }),
  pluginsDir,
  mode: command,
});

const failures: Record<string, string> = {
  "no-workbench": "workbench.html not found",
  unwritable: "workbench.html is not writable",
  "backup-missing": "patch backup is missing; leaving the patch in place",
};
if (result in failures) {
  console.error(failures[result]);
  process.exit(1);
}
const messages: Record<string, string> = {
  patched: "custom scripts patched into workbench",
  unpatched: "custom scripts patch removed from workbench",
  fresh: "workbench patch already matches plugins",
};
console.log(messages[result]);
