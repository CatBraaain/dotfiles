import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, it, spyOn } from "bun:test";
import { applyCustomPatch, selectPatchTarget } from "../../vscode-custom-patch.apply.ts";
import { buildProject, buildScmSelection } from "./scripts/build.ts";
import { ensurePatched } from "./src/patch.ts";

const first = "a".repeat(64);
const second = "b".repeat(64);
const installed = "catbraaain.vscode-custom-patch@1.0.0";
const linux = { platform: "linux" as const, codeCommand: ["code"] };
const windows = { platform: "windows", powershell: "powershell.exe" } as const;
const activeAppOut = "C:\\Program Files\\VS Code\\O’Brien\\8a14f0cc1b\\resources\\app\\out";
const locateApp = "code --locate-shell-integration-path pwsh";
const shellIntegrationPath = `${activeAppOut}\\vs\\workbench\\contrib\\terminal\\common\\scripts\\shellIntegration.ps1`;
let root: string;
let vscodeDir: string;
let vsix: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vscode-install-test-"));
  vscodeDir = join(root, "dist");
  await mkdir(vscodeDir);
  vsix = join(vscodeDir, "vscode-custom-patch-1.0.0.data.vsix");
  await writeFile(vsix, "");
  await writeFile(vsix + ".sha256", first);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function receipt(target: "linux" | "windows") {
  return join(
    root,
    ".cache/dotfiles/vscode-extensions",
    target,
    "catbraaain.vscode-custom-patch.sha256",
  );
}

function linuxInjectPath() {
  return join(vscodeDir, "vscode-custom-patch", "inject.data.js");
}

it("installs a same-version VSIX on first apply and injects only after installation succeeds", async () => {
  const calls: string[][] = [];
  await applyCustomPatch(vscodeDir, root, linux, async (argv) => {
    calls.push(argv);
    if (argv[1] === linuxInjectPath()) {
      assert.equal((await readFile(receipt("linux"), "utf8")).trim(), first);
    }
    return argv.includes("--list-extensions") ? installed : "";
  });
  assert.deepEqual(calls, [
    ["code", "--list-extensions", "--show-versions"],
    ["code", "--install-extension", vsix, "--force"],
    [process.execPath, linuxInjectPath()],
  ]);
});

it("reports the extension ID without echoing the installer success output", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await applyCustomPatch(vscodeDir, root, linux, async (argv) =>
      argv.includes("--install-extension") ? "Extension was successfully installed.\n" : "",
    );
    assert.deepEqual(log.mock.calls, [["[linux] install catbraaain.vscode-custom-patch"]]);
    assert.deepEqual(stdout.mock.calls, []);
  } finally {
    stdout.mockRestore();
    log.mockRestore();
  }
});

it("skips only the VSIX installation on a content hit, and reinstalls if absent", async () => {
  await applyCustomPatch(vscodeDir, root, linux, async () => "");
  const calls: string[] = [];
  await applyCustomPatch(vscodeDir, root, linux, async (argv) => {
    calls.push(argv[1]!);
    return argv.includes("--list-extensions") ? installed : "";
  });
  assert.deepEqual(calls, ["--list-extensions", linuxInjectPath()]);
  calls.length = 0;
  await applyCustomPatch(vscodeDir, root, linux, async (argv) => {
    calls.push(argv[1]!);
    return "";
  });
  assert.deepEqual(calls, ["--list-extensions", "--install-extension", linuxInjectPath()]);
});

it("skips injection on a failed same-version update, then retries it before injecting", async () => {
  await applyCustomPatch(vscodeDir, root, linux, async () => "");
  await writeFile(vsix + ".sha256", second);
  await assert.rejects(
    applyCustomPatch(vscodeDir, root, linux, async (argv) => {
      if (argv.includes("--install-extension")) throw new Error("install failed");
      if (argv[1] === linuxInjectPath()) assert.fail("injection must not run");
      return installed;
    }),
    /install failed/,
  );
  assert.equal((await readFile(receipt("linux"), "utf8")).trim(), first);
  const calls: string[] = [];
  await applyCustomPatch(vscodeDir, root, linux, async (argv) => {
    calls.push(argv[1]!);
    return argv.includes("--list-extensions") ? installed : "";
  });
  assert.deepEqual(calls, ["--list-extensions", "--install-extension", linuxInjectPath()]);
  assert.equal((await readFile(receipt("linux"), "utf8")).trim(), second);
});

it.skipIf(process.platform !== "linux")(
  "never selects the Windows launcher or remote CLI for a WSL patch",
  async () => {
    const windowsBin = join(root, "windows", "bin");
    const remoteBin = join(root, "server", "bin", "remote-cli");
    const aliases = join(root, "aliases");
    const wrappers = join(root, "wrapper", "bin");
    for (const bin of [windowsBin, remoteBin, aliases, wrappers])
      await mkdir(bin, { recursive: true });
    await writeFile(join(windowsBin, "code"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(windowsBin, "..", "Code.exe"), "");
    await symlink(join(windowsBin, "code"), join(aliases, "code"));
    await writeFile(join(remoteBin, "code"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(
      join(wrappers, "code"),
      `#!/bin/sh\nexec "${join(windowsBin, "code")}" "$@"\n`,
      { mode: 0o755 },
    );
    const path = [aliases, windowsBin, remoteBin, wrappers].join(delimiter);

    assert.equal(await selectPatchTarget("linux", true, path), undefined);
    assert.deepEqual(await selectPatchTarget("win32", false, path), windows);

    const desktopBin = join(root, "linux", "bin");
    await mkdir(desktopBin, { recursive: true });
    const desktopCode = join(desktopBin, "code");
    await writeFile(desktopCode, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(desktopBin, "..", "code"), "\x7fELF");
    const target = await selectPatchTarget("linux", true, [path, desktopBin].join(delimiter));
    assert.ok(target);
    const calls: string[][] = [];
    await applyCustomPatch(vscodeDir, root, target, async (argv) => {
      calls.push(argv);
      return "";
    });
    const command = ["env", "-u", "VSCODE_IPC_HOOK_CLI", desktopCode];
    assert.deepEqual(calls, [
      [...command, "--list-extensions", "--show-versions"],
      [...command, "--install-extension", vsix, "--force"],
      [process.execPath, linuxInjectPath()],
    ]);
  },
);

it("installs and injects from native Windows", async () => {
  const calls: string[][] = [];
  await applyCustomPatch(vscodeDir, root, windows, async (argv) => {
    calls.push(argv);
    return argv[0] === windows.powershell && windowsCommand(argv) === locateApp
      ? shellIntegrationPath
      : "";
  });
  assert.equal(calls.length, 4);
  assert.match(windowsCommand(calls[0]!), /code --list-extensions --show-versions$/);
  assert.ok(windowsCommand(calls[1]!).includes(`$env:DOTFILES_VSCODE_VSIX = '${vsix}'`));
  assert.equal(windowsCommand(calls[2]!), locateApp);
  assert.deepEqual(calls[3], [
    process.execPath,
    join(vscodeDir, "vscode-custom-patch", "cli.js"),
    "ensure",
    "--app-out",
    activeAppOut,
  ]);
});

it("still injects on Windows when the installed VSIX already matches", async () => {
  await applyCustomPatch(vscodeDir, root, windows, async (argv) =>
    argv[0] === windows.powershell && windowsCommand(argv) === locateApp
      ? shellIntegrationPath
      : "",
  );
  const calls: string[][] = [];
  await applyCustomPatch(vscodeDir, root, windows, async (argv) => {
    calls.push(argv);
    if (argv[0] !== windows.powershell) return "";
    return windowsCommand(argv) === locateApp ? shellIntegrationPath : installed;
  });
  assert.equal(calls.length, 3);
  assert.match(windowsCommand(calls[0]!), /code --list-extensions --show-versions$/);
  assert.equal(windowsCommand(calls[1]!), locateApp);
  assert.deepEqual(calls[2], [
    process.execPath,
    join(vscodeDir, "vscode-custom-patch", "cli.js"),
    "ensure",
    "--app-out",
    activeAppOut,
  ]);
});

it("warns and leaves startup to retry when Windows injection fails", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await applyCustomPatch(vscodeDir, root, windows, async (argv) => {
      if (argv[0] === process.execPath) throw new Error("not writable");
      return windowsCommand(argv) === locateApp ? shellIntegrationPath : "";
    });
    assert.match(String(warning.mock.calls[0]?.[0]), /will retry at startup.*not writable/);
    assert.equal((await readFile(receipt("windows"), "utf8")).trim(), first);
  } finally {
    warning.mockRestore();
  }
});

it("skips Windows injection when code does not identify an app output directory", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const calls: string[][] = [];
  try {
    await applyCustomPatch(vscodeDir, root, windows, async (argv) => {
      calls.push(argv);
      return windowsCommand(argv) === locateApp ? shellIntegrationPath.slice(2) : "";
    });
    assert.equal(windowsCommand(calls.at(-1)!), locateApp);
    assert.match(
      String(warning.mock.calls[0]?.[0]),
      /could not locate the VS Code app output directory/,
    );
  } finally {
    warning.mockRestore();
  }
});

it("replaces the old HTML injection only in the selected app and keeps the SCM bridge", async () => {
  const oldOut = join(root, "old", "out");
  const selectedOut = join(root, "selected", "out");
  const original = "<html><head></head></html>";
  const workbenchFile = join("vs", "code", "electron-browser", "workbench", "workbench.html");
  const bundleFile = join("vs", "workbench", "workbench.desktop.main.js");
  const originalBundle = `
var viewService = createDecorator("scmView");
registry.registerCommand("scm.setActiveProvider", accessor => { accessor.get(viewService); });
class View {
  constructor() { this.selectionModeConfig = config("scm.repositories.selectionMode"); }
  set visibleRepositories(repositories) {}
}
var Sorter = class {
  constructor(explorer, context) { this.explorerService = explorer; this.contextService = context; }
  compare(left, right) {
    if (left.isRoot) return -1;
    if (right.isRoot) return 1;
    return left.name.localeCompare(right.name);
  }
};`;
  for (const out of [oldOut, selectedOut]) {
    const html = join(out, workbenchFile);
    const bundle = join(out, bundleFile);
    await mkdir(dirname(html), { recursive: true });
    await mkdir(dirname(bundle), { recursive: true });
    await writeFile(html, original);
    await writeFile(bundle, originalBundle);
  }
  const scmSelectionSource = await buildScmSelection(import.meta.dir);
  assert.equal(
    ensurePatched({
      searchDirs: [selectedOut],
      plugins: [{ name: "scm-collapse.js", content: "window.legacyCollapse = true;" }],
      scmSelectionSource,
    }),
    "patched",
  );
  assert.match(await readFile(join(selectedOut, workbenchFile), "utf8"), /legacyCollapse/);
  const legacyBundle = await readFile(join(selectedOut, bundleFile), "utf8");
  const legacyBridge = legacyBundle.slice(
    legacyBundle.indexOf("\n// vscode-custom-patch: SCM bridge start"),
  );

  await buildProject(import.meta.dir, vscodeDir, async () => {});
  const cli = join(vscodeDir, "cli.js");
  const patch = Bun.spawnSync([process.execPath, cli, "ensure", "--app-out", selectedOut]);
  assert.equal(patch.exitCode, 0, patch.stderr.toString());
  assert.equal(await readFile(join(selectedOut, workbenchFile), "utf8"), original);
  assert.equal(await readFile(join(oldOut, workbenchFile), "utf8"), original);
  const patchedBundle = await readFile(join(selectedOut, bundleFile), "utf8");
  assert.match(patchedBundle, /vscode-custom-patch: sort-explorer start/);
  assert.ok(patchedBundle.endsWith(legacyBridge));
  assert.match(legacyBridge, /agentKit\.scm\.selectRepositories/);
  assert.equal(await readFile(join(oldOut, bundleFile), "utf8"), originalBundle);

  const repeat = Bun.spawnSync([process.execPath, cli, "ensure", "--app-out", selectedOut]);
  assert.equal(repeat.exitCode, 0, repeat.stderr.toString());
  assert.match(repeat.stdout.toString(), /patch already matches/);

  const restore = Bun.spawnSync([process.execPath, cli, "remove", "--app-out", selectedOut]);
  assert.equal(restore.exitCode, 0, restore.stderr.toString());
  assert.equal(await readFile(join(selectedOut, workbenchFile), "utf8"), original);
  assert.equal(await readFile(join(selectedOut, bundleFile), "utf8"), originalBundle);
});

function windowsCommand(argv: string[]): string {
  assert.deepEqual(argv.slice(0, -1), [
    windows.powershell,
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  const script = Buffer.from(argv.at(-1)!, "base64").toString("utf16le");
  const afterSetup = "; Set-Location -LiteralPath $env:SystemRoot; ";
  const exit = "; exit $LASTEXITCODE";
  assert.ok(script.includes(afterSetup));
  assert.ok(script.endsWith(exit));
  return script.slice(script.indexOf(afterSetup) + afterSetup.length, -exit.length);
}
