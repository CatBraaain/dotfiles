// Windows bootstrap installer: installs apps with winget and cleans up
// desktop shortcuts and WinGet package links.
//
// Usage: bun windows.ts. The profile comes from the INSTALL_PROFILE marking
// in the repository root .env. The "work" profile skips personal-only apps
// such as Discord, Steam, and games.
//
// Requires Administrator. When not elevated, the script relaunches itself via
// gsudo (one UAC prompt); `gsudo status IsElevated` exits with 0 once
// elevated, so the relaunch happens at most once.

import { mkdtemp } from "node:fs/promises";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { markingPath, readInstallProfile, type InstallProfile } from "./marking.ts";

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
  "Git.Git",
  "Casey.Just",
  "RussellBanks.Komac",
  "OpenJS.NodeJS.LTS",
  "Microsoft.PowerShell", // windows
  "marlocarlo.psmux",
  "Canonical.Ubuntu", // windows
  "GitHub.cli",
  "Microsoft.coreutils",
  "dandavison.delta",
  "gerardog.gsudo", // windows
  "CatBraaain.runx", // windows
  "CatBraaain.wintasks", // windows
  // keep-sorted end
];

async function main(): Promise<void> {
  const profile = await readInstallProfile(() => Bun.file(markingPath).text());
  if (!isElevated()) await selfElevate();
  installWingetPackages(profile);
  refreshProcessPath();
  installPi();
  runAllowingFailure(["cmd", "/c", "npm", "install", "-g", "--ignore-scripts", "@playwright/cli"]);
  await installCamoufox().catch((error: unknown) =>
    console.error(`camoufox install failed: ${message(error)}`),
  );
  await installOpenSerp().catch((error: unknown) =>
    console.error(`openserp install failed: ${message(error)}`),
  );
  await installRustDesk().catch((error: unknown) =>
    console.error(`rustdesk install failed: ${message(error)}`),
  );
  removeDesktopShortcuts();
  linkWingetPackageExes();
}

function selfElevate(): Promise<never> {
  const proc = Bun.spawn(["gsudo", "-d", process.execPath, import.meta.path], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited.then((code) => process.exit(code ?? 1));
}

function installWingetPackages(profile: InstallProfile): void {
  const isPersonal = profile === "personal";
  const unmanaged = isPersonal
    ? [...unmanagedPackages, ...unmanagedPersonalPackages]
    : unmanagedPackages;
  const managed = isPersonal ? [...managedPackages, ...managedPersonalPackages] : managedPackages;
  // Individual winget failures are logged but do not abort the rest of the
  // bootstrap, matching the previous PowerShell behavior.
  runAllowingFailure([
    "winget",
    "install",
    "AutoHotkey.AutoHotkey",
    "--silent",
    "--version",
    "1.1.37.02",
    "--no-upgrade",
    "--source",
    "winget",
  ]);
  runAllowingFailure(["winget", "install", ...unmanaged, "--no-upgrade", "--source", "winget"]);
  runAllowingFailure(["winget", "install", ...managed, "--source", "winget"]);
  runAllowingFailure(["winget", "install", ...managedDevPackages, "--source", "winget"]);
}

const piNpmPackage = "@earendil-works/pi-coding-agent";

// pi has no winget package; --ignore-scripts is required by its install docs
// (https://github.com/earendil-works/pi#install).
function installPi(): void {
  run(["cmd", "/c", "npm", "install", "-g", "--ignore-scripts", piNpmPackage]);
}

function refreshProcessPath(): void {
  // winget updates the registry PATH, but a running process keeps the PATH
  // snapshot from its start, so npm and gh installed above are unresolved
  // until the registry values are re-read.
  const script =
    "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
  const combined = output(["powershell", "-NoProfile", "-Command", script]);
  if (combined) process.env.Path = combined;
}

async function installCamoufox(): Promise<void> {
  const programsDir = join(localAppData(), "Programs");
  const installDir = join(programsDir, "Camoufox");
  const executable = "camoufox.exe";
  if (statSync(join(installDir, executable), { throwIfNoEntry: false })?.isFile()) return;
  if (existsSync(installDir))
    throw new Error(`installation directory already exists: ${installDir}`);

  mkdirSync(programsDir, { recursive: true });
  const directory = await mkdtemp(join(programsDir, "bootstrap-camoufox-"));
  const archive = join(directory, "camoufox.zip");
  const browserDir = join(directory, "browser");
  try {
    run([
      "gh",
      "release",
      "download",
      "--repo",
      "daijro/camoufox",
      "--pattern",
      "camoufox-*-win.x86_64.zip",
      "--output",
      archive,
    ]);
    mkdirSync(browserDir);
    run(["tar.exe", "-xf", archive, "-C", browserDir]);
    if (!statSync(join(browserDir, executable), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`release archive is missing ${executable}`);
    }
    renameSync(browserDir, installDir);
    console.log(`Camoufox installed at ${join(installDir, executable)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function installOpenSerp(): Promise<void> {
  if (Bun.which("openserp")) return;
  const releaseArch = process.arch === "x64" ? "amd64" : process.arch;
  const directory = await mkdtemp(join(tmpdir(), "bootstrap-openserp-"));
  const archive = join(directory, "openserp.tgz");
  try {
    run([
      "gh",
      "release",
      "download",
      "--repo",
      "karust/openserp",
      "--pattern",
      `openserp-windows-${releaseArch}-*.tgz`,
      "--output",
      archive,
    ]);
    run(["tar.exe", "-xzf", archive, "-C", directory, "openserp.exe"]);
    const linksDir = wingetLinksDir();
    mkdirSync(linksDir, { recursive: true });
    copyFileSync(
      join(directory, "openserp.exe"),
      join(linksDir, "openserp.exe"),
      constants.COPYFILE_EXCL,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const rustDeskRepo = "rustdesk/rustdesk";

// RustDesk is not on winget (removed from the community repository), so it is
// installed from the GitHub release msi instead. The installed version is
// looked up from the registry so upgrades replace the previous msi install.
async function installRustDesk(): Promise<void> {
  if (process.arch !== "x64") throw new Error("the RustDesk Windows installer supports x64 only");
  const tag = output([
    "gh",
    "release",
    "view",
    "--repo",
    rustDeskRepo,
    "--json",
    "tagName",
    "--jq",
    ".tagName",
  ]);
  if (rustDeskRegistryVersion() === tag) return;

  const directory = await mkdtemp(join(tmpdir(), "bootstrap-rustdesk-"));
  try {
    run([
      "gh",
      "release",
      "download",
      tag,
      "--repo",
      rustDeskRepo,
      "--pattern",
      `rustdesk-${tag}-x86_64.msi`,
      "--dir",
      directory,
    ]);
    const file = readdirSync(directory).find((name) => name.endsWith(".msi"));
    if (!file) throw new Error("RustDesk release archive is missing an msi package");
    run(["msiexec", "/i", join(directory, file), "/qn"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function rustDeskRegistryVersion(): string {
  return output([
    "powershell",
    "-NoProfile",
    "-Command",
    [
      "Get-ItemProperty",
      "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\*',",
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\*'",
      "-ErrorAction SilentlyContinue",
      "| Where-Object DisplayName -eq 'RustDesk'",
      "| Select-Object -First 1 -ExpandProperty DisplayVersion",
    ].join(" "),
  ]);
}

function removeDesktopShortcuts(): void {
  const desktop = join(homedir(), "Desktop");
  for (const name of readdirSync(desktop)) {
    if (name.endsWith(".lnk")) rmSync(join(desktop, name), { force: true });
  }
}

function wingetLinksDir(): string {
  return join(localAppData(), "Microsoft", "WinGet", "Links");
}

function linkWingetPackageExes(): void {
  const linksDir = wingetLinksDir();
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
  const status = Bun.spawnSync(["gsudo", "status", "IsElevated"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return status.exitCode === 0;
}

function run(command: readonly string[]): void {
  const exitCode = runInheritingIO(command);
  if (exitCode !== 0)
    throw new Error(`command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

function runAllowingFailure(command: readonly string[]): void {
  const exitCode = runInheritingIO(command);
  if (exitCode !== 0)
    console.error(`command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

function runInheritingIO(command: readonly string[]): number | null {
  return Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" }).exitCode;
}

function localAppData(): string {
  const value = process.env["LOCALAPPDATA"];
  if (!value) throw new Error("environment variable LOCALAPPDATA is not set");
  return value;
}

function output(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || command.join(" "));
  return result.stdout.toString().trim();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await main();
