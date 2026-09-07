// Bootstrap system packages and CLI tools for this dotfiles setup.
// Every package below goes through `sudo apt` (apt() entries), a generated
// temporary Brewfile applied via `brew bundle` (most entries), or a shell
// command run on every bootstrap (run() entries).
// No version management: every tool installs/updates to its latest release.
// Prerequisites, installed by setup.sh: Homebrew on Linux and bun.
//
// Run with `bun undotfiles/bootstrap.ts` (or `just install`).

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Homebrew on Linux official installer default. Only this path is hardcoded:
// PATH lookup may miss brew when this runs outside setup.sh's shellenv.
const BREW_FALLBACK_DIR = "/home/linuxbrew/.linuxbrew";

// Android SDK install target of the sdkmanager run entries in PACKAGES.
const SDK_DIR = join(homedir(), ".android-sdk");

// PACKAGES entry types: kind is the install method (the Brewfile DSL, "apt"
// for packages installed outside the Brewfile, or "run" for shell commands).
type Package = AptEntry | BrewEntry | FlatpakEntry | ToolEntry | RunEntry;
type AptEntry = { kind: "apt"; name: string };
type BrewEntry = { kind: "brew" | "cask"; name: string };
type FlatpakEntry = { kind: "flatpak"; name: string; url?: string };
type ToolEntry = { kind: "npm" | "uv" | "go"; name: string };
type RunEntry = { kind: "run"; command: string };

// Everything except apt and run entries becomes Brewfile lines.
type BrewfileEntry = Exclude<Package, AptEntry | RunEntry>;

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
const run = (command: string): RunEntry => ({ kind: "run", command });

// Every package in one list. One entry = its install method + options:
// apt entries go through `sudo apt install`; run entries execute a shell
// command on every bootstrap; everything else becomes one Brewfile line in
// list order, e.g. brew("jq") -> `brew "jq"`.
// Order matters: brew entries install the language runtimes first, so keep
// npm/uv/go entries after the runtime they need (brew bundle runs lines in order).
const PACKAGES: readonly Package[] = [
  // apt prerequisites (installed outside the Brewfile)
  apt("flatpak"), // used by the disabled Chrome flatpak entry below
  apt("fonts-noto-cjk"),
  apt("libasound2t64"),
  apt("xvfb"),
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
  cask("drawio"),
  // flatpak("com.google.Chrome", { url: "https://dl.flathub.org/repo/flathub.flatpakrepo" }), // disabled for now
  cask("android-commandlinetools"),
  // sdkmanager resolves via the PATH set in setupBrew; keep SDK packages current
  run(`yes | sdkmanager --sdk_root=${SDK_DIR} --licenses >/dev/null`),
  run(`sdkmanager --sdk_root=${SDK_DIR} 'cmdline-tools;latest' 'platform-tools' >/dev/null`),
];

async function main(): Promise<void> {
  log("apt prerequisites");
  ensureAptPackages(aptPackages());

  log("homebrew");
  await brewBundle(setupBrew());

  log("setup steps");
  for (const command of runCommands()) {
    exec(["bash", "-c", command]);
  }
}

function aptPackages(): string[] {
  return PACKAGES.filter((pkg) => pkg.kind === "apt").map((pkg) => pkg.name);
}

function runCommands(): string[] {
  return PACKAGES.filter((pkg) => pkg.kind === "run").map((pkg) => pkg.command);
}

function ensureAptPackages(pkgs: string[]): void {
  const missing = pkgs.filter((pkg) => !commandSucceeded(["dpkg", "-s", pkg]));
  if (missing.length === 0) return;
  exec(["sudo", "apt", "update"]);
  for (const pkg of missing) {
    exec(["sudo", "apt", "install", "-y", pkg]);
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
  } finally {
    await rm(brewfileDir, { recursive: true, force: true });
  }
}

function generateBrewfile(): string {
  const lines = PACKAGES.filter(
    (pkg): pkg is BrewfileEntry => pkg.kind !== "apt" && pkg.kind !== "run",
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

if (import.meta.main) {
  await main();
}
