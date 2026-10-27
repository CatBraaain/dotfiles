import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { markingPath, readInstallProfile, type InstallProfile } from "./marking.ts";

export type Key =
  "apt" | "flatpak" | "uv" | "bun" | "cargo" | "go" | "brew" | "brew-cask" | "custom" | "run";
type DeclarativeKey = "uv" | "bun" | "cargo" | "go" | "brew" | "brew-cask";
type BatchableKey = "apt" | "flatpak" | "uv" | "bun" | "cargo" | "go" | "brew" | "brew-cask";
export type Entry = { key: Key; value: string };
export type InstallBatch = { key: BatchableKey; values: readonly string[] } | Entry;
type State = Map<DeclarativeKey, Map<string, string>>;
type CustomHandler = () => void | Promise<void>;
type PersonalOnlyHandler = { isInstalled: () => boolean; remove: () => void };
export type ProfileEntries = { work: readonly Entry[]; personal: readonly Entry[] };

export interface Runtime {
  execute(command: readonly string[]): void;
  output(command: readonly string[]): string;
  outputAllowFailure(command: readonly string[]): string;
  succeeds(command: readonly string[]): boolean;
  log(message: string): void;
  error(message: string): void;
}

const declarativeKeys: readonly DeclarativeKey[] = [
  "brew-cask",
  "brew",
  "bun",
  "cargo",
  "go",
  "uv",
];
const batchableKeys = new Set<BatchableKey>([
  "apt",
  "flatpak",
  "uv",
  "bun",
  "cargo",
  "go",
  "brew",
  "brew-cask",
]);
const validKeys = new Set<Key>([
  "apt",
  "flatpak",
  "uv",
  "bun",
  "cargo",
  "go",
  "brew",
  "brew-cask",
  "custom",
  "run",
]);
const configPath = join(import.meta.dir, "linux.config.yaml");
const androidSdkDir = join(homedir(), ".android-sdk");
const flathubRepoUrl = "https://dl.flathub.org/repo/flathub.flatpakrepo";
export const openDesignDir = join(homedir(), "mirrors", "open-design");
export const openDesignRepoUrl = "https://github.com/nexu-io/open-design.git";
const openWhisprRepo = "OpenWhispr/openwhispr";
const openWhisprPackageName = "open-whispr";
const rustDeskRepo = "rustdesk/rustdesk";
const rustDeskPackageName = "rustdesk";
const surgeXtRepo = "surge-synthesizer/releases-xt";
const surgeXtPackageName = "surge-xt";
const museScoreRepo = "musescore/MuseScore";
const museScoreTag = "v4.7.6";
const museScoreAppImage = "MuseScore-Studio-4.7.6.261022093-x86_64.AppImage";
const museScoreChecksums = "checksums.sha256.txt";
const museScoreInstallDir = "/opt/musescore-4.7.6-x86_64";
const museScoreAppRun = join(museScoreInstallDir, "AppRun");
const museScoreBinPath = "/usr/local/bin/musescore";
const museScoreWrapper = ["#!/usr/bin/env bash", `exec "${museScoreAppRun}" "$@"`, ""].join("\n");
const museScoreWrapperHash = new Bun.CryptoHasher("sha256").update(museScoreWrapper).digest("hex");
const generalUserGsRepo = "mrbumpy409/GeneralUser-GS";
const generalUserGsDir = join(homedir(), ".local", "share", "soundfonts");
const generalUserGsPath = join(generalUserGsDir, "GeneralUser-GS.sf2");
const generalUserGsUrl = `https://raw.githubusercontent.com/${generalUserGsRepo}/main/GeneralUser-GS.sf2`;
export const openDesignDaemonEntry = join(openDesignDir, "apps", "daemon", "dist", "cli.js");
export const openDesignWebEntry = join(openDesignDir, "apps", "web", "out", "index.html");
const openDesignBinDir = join(homedir(), ".local", "bin");
export const openDesignBinPath = join(openDesignBinDir, "od");
// pnpm 12 validates the repo's packageManager pin and fails, so the wrapper must
// cd into the repo before corepack resolves pnpm.
export const openDesignOdWrapper = [
  "#!/usr/bin/env bash",
  `repo="${openDesignDir}"`,
  `cd "$repo" || exit 127`,
  `exec corepack pnpm exec od "$@"`,
].join("\n");
export const openDesignOdWriteCommand = [
  `mkdir -p ${openDesignBinDir}`,
  `cat > ${openDesignBinPath} <<'EOF'`,
  openDesignOdWrapper,
  "EOF",
  `chmod +x ${openDesignBinPath}`,
].join("\n");

const tmpMountOverridePath = "/etc/systemd/system/tmp.mount";
const tmpfilesConfigPath = "/etc/tmpfiles.d/tmp.conf";
const tmpfilesConfig = "q /tmp 1777 root root 2d";

const blenderReleaseUrl = "https://download.blender.org/release/";
const blenderInstallRoot = "/opt";
const blenderBinPath = "/usr/local/bin/blender";
const blenderManagedLinkPattern = /^\/opt\/blender-\d+\.\d+\.\d+-linux-x64\/blender$/;
const blenderManagedDirCommand = `find ${blenderInstallRoot} -maxdepth 1 -type d -regex '.*/blender-[0-9]+\\.[0-9]+\\.[0-9]+-linux-x64'`;
const blenderLatestArchiveCommand =
  `family=$(curl -fsSL ${blenderReleaseUrl} | grep -oE 'Blender[0-9]+\\.[0-9]+/' | sort -uV | tail -1); ` +
  `curl -fsSL ${blenderReleaseUrl}$family | grep -oE 'blender-[0-9.]+-linux-x64\\.tar\\.xz' | sort -uV | tail -1`;

export class Bootstrap {
  private readonly failures: string[] = [];
  private readonly customHandlers: ReadonlyMap<string, CustomHandler>;
  private readonly personalOnlyHandlers: ReadonlyMap<string, PersonalOnlyHandler>;
  private flatpakRemotePrepared = false;

  constructor(
    private readonly entries: readonly Entry[],
    private readonly runtime: Runtime = systemRuntime,
    customHandlers?: ReadonlyMap<string, CustomHandler>,
  ) {
    this.customHandlers = customHandlers ?? this.defaultCustomHandlers();
    this.personalOnlyHandlers = this.defaultPersonalOnlyHandlers();
  }

  async sync(profile: InstallProfile): Promise<number> {
    const aptValues = this.entries
      .filter((entry) => entry.key === "apt")
      .map((entry) => entry.value);
    if (aptValues.length > 0) await this.install({ key: "apt", values: aptValues }, profile);

    const entriesWithoutApt = this.entries.filter((entry) => entry.key !== "apt");
    for (const batch of coalesceEntries(entriesWithoutApt)) await this.install(batch, profile);

    const states = this.readStates();
    for (const key of declarativeKeys) this.removeUnused(key, states.get(key));
    if (profile === "work") this.removePersonalOnlyPackages();
    return this.finish();
  }

  async diff(profile: InstallProfile): Promise<number> {
    const states = this.readStates();
    for (const key of declarativeKeys) {
      const current = states.get(key);
      if (!current) continue;
      for (const name of current.keys()) {
        if (!desiredNames(this.entries, key).has(name)) this.runtime.log(`remove ${key}: ${name}`);
      }
    }

    for (const entry of this.entries) {
      if (isDeclarative(entry.key) && !states.has(entry.key)) continue;
      if (entry.key === "custom") {
        if (!this.customHandlers.has(entry.value))
          this.fail(`unknown custom handler: ${entry.value}`);
        else if (profile === "work" && this.personalOnlyHandlers.has(entry.value))
          this.fail(`personal-only custom handler in work config: ${entry.value}`);
        else this.runtime.log(`custom: ${entry.value}`);
        continue;
      }
      if (entry.key === "apt" && isAptInstalled(this.runtime, entry.value)) continue;
      if (entry.key === "flatpak" && isFlatpakInstalled(this.runtime, entry.value)) continue;
      this.runtime.log(
        entry.key === "run"
          ? `run: ${entry.value}`
          : `install / update ${entry.key}: ${entry.value}`,
      );
    }
    if (profile === "work")
      for (const [name, handler] of this.personalOnlyHandlers)
        if (handler.isInstalled()) this.runtime.log(`remove custom: ${name}`);
    return this.finish();
  }

  private readStates(): State {
    const states: State = new Map();
    for (const key of declarativeKeys) {
      try {
        states.set(key, this.readState(key));
      } catch (error) {
        this.fail(`${key} state: ${message(error)}`);
      }
    }
    return states;
  }

  private readState(key: DeclarativeKey): Map<string, string> {
    switch (key) {
      case "brew":
        return names(this.runtime.output(["brew", "leaves"]));
      case "brew-cask":
        return names(this.runtime.output(["brew", "list", "--cask", "-1"]));
      case "uv":
        return names(this.runtime.output(["uv", "tool", "list"]), uvName);
      case "bun":
        return names(this.runtime.output(["bun", "pm", "ls", "-g"]), bunName);
      case "cargo":
        return names(this.runtime.output(["cargo", "install", "--list"]), cargoName);
      case "go":
        return new Map(
          (
            JSON.parse(this.runtime.output(["gup", "list", "--json"])) as Array<{
              import_path: string;
              name: string;
            }>
          ).map((tool) => [tool.import_path, tool.name]),
        );
    }
  }

  private removeUnused(key: DeclarativeKey, current: Map<string, string> | undefined): void {
    if (!current) return;
    const unused = [...current.entries()].filter(
      ([name]) => !desiredNames(this.entries, key).has(name),
    );
    if (unused.length === 0) return;

    this.attempt(`remove ${key}`, () => {
      switch (key) {
        case "brew":
          this.runtime.execute(["brew", "uninstall", ...unused.map(([name]) => name)]);
          return;
        case "brew-cask":
          this.runtime.execute(["brew", "uninstall", "--cask", ...unused.map(([name]) => name)]);
          return;
        case "bun":
          this.runtime.execute(["bun", "remove", "-g", ...unused.map(([name]) => name)]);
          return;
        case "cargo":
          this.runtime.execute(["cargo", "uninstall", ...unused.map(([name]) => name)]);
          return;
        case "uv":
          this.runtime.execute(["uv", "tool", "uninstall", ...unused.map(([name]) => name)]);
          return;
        case "go":
          this.runtime.execute(["gup", "remove", "--force", ...unused.map(([, binary]) => binary)]);
      }
    });
  }

  private async install(batch: InstallBatch, profile: InstallProfile): Promise<void> {
    if (!isBatch(batch)) {
      const entry = batch;
      if (entry.key === "custom") {
        if (profile === "work" && this.personalOnlyHandlers.has(entry.value)) {
          this.fail(`personal-only custom handler in work config: ${entry.value}`);
          return;
        }
        const handler = this.customHandlers.get(entry.value);
        if (!handler) {
          this.fail(`unknown custom handler: ${entry.value}`);
          return;
        }
        await this.attemptAsync(`custom ${entry.value}`, handler);
        return;
      }

      this.attempt(`install ${entry.key}: ${entry.value}`, () => {
        if (entry.key === "run") this.runtime.execute(["bash", "-c", entry.value]);
      });
      return;
    }

    const label = `install ${batch.key}: ${batch.values.join(" ")}`;
    this.attempt(label, () => {
      switch (batch.key) {
        case "apt": {
          const missing = batch.values.filter((value) => !isAptInstalled(this.runtime, value));
          if (missing.length === 0) return;
          this.runtime.execute(["sudo", "apt", "update"]);
          this.runtime.execute(["sudo", "apt", "install", "-y", ...missing]);
          return;
        }
        case "flatpak": {
          const missing = batch.values.filter((value) => !isFlatpakInstalled(this.runtime, value));
          if (missing.length === 0) return;
          this.ensureFlatpakRemote();
          this.runtime.execute(["flatpak", "install", "-y", "--user", "flathub", ...missing]);
          return;
        }
        case "uv":
          for (const value of batch.values)
            this.runtime.execute(["uv", "tool", "install", "-q", value]);
          return;
        case "bun":
          this.runtime.execute(["bun", "add", "-g", "--silent", ...batch.values]);
          return;
        case "cargo":
          this.runtime.execute(["cargo", "install", "--quiet", ...batch.values]);
          return;
        case "go":
          this.runtime.execute([
            "go",
            "install",
            ...batch.values.map((value) => goInstallArg(value)),
          ]);
          return;
        case "brew":
          this.runtime.execute([
            "env",
            "HOMEBREW_NO_ENV_HINTS=1",
            "brew",
            "install",
            "--quiet",
            ...batch.values,
          ]);
          return;
        case "brew-cask":
          this.runtime.execute([
            "env",
            "HOMEBREW_NO_ENV_HINTS=1",
            "brew",
            "install",
            "--quiet",
            "--cask",
            ...batch.values,
          ]);
      }
    });
  }

  private defaultCustomHandlers(): ReadonlyMap<string, CustomHandler> {
    return new Map([
      ["android-sdk", () => this.installAndroidSdk()],
      ["blender", () => this.installBlender()],
      ["drawio", () => this.installDrawio()],
      ["generaluser-gs", () => this.installGeneralUserGs()],
      ["musescore", () => this.installMuseScore()],
      ["openwhispr", () => this.installOpenWhispr()],
      ["rustdesk", () => this.installRustDesk()],
      ["surge-xt", () => this.installSurgeXt()],
      ["opendesign", () => this.installOpenDesign()],
      ["tmp-disk", () => this.ensureTmpDisk()],
    ]);
  }

  private async installBlender(): Promise<void> {
    if (this.runtime.output(["uname", "-m"]) !== "x86_64")
      throw new Error("Blender linux-x64 tarball supports x86_64 only");

    const archive = this.runtime.output(["bash", "-c", blenderLatestArchiveCommand]);
    const version = archive.match(/^blender-(\d+\.\d+\.\d+)-linux-x64\.tar\.xz$/)?.[1];
    if (!version) throw new Error(`unexpected Blender release name: ${archive}`);

    const installDir = join(blenderInstallRoot, `blender-${version}-linux-x64`);
    const binTarget = join(installDir, "blender");
    if (this.runtime.succeeds(["test", "-d", installDir])) {
      if (this.runtime.outputAllowFailure(["readlink", blenderBinPath]) !== binTarget)
        this.runtime.execute(["sudo", "ln", "-sfn", binTarget, blenderBinPath]);
      return;
    }

    const family = version.split(".").slice(0, 2).join(".");
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-blender-"));
    try {
      this.runtime.execute([
        "curl",
        "-fL",
        "--retry",
        "3",
        "-o",
        join(directory, archive),
        `${blenderReleaseUrl}Blender${family}/${archive}`,
      ]);
      this.runtime.execute([
        "sudo",
        "tar",
        "-xJf",
        join(directory, archive),
        "-C",
        blenderInstallRoot,
      ]);
      this.runtime.execute(["sudo", "ln", "-sfn", binTarget, blenderBinPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private defaultPersonalOnlyHandlers(): ReadonlyMap<string, PersonalOnlyHandler> {
    return new Map([
      [
        "blender",
        { isInstalled: () => this.isBlenderInstalled(), remove: () => this.removeBlender() },
      ],
    ]);
  }

  private removePersonalOnlyPackages(): void {
    for (const [name, handler] of this.personalOnlyHandlers)
      this.attempt(`remove custom ${name}`, () => handler.remove());
  }

  private isBlenderInstalled(): boolean {
    if (
      blenderManagedLinkPattern.test(this.runtime.outputAllowFailure(["readlink", blenderBinPath]))
    )
      return true;
    return this.runtime.outputAllowFailure(["bash", "-c", blenderManagedDirCommand]) !== "";
  }

  private removeBlender(): void {
    const linkTarget = this.runtime.outputAllowFailure(["readlink", blenderBinPath]);
    if (blenderManagedLinkPattern.test(linkTarget))
      this.runtime.execute(["sudo", "rm", blenderBinPath]);

    const directories = this.runtime.outputAllowFailure(["bash", "-c", blenderManagedDirCommand]);
    for (const directory of directories.split("\n").filter(Boolean))
      this.runtime.execute(["sudo", "rm", "-rf", directory]);
  }

  private installAndroidSdk(): void {
    this.runtime.execute([
      "android",
      `--sdk=${androidSdkDir}`,
      "sdk",
      "install",
      "cmdline-tools/latest",
      "platform-tools",
    ]);
  }

  private ensureFlatpakRemote(): void {
    if (this.flatpakRemotePrepared) return;
    this.runtime.execute([
      "flatpak",
      "remote-add",
      "--if-not-exists",
      "--user",
      "flathub",
      flathubRepoUrl,
    ]);
    this.flatpakRemotePrepared = true;
  }

  private async installDrawio(): Promise<void> {
    const tag = this.runtime.output([
      "gh",
      "release",
      "view",
      "--repo",
      "jgraph/drawio-desktop",
      "--json",
      "tagName",
      "--jq",
      ".tagName",
    ]);
    if (
      this.runtime.outputAllowFailure(["dpkg-query", "-W", "-f=${Version}", "draw.io"]) ===
      tag.replace(/^v/, "")
    )
      return;

    const directory = await mkdtemp(join(tmpdir(), "bootstrap-drawio-"));
    try {
      this.runtime.execute([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        "jgraph/drawio-desktop",
        "--pattern",
        "drawio-amd64-*.deb",
        "--dir",
        directory,
      ]);
      const file = readdirSync(directory).find((name) => name.endsWith(".deb"));
      if (!file) throw new Error("draw.io release archive is missing a deb package");
      this.runtime.execute(["sudo", "apt", "install", "-y", join(directory, file)]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async installOpenWhispr(): Promise<void> {
    if (this.runtime.output(["uname", "-m"]) !== "x86_64")
      throw new Error("OpenWhispr Linux release supports x86_64 only");

    const tag = this.runtime.output([
      "gh",
      "release",
      "view",
      "--repo",
      openWhisprRepo,
      "--json",
      "tagName",
      "--jq",
      ".tagName",
    ]);
    const version = tag.replace(/^v/, "");
    if (
      this.runtime.outputAllowFailure([
        "dpkg-query",
        "-W",
        "-f=${Version}",
        openWhisprPackageName,
      ]) === version
    )
      return;

    const directory = await mkdtemp(join(tmpdir(), "bootstrap-openwhispr-"));
    try {
      this.runtime.execute([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        openWhisprRepo,
        "--pattern",
        `OpenWhispr-${version}-linux-amd64.deb`,
        "--dir",
        directory,
      ]);
      const file = readdirSync(directory).find((name) => name.endsWith(".deb"));
      if (!file) throw new Error("OpenWhispr release archive is missing a deb package");
      this.runtime.execute(["sudo", "apt", "install", "-y", join(directory, file)]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async installRustDesk(): Promise<void> {
    if (this.runtime.output(["uname", "-m"]) !== "x86_64")
      throw new Error("RustDesk Linux release supports x86_64 only");

    const tag = this.runtime.output([
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
    const version = tag.replace(/^v/, "");
    if (
      this.runtime.outputAllowFailure([
        "dpkg-query",
        "-W",
        "-f=${Version}",
        rustDeskPackageName,
      ]) === version
    )
      return;

    const directory = await mkdtemp(join(tmpdir(), "bootstrap-rustdesk-"));
    try {
      this.runtime.execute([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        rustDeskRepo,
        "--pattern",
        `rustdesk-${version}-x86_64.deb`,
        "--dir",
        directory,
      ]);
      const file = readdirSync(directory).find((name) => name.endsWith(".deb"));
      if (!file) throw new Error("RustDesk release archive is missing a deb package");
      this.runtime.execute(["sudo", "apt", "install", "-y", join(directory, file)]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async installSurgeXt(): Promise<void> {
    if (this.runtime.output(["uname", "-m"]) !== "x86_64")
      throw new Error("Surge XT Linux release supports x86_64 only");

    const tag = this.runtime.output([
      "gh",
      "release",
      "view",
      "--repo",
      surgeXtRepo,
      "--json",
      "tagName",
      "--jq",
      ".tagName",
    ]);
    const version = tag.replace(/^v/, "");
    if (
      this.runtime.outputAllowFailure(["dpkg-query", "-W", "-f=${Version}", surgeXtPackageName]) ===
      version
    )
      return;

    const directory = await mkdtemp(join(tmpdir(), "bootstrap-surge-xt-"));
    try {
      this.runtime.execute([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        surgeXtRepo,
        "--pattern",
        `surge-xt-linux-x64-${version}.deb`,
        "--dir",
        directory,
      ]);
      const file = readdirSync(directory).find((name) => name.endsWith(".deb"));
      if (!file) throw new Error("Surge XT release archive is missing a deb package");
      this.runtime.execute(["sudo", "apt", "install", "-y", join(directory, file)]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async installMuseScore(): Promise<void> {
    if (this.runtime.output(["uname", "-m"]) !== "x86_64")
      throw new Error("MuseScore AppImage supports x86_64 only");

    if (this.runtime.succeeds(["test", "-L", museScoreBinPath]))
      throw new Error(`refusing to replace unmanaged MuseScore path: ${museScoreBinPath}`);
    const wrapperExists = this.runtime.succeeds(["test", "-e", museScoreBinPath]);
    if (
      wrapperExists &&
      (!this.runtime.succeeds(["test", "-f", museScoreBinPath]) ||
        this.runtime.output(["sha256sum", museScoreBinPath]).split(/\s+/, 1)[0] !==
          museScoreWrapperHash)
    )
      throw new Error(`refusing to replace unmanaged MuseScore path: ${museScoreBinPath}`);

    if (this.runtime.succeeds(["test", "-L", museScoreInstallDir]))
      throw new Error(`refusing to replace MuseScore symlink: ${museScoreInstallDir}`);
    const installed =
      this.runtime.succeeds(["test", "-d", museScoreInstallDir]) &&
      this.runtime.succeeds(["test", "-f", museScoreAppRun]) &&
      this.runtime.succeeds(["test", "-x", museScoreAppRun]);
    if (!installed && this.runtime.succeeds(["test", "-e", museScoreInstallDir]))
      throw new Error(`refusing to replace incomplete MuseScore directory: ${museScoreInstallDir}`);

    if (installed && wrapperExists) {
      if (!this.runtime.succeeds(["test", "-x", museScoreBinPath]))
        this.runtime.execute(["sudo", "chmod", "+x", museScoreBinPath]);
      return;
    }

    const directory = await mkdtemp(join(tmpdir(), "bootstrap-musescore-"));
    try {
      if (!installed) this.downloadMuseScore(directory);
      if (!wrapperExists) {
        const wrapperPath = join(directory, "musescore");
        await Bun.write(wrapperPath, museScoreWrapper);
        this.runtime.execute(["sudo", "mkdir", "-p", "/usr/local/bin"]);
        this.runtime.execute(["sudo", "install", "-m", "755", wrapperPath, museScoreBinPath]);
      } else if (!this.runtime.succeeds(["test", "-x", museScoreBinPath])) {
        this.runtime.execute(["sudo", "chmod", "+x", museScoreBinPath]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private downloadMuseScore(directory: string): void {
    this.runtime.execute([
      "gh",
      "release",
      "download",
      museScoreTag,
      "--repo",
      museScoreRepo,
      "--pattern",
      museScoreAppImage,
      "--pattern",
      museScoreChecksums,
      "--dir",
      directory,
    ]);
    const checksums = this.runtime.output(["cat", join(directory, museScoreChecksums)]);
    const matchingLines = checksums
      .split(/\r?\n/)
      .map((line) => line.match(/^(\S+) [ *](.*)$/))
      .filter((match) => match?.[2] === museScoreAppImage);
    const checksum = matchingLines[0]?.[1];
    if (matchingLines.length !== 1 || !checksum || !/^[a-fA-F0-9]{64}$/.test(checksum))
      throw new Error(`MuseScore checksum entry is missing or invalid: ${museScoreAppImage}`);
    const appImagePath = join(directory, museScoreAppImage);
    const actualChecksum = this.runtime.output(["sha256sum", appImagePath]).split(/\s+/, 1)[0];
    if (actualChecksum !== checksum.toLowerCase())
      throw new Error(`MuseScore checksum mismatch: ${museScoreAppImage}`);

    this.runtime.execute(["chmod", "+x", appImagePath]);
    this.runtime.execute([
      "bash",
      "-c",
      'cd "$1" && "$2" --appimage-extract',
      "musescore-extract",
      directory,
      appImagePath,
    ]);
    const extractedDir = join(directory, "squashfs-root");
    if (
      !this.runtime.succeeds(["test", "-f", join(extractedDir, "AppRun")]) ||
      !this.runtime.succeeds(["test", "-x", join(extractedDir, "AppRun")])
    )
      throw new Error("MuseScore AppImage is missing an executable AppRun");

    const stagingDir = join("/opt", `.${basename(directory)}`);
    this.runtime.execute(["sudo", "mkdir", stagingDir]);
    try {
      this.runtime.execute(["sudo", "cp", "-a", `${extractedDir}/.`, stagingDir]);
      this.runtime.execute(["sudo", "chown", "-hR", "root:root", stagingDir]);
      this.runtime.execute(["sudo", "mv", "-T", "-n", stagingDir, museScoreInstallDir]);
      if (this.runtime.succeeds(["test", "-e", stagingDir]))
        throw new Error(
          `MuseScore install path appeared during installation: ${museScoreInstallDir}`,
        );
    } finally {
      this.runtime.execute(["sudo", "rm", "-rf", stagingDir]);
    }
  }

  private installGeneralUserGs(): void {
    const remoteBlobSha = this.runtime.output([
      "gh",
      "api",
      `repos/${generalUserGsRepo}/contents/GeneralUser-GS.sf2`,
      "--jq",
      ".sha",
    ]);
    const localBlobSha = this.runtime.outputAllowFailure(["git", "hash-object", generalUserGsPath]);
    if (localBlobSha === remoteBlobSha) return;

    this.runtime.execute(["mkdir", "-p", generalUserGsDir]);
    this.runtime.execute([
      "curl",
      "-fL",
      "--retry",
      "3",
      "-o",
      generalUserGsPath,
      generalUserGsUrl,
    ]);
    if (this.runtime.output(["git", "hash-object", generalUserGsPath]) !== remoteBlobSha)
      throw new Error("downloaded GeneralUser-GS.sf2 does not match the upstream blob");
  }

  private installOpenDesign(): void {
    if (!this.runtime.succeeds(["test", "-d", join(openDesignDir, ".git")])) {
      this.runtime.execute(["git", "clone", "--depth", "1", openDesignRepoUrl, openDesignDir]);
    }

    // pnpm install's postinstall also builds the daemon CLI.
    if (!this.runtime.succeeds(["test", "-f", openDesignDaemonEntry])) {
      this.runtime.execute(["bash", "-c", `cd ${openDesignDir} && corepack pnpm install`]);
    }

    if (!this.runtime.succeeds(["test", "-f", openDesignWebEntry])) {
      this.runtime.execute([
        "bash",
        "-c",
        // The web build's TypeScript phase exceeds Node's default ~2GB heap.
        `cd ${openDesignDir} && NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm --filter @open-design/web build`,
      ]);
    }

    if (this.runtime.outputAllowFailure(["cat", openDesignBinPath]) === openDesignOdWrapper) return;
    this.runtime.execute(["bash", "-c", openDesignOdWriteCommand]);
  }

  private ensureTmpDisk(): void {
    // Masked tmp.mount resolves to /dev/null; anything else means /tmp is still tmpfs-backed.
    if (this.runtime.outputAllowFailure(["readlink", "-f", tmpMountOverridePath]) !== "/dev/null")
      this.runtime.execute(["sudo", "systemctl", "mask", "tmp.mount"]);

    if (this.runtime.outputAllowFailure(["cat", tmpfilesConfigPath]) !== tmpfilesConfig)
      this.runtime.execute([
        "bash",
        "-c",
        `printf '${tmpfilesConfig}\n' | sudo tee ${tmpfilesConfigPath} > /dev/null`,
      ]);
  }

  private attempt(label: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.fail(`${label}: ${message(error)}`);
    }
  }

  private async attemptAsync(label: string, action: CustomHandler): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.fail(`${label}: ${message(error)}`);
    }
  }

  private fail(problem: string): void {
    this.failures.push(problem);
    this.runtime.error(problem);
  }

  private finish(): number {
    return this.failures.length === 0 ? 0 : 1;
  }
}

export function coalesceEntries(entries: readonly Entry[]): InstallBatch[] {
  const batches: InstallBatch[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (!batchableKeys.has(entry.key as BatchableKey)) {
      batches.push(entry);
      index += 1;
      continue;
    }

    const values = [entry.value];
    let next = index + 1;
    while (next < entries.length && entries[next]!.key === entry.key) {
      values.push(entries[next]!.value);
      next += 1;
    }
    batches.push({ key: entry.key as BatchableKey, values });
    index = next;
  }
  return batches;
}

function isBatch(batch: InstallBatch): batch is { key: BatchableKey; values: readonly string[] } {
  return "values" in batch;
}

export function parseConfig(source: string): ProfileEntries {
  const parsed = Bun.YAML.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("config top-level value must be a map with work and personal keys");
  const profileEntries: { work: Entry[]; personal: Entry[] } = { work: [], personal: [] };
  for (const [profile, value] of Object.entries(parsed)) {
    if (profile !== "work" && profile !== "personal")
      throw new Error(`invalid config top-level key: ${profile}`);
    if (!Array.isArray(value)) throw new Error(`config ${profile} value must be an array`);
    profileEntries[profile] = value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error(`config ${profile} entry ${index + 1} must be a map`);
      const entries = Object.entries(item);
      if (entries.length !== 1)
        throw new Error(`config ${profile} entry ${index + 1} must have one key`);
      const [key, entryValue] = entries[0]!;
      if (!validKeys.has(key as Key) || typeof entryValue !== "string")
        throw new Error(`invalid config ${profile} entry ${index + 1}`);
      return { key: key as Key, value: entryValue };
    });
  }
  if (profileEntries.work.length === 0 && profileEntries.personal.length === 0)
    throw new Error("config must define entries under work or personal");
  return profileEntries;
}

function desiredNames(entries: readonly Entry[], key: DeclarativeKey): Set<string> {
  return new Set(
    entries.filter((entry) => entry.key === key).map((entry) => packageName(key, entry.value)),
  );
}

function aptPackageName(value: string): string {
  return value.split(/[<>=!~[ ;]/, 1)[0]!;
}

function isAptInstalled(runtime: Runtime, value: string): boolean {
  return (
    runtime.outputAllowFailure([
      "dpkg-query",
      "-W",
      "-f=${db:Status-Status}",
      aptPackageName(value),
    ]) === "installed"
  );
}

function isFlatpakInstalled(runtime: Runtime, value: string): boolean {
  return runtime.succeeds(["flatpak", "info", "--user", value]);
}

function packageName(key: DeclarativeKey, value: string): string {
  if (key === "brew" || key === "brew-cask") return value;
  if (key === "go" || key === "cargo") return splitVersion(value)[0];
  if (key === "bun") return bunName(value);
  return value.split(/[<>=!~[ ;]/, 1)[0]!;
}

function cargoName(line: string): string {
  return line.match(/^(\S+)\s+v[^:]+:$/)?.[1] ?? "";
}

function bunName(value: string): string {
  const line = value.trim();
  const packageValue = line.match(/^[├└]──\s+(\S+)/)?.[1];
  if (line.startsWith("/") || (!packageValue && line.startsWith("-"))) return "";

  const packageSpec = packageValue ?? line.split(/\s+/, 1)[0]!;
  const versionAt = packageSpec.lastIndexOf("@");
  return versionAt > 0 ? packageSpec.slice(0, versionAt) : packageSpec;
}

function splitVersion(value: string): [string, string | undefined] {
  const index = value.lastIndexOf("@");
  return index > 0 ? [value.slice(0, index), value.slice(index + 1)] : [value, undefined];
}

function goInstallArg(value: string): string {
  const [, version] = splitVersion(value);
  return version === undefined ? `${value}@latest` : value;
}

function uvName(value: string): string {
  const line = value.trim();
  return line.startsWith("-") ? "" : line.split(/\s+/, 1)[0]!;
}

function names(output: string, name = (line: string) => line): Map<string, string> {
  return new Map(
    output
      .split("\n")
      .map((line) => name(line.trim()))
      .filter(Boolean)
      .map((packageName) => [packageName, packageName]),
  );
}

function isDeclarative(key: Key): key is DeclarativeKey {
  return declarativeKeys.includes(key as DeclarativeKey);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const systemRuntime: Runtime = {
  execute(command) {
    const result = Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) throw new Error(command.join(" "));
  },
  output(command) {
    const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.toString().trim() || command.join(" "));
    return result.stdout.toString().trim();
  },
  outputAllowFailure(command) {
    const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : "";
  },
  succeeds(command) {
    try {
      return Bun.spawnSync([...command], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      return false;
    }
  },
  log(message) {
    console.log(message);
  },
  error(message) {
    console.error(message);
  },
};

export async function run(
  arguments_: readonly string[],
  readConfig = () => Bun.file(configPath).text(),
  runtime: Runtime = systemRuntime,
): Promise<number> {
  const [command] = arguments_;
  if (arguments_.length !== 1 || (command !== "sync" && command !== "diff")) {
    runtime.error("usage: bun undotfiles/install/linux.ts <sync|diff>");
    return 1;
  }

  try {
    const profile = await readInstallProfile(() => Bun.file(markingPath).text());
    runtime.log(`install profile: ${profile}`);
    if (command === "sync") {
      const auth = Bun.spawnSync(["sudo", "-v"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      if (auth.exitCode !== 0) return 1;
    }
    const config = parseConfig(await readConfig());
    const entries = profile === "personal" ? [...config.work, ...config.personal] : config.work;
    const bootstrap = new Bootstrap(entries, runtime);
    return command === "sync" ? await bootstrap.sync(profile) : await bootstrap.diff(profile);
  } catch (error) {
    runtime.error(message(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));
