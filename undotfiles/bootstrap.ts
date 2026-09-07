// Bootstrap system packages and CLI tools for this dotfiles setup.
// Every package below goes through `sudo apt` (apt: entries) or a generated
// temporary Brewfile applied via `brew bundle` (everything else).
// No version management: every tool installs/updates to its latest release.
// Prerequisites, installed by setup.sh: Homebrew on Linux and bun.
//
// Run with `bun undotfiles/bootstrap.ts` (or `just install`).

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const FLATHUB_REPO_URL = "https://dl.flathub.org/repo/flathub.flatpakrepo";

// Homebrew on Linux official installer default. Only this path is hardcoded:
// PATH lookup may miss brew when this runs outside setup.sh's shellenv.
const BREW_FALLBACK_DIR = "/home/linuxbrew/.linuxbrew";

// Android SDK install target of the sdkmanager postinstall in the Brewfile.
const SDK_DIR = join(homedir(), ".android-sdk");

// Every package in one list, prefixed with its install method:
// "apt:<package>", "brew:<formula>", "cask:<cask>", "npm:<package>",
// "uv:<tool>", "go:<module>", or "setup:<name>" for entries with an extra
// setup step a plain name cannot express (full line built in
// setupBrewfileLine). A prefix maps to one install step: apt goes through
// `sudo apt install`, everything else becomes one Brewfile line,
// e.g. "brew:jq" -> `brew "jq"`.
// Order matters: brew entries install the language runtimes first, so keep
// npm/uv/go entries after the runtime they need (brew bundle runs lines in order).
const PACKAGES = [
  // apt prerequisites (installed outside the Brewfile)
  "apt:flatpak", // used by the disabled Chrome flatpak entry below
  "apt:fonts-noto-cjk",
  "apt:libasound2t64",
  "apt:xvfb",
  // system packages
  "brew:bubblewrap",
  "brew:coreutils",
  "brew:ffmpeg",
  "brew:gcc",
  "brew:git",
  "brew:make",
  "brew:powershell",
  "brew:socat",
  "brew:tmux",
  "brew:unzip",
  // language runtimes (npm/uv/go entries below depend on these)
  "brew:bun",
  "brew:go",
  "brew:node",
  "setup:rustup", // brew "rustup" + postinstall: set default toolchain on install
  "brew:uv",
  // standalone tools (vp / vpr / oxfmt / oxlint via vite-plus)
  "npm:vite-plus",
  // LLM-only CLI tools
  "brew:ast-grep",
  "brew:code2prompt",
  "brew:dasel",
  "brew:difftastic",
  "brew:hyperfine",
  "brew:jq",
  "brew:keep-sorted",
  "brew:pdfcpu",
  "brew:rtk",
  "brew:sd",
  "brew:shellcheck",
  "brew:shfmt",
  "brew:watchexec",
  "npm:@earendil-works/pi-coding-agent",
  "npm:agent-browser",
  "npm:cursor-agent",
  "npm:officecli",
  "uv:trafilatura[all]",
  "uv:mineru[all]",
  "go:github.com/karust/openserp",
  // general CLI tools
  "brew:act",
  "brew:cargo-binstall",
  "brew:chezmoi",
  "brew:erdtree",
  "brew:eza",
  "brew:fd",
  "brew:gh",
  "brew:git-cliff",
  "brew:gopls",
  "brew:just",
  "brew:just-lsp",
  "brew:mise",
  "brew:nixfmt",
  "brew:pandoc",
  "brew:pnpm",
  "brew:ripgrep",
  "brew:tokei",
  "brew:tree-sitter-cli",
  "brew:yq",
  "npm:@typescript/native-preview", // tsgo / tsgolint
  "uv:harlequin",
  // apps and SDKs
  "cask:drawio",
  // "setup:com.google.Chrome", // flatpak via Flathub, disabled for now
  "setup:android-commandlinetools",
];

async function main(): Promise<void> {
  log("apt prerequisites");
  ensureAptPackages(aptPackages());

  log("homebrew");
  const brew = setupBrew();
  await brewBundle(brew);
}

const APT_PREFIX = "apt:";

function aptPackages(): string[] {
  return PACKAGES.filter((spec) => spec.startsWith(APT_PREFIX)).map((spec) =>
    spec.slice(APT_PREFIX.length),
  );
}

function ensureAptPackages(pkgs: string[]): void {
  const missing = pkgs.filter((pkg) => !commandSucceeded(["dpkg", "-s", pkg]));
  if (missing.length === 0) return;
  run(["sudo", "apt", "update"]);
  for (const pkg of missing) {
    run(["sudo", "apt", "install", "-y", pkg]);
  }
}

type Brew = { bin: string; prefix: string };

// Finds brew's executable and prefix, and puts brew's bin dir on PATH (the
// `brew shellenv` equivalent) so brew-installed CLIs like rustup resolve.
function setupBrew(): Brew {
  const bin = Bun.which("brew") ?? `${BREW_FALLBACK_DIR}/bin/brew`;
  if (!existsSync(bin)) {
    throw new Error(`brew not found at ${bin}; run setup.sh first to install Homebrew`);
  }
  const prefix = Bun.spawnSync([bin, "--prefix"], { stdout: "pipe" }).stdout.toString().trim();
  process.env.PATH = `${prefix}/bin:${process.env.PATH ?? ""}`;
  return { bin, prefix };
}

async function brewBundle(brew: Brew): Promise<void> {
  const brewfileDir = await mkdtemp(join(tmpdir(), "bootstrap-"));
  const brewfilePath = join(brewfileDir, "Brewfile");
  try {
    await writeFile(brewfilePath, generateBrewfile(brew.prefix));
    run([brew.bin, "bundle", `--file=${brewfilePath}`]);
  } finally {
    await rm(brewfileDir, { recursive: true, force: true });
  }
}

function generateBrewfile(brewPrefix: string): string {
  const brewEntries = PACKAGES.filter((spec) => !spec.startsWith(APT_PREFIX)).map((spec) =>
    brewfileLine(spec, brewPrefix),
  );
  return [...brewEntries, ""].join("\n");
}

function brewfileLine(spec: string, brewPrefix: string): string {
  const [dsl, ...name] = spec.split(":");
  const pkg = name.join(":");
  if (dsl === "setup") return setupBrewfileLine(pkg, brewPrefix);
  return `${dsl} "${pkg}"`;
}

// `setup:` entries pair an install with an extra setup step that a plain
// name cannot express, so their full Brewfile lines are defined here.
function setupBrewfileLine(name: string, brewPrefix: string): string {
  if (name === "rustup") {
    return `brew "rustup", postinstall: "rustup default stable"`;
  }
  if (name === "android-commandlinetools") {
    const sdkmanager = `${brewPrefix}/bin/sdkmanager`;
    const acceptLicenses = `yes | ${sdkmanager} --sdk_root=${SDK_DIR} --licenses >/dev/null`;
    const installSdkPackages = `${sdkmanager} --sdk_root=${SDK_DIR} 'cmdline-tools;latest' 'platform-tools' >/dev/null`;
    return `cask "android-commandlinetools", postinstall: "${acceptLicenses} && ${installSdkPackages}"`;
  }
  if (name === "com.google.Chrome") {
    return `flatpak "${name}", url: "${FLATHUB_REPO_URL}"`;
  }
  throw new Error(`setup package not defined: ${name}`);
}

function log(message: string): void {
  console.log(`\x1b[1;32m==>\x1b[0m ${message}`);
}

function run(command: string[]): void {
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
