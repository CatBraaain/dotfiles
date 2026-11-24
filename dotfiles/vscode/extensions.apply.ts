#!/usr/bin/env bun
import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep, win32 } from "node:path";

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

const todoLspUrl = "https://github.com/CatBraaain/todo-lsp.git";
const defaultBranch = "main";

type Target = {
  label: "linux" | "windows" | "wsl";
  code: string;
  entries?: [string, string][];
};
type RunOptions = {
  quiet?: boolean;
  ignoreFailure?: (stderr: string) => boolean;
};
type Run = (argv: string[], options?: RunOptions) => Promise<string>;

async function main() {
  const platform = process.platform;
  const kernel =
    platform === "linux" ? await readFile("/proc/version", "utf8").catch(() => "") : "";
  const isWsl =
    platform === "linux" &&
    Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || /microsoft/i.test(kernel));
  await applyExtensions(platform, isWsl);
}

export async function applyExtensions(
  platform: NodeJS.Platform,
  isWsl: boolean,
  {
    selectTarget = selectExtensionTarget,
    installLocal = installLocalExtensions,
    installWindowsAgentKit = installAgentKit,
    run = runCommand,
    findPowerShell = findWindowsPowerShell,
  } = {},
) {
  async function syncPrimaryTarget() {
    const target = await selectTarget(platform, isWsl);
    if (!target) {
      console.warn(
        isWsl
          ? "[wsl] Could not select a VS Code Server CLI; skipping"
          : "VS Code CLI not found; skipping",
      );
      return;
    }
    if (target.label !== "windows") await installLocal(target);
    await syncMarketplaceExtensions(target, run);
    if (platform === "win32" && !isWsl && target.label === "windows") {
      await installWindowsAgentKit(target, run);
    }
  }

  if (!isWsl) return syncPrimaryTarget();

  const results = await Promise.allSettled([
    syncPrimaryTarget(),
    syncWindowsExtensionsFromWsl(findPowerShell(), run),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, "Could not sync VS Code extensions");
}

function findWindowsPowerShell() {
  const onPath = Bun.which("powershell.exe");
  if (onPath) return onPath;
  const standardPath = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  if (isFile(standardPath)) return standardPath;
}

async function syncWindowsExtensionsFromWsl(powershell: string | undefined, run: Run) {
  if (!powershell) {
    console.warn("[windows] Windows PowerShell not found; skipping");
    return;
  }
  await syncMarketplaceExtensions({ label: "windows", code: powershell }, (argv, options) =>
    runWindowsCode(argv, options, run),
  );
}

export function runWindowsCode(
  [powershell, ...args]: string[],
  options?: RunOptions,
  run: Run = runCommand,
) {
  if (!powershell || args.some((arg) => arg.length === 0 || /[^a-z0-9.-]/i.test(arg))) {
    throw new Error("Invalid Windows VS Code CLI arguments");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "Set-Location -LiteralPath $env:SystemRoot",
    "Remove-Item Env:VSCODE_IPC_HOOK_CLI -ErrorAction SilentlyContinue",
    "$code = Get-Command code.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if (-not $code) { throw 'Windows VS Code CLI not found on PATH' }",
    `& $code.Source ${args.map((arg) => `'${arg}'`).join(" ")}`,
    "exit $LASTEXITCODE",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run([powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], options);
}

export async function selectExtensionTarget(
  platform: NodeJS.Platform,
  isWsl: boolean,
  path = process.env.PATH ?? "",
  serverHome = process.env.VSCODE_AGENT_FOLDER || join(homedir(), ".vscode-server"),
): Promise<Target | undefined> {
  if (platform !== "linux" && platform !== "win32") return;
  if (platform === "linux" && isWsl) {
    const code = await findWslServerCli(path, serverHome);
    if (code) return { label: "wsl", code };
    return;
  }
  const code = Bun.which("code", { PATH: path });
  if (code) return { label: platform === "win32" ? "windows" : "linux", code };
}

async function findWslServerCli(path: string, serverHome: string): Promise<string | undefined> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = Bun.which("code", { PATH: dir });
    if (!candidate) continue;
    const cliDir = dirname(await realpath(candidate).catch(() => ""));
    if (basename(cliDir) !== "remote-cli") continue;
    const server = await findServerInDir(dirname(cliDir));
    if (server) return server;
  }

  const root = await realpath(serverHome).catch(() => "");
  if (!root) return;
  let server: string | undefined;
  for (const pattern of ["bin/*/bin/code-server", "cli/servers/Stable-*/server/bin/code-server"]) {
    const glob = new Bun.Glob(pattern);
    for await (const candidate of glob.scan({ cwd: root, absolute: true })) {
      const confirmed = await findServerInDir(dirname(candidate));
      if (!confirmed) continue;
      if (server) return;
      server = confirmed;
    }
  }
  return server;
}

async function findServerInDir(dir: string): Promise<string | undefined> {
  const server = Bun.which("code-server", { PATH: dir });
  if (!server || (await realpath(server).catch(() => "")) !== join(dir, "code-server")) return;
  const nodeHeader = await Bun.file(join(dir, "..", "node"))
    .slice(0, 4)
    .text()
    .catch(() => "");
  if (nodeHeader === "\x7fELF") return server;
}

async function installLocalExtensions(target: Target) {
  if (target.label === "wsl") await readExtensionEntries(target);

  await installTodoLsp(target);
  try {
    await installAgentKit(target);
  } catch (error) {
    console.error(`[${target.label}] ${agentKitId}: ${error}`);
    process.exitCode = 1;
  }
}

async function installTodoLsp(target: Target) {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("HOME: unbound variable");
  const todoLspRepo = join(home, "mirrors/github.com/CatBraaain/todo-lsp");
  if (isDirectory(join(todoLspRepo, ".git"))) {
    const localHead = (await $`git -C ${todoLspRepo} rev-parse HEAD`.text()).trimEnd();
    const remoteHead = (
      await $`git -C ${todoLspRepo} ls-remote origin refs/heads/${defaultBranch}`.text()
    ).split(/\s+/)[0];
    if (remoteHead && localHead === remoteHead) {
      const trackedChanges =
        await $`git -C ${todoLspRepo} status --porcelain --untracked-files=no`.text();
      if (!trackedChanges && (await readExtensionEntries(target)).some(([id]) => id === todoLspId))
        return;
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
  await installVsix(target, vsixPath, (argv) => {
    console.log(`[${target.label}] install ${vsixPath}`);
    return runCommand(argv);
  });
}

async function installAgentKit(target: Target, run = runCommand) {
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
  const project = join(
    distRoot,
    vscodeRelativeDir,
    "local-extensions.data.projects/vscode-agent-kit",
  );
  await syncAgentKit(target, { homeRoot, project }, { run });
}

const agentKitVsixName = "agent-kit.vsix";
const generatedAgentKitEntries = new Set([
  "node_modules",
  "dist",
  "dist-webview",
  "storybook-static",
  agentKitVsixName,
]);

export async function syncAgentKit(
  target: Target,
  { homeRoot, project }: { homeRoot: string; project: string },
  { run = runCommand, runStep = runAgentKitStep } = {},
) {
  const manifest = await Bun.file(join(project, "package.json")).json();
  const contentHash = await hashAgentKitBuildInputs(project);
  const receipt = join(
    homeRoot,
    ".cache/dotfiles/vscode-extensions",
    target.label === "windows" ? "windows" : "linux",
    `${agentKitId}.sha256`,
  );
  const installed = (await readExtensionEntries(target, true, run)).some(
    ([id, version]) => id === agentKitId && version === manifest.version,
  );
  if (installed && (await readReceipt(receipt)) === contentHash) return;

  console.log(`[${target.label}] build and install ${agentKitId}`);
  if (target.label === "windows" && win32.parse(project).root.startsWith("\\\\")) {
    const tempRoot = await realpath(tmpdir());
    if (!/^[a-z]:\\$/i.test(win32.parse(tempRoot).root)) {
      throw new Error(`Agent Kit staging requires a local Windows temp directory: ${tempRoot}`);
    }
    const stage = await mkdtemp(join(tempRoot, "dotfiles-agent-kit-"));
    try {
      const stagedProject = join(stage, "vscode-agent-kit");
      await cp(project, stagedProject, {
        recursive: true,
        filter: (path) =>
          !generatedAgentKitEntries.has(relative(project, path).split(sep)[0] ?? ""),
      });
      await buildAndInstallAgentKit(target, stagedProject, run, runStep);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } else {
    await buildAndInstallAgentKit(target, project, run, runStep);
  }
  await mkdir(dirname(receipt), { recursive: true });
  await Bun.write(receipt, `${contentHash}\n`);
}

async function buildAndInstallAgentKit(
  target: Target,
  project: string,
  run: Run,
  runStep: typeof runAgentKitStep,
) {
  const vsixPath = join(project, agentKitVsixName);
  rmSync(vsixPath, { force: true });
  await runStep("Install dependencies", ["bun", "install", "--frozen-lockfile"], project);
  await runStep("Build extension", ["bun", "run", "build"], project);
  await runStep(
    "Package VSIX",
    [
      "bunx",
      "@vscode/vsce",
      "package",
      "--allow-missing-repository",
      "--skip-license",
      "--no-dependencies",
      "--out",
      vsixPath,
    ],
    project,
  );
  if (target.label === "windows") {
    await installVsix(target, vsixPath, (argv, options) =>
      runNativeVsixInstall(argv, options, run),
    );
  } else {
    await installVsix(target, vsixPath, (argv) => runStep("Install VSIX", argv));
  }
}

async function hashAgentKitBuildInputs(project: string): Promise<string> {
  const paths: string[] = [];
  const childFiles = new Bun.Glob("**/*");
  for (const entry of await readdir(project, { withFileTypes: true })) {
    if (generatedAgentKitEntries.has(entry.name)) continue;
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

export async function syncMarketplaceExtensions(target: Target, run: Run = runCommand) {
  const { label } = target;
  const desired = label === "windows" ? extensionsForWindows : extensionsForLinux;
  const entries = await readExtensionEntries(target, label !== "linux", run);
  const installed = entries.map(([id]) => id);
  const marketplace = (extensions: string[]) =>
    [...new Set(extensions.filter((extension) => !localExtensionIds.includes(extension)))].sort();
  const installedMarketplace = marketplace(installed);
  const desiredMarketplace = marketplace(desired);

  for (const extension of desiredMarketplace) {
    if (!installedMarketplace.includes(extension)) {
      console.log(`[${label}] install  ${extension}`);
      await runCode(target, ["--install-extension", extension], run);
    }
  }
  for (const extension of installedMarketplace) {
    if (!desiredMarketplace.includes(extension)) {
      console.log(`[${label}] uninstall ${extension}`);
      await runCode(target, ["--uninstall-extension", extension], run, {
        ignoreFailure: (stderr) => isExtensionAlreadyUninstalled(stderr, extension),
      });
    }
  }
}

function isExtensionAlreadyUninstalled(stderr: string, extension: string): boolean {
  const [message, hint, ...otherLines] = stderr.trim().split(/\r?\n/);
  const useFullExtensionId =
    "Make sure you use the full extension ID, including the publisher, e.g.: ms-dotnettools.csharp";
  return (
    message === `Extension '${extension}' is not installed.` &&
    (hint === undefined || hint === useFullExtensionId) &&
    otherLines.length === 0
  );
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

async function installVsix(target: Target, vsixPath: string, run: Run) {
  if (!isFile(vsixPath)) throw new Error(`error: VSIX was not created: ${vsixPath}`);
  await runCode(target, ["--install-extension", vsixPath, "--force"], run);
}

function runNativeVsixInstall(
  [code, flag, vsixPath, force]: string[],
  options: RunOptions | undefined,
  run: Run,
) {
  if (!code || !vsixPath || flag !== "--install-extension" || force !== "--force") {
    throw new Error("Invalid native VS Code VSIX arguments");
  }
  if (!/\.(cmd|bat)$/i.test(code)) return run([code, flag, vsixPath, force], options);

  function pathLiteral(path: string) {
    if (/["\0\r\n]/.test(path)) throw new Error("Invalid Windows path");
    return `'${path.replace(/['‘’‚‛]/g, "$&$&")}'`;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "Set-Location -LiteralPath $env:SystemRoot",
    `$env:DOTFILES_VSCODE_CODE = ${pathLiteral(code)}`,
    `$env:DOTFILES_VSCODE_VSIX = ${pathLiteral(vsixPath)}`,
    `& $env:ComSpec /d /v:off /s /c '""%DOTFILES_VSCODE_CODE%" --install-extension "%DOTFILES_VSCODE_VSIX%" --force"'`,
    "exit $LASTEXITCODE",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    options,
  );
}

async function runAgentKitStep(step: string, argv: string[], cwd?: string): Promise<string> {
  const command = $`${argv}`.quiet().nothrow();
  if (cwd) command.cwd(cwd);
  const { stdout, stderr, exitCode } = await command;
  if (exitCode !== 0) {
    const details = [stdout.toString().trimEnd(), stderr.toString().trimEnd()].filter(Boolean);
    throw new Error([`${step} failed (exit code ${exitCode})`, ...details].join("\n"));
  }
  return stdout.toString();
}

const extensionIdPattern = /^([a-z0-9-]+\.[a-z0-9-]+)@/i;

async function readExtensionEntries(
  target: Target,
  requireSuccess = target.label !== "linux",
  run: Run = runCommand,
): Promise<[string, string][]> {
  if (target.entries !== undefined) return target.entries;
  const argv = [target.code, "--list-extensions", "--show-versions"];
  let listing: string;
  try {
    listing = await run(argv, { quiet: true });
  } catch (error) {
    if (!requireSuccess) return [];
    throw new Error(`could not list ${target.label} extensions: ${error}`, { cause: error });
  }
  const entries = listing
    .split(/\r?\n/)
    .filter((line) => extensionIdPattern.test(line))
    .map((line): [string, string] => {
      const at = line.indexOf("@");
      return [line.slice(0, at).toLowerCase(), line.slice(at + 1)];
    });
  target.entries = entries;
  return entries;
}

async function runCode(target: Target, args: string[], run: Run, options?: RunOptions) {
  await run([target.code, ...args], options);
  delete target.entries;
}

async function runCommand(
  argv: string[],
  { quiet = false, ignoreFailure }: RunOptions = {},
): Promise<string> {
  const command = $`${argv}`.nothrow();
  if (quiet || ignoreFailure) command.quiet();
  const { exitCode, stdout, stderr } = await command;
  const errorOutput = stderr.toString();
  const ignoredFailure = exitCode !== 0 && ignoreFailure?.(errorOutput);
  if (ignoreFailure && !quiet) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderr.length > 0 && !ignoredFailure) process.stderr.write(stderr);
  }
  if (exitCode !== 0 && !ignoredFailure) {
    throw new Error(`${argv[0]} exited with code ${exitCode}: ${errorOutput.trim()}`);
  }
  return stdout.toString();
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

if (import.meta.main) await main();
