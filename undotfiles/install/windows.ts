// Windows bootstrap installer: installs apps with winget and cleans up
// desktop shortcuts and WinGet package links.
//
// Usage: bun windows.ts [personal|work] (defaults to "personal"). The "work"
// profile skips personal-only apps such as Discord, Steam, and games.
//
// Requires Administrator. When not elevated, the script relaunches itself via
// gsudo (one UAC prompt); `gsudo status IsElevated` exits with 0 once
// elevated, so the relaunch happens at most once.

import { readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type Profile = "personal" | "work";

const unmanagedPackages: readonly string[] = [
  // keep-sorted start by_regex=\..+ sticky_comments=no
  "Google.Chrome",
  "Docker.DockerDesktop",
  "Mozilla.Firefox",
  // keep-sorted end
];

// Installed only with the "personal" profile.
const unmanagedPersonalPackages: readonly string[] = ["Discord.Discord"];

const managedPackages: readonly string[] = [
  // keep-sorted start by_regex=\..+ sticky_comments=no
  // "Microsoft.AppInstaller"
  "BluePointLilac.ContextMenuManager",
  "sordum.EasyContextMenu",
  "w4po.ExplorerTabUtility",
  "AdrienAllard.FileConverter",
  "DuongDieuPhap.ImageGlass",
  // "mulaRahul.Keyviz"
  "LocalSend.LocalSend",
  "MPC-BE.MPC-BE",
  "M2Team.NanaZip",
  "OpenWhispr.OpenWhispr",
  "ShareX.ShareX",
  // "StirlingTools.StirlingPDF"
  "Microsoft.Sysinternals.Autologon",
  "Microsoft.VisualStudioCode",
  "Rime.Weasel",
  "WinDirStat.WinDirStat",
  "Microsoft.WindowsTerminal",
  "ZedIndustries.Zed",
  // keep-sorted end
];

// Installed only with the "personal" profile.
const managedPersonalPackages: readonly string[] = [
  // keep-sorted start by_regex=\..+ sticky_comments=no
  "Guru3D.Afterburner",
  "CPUID.CPU-Z",
  "Rem0o.FanControl",
  "GIMP.GIMP.3",
  "ch.LosslessCut",
  "Mojang.MinecraftLauncher",
  "OBSProject.OBSStudio",
  "Guru3D.RTSS",
  "Meltytech.Shotcut",
  "Valve.Steam",
  "Devolutions.UniGetUI",
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
  const profile = parseProfile();
  if (!isElevated()) await selfElevate(profile);
  installWingetPackages(profile);
  removeDesktopShortcuts();
  linkWingetPackageExes();
}

function selfElevate(profile: Profile): Promise<never> {
  const proc = Bun.spawn(["gsudo", "-d", process.execPath, import.meta.path, profile], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited.then((code) => process.exit(code ?? 1));
}

function installWingetPackages(profile: Profile): void {
  const isPersonal = profile === "personal";
  const unmanaged = isPersonal
    ? [...unmanagedPackages, ...unmanagedPersonalPackages]
    : unmanagedPackages;
  const managed = isPersonal
    ? [...managedPackages, ...managedPersonalPackages]
    : managedPackages;
  // Individual winget failures are logged but do not abort the rest of the
  // bootstrap, matching the previous PowerShell behavior.
  runAllowingFailure([
    "winget", "install", "AutoHotkey.AutoHotkey",
    "--silent", "--version", "1.1.37.02", "--no-upgrade", "--source", "winget",
  ]);
  runAllowingFailure(["winget", "install", ...unmanaged, "--no-upgrade", "--source", "winget"]);
  runAllowingFailure(["winget", "install", ...managed, "--source", "winget"]);
  runAllowingFailure(["winget", "install", ...managedDevPackages, "--source", "winget"]);
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

function parseProfile(): Profile {
  const value = process.argv[2] ?? "personal";
  if (value !== "personal" && value !== "work") {
    throw new Error(`unknown profile "${value}" (expected "personal" or "work")`);
  }
  return value;
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

function runInheritingIO(command: readonly string[]): number | null {
  return Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" }).exitCode;
}

function localAppData(): string {
  const value = process.env["LOCALAPPDATA"];
  if (!value) throw new Error("environment variable LOCALAPPDATA is not set");
  return value;
}

if (import.meta.main) await main();
