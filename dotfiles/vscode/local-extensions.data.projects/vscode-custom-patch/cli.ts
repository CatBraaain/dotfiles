import { isAbsolute, parse } from "node:path";
import { ensurePatched, installRoots, workbenchSearchDirs } from "./src/patch.ts";

declare const BUNDLED_SCM_COLLAPSE: string;

const command = process.argv[2] ?? "ensure";
if (command !== "ensure" && command !== "remove") {
  console.error(`unknown command: ${command} (expected ensure or remove)`);
  process.exit(1);
}
const pathOption = process.argv[3];
const useAppOut = pathOption === "--app-out";
const appOut = useAppOut ? (process.argv[4] ?? "") : undefined;
if (appOut !== undefined && !isAbsoluteAppOut(appOut)) {
  console.error(`usage: ${command} --app-out <absolute-directory>`);
  process.exit(1);
}
const searchDirs =
  appOut === undefined ? workbenchSearchDirs({ extraRoots: installRoots() }) : [appOut];
const plugins = [{ name: "scm-collapse.js", content: BUNDLED_SCM_COLLAPSE }];

const result = ensurePatched({
  searchDirs,
  ...(useAppOut || pathOption === undefined
    ? { plugins, enableScmBridge: true }
    : { pluginsDir: pathOption }),
  mode: command,
});

const failures: Record<string, string> = {
  "no-workbench": "workbench.html not found",
  unwritable: "workbench.html is not writable",
  "backup-missing": "patch backup is missing; leaving the patch in place",
  "bridge-unwritable": "SCM bridge: workbench.desktop.main.js cannot be updated",
  "bridge-invalid":
    "SCM bridge: workbench.desktop.main.js has an invalid patch boundary; leaving it in place",
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

function isAbsoluteAppOut(path: string): boolean {
  return isAbsolute(path) && (process.platform !== "win32" || parse(path).root.length > 1);
}
