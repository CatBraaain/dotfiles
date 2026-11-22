import { $ } from "bun";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep, win32 } from "node:path";

const extensionId = "catbraaain.vscode-custom-patch";
const vsixPattern = /^vscode-custom-patch-(\d+\.\d+\.\d+)\.data\.vsix$/;
const windowsCodeNotFound = "VS Code CLI not found; skipping";
const shellIntegrationPathSuffix =
  "\\vs\\workbench\\contrib\\terminal\\common\\scripts\\shellIntegration.ps1";
type WindowsTarget = { platform: "windows"; powershell: string };
type Target = { platform: "linux"; codeCommand: string[] } | WindowsTarget;
type Run = (argv: string[], cwd?: string) => Promise<string>;

async function main(): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "win32") return;
  const { DOTFILES_HOME_ROOT: homeRoot, DOTFILES_DIST_DIR: distRoot } = process.env;
  const scriptPath = process.argv[1];
  if (!homeRoot || !distRoot || !scriptPath) throw new Error("apply hook paths are not set");
  const homeRelativeDir = relative(homeRoot, dirname(scriptPath));
  if (
    isAbsolute(homeRelativeDir) ||
    homeRelativeDir === ".." ||
    homeRelativeDir.startsWith(`..${sep}`)
  ) {
    throw new Error("apply hook must run from inside the home root");
  }
  const kernel =
    process.platform === "linux" ? await readFile("/proc/version", "utf8").catch(() => "") : "";
  const isWsl =
    process.platform === "linux" &&
    Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || /microsoft/i.test(kernel));
  const target = await selectPatchTarget(process.platform, isWsl);
  if (target) await applyCustomPatch(join(distRoot, homeRelativeDir), homeRoot, target);
}

export async function selectPatchTarget(
  platform: NodeJS.Platform,
  isWsl: boolean,
  path = process.env.PATH ?? "",
): Promise<Target | undefined> {
  if (platform === "win32") return { platform: "windows", powershell: "powershell.exe" };
  if (platform !== "linux") return;
  const code = isWsl ? await findWslLinuxDesktopCli(path) : Bun.which("code", { PATH: path });
  if (!code) return;
  const codeCommand = isWsl ? ["env", "-u", "VSCODE_IPC_HOOK_CLI", code] : [code];
  return { platform: "linux", codeCommand };
}

async function findWslLinuxDesktopCli(path: string): Promise<string | undefined> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = Bun.which("code", { PATH: dir });
    if (!candidate) continue;
    const launcher =
      candidate === "/snap/bin/code" ? "/snap/code/current/usr/share/code/bin/code" : candidate;
    const code = await realpath(launcher).catch(() => "");
    const binDir = dirname(code);
    if (basename(code) !== "code" || basename(binDir) !== "bin") continue;
    const appHeader = await Bun.file(join(binDir, "..", "code"))
      .slice(0, 4)
      .text()
      .catch(() => "");
    if (appHeader === "\x7fELF") return candidate;
  }
}

export async function applyCustomPatch(
  vscodeDir: string,
  homeRoot: string,
  target: Target,
  run: Run = runCommand,
): Promise<void> {
  const packages = (await readdir(vscodeDir)).filter((name) => vsixPattern.test(name));
  const [fileName] = packages;
  if (!fileName || packages.length !== 1) {
    throw new Error(
      `expected one vscode-custom-patch VSIX in ${vscodeDir}, found ${packages.length}`,
    );
  }
  const version = vsixPattern.exec(fileName)?.[1];
  const vsixPath = join(vscodeDir, fileName);
  const contentHash = (await readFile(`${vsixPath}.sha256`, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(contentHash))
    throw new Error(`invalid VSIX content hash: ${vsixPath}`);

  const receipt = join(
    homeRoot,
    ".cache/dotfiles/vscode-extensions",
    target.platform,
    `${extensionId}.sha256`,
  );
  const extensions = await listExtensions(target, run);
  if (extensions.trim() === windowsCodeNotFound) {
    console.warn(`[windows] ${windowsCodeNotFound}`);
    return;
  }
  const installed = extensions
    .split(/\r?\n/)
    .some((entry) => entry.trim().toLowerCase() === `${extensionId}@${version}`);
  if (!installed || (await readReceipt(receipt)) !== contentHash) {
    await installExtension(target, vsixPath, run);
    await writeReceipt(receipt, contentHash);
  }
  await inject(target, vscodeDir, run);
}

function listExtensions(target: Target, run: Run): Promise<string> {
  if (target.platform === "linux")
    return run([...target.codeCommand, "--list-extensions", "--show-versions"]);
  return runWindows(
    target,
    `if (!(Get-Command code -ErrorAction SilentlyContinue)) { '${windowsCodeNotFound}'; exit 0 }; code --list-extensions --show-versions`,
    run,
  );
}

async function installExtension(target: Target, vsixPath: string, run: Run): Promise<void> {
  console.log(`[${target.platform}] install ${vsixPath}`);
  const output =
    target.platform === "linux"
      ? await run([...target.codeCommand, "--install-extension", vsixPath, "--force"])
      : await runWindows(target, windowsInstallCommand(powerShellLiteral(vsixPath)), run);
  if (output.length > 0) process.stdout.write(output);
}

async function inject(target: Target, vscodeDir: string, run: Run): Promise<void> {
  if (target.platform === "linux") {
    const output = await run(
      [process.execPath, "run", "inject", join(vscodeDir, "scm-collapse.data.js")],
      join(vscodeDir, "extensions.data.projects/vscode-custom-patch"),
    );
    if (output.length > 0) process.stdout.write(output);
    return;
  }

  const cliPath = join(vscodeDir, "vscode-custom-patch", "cli.js");
  try {
    const appOut = await locateWindowsAppOut(target, run);
    const output = await run([process.execPath, cliPath, "ensure", "--app-out", appOut]);
    if (output.length > 0) process.stdout.write(output);
  } catch (error) {
    console.warn(
      `[windows] Could not patch workbench.html; VS Code will retry at startup: ${error}`,
    );
  }
}

async function locateWindowsAppOut(target: WindowsTarget, run: Run): Promise<string> {
  const output = await runWindows(target, "code --locate-shell-integration-path pwsh", run);
  const shellPath = output.trimEnd();
  const appOut = shellPath.slice(0, -shellIntegrationPathSuffix.length);
  if (
    !win32.isAbsolute(shellPath) ||
    win32.parse(shellPath).root.length < 2 ||
    /[\r\n\0]/.test(shellPath) ||
    !shellPath.toLowerCase().endsWith(shellIntegrationPathSuffix.toLowerCase()) ||
    win32.basename(appOut).toLowerCase() !== "out"
  ) {
    throw new Error("could not locate the VS Code app output directory");
  }
  return appOut;
}

function powerShellLiteral(path: string): string {
  if (/["\0\r\n]/.test(path)) throw new Error("invalid Windows path");
  return `'${path.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

function windowsInstallCommand(vsixPathLiteral: string): string {
  return [
    "$code = Get-Command code",
    "$env:DOTFILES_VSCODE_CODE = $code.Source",
    `$env:DOTFILES_VSCODE_VSIX = ${vsixPathLiteral}`,
    "if ($code.Source -match '\\.(cmd|bat)$') {",
    `& $env:ComSpec /d /v:off /s /c '""%DOTFILES_VSCODE_CODE%" --install-extension "%DOTFILES_VSCODE_VSIX%" --force"'`,
    "} else { & $code --install-extension $env:DOTFILES_VSCODE_VSIX --force }",
  ].join("\n");
}

function runWindows(target: WindowsTarget, command: string, run: Run): Promise<string> {
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Set-Location -LiteralPath $env:SystemRoot; ${command}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run([target.powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
}

async function readReceipt(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeReceipt(path: string, contentHash: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempDir = await mkdtemp(join(parent, ".stage-"));
  try {
    const tempPath = join(tempDir, "content.sha256");
    await writeFile(tempPath, `${contentHash}\n`);
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runCommand(argv: string[], cwd?: string): Promise<string> {
  const command = $`${argv}`.quiet();
  if (cwd) command.cwd(cwd);
  const { stdout, stderr, exitCode } = await command.nothrow();
  if (stderr.length > 0) process.stderr.write(stderr);
  if (exitCode !== 0) {
    if (stdout.length > 0) process.stdout.write(stdout);
    throw new Error(`${argv[0]} exited with code ${exitCode}`);
  }
  return stdout.toString();
}

if (import.meta.main) await main();
