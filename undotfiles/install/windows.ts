// Windows bootstrap installer: installs apps with winget and cleans up
// desktop shortcuts and WinGet package links.
//
// Usage: bun windows.ts. The profile comes from the INSTALL_PROFILE marking
// in the repository root .env.
//
// Requires Administrator. When not elevated, the script relaunches itself via
// gsudo (one UAC prompt); `gsudo status IsElevated` exits with 0 once
// elevated, so the relaunch happens at most once.

import { mkdtemp } from "node:fs/promises";
import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { markingPath, readInstallProfile, type InstallProfile } from "./marking.ts";
import { PI_LAUNCHER_NAME, PI_PACKAGE } from "./windows-pi.ts";

type WingetPackage = { key: "winget"; id: string; args: readonly string[] };
type CustomInstaller = { install: () => void | Promise<void>; required?: true };
type InstallEntry =
  | WingetPackage
  | { key: "npm"; name: string }
  | ({ key: "custom"; name: string } & CustomInstaller);

const configPath = join(import.meta.dir, "windows.install.yaml");
const profiles = ["dev", "work", "personal"] as const;
const wingetPackageId = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/i;
const wingetVersion = /^[a-z0-9][a-z0-9.+_-]*$/i;
const npmPackageSpec =
  /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2})?$/;
const npmArchiveSuffix = /\.(?:tgz|tar\.gz|tar)$/;
const wingetVersionFlag = "--version";
const customInstallers = new Map<string, CustomInstaller>([
  ["camoufox", { install: installCamoufox }],
  ["openserp", { install: installOpenSerp }],
  ["pi", { install: installPi, required: true }],
  ["playwright-chromium", { install: installPlaywrightChromium }],
  ["rustdesk", { install: installRustDesk }],
  ["trafilatura", { install: installTrafilatura }],
]);

async function main(): Promise<void> {
  const profile = await readInstallProfile(() => Bun.file(markingPath).text());
  await installWindows(profile);
}

export async function installWindows(
  profile: InstallProfile,
  desktop = join(homedir(), "Desktop"),
  readConfig = () => Bun.file(configPath).text(),
): Promise<void> {
  const entries = parseInstallEntries(await readConfig(), profile);
  if (!isElevated()) await selfElevate();
  installWingetPackages(entries.filter((entry) => entry.key === "winget"));
  refreshProcessPath();
  for (const entry of entries) {
    if (entry.key === "npm") installNpmPackage(entry.name);
    if (entry.key === "custom") {
      try {
        await entry.install();
      } catch (error) {
        if (entry.required) throw error;
        console.error(`${entry.name} install failed: ${message(error)}`);
      }
    }
  }

  if (profile === "dev") return;
  removeDesktopShortcuts(desktop);
  linkWingetPackageExes();
}

function selfElevate(): Promise<never> {
  const proc = Bun.spawn(["gsudo", "-d", process.execPath, import.meta.path], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited.then((code) => process.exit(code ?? 1));
}

function parseInstallEntries(source: string, profile: InstallProfile): InstallEntry[] {
  if (typeof Bun.YAML?.parse !== "function") {
    throw new Error("Bun 1.2.21 or later is required to read windows.install.yaml.");
  }
  const config: unknown = Bun.YAML.parse(source);
  if (!isConfigMap(config)) throw new Error("windows.install.yaml must be a map");
  for (const key of Object.keys(config)) {
    if (!profiles.some((name) => name === key))
      throw new Error(`Unknown windows.install.yaml profile: ${key}`);
  }

  const lastProfile = profiles.indexOf(profile);
  return profiles.flatMap((name, index) => {
    const rawEntries = config[name];
    if (!Array.isArray(rawEntries)) throw new Error(`windows.install.yaml ${name} must be a list`);
    const entries = rawEntries.map((entry: unknown, position) =>
      parseInstallEntry(entry, `windows.install.yaml ${name} entry ${position + 1}`),
    );
    return index <= lastProfile ? entries : [];
  });
}

function parseInstallEntry(rawEntry: unknown, label: string): InstallEntry {
  if (!isConfigMap(rawEntry)) throw new Error(`${label} must be a map`);
  const pairs = Object.entries(rawEntry);
  const pair = pairs[0];
  if (pairs.length !== 1 || !pair) throw new Error(`${label} must have one key`);

  const [key, value] = pair;
  switch (key) {
    case "winget":
      return parseWingetPackage(value, label);
    case "npm":
      if (!isNpmPackageSpec(value))
        throw new Error(`${label} has an invalid npm package name or version`);
      return { key, name: value };
    case "custom": {
      if (typeof value !== "string") throw new Error(`${label} custom name must be a string`);
      const installer = customInstallers.get(value);
      if (!installer) throw new Error(`${label} has an unknown custom installer: ${value}`);
      return { key, name: value, ...installer };
    }
    default:
      throw new Error(`${label} has an unknown key: ${key}`);
  }
}

function isNpmPackageSpec(spec: unknown): spec is string {
  if (typeof spec !== "string") return false;
  const name = npmPackageSpec.exec(spec)?.[1];
  return name !== undefined && (name.startsWith("@") || !npmArchiveSuffix.test(name));
}

function parseWingetPackage(rawPackage: unknown, label: string): WingetPackage {
  if (typeof rawPackage === "string") {
    return { key: "winget", id: validateWingetId(rawPackage, label), args: [] };
  }

  if (!isConfigMap(rawPackage)) throw new Error(`${label} winget must be an id or a map`);
  for (const key of Object.keys(rawPackage)) {
    if (key !== "id" && key !== "args")
      throw new Error(`${label} winget has an unknown key: ${key}`);
  }

  const id = validateWingetId(rawPackage.id, label);
  const args = "args" in rawPackage ? parseWingetArgs(rawPackage.args, label) : [];
  return { key: "winget", id, args };
}

function validateWingetId(id: unknown, label: string): string {
  if (typeof id !== "string" || !wingetPackageId.test(id))
    throw new Error(`${label} has an invalid WinGet id`);
  return id;
}

function parseWingetArgs(rawArgs: unknown, label: string): string[] {
  if (!Array.isArray(rawArgs)) throw new Error(`${label} winget args must be an array`);

  const args: string[] = [];
  const flags = new Set<string>();
  for (let index = 0; index < rawArgs.length; index++) {
    const flag: unknown = rawArgs[index];
    if (flag !== "--silent" && flag !== "--no-upgrade" && flag !== wingetVersionFlag)
      throw new Error(`${label} has an invalid WinGet argument at position ${index + 1}`);
    if (flags.has(flag)) throw new Error(`${label} has a duplicate WinGet argument: ${flag}`);
    flags.add(flag);
    args.push(flag);
    if (flag === wingetVersionFlag) {
      const version: unknown = rawArgs[++index];
      if (typeof version !== "string" || !wingetVersion.test(version))
        throw new Error(`${label} has an invalid WinGet version`);
      args.push(version);
    }
  }
  return args;
}

function isConfigMap(input: unknown): input is Record<string, unknown> {
  return (
    input !== null && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype
  );
}

function installWingetPackages(packages: readonly WingetPackage[]): void {
  const pinnedPackages = packages.filter((entry) => entry.args.includes(wingetVersionFlag));
  for (const { id, args } of pinnedPackages) installWingetBatch([id], args);

  const batches: { ids: string[]; args: readonly string[] }[] = [];
  const unpinnedPackages = packages.filter((entry) => !entry.args.includes(wingetVersionFlag));
  for (const { id, args } of unpinnedPackages) {
    const previous = batches.at(-1);
    if (previous?.args.length === args.length && previous.args.every((arg, i) => arg === args[i])) {
      previous.ids.push(id);
    } else {
      batches.push({ ids: [id], args });
    }
  }
  for (const { ids, args } of batches) installWingetBatch(ids, args);
}

function installWingetBatch(ids: readonly string[], args: readonly string[]): void {
  runAllowingFailure(["winget", "install", ...ids, ...args, "--source", "winget"]);
}

function installNpmPackage(name: string): void {
  try {
    runCmd(["npm", "install", "-g", "--ignore-scripts", name]);
  } catch (error) {
    console.error(message(error));
  }
}

function installPi(): void {
  runCmd(["npm", "install", "-g", "--ignore-scripts", PI_PACKAGE]);
  const prefix = output(["cmd", "/c", "npm", "prefix", "--global"], {
    cwd: cmdWorkingDirectory(),
  });
  if (
    !isAbsolute(prefix) ||
    prefix.includes("\n") ||
    (process.platform === "win32" && parse(prefix).root.length <= 1)
  ) {
    throw new Error(`Invalid npm global prefix: ${prefix}`);
  }
  const destination = join(prefix, "pi.exe");
  const dist = join(import.meta.dir, "../../dist");
  mkdirSync(dist, { recursive: true });
  const buildDir = mkdtempSync(join(dist, "windows-pi-"));
  try {
    const binary = join(buildDir, "pi.exe");
    run([
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      join(import.meta.dir, "windows-pi.ts"),
      "--outfile",
      binary,
    ]);
    if (!readFileSync(binary).includes(PI_LAUNCHER_NAME)) {
      throw new Error(`Build did not produce the ${PI_LAUNCHER_NAME}`);
    }
    publishPiLauncher(binary, destination);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

function publishPiLauncher(binary: string, destination: string): void {
  if (!hasManagedPiLauncher(destination)) {
    copyFileSync(binary, destination, constants.COPYFILE_EXCL);
    return;
  }
  const backupDir = mkdtempSync(join(dirname(destination), ".pi-launcher-"));
  const backup = join(backupDir, "pi.exe");
  let keepBackup = false;
  try {
    renameSync(destination, backup);
    try {
      if (!hasManagedPiLauncher(backup)) throw new Error(`Cannot find ${backup}`);
      copyFileSync(binary, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      try {
        if (!lstatSync(backup).isFile()) throw new Error(`Not a regular file: ${backup}`);
        copyFileSync(backup, destination, constants.COPYFILE_EXCL);
      } catch (restoreError) {
        keepBackup = true;
        throw new Error(
          `Cannot install ${destination}: ${message(error)}; cannot restore the previous file (${message(restoreError)}); backup: ${backup}`,
        );
      }
      throw error;
    }
  } finally {
    if (!keepBackup) rmSync(backupDir, { recursive: true, force: true });
  }
}

function hasManagedPiLauncher(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) return false;
  if (!existing.isFile() || !readFileSync(path).includes(PI_LAUNCHER_NAME)) {
    throw new Error(`Keeping existing ${path}: not the ${PI_LAUNCHER_NAME}`);
  }
  return true;
}

async function installPlaywrightChromium(): Promise<void> {
  const browserEnv = {
    PLAYWRIGHT_BROWSERS_PATH: join(localAppData(), "ms-playwright"),
    PLAYWRIGHT_SKIP_BROWSER_GC: "1",
  };
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !Object.hasOwn(browserEnv, name.toUpperCase())),
  );
  runCmd(["playwright-cli", "install-browser", "chrome-for-testing", "--no-shell"], {
    ...inheritedEnv,
    ...browserEnv,
  });
}

function cmdWorkingDirectory(): string | undefined {
  return process.cwd().startsWith("\\\\") ? process.env.SystemRoot : undefined;
}

function runCmd(command: readonly string[], env?: NodeJS.ProcessEnv): void {
  run(["cmd", "/c", ...command], { cwd: cmdWorkingDirectory(), env });
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

async function installTrafilatura(): Promise<void> {
  run(["uv", "tool", "install", "trafilatura"]);
  run(["uv", "tool", "update-shell"]);
}

const camoufoxVersion = { version: "158.0.1", release: "beta.41" };
const camoufoxBuild = `${camoufoxVersion.version}-${camoufoxVersion.release}`;

export async function installCamoufox(appDataDir: string = localAppData()): Promise<void> {
  const programsDir = join(appDataDir, "Programs");
  const installDir = join(programsDir, "Camoufox");
  const executable = "camoufox.exe";
  const existing = lstatSync(installDir, { throwIfNoEntry: false });
  if (existing) {
    if (
      !existing.isDirectory() ||
      !lstatSync(join(installDir, executable), { throwIfNoEntry: false })?.isFile()
    ) {
      throw new Error(`Keeping existing Camoufox path ${installDir}: expected ${executable}`);
    }
    ensureCamoufoxVersionFile(installDir);
    return;
  }

  mkdirSync(programsDir, { recursive: true });
  const directory = await mkdtemp(join(programsDir, "bootstrap-camoufox-"));
  const archive = join(directory, "camoufox.zip");
  const browserDir = join(directory, "browser");
  try {
    run([
      "gh",
      "release",
      "download",
      `v${camoufoxBuild}`,
      "--repo",
      "daijro/camoufox",
      "--pattern",
      `camoufox-${camoufoxBuild}-win.x86_64.zip`,
      "--output",
      archive,
    ]);
    mkdirSync(browserDir);
    run(["tar.exe", "-xf", archive, "-C", browserDir]);
    if (!lstatSync(join(browserDir, executable), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`release archive is missing ${executable}`);
    }
    ensureCamoufoxVersionFile(browserDir);
    renameSync(browserDir, installDir);
    console.log(`Camoufox installed at ${join(installDir, executable)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function ensureCamoufoxVersionFile(browserDir: string): void {
  const applicationPath = join(browserDir, "application.ini");
  if (!lstatSync(applicationPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `Cannot verify Camoufox ${camoufoxBuild}: missing or invalid ${applicationPath}`,
    );
  }
  const appSections = readFileSync(applicationPath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/(?=^[\t ]*\[)/m)
    .filter((section) => /^[\t ]*\[App\][\t ]*(?:\r?\n|$)/i.test(section));
  const versionEntries = [
    ...(appSections[0] ?? "").matchAll(/^[\t ]*Version[\t ]*=[\t ]*(.*)$/gim),
  ];
  const installedBuild = versionEntries[0]?.[1]?.trim();
  if (appSections.length !== 1 || versionEntries.length !== 1 || !installedBuild) {
    throw new Error(`Invalid Camoufox version in ${applicationPath}; leaving it unchanged`);
  }
  if (installedBuild !== camoufoxBuild) {
    throw new Error(
      `Expected Camoufox ${camoufoxBuild}, found ${installedBuild} in ${applicationPath}; leaving it unchanged`,
    );
  }

  const versionPath = join(browserDir, "version.json");
  const metadata = lstatSync(versionPath, { throwIfNoEntry: false });
  if (metadata) {
    if (!metadata.isFile()) throw new Error(`Invalid Camoufox metadata: ${versionPath}`);
    const installed: unknown = JSON.parse(readFileSync(versionPath, "utf8"));
    if (
      !isConfigMap(installed) ||
      installed.version !== camoufoxVersion.version ||
      installed.release !== camoufoxVersion.release
    ) {
      throw new Error(`Expected Camoufox ${camoufoxBuild} in ${versionPath}; leaving it unchanged`);
    }
    return;
  }

  const stagingDir = mkdtempSync(join(browserDir, ".version-"));
  try {
    const stagedVersion = join(stagingDir, "version.json");
    writeFileSync(stagedVersion, `${JSON.stringify(camoufoxVersion)}\n`);
    linkSync(stagedVersion, versionPath);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
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

function removeDesktopShortcuts(desktop: string): void {
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

type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

function run(command: readonly string[], options?: CommandOptions): void {
  const exitCode = runInheritingIO(command, options);
  if (exitCode !== 0)
    throw new Error(`command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

function runAllowingFailure(command: readonly string[]): void {
  const exitCode = runInheritingIO(command);
  if (exitCode !== 0)
    console.error(`command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

function runInheritingIO(command: readonly string[], options?: CommandOptions): number | null {
  return Bun.spawnSync([...command], { ...options, stdout: "inherit", stderr: "inherit" }).exitCode;
}

function localAppData(): string {
  const value = process.env["LOCALAPPDATA"];
  if (!value) throw new Error("environment variable LOCALAPPDATA is not set");
  return value;
}

function output(command: readonly string[], options?: CommandOptions): string {
  const result = Bun.spawnSync([...command], { ...options, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || command.join(" "));
  return result.stdout.toString().trim();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await main();
