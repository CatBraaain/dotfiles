#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const extensionsForWindows = [
  "be5invis.vscode-custom-css",
  "ms-vscode-remote.remote-wsl",
  "tomoki1207.pdf",
];

const extensionsForLinux = [
  "alefragnani.bookmarks",
  "apaya.webm-player",
  "be5invis.vscode-custom-css",
  "bierner.markdown-yaml-preamble",
  "bpruitt-goddard.mermaid-markdown-syntax-highlighting",
  "catbraaain.auto-fix-venv",
  "catbraaain.toggle-files-exclude",
  "christian-kohler.path-intellisense",
  "davidkol.fastcompare",
  "donjayamanne.githistory",
  "eamodio.gitlens",
  "emeraldwalk.runonsave",
  "formulahendry.code-runner",
  "golang.go",
  "grapecity.gc-excelviewer",
  "gurumukhi.selected-lines-count",
  "ibm.output-colorizer",
  "ionutvmi.reg",
  "jinliming2.vscode-go-template",
  "jkillian.custom-local-formatters",
  "jnoortheen.nix-ide",
  "joshbolduc.commitlint",
  "mark-wiemer.vscode-autohotkey-plus-plus",
  "mechatroner.rainbow-csv",
  "mikestead.dotenv",
  "ms-azuretools.vscode-containers",
  "ms-vscode.live-server",
  "ms-vscode.powershell",
  "ms-vscode.remote-repositories",
  "mylesmurphy.prettify-ts",
  "naumovs.color-highlight",
  "nefrob.vscode-just-syntax",
  "pomber.git-file-history",
  "redhat.vscode-yaml",
  "saber2pr.file-git-history",
  "shd101wyy.markdown-preview-enhanced",
  "svelte.svelte-vscode",
  "takumii.markdowntable",
  "tamasfe.even-better-toml",
  "tombonnike.vscode-status-bar-format-toggle",
  // tomoki1207.pdf is for Linux, but not for WSL.
  "yzhang.markdown-all-in-one",
];

// Built locally from source and installed via VSIX instead of the Marketplace.
// "targets" lists the OS installations each extension is synced to.
const localVscodeExtensions: { id: string; targets: Label[] }[] = [
  { id: "todo-lsp.todo", targets: ["linux"] },
  { id: "catbraaain.scm-collapse-reapply", targets: ["linux", "windows"] },
];
const localExtensionIds = localVscodeExtensions.map((extension) => extension.id);

// Extensions packaged by build hooks into this dist folder. Values are the
// VSIX file name prefix ("name-version.data.vsix"; the reserved .data. marker
// keeps the file out of the home deployment).
const workspaceVsixPrefixes: Record<string, string> = {
  "catbraaain.scm-collapse-reapply": "scm-collapse-reapply-",
};

const home = process.env.HOME;
if (home === undefined) throw new Error("HOME: unbound variable");
const todoLspRepo = join(home, "mirrors/github.com/CatBraaain/todo-lsp");
const defaultBranch = "main";

type Label = "linux" | "windows";

let linuxExtensionEntries: [string, string][] | undefined;

async function main() {
  if (await hasCommand("code")) {
    for (const { id, targets } of localVscodeExtensions) {
      if (!targets.includes("linux")) continue;
      await installLocalExtension(id);
    }
    await syncExtensions("linux");
  } else {
    console.error("warn: 'code' not found; skipping linux extensions");
  }

  let isWsl = false;
  try {
    isWsl = /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    // Missing or unreadable /proc/version does not indicate WSL.
  }
  if (isWsl && (await hasCommand("powershell.exe"))) {
    for (const { id, targets } of localVscodeExtensions) {
      if (!targets.includes("windows")) continue;
      await installLocalExtensionToWindows(id);
    }
    await syncExtensions("windows");
  }
}

async function installLocalExtension(extension: string) {
  if (workspaceVsixPrefixes[extension] !== undefined) {
    const vsix = findWorkspaceVsix(extension);
    if ((await installedExtensionVersion("linux", extension)) === vsix.version) return;
    console.log(`[linux] install ${vsix.path}`);
    await $`code --install-extension ${vsix.path} --force`;
    linuxExtensionEntries = undefined;
    return;
  }

  const { url, repo } = localExtensionSource(extension);
  if (isDirectory(join(repo, ".git"))) {
    const localHead = (await $`git -C ${repo} rev-parse HEAD`.text()).trimEnd();
    const remoteHead = (
      await $`git -C ${repo} ls-remote origin refs/heads/${defaultBranch}`.text()
    ).split(/\s+/)[0];
    if (remoteHead && localHead === remoteHead) {
      const trackedChanges = await $`git -C ${repo} status --porcelain --untracked-files=no`.text();
      if (!trackedChanges && (await isExtensionInstalled("linux", extension))) {
        return;
      }
    }
  }

  await ensureRepo(url, repo);
  const vsixPath = await buildLocalExtensionVsix(extension);
  console.log(`[linux] install ${vsixPath}`);
  await $`code --install-extension ${vsixPath} --force`;
  linuxExtensionEntries = undefined;
}

async function installLocalExtensionToWindows(extension: string) {
  const vsix = findWorkspaceVsix(extension);
  if ((await installedExtensionVersion("windows", extension)) === vsix.version) return;
  const windowsPath = (await $`wslpath -w ${vsix.path}`.text()).replace(/\n+$/, "");
  console.log(`[windows] install ${vsix.path}`);
  await runCode("windows", ["--install-extension", windowsPath, "--force"]);
}

// Build hooks leave their VSIX next to this apply script in the dist folder
// (import.meta.dir is the original dist folder, see SPEC apply scripts).
function findWorkspaceVsix(extension: string): { path: string; version: string } {
  const prefix = workspaceVsixPrefixes[extension];
  if (prefix === undefined) {
    throw new Error(`error: unknown workspace extension '${extension}'`);
  }
  const suffix = ".data.vsix";
  const candidates = readdirSync(import.meta.dir).filter(
    (name) => name.startsWith(prefix) && name.endsWith(suffix),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `error: expected exactly one ${prefix}*${suffix} beside ${import.meta.url}, found ${candidates.length}`,
    );
  }
  const fileName = candidates[0]!;
  const version = fileName.slice(prefix.length, -suffix.length);
  return { path: join(import.meta.dir, fileName), version };
}

async function syncExtensions(label: Label) {
  const desired = label === "linux" ? extensionsForLinux : extensionsForWindows;
  const installed = await installedExtensionIds(label);
  const marketplace = (extensions: string[]) =>
    [
      ...new Set(extensions.filter((extension) => !localExtensionIds.includes(extension))),
    ].sort();
  const installedMarketplace = marketplace(installed);
  const desiredMarketplace = marketplace(desired);

  for (const extension of desiredMarketplace) {
    if (!installedMarketplace.includes(extension)) {
      console.log(`[${label}] install  ${extension}`);
      await runCode(label, ["--install-extension", extension]);
    }
  }
  for (const extension of installedMarketplace) {
    if (!desiredMarketplace.includes(extension)) {
      console.log(`[${label}] uninstall ${extension}`);
      await runCode(label, ["--uninstall-extension", extension]);
    }
  }
}

function localExtensionSource(extension: string) {
  switch (extension) {
    case "todo-lsp.todo":
      return { url: "https://github.com/CatBraaain/todo-lsp.git", repo: todoLspRepo };
    default:
      throw new Error(`error: unknown local extension '${extension}'`);
  }
}

async function ensureRepo(url: string, repo: string) {
  if (isDirectory(join(repo, ".git"))) {
    await $`git -C ${repo} pull --ff-only origin ${defaultBranch} 1>&2`;
  } else if (existsSync(repo)) {
    throw new Error(`error: mirror path is not a Git repository: ${repo}`);
  } else {
    mkdirSync(dirname(repo), { recursive: true });
    await $`git clone ${url} ${repo}`;
  }
}

async function buildLocalExtensionVsix(extension: string) {
  let vsixPath: string;
  if (extension === "todo-lsp.todo") {
    const version = (
      await $`node -p "require('./package.json').version"`
        .cwd(join(todoLspRepo, "vscode-todo"))
        .text()
    ).replace(/\n+$/, "");
    vsixPath = join(todoLspRepo, "vscode-todo/dist", `todo-${version}.vsix`);
    rmSync(vsixPath, { force: true });
    await $`bun install --frozen-lockfile 1>&2`.cwd(todoLspRepo);
    await $`just package 1>&2`.cwd(todoLspRepo);
  } else {
    throw new Error(`error: unknown local extension '${extension}'`);
  }

  if (!isFile(vsixPath)) {
    throw new Error(`error: VSIX was not created: ${vsixPath}`);
  }
  return vsixPath;
}

const extensionIdPattern = /^([a-z0-9-]+\.[a-z0-9-]+)@/;

async function readExtensionEntries(label: Label): Promise<[string, string][]> {
  if (label === "linux" && linuxExtensionEntries !== undefined) return linuxExtensionEntries;
  const codeCommand = codeExecutable(label);
  const { stdout, exitCode } = await $`${codeCommand} --list-extensions --show-versions`.quiet().nothrow();
  if (exitCode !== 0) return [];
  const entries = stdout
    .toString()
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => extensionIdPattern.test(line))
    .map((line): [string, string] => {
      const at = line.indexOf("@");
      return [line.slice(0, at), line.slice(at + 1)];
    });
  if (label === "linux") linuxExtensionEntries = entries;
  return entries;
}

async function installedExtensionIds(label: Label): Promise<string[]> {
  const entries = await readExtensionEntries(label);
  return entries.map(([id]) => id);
}

async function installedExtensionVersion(label: Label, extension: string): Promise<string | undefined> {
  const entries = await readExtensionEntries(label);
  return entries.find(([id]) => id === extension)?.[1];
}

async function isExtensionInstalled(label: Label, extension: string): Promise<boolean> {
  const entries = await readExtensionEntries(label);
  return entries.some(([id]) => id === extension);
}

async function runCode(label: Label, args: string[]) {
  const codeCommand = codeExecutable(label);
  await $`${codeCommand} ${args}`;
  if (label === "linux") linuxExtensionEntries = undefined;
}

async function hasCommand(command: string) {
  return (await $`which ${command}`.quiet().nothrow()).exitCode === 0;
}

function codeExecutable(label: Label) {
  return label === "linux" ? ["code"] : ["powershell.exe", "-NoProfile", "-Command", "code"];
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

await main();
