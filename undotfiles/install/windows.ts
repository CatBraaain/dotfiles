// Windows bootstrap installer: installs apps with winget, sets up Mozc, and
// cleans up desktop shortcuts and WinGet package links.
//
// Requires Administrator. When not elevated, the script relaunches itself via
// gsudo (one UAC prompt); `gsudo status IsElevated` exits with 0 once
// elevated, so the relaunch happens at most once.

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const unmanagedPackages: readonly string[] = [
  // keep-sorted start by_regex=\..+ sticky_comments=no
  "Google.Chrome",
  "Discord.Discord",
  "Docker.DockerDesktop",
  "Mozilla.Firefox",
  // keep-sorted end
];

const managedPackages: readonly string[] = [
  // keep-sorted start by_regex=\..+ sticky_comments=no
  "Guru3D.Afterburner",
  // "Microsoft.AppInstaller"
  "CPUID.CPU-Z",
  "BluePointLilac.ContextMenuManager",
  "sordum.EasyContextMenu",
  "w4po.ExplorerTabUtility",
  "Rem0o.FanControl",
  "AdrienAllard.FileConverter",
  "GIMP.GIMP.3",
  "DuongDieuPhap.ImageGlass",
  // "mulaRahul.Keyviz"
  "LocalSend.LocalSend",
  "ch.LosslessCut",
  "MPC-BE.MPC-BE",
  "Mojang.MinecraftLauncher",
  "M2Team.NanaZip",
  "OBSProject.OBSStudio",
  "OpenWhispr.OpenWhispr",
  "Guru3D.RTSS",
  "ShareX.ShareX",
  "Meltytech.Shotcut",
  "Valve.Steam",
  // "StirlingTools.StirlingPDF"
  "Microsoft.Sysinternals.Autologon",
  "Devolutions.UniGetUI",
  "Microsoft.VisualStudioCode",
  "Rime.Weasel",
  "WinDirStat.WinDirStat",
  "Microsoft.WindowsTerminal",
  "ZedIndustries.Zed",
  "HaraldBoegeholz.h2testw",
  // keep-sorted end
];

const managedDevPackages: readonly string[] = [
  // keep-sorted start by_regex=\..+ sticky_comments=no
  // "qishibo.AnotherRedisDesktopManager"
  "AutoHotkey.AutoHotkey", // windows
  "Oven-sh.Bun",
  "Solidiquis.Erdtree",
  "Git.Git",
  "Casey.Just",
  "RussellBanks.Komac",
  "OpenJS.NodeJS.LTS",
  "Microsoft.PowerShell", // windows
  "Canonical.Ubuntu", // windows
  "GitHub.cli",
  "Microsoft.coreutils",
  "Wilfred.difftastic",
  "gerardog.gsudo", // windows
  "CatBraaain.runx", // windows
  "CatBraaain.winconfig", // windows
  // keep-sorted end
];

async function main(): Promise<void> {
  if (!isElevated()) await selfElevate();
  installWingetPackages();
  installMozc();
  removeDesktopShortcuts();
  linkWingetPackageExes();
}

function selfElevate(): Promise<never> {
  const proc = Bun.spawn(["gsudo", "-d", process.execPath, import.meta.path], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited.then((code) => process.exit(code ?? 1));
}

function installWingetPackages(): void {
  // Individual winget failures are logged but do not abort the rest of the
  // bootstrap, matching the previous PowerShell behavior.
  runAllowingFailure([
    "winget", "install", "AutoHotkey.AutoHotkey",
    "--silent", "--version", "1.1.37.02", "--no-upgrade", "--source", "winget",
  ]);
  runAllowingFailure(["winget", "install", ...unmanagedPackages, "--no-upgrade", "--source", "winget"]);
  runAllowingFailure(["winget", "install", ...managedPackages, "--source", "winget"]);
  runAllowingFailure(["winget", "install", ...managedDevPackages, "--source", "winget"]);
}

function installMozc(): void {
  const mozcServerExe = join(programFilesX86(), "Mozc", "mozc_server.exe");
  if (existsSync(mozcServerExe)) {
    console.log(`Mozc is already installed at ${dirname(mozcServerExe)}; skipping the Mozc install`);
    return;
  }

  // No winget package nor GitHub release exists; the official CI publishes an
  // MSI as a run artifact, which needs GitHub authentication (gh from
  // managedDevPackages and `gh auth login`).
  const mozcRun = output([
    "gh", "run", "list", "--repo", "google/mozc",
    "--workflow=windows.yaml", "--status=success", "--limit", "1",
    "--json", "databaseId", "--jq", ".[0].databaseId",
  ]).trim();
  const mozcDir = join(tmpdir(), "mozc-install");
  mkdirSync(mozcDir, { recursive: true });
  run([
    "gh", "run", "download", mozcRun, "--repo", "google/mozc",
    "--name", "Mozc64_x64.msi", "--dir", mozcDir,
  ]);
  // The artifact name and the MSI file name inside it differ (Mozc64.msi), so
  // resolve the extracted .msi instead of assuming the artifact name.
  const mozcMsi = readdirSync(mozcDir).find((name) => name.endsWith(".msi"));
  if (!mozcMsi) throw new Error(`no MSI found in ${mozcDir}`);
  run(["msiexec", "/i", mozcMsi, "/qn"]);
  rmSync(mozcDir, { recursive: true, force: true });
}

function removeDesktopShortcuts(): void {
  const desktop = join(homedir(), "Desktop");
  for (const name of readdirSync(desktop)) {
    if (name.endsWith(".lnk")) rmSync(join(desktop, name), { force: true });
  }
}

function linkWingetPackageExes(): void {
  const linksDir = join(localAppData(), "Microsoft", "WinGet", "Links");
  const packagesDir = join(localAppData(), "Microsoft", "WinGet", "Packages");
  for (const relative of readdirSync(packagesDir, { recursive: true, encoding: "utf8" })) {
    if (!relative.endsWith(".exe")) continue;
    const exePath = join(packagesDir, relative);
    const linkPath = join(linksDir, basename(exePath));
    rmSync(linkPath, { force: true }); // Replace existing links (New-Item -Force).
    symlinkSync(exePath, linkPath, "file");
  }
}

function isElevated(): boolean {
  // `gsudo status IsElevated` exits with 0 when elevated, 1 otherwise.
  const status = Bun.spawnSync(["gsudo", "status", "IsElevated"], { stdout: "ignore", stderr: "ignore" });
  return status.exitCode === 0;
}

function run(command: readonly string[]): void {
  const exitCode = runInheritingIO(command);
  if (exitCode !== 0) throw new Error(`command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

function runAllowingFailure(command: readonly string[]): void {
  const exitCode = runInheritingIO(command);
  if (exitCode !== 0) console.error(`command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

function output(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`command failed with exit code ${result.exitCode}: ${command.join(" ")}`);
  }
  return new TextDecoder().decode(result.stdout);
}

function runInheritingIO(command: readonly string[]): number | null {
  return Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" }).exitCode;
}

function programFilesX86(): string {
  const value = process.env["ProgramFiles(x86)"];
  if (!value) throw new Error("environment variable ProgramFiles(x86) is not set");
  return value;
}

function localAppData(): string {
  const value = process.env["LOCALAPPDATA"];
  if (!value) throw new Error("environment variable LOCALAPPDATA is not set");
  return value;
}

if (import.meta.main) await main();
