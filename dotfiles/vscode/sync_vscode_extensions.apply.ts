#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const extensionsForWindows = ["ms-vscode-remote.remote-wsl", "tomoki1207.pdf"];

const extensionsForLinux = [
  "alefragnani.bookmarks",
  "apaya.webm-player",
  "awalsh128.keep-sorted",
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
  "hediet.vscode-drawio",
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
const localVscodeExtensions = ["catbraaain.worktree-workspace-sync", "todo-lsp.todo"];

const home = process.env.HOME;
if (home === undefined) throw new Error("HOME: unbound variable");
const todoLspRepo = join(home, "mirrors/github.com/CatBraaain/todo-lsp");
const worktreeWorkspaceSyncRepo = join(
  home,
  "mirrors/github.com/CatBraaain/vscode-worktree-workspace-sync",
);
const defaultBranch = "main";

type Label = "linux" | "windows";

async function main() {
  if (await hasCommand("code")) {
    for (const extension of localVscodeExtensions) {
      await installLocalExtension(extension);
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
    await syncExtensions("windows");
  }
}

async function installLocalExtension(extension: string) {
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
}

async function syncExtensions(label: Label) {
  const desired = label === "linux" ? extensionsForLinux : extensionsForWindows;
  const installed = await listExtensions(label);
  const marketplace = (extensions: string[]) =>
    [
      ...new Set(extensions.filter((extension) => !localVscodeExtensions.includes(extension))),
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
    case "catbraaain.worktree-workspace-sync":
      return {
        url: "https://github.com/CatBraaain/vscode-worktree-workspace-sync.git",
        repo: worktreeWorkspaceSyncRepo,
      };
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
  if (extension === "catbraaain.worktree-workspace-sync") {
    const version = (
      await $`node -p "require('./package.json').version"`.cwd(worktreeWorkspaceSyncRepo).text()
    ).replace(/\n+$/, "");
    vsixPath = join(worktreeWorkspaceSyncRepo, `worktree-workspace-sync-${version}.vsix`);
    rmSync(vsixPath, { force: true });
    await $`npm install 1>&2`.cwd(worktreeWorkspaceSyncRepo);
    await $`npm run build 1>&2`.cwd(worktreeWorkspaceSyncRepo);
    await $`npm run package -- --allow-missing-repository 1>&2`.cwd(worktreeWorkspaceSyncRepo);
  } else if (extension === "todo-lsp.todo") {
    const version = (
      await $`node -p "require('./package.json').version"`
        .cwd(join(todoLspRepo, "vscode-todo"))
        .text()
    ).replace(/\n+$/, "");
    vsixPath = join(todoLspRepo, "vscode-todo/dist", `todo-${version}.vsix`);
    rmSync(vsixPath, { force: true });
    await $`npm ci 1>&2`.cwd(todoLspRepo);
    await $`just package 1>&2`.cwd(todoLspRepo);
  } else {
    throw new Error(`error: unknown local extension '${extension}'`);
  }

  if (!isFile(vsixPath)) {
    throw new Error(`error: VSIX was not created: ${vsixPath}`);
  }
  return vsixPath;
}

async function listExtensions(label: Label): Promise<string[]> {
  const codeCommand = codeExecutable(label);
  const { stdout, exitCode } = await $`${codeCommand} --list-extensions`.quiet().nothrow();
  if (exitCode !== 0) return [];
  return stdout
    .toString()
    .replace(/\r/g, "")
    .split("\n")
    .filter((extension) => /^[a-z0-9-]+\.[a-z0-9-]+$/.test(extension));
}

async function isExtensionInstalled(label: Label, extension: string): Promise<boolean> {
  const codeCommand = codeExecutable(label);
  const { stdout, exitCode } = await $`${codeCommand} --list-extensions`.quiet().nothrow();
  return exitCode === 0 && stdout.toString().replace(/\r/g, "").split("\n").includes(extension);
}

async function runCode(label: Label, args: string[]) {
  const codeCommand = codeExecutable(label);
  await $`${codeCommand} ${args}`;
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
