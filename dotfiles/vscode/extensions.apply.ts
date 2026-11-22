#!/usr/bin/env bun
import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const extensionsForWindows = ["ms-vscode-remote.remote-wsl", "tomoki1207.pdf"];

const extensionsForLinux = [
  "alefragnani.bookmarks",
  "apaya.webm-player",
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

const todoLspId = "todo-lsp.todo";
const agentKitId = "agent-kit.agent-kit";
const localExtensionIds = [todoLspId, agentKitId, "catbraaain.vscode-custom-patch"];

const home = process.env.HOME;
if (home === undefined) throw new Error("HOME: unbound variable");
const todoLspRepo = join(home, "mirrors/github.com/CatBraaain/todo-lsp");
const todoLspUrl = "https://github.com/CatBraaain/todo-lsp.git";
const defaultBranch = "main";

type Label = "linux" | "windows";

let linuxExtensionEntries: [string, string][] | undefined;

async function main() {
  if (await hasCommand("code")) {
    await installTodoLsp();
    try {
      await installAgentKit();
    } catch (error) {
      console.error(`[linux] ${agentKitId}: ${error}`);
      process.exitCode = 1;
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

async function installTodoLsp() {
  if (isDirectory(join(todoLspRepo, ".git"))) {
    const localHead = (await $`git -C ${todoLspRepo} rev-parse HEAD`.text()).trimEnd();
    const remoteHead = (
      await $`git -C ${todoLspRepo} ls-remote origin refs/heads/${defaultBranch}`.text()
    ).split(/\s+/)[0];
    if (remoteHead && localHead === remoteHead) {
      const trackedChanges =
        await $`git -C ${todoLspRepo} status --porcelain --untracked-files=no`.text();
      if (!trackedChanges && (await isExtensionInstalled("linux", todoLspId))) return;
    }
  }

  await ensureRepo(todoLspUrl, todoLspRepo);
  const project = join(todoLspRepo, "vscode-todo");
  const version = (
    await $`node -p "require('./package.json').version"`.cwd(project).text()
  ).trimEnd();
  const vsixPath = join(project, "dist", `todo-${version}.vsix`);
  rmSync(vsixPath, { force: true });
  await $`bun install --frozen-lockfile 1>&2`.cwd(todoLspRepo);
  await $`just package 1>&2`.cwd(todoLspRepo);
  await installVsix(vsixPath);
}

async function installAgentKit() {
  const { DOTFILES_HOME_ROOT: homeRoot, DOTFILES_DIST_DIR: distRoot } = process.env;
  if (!homeRoot || !distRoot) throw new Error("apply hook paths are not set");
  const vscodeRelativeDir = relative(homeRoot, import.meta.dir);
  if (
    isAbsolute(vscodeRelativeDir) ||
    vscodeRelativeDir === ".." ||
    vscodeRelativeDir.startsWith(`..${sep}`)
  ) {
    throw new Error("apply hook must run from inside the home root");
  }
  const project = join(distRoot, vscodeRelativeDir, "extensions.data.projects/vscode-agent-kit");
  const manifest = await Bun.file(join(project, "package.json")).json();
  const vsixName = "agent-kit.vsix";
  const contentHash = await hashAgentKitBuildInputs(project, vsixName);
  const receipt = join(homeRoot, ".cache/dotfiles/vscode-extensions/linux", `${agentKitId}.sha256`);
  const installed = (await readExtensionEntries("linux", { requireSuccess: true })).some(
    ([id, version]) => id === agentKitId && version === manifest.version,
  );
  if (installed && (await readReceipt(receipt)) === contentHash) return;

  const vsixPath = join(project, vsixName);
  rmSync(vsixPath, { force: true });
  await $`bun install --frozen-lockfile 1>&2`.cwd(project);
  await $`bun run build 1>&2`.cwd(project);
  await $`bunx @vscode/vsce package --allow-missing-repository --skip-license --no-dependencies --out ${vsixPath} 1>&2`.cwd(
    project,
  );
  await installVsix(vsixPath);
  await mkdir(dirname(receipt), { recursive: true });
  await Bun.write(receipt, `${contentHash}\n`);
}

async function hashAgentKitBuildInputs(project: string, vsixName: string): Promise<string> {
  const generatedEntries = new Set([
    "node_modules",
    "dist",
    "dist-webview",
    "storybook-static",
    vsixName,
  ]);
  const paths: string[] = [];
  const childFiles = new Bun.Glob("**/*");
  for (const entry of await readdir(project, { withFileTypes: true })) {
    if (generatedEntries.has(entry.name)) continue;
    if (entry.isDirectory()) {
      const cwd = join(project, entry.name);
      for await (const path of childFiles.scan({ cwd, dot: true })) {
        paths.push(join(entry.name, path));
      }
    } else {
      paths.push(entry.name);
    }
  }
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const contents = await readFile(join(project, path));
    const fileHash = createHash("sha256").update(contents).digest("hex");
    hash.update(`${path}\0${fileHash}\n`);
  }
  return hash.digest("hex");
}

async function readReceipt(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function syncExtensions(label: Label) {
  const desired = label === "linux" ? extensionsForLinux : extensionsForWindows;
  const installed = await installedExtensionIds(label);
  const marketplace = (extensions: string[]) =>
    [...new Set(extensions.filter((extension) => !localExtensionIds.includes(extension)))].sort();
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

async function installVsix(vsixPath: string) {
  if (!isFile(vsixPath)) throw new Error(`error: VSIX was not created: ${vsixPath}`);
  console.log(`[linux] install ${vsixPath}`);
  await runCode("linux", ["--install-extension", vsixPath, "--force"]);
}

const extensionIdPattern = /^([a-z0-9-]+\.[a-z0-9-]+)@/;

async function readExtensionEntries(
  label: Label,
  options?: { requireSuccess: boolean },
): Promise<[string, string][]> {
  if (label === "linux" && linuxExtensionEntries !== undefined) return linuxExtensionEntries;
  const codeCommand = codeExecutable(label);
  const { stdout, stderr, exitCode } = await $`${codeCommand} --list-extensions --show-versions`
    .quiet()
    .nothrow();
  if (exitCode !== 0) {
    if (options?.requireSuccess) {
      throw new Error(
        `could not list ${label} extensions (exit ${exitCode}): ${stderr.toString().trim()}`,
      );
    }
    return [];
  }
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
