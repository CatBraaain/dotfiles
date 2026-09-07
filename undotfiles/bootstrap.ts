// Bootstrap system packages and CLI tools for this dotfiles setup.
// PACKAGES reads top-to-bottom: setup() entries act in place at their line
// (sudo apt update; putting brew on PATH), apt() entries install in place,
// and the rest defers to the end — a generated temporary Brewfile applied
// via `brew bundle` (most entries), a custom install step for sources no
// package manager covers (custom() entries), or a shell command run on
// every bootstrap (run() entries).
// No version management: every tool installs/updates to its latest release.
// Prerequisites, installed by setup.sh: Homebrew on Linux and bun.
//
// Run with `bun undotfiles/bootstrap.ts` (or `just install`).

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Homebrew on Linux official installer default. Only this path is hardcoded:
// PATH lookup may miss brew when this runs outside setup.sh's shellenv.
const BREW_FALLBACK_DIR = "/home/linuxbrew/.linuxbrew";

// Android SDK install target of the sdkmanager run entries in PACKAGES.
const SDK_DIR = join(homedir(), ".android-sdk");

// PACKAGES entry types: kind is the install method (the Brewfile DSL, "apt"
// for packages installed outside the Brewfile, "run" for shell commands, or
// "setup" for in-place bootstrap actions).
type Package =
  | AptEntry
  | BrewEntry
  | FlatpakEntry
  | ToolEntry
  | CustomEntry
  | RunEntry
  | SetupEntry;
type AptEntry = { kind: "apt"; name: string };
type BrewEntry = { kind: "brew" | "cask"; name: string };
type FlatpakEntry = { kind: "flatpak"; name: string; url?: string };
type ToolEntry = { kind: "npm" | "uv" | "go"; name: string };
type CustomEntry = { kind: "custom"; name: string };
type RunEntry = { kind: "run"; command: string };
type SetupEntry = { kind: "setup"; phase: "apt" | "brew" };

// Everything except apt, custom, run, and setup entries becomes Brewfile lines.
type BrewfileEntry = Exclude<Package, AptEntry | CustomEntry | RunEntry | SetupEntry>;

// Entry builders: keep PACKAGES declarative while the types above constrain
// each method's options (url for flatpak).
const apt = (name: string): AptEntry => ({ kind: "apt", name });
const brew = (name: string): BrewEntry => ({ kind: "brew", name });
const cask = (name: string): BrewEntry => ({ kind: "cask", name });
// eslint-disable-next-line no-unused-vars -- used by the disabled Chrome entry below
const flatpak = (name: string, opts: { url?: string } = {}): FlatpakEntry => ({
  kind: "flatpak",
  name,
  ...opts,
});
const npm = (name: string): ToolEntry => ({ kind: "npm", name });
const uv = (name: string): ToolEntry => ({ kind: "uv", name });
const go = (name: string): ToolEntry => ({ kind: "go", name });
const custom = (name: string): CustomEntry => ({ kind: "custom", name });
const run = (command: string): RunEntry => ({ kind: "run", command });
const setup = (phase: SetupEntry["phase"]): SetupEntry => ({ kind: "setup", phase });

// Every package in one list, read top-to-bottom: setup entries act in
// place at their line; apt entries install in place when missing; custom
// entries run their named custom install step; run entries execute a shell
// command on every bootstrap; everything else becomes one Brewfile line in
// list order, e.g. brew("jq") -> `brew "jq"`.
// Order matters: brew entries install the language runtimes first, so keep
// npm/uv/go entries after the runtime they need (brew bundle runs lines in order).
const PACKAGES: readonly Package[] = [
  setup("apt"), // in place: sudo apt update
  // apt prerequisites (installed outside the Brewfile)
  apt("flatpak"), // used by the disabled Chrome flatpak entry below
  apt("fonts-noto-cjk"),
  apt("libasound2t64"),
  apt("xvfb"),
  setup("brew"), // in place: locate brew and put it on PATH
  // system packages
  brew("bubblewrap"),
  brew("coreutils"),
  brew("ffmpeg"),
  brew("gcc"),
  brew("git"),
  brew("make"),
  brew("powershell"),
  brew("socat"),
  brew("tmux"),
  brew("unzip"),
  // language runtimes (npm/uv/go entries below depend on these)
  brew("bun"),
  brew("go"),
  brew("node"),
  brew("openjdk"), // sdkmanager needs a JDK; the android-commandlinetools cask ships none
  brew("rustup"),
  // toolchains live in ~/.rustup, outside brew: keep stable current and default
  run("rustup update stable && rustup default stable"),
  brew("uv"),
  // standalone tools (vp / vpr / oxfmt / oxlint via vite-plus)
  npm("vite-plus"),
  // LLM-only CLI tools
  brew("ast-grep"),
  brew("code2prompt"),
  brew("dasel"),
  brew("difftastic"),
  brew("hyperfine"),
  brew("jq"),
  brew("keep-sorted"),
  brew("pdfcpu"),
  brew("rtk"),
  brew("sd"),
  brew("shellcheck"),
  brew("shfmt"),
  brew("watchexec"),
  npm("@earendil-works/pi-coding-agent"),
  npm("agent-browser"),
  npm("cursor-agent"),
  npm("officecli"),
  uv("trafilatura[all]"),
  uv("mineru[all]"),
  go("github.com/karust/openserp"),
  // general CLI tools
  brew("act"),
  brew("cargo-binstall"),
  brew("chezmoi"),
  brew("erdtree"),
  brew("eza"),
  brew("fd"),
  brew("gh"),
  brew("git-cliff"),
  brew("gopls"),
  brew("just"),
  brew("just-lsp"),
  brew("mise"),
  brew("nixfmt"),
  brew("pandoc"),
  brew("pnpm"),
  brew("ripgrep"),
  brew("tokei"),
  brew("tree-sitter-cli"),
  brew("yq"),
  npm("@typescript/native-preview"), // tsgo / tsgolint
  uv("harlequin"),
  // apps and SDKs
  // the CLI export mode ships inside the desktop binary; the deb registers
  // /usr/bin/drawio (postinst) while the cask AppImage cannot run on WSL2
  custom("drawio"),
  // flatpak("com.google.Chrome", { url: "https://dl.flathub.org/repo/flathub.flatpakrepo" }), // disabled for now
  cask("android-commandlinetools"),
  // sdkmanager resolves via the PATH set in setupBrew; keep SDK packages current
  run(`yes | sdkmanager --sdk_root=${SDK_DIR} --licenses >/dev/null`),
  run(`sdkmanager --sdk_root=${SDK_DIR} 'cmdline-tools;latest' 'platform-tools' >/dev/null`),
];

async function main(): Promise<void> {
  let brewBin: string | undefined;
  for (const entry of PACKAGES) {
    switch (entry.kind) {
      case "setup":
        if (entry.phase === "apt") exec(["sudo", "apt", "update"]);
        else brewBin = setupBrew();
        break;
      case "apt":
        installApt(entry.name);
        break;
      default:
        break; // brew family, custom, and run entries defer to the steps below
    }
  }

  log("homebrew");
  await brewBundle(brewBin ?? setupBrew());

  log("custom installs");
  await runCustomPackages();

  log("setup steps");
  for (const command of runCommands()) {
    exec(["bash", "-c", command]);
  }
}

function customPackages(): CustomEntry[] {
  return PACKAGES.filter((pkg): pkg is CustomEntry => pkg.kind === "custom");
}

function runCommands(): string[] {
  return PACKAGES.filter((pkg) => pkg.kind === "run").map((pkg) => pkg.command);
}

// Installs one apt package when missing. The setup("apt") entry runs
// `sudo apt update` beforehand, so no conditional update here.
function installApt(pkg: string): void {
  if (commandSucceeded(["dpkg", "-s", pkg])) return;
  exec(["sudo", "apt", "install", "-y", pkg]);
}

// Named custom install steps for sources no package manager entry covers.
// Depends on gh, so runs after the Brewfile that installs it.
async function runCustomPackages(): Promise<void> {
  for (const pkg of customPackages()) {
    if (pkg.name === "drawio") await installDrawioDeb();
    else throw new Error(`custom install step not defined: ${pkg.name}`);
  }
}

// drawio's deb lives only on GitHub Releases; the deb registers /usr/bin/drawio
// (postinst update-alternatives) and apt-resolves its deps. Same-version
// reinstalls are skipped.
async function installDrawioDeb(): Promise<void> {
  const repo = "jgraph/drawio-desktop";
  const tag = commandOutput([
    "gh",
    "release",
    "view",
    "--repo",
    repo,
    "--json",
    "tagName",
    "--jq",
    ".tagName",
  ]);
  // The deb's dpkg package name is "draw.io", not "drawio" (which would make
  // dpkg-query fail and re-download on every run).
  const installed = commandOutput(["dpkg-query", "-W", "-f=${Version}", "draw.io"]);
  if (installed === tag.replace(/^v/, "")) return;

  const dir = await mkdtemp(join(tmpdir(), "bootstrap-drawio-"));
  try {
    exec([
      "gh",
      "release",
      "download",
      tag,
      "--repo",
      repo,
      "--pattern",
      "drawio-amd64-*.deb",
      "--dir",
      dir,
    ]);
    const debFile = readdirSync(dir).find((file: string) => file.endsWith(".deb"));
    if (!debFile) throw new Error(`no .deb downloaded into ${dir}`);
    exec(["sudo", "apt", "install", "-y", join(dir, debFile)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Finds brew's executable and puts brew's bin dir on PATH (the
// `brew shellenv` equivalent) so brew-installed CLIs resolve inside
// postinstall steps (rustup, sdkmanager).
function setupBrew(): string {
  const bin = Bun.which("brew") ?? `${BREW_FALLBACK_DIR}/bin/brew`;
  if (!existsSync(bin)) {
    throw new Error(`brew not found at ${bin}; run setup.sh first to install Homebrew`);
  }
  const prefix = Bun.spawnSync([bin, "--prefix"], { stdout: "pipe" }).stdout.toString().trim();
  process.env.PATH = `${prefix}/bin:${process.env.PATH ?? ""}`;
  return bin;
}

async function brewBundle(brewBin: string): Promise<void> {
  const brewfileDir = await mkdtemp(join(tmpdir(), "bootstrap-"));
  const brewfilePath = join(brewfileDir, "Brewfile");
  try {
    await writeFile(brewfilePath, generateBrewfile());
    exec([brewBin, "bundle", `--file=${brewfilePath}`]);
    // Keep Brewfile-managed packages declarative; cleanup also resets Homebrew trust.
    exec([brewBin, "bundle", "cleanup", "--force", `--file=${brewfilePath}`]);
  } finally {
    await rm(brewfileDir, { recursive: true, force: true });
  }
}

function generateBrewfile(): string {
  const lines = PACKAGES.filter(
    (pkg): pkg is BrewfileEntry =>
      pkg.kind !== "apt" && pkg.kind !== "custom" && pkg.kind !== "run" && pkg.kind !== "setup",
  ).map(brewfileLine);
  return [...lines, ""].join("\n");
}

function brewfileLine(pkg: BrewfileEntry): string {
  if (pkg.kind === "flatpak" && pkg.url) {
    return `flatpak "${pkg.name}", url: "${pkg.url}"`;
  }
  return `${pkg.kind} "${pkg.name}"`;
}

function log(message: string): void {
  console.log(`\x1b[1;32m==>\x1b[0m ${message}`);
}

function exec(command: string[]): void {
  const proc = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    throw new Error(`command failed (exit ${proc.exitCode}): ${command.join(" ")}`);
  }
}

// Reports whether a probe command succeeded, without any output.
function commandSucceeded(command: string[]): boolean {
  return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

// Captures a command's stdout; "" on failure (e.g. dpkg-query for an
// uninstalled package).
function commandOutput(command: string[]): string {
  return Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
}

if (import.meta.main) {
  await main();
}
