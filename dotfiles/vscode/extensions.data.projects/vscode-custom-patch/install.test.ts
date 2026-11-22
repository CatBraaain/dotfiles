import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "bun:test";
import { applyCustomPatch } from "../../vscode-custom-patch.apply.ts";

const first = "a".repeat(64);
const second = "b".repeat(64);
const installed = "catbraaain.vscode-custom-patch@1.0.0";
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

it("installs a same-version VSIX on first apply and injects only after installation succeeds", async () => {
  const calls: string[][] = [];
  await applyCustomPatch(vscodeDir, root, ["linux"], async (argv, cwd) => {
    calls.push(argv);
    if (argv.includes("inject")) {
      assert.equal(cwd, join(vscodeDir, "extensions.data.projects/vscode-custom-patch"));
      assert.equal((await readFile(receipt("linux"), "utf8")).trim(), first);
    }
    return argv.includes("--list-extensions") ? installed : "";
  });
  assert.deepEqual(calls, [
    ["code", "--list-extensions", "--show-versions"],
    ["code", "--install-extension", vsix, "--force"],
    [process.execPath, "run", "inject", join(vscodeDir, "scm-collapse.data.js")],
  ]);
});

it("skips only the VSIX installation on a content hit, and reinstalls if absent", async () => {
  await applyCustomPatch(vscodeDir, root, ["linux"], async () => "");
  const calls: string[] = [];
  await applyCustomPatch(vscodeDir, root, ["linux"], async (argv) => {
    calls.push(argv[1]!);
    return argv.includes("--list-extensions") ? installed : "";
  });
  assert.deepEqual(calls, ["--list-extensions", "run"]);
  calls.length = 0;
  await applyCustomPatch(vscodeDir, root, ["linux"], async (argv) => {
    calls.push(argv[1]!);
    return "";
  });
  assert.deepEqual(calls, ["--list-extensions", "--install-extension", "run"]);
});

it("skips injection on a failed same-version update, then retries it before injecting", async () => {
  await applyCustomPatch(vscodeDir, root, ["linux"], async () => "");
  await writeFile(vsix + ".sha256", second);
  await assert.rejects(
    applyCustomPatch(vscodeDir, root, ["linux"], async (argv) => {
      if (argv.includes("--install-extension")) throw new Error("install failed");
      if (argv.includes("inject")) assert.fail("injection must not run");
      return installed;
    }),
    /install failed/,
  );
  assert.equal((await readFile(receipt("linux"), "utf8")).trim(), first);
  const calls: string[] = [];
  await applyCustomPatch(vscodeDir, root, ["linux"], async (argv) => {
    calls.push(argv[1]!);
    return installed;
  });
  assert.deepEqual(calls, ["--list-extensions", "--install-extension", "run"]);
  assert.equal((await readFile(receipt("linux"), "utf8")).trim(), second);
});

it("uses a separate receipt for Windows and leaves Windows injection to startup", async () => {
  await applyCustomPatch(vscodeDir, root, ["linux"], async () => "");
  const windowsVsix = "\\\\wsl.localhost\\Ubuntu\\dot files\\O'Brien\\patch.vsix";
  const calls: string[][] = [];
  await applyCustomPatch(vscodeDir, root, ["windows"], async (argv) => {
    calls.push(argv);
    if (argv[0] === "wslpath") return windowsVsix + "\n";
    return argv.includes("--list-extensions") ? installed : "";
  });
  const code = [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "Set-Location -LiteralPath $env:SystemRoot -ErrorAction Stop; code",
  ];
  assert.deepEqual(calls, [
    [...code, "--list-extensions", "--show-versions"],
    ["wslpath", "-w", vsix],
    [
      ...code,
      "--install-extension",
      "'\\\\wsl.localhost\\Ubuntu\\dot files\\O''Brien\\patch.vsix'",
      "--force",
    ],
  ]);
  assert.equal((await readFile(receipt("windows"), "utf8")).trim(), first);
});
