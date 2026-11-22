import { ensurePatched, installRoots, workbenchSearchDirs } from "./src/patch.ts";

declare const BUNDLED_SCM_COLLAPSE: string;

const command = process.argv[2] ?? "ensure";
if (command !== "ensure" && command !== "remove") {
  console.error(`unknown command: ${command} (expected ensure or remove)`);
  process.exit(1);
}
const pluginsDir = process.argv[3];
const plugins = [{ name: "scm-collapse.js", content: BUNDLED_SCM_COLLAPSE }];

const result = ensurePatched({
  searchDirs: workbenchSearchDirs({ extraRoots: installRoots() }),
  ...(pluginsDir === undefined ? { plugins } : { pluginsDir }),
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
