import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { installCamoufox, parseConfig, run, type Runtime } from "./linux.ts";
import type { InstallProfile } from "./marking.ts";

const layeredConfig = `
personal:
  - custom: blender
work:
  - apt: work-only-deb
  - run: work-marker
dev:
  - brew: formula-one
  - apt: installed-deb
  - brew: formula-two
  - run: marker
  - flatpak: installed-app
  - flatpak: missing-app
  - apt: missing-deb
  - brew-cask: cask-one
`;

const legacyConfig = `
work:
  - bun: work-tool
  - apt: missing-deb
personal:
  - bun: personal-tool
`;

const stateReads = [
  "brew list --cask -1",
  "brew leaves",
  "bun pm ls -g",
  "cargo install --list",
  "gup list --json",
  "uv tool list",
];
const blenderLinkLookup = "readlink /usr/local/bin/blender";
const blenderDirLookup =
  "bash -c find /opt -maxdepth 1 -type d -regex '.*/blender-[0-9]+\\.[0-9]+\\.[0-9]+-linux-x64'";
const blenderTarget = "/opt/blender-4.5.0-linux-x64/blender";

function mockRuntime(execute: Runtime["execute"] = () => {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime: Runtime = {
    execute(command, options) {
      calls.push(command.join(" "));
      execute(command, options);
    },
    output(command) {
      const line = command.join(" ");
      calls.push(line);
      if (line === "brew list --cask -1") return "extra-cask";
      if (line === "brew leaves") return "extra-formula";
      if (line === "gup list --json") return "[]";
      return "";
    },
    outputAllowFailure(command) {
      const line = command.join(" ");
      calls.push(line);
      if (line === "dpkg-query -W -f=${db:Status-Status} installed-deb") return "installed";
      if (line === blenderLinkLookup) return blenderTarget;
      return "";
    },
    succeeds(command) {
      const line = command.join(" ");
      calls.push(line);
      return line === "flatpak info --user installed-app";
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  };
  return { runtime, calls, logs, errors };
}

function invoke(
  command: "diff" | "sync",
  profile: InstallProfile,
  source: string,
  runtime: Runtime,
) {
  return run(
    [command],
    async () => source,
    runtime,
    async () => `INSTALL_PROFILE=${profile}`,
  );
}

describe("Linux install profile configuration", () => {
  it("defines 74 dev entries, 25 work additions and three personal additions", async () => {
    const { dev, work, personal } = parseConfig(
      await Bun.file(new URL("./linux.install.yaml", import.meta.url)).text(),
    );
    assert.equal(dev.length, 74);
    assert.equal(work.length, 25);
    assert.ok(dev.some((entry) => entry.key === "brew" && entry.value === "gh"));
    assert.deepEqual(
      dev.filter((entry) => entry.key === "bun" && entry.value.startsWith("@playwright/cli")),
      [{ key: "bun", value: "@playwright/cli@0.1.22" }],
    );
    for (const entries of [dev, work, personal]) {
      assert.equal(
        entries.filter((entry) => entry.key === "custom" && entry.value === "camoufox").length,
        entries === work ? 1 : 0,
      );
    }
    assert.deepEqual(personal, [
      { key: "custom", value: "blender" },
      { key: "custom", value: "musescore" },
      { key: "custom", value: "surge-xt" },
    ]);
  });

  it("accepts a config with only a dev list", async () => {
    const { runtime, calls, logs } = mockRuntime();
    assert.equal(await invoke("diff", "dev", "dev: [{ bun: dev-tool }]", runtime), 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, ["install profile: dev", "install / update bun: dev-tool"]);
  });

  it.each([
    ["legacy", legacyConfig],
    ["empty dev list", "dev: []\nwork: [{ apt: work-only-deb }]"],
    ["all lists empty", "dev: []\nwork: []\npersonal: []"],
    ["malformed YAML", "dev: [{ apt:"],
    ["non-list dev value", "dev: { apt: one }"],
    ["multiple entry keys", "dev: [{ apt: one, brew: two }]"],
    ["unknown manager", "dev: [{ unknown: one }]"],
    ["nested dev wrapper", "dev: [{ apt: one }]\nwork: [{ dev: { apt: two } }]"],
  ])("rejects %s dev configuration before host operations", async (_name, source) => {
    for (const command of ["sync", "diff"] as const) {
      const { runtime, calls, errors } = mockRuntime();
      assert.equal(await invoke(command, "dev", source, runtime), 1);
      assert.deepEqual(calls, []);
      assert.match(errors[0] ?? "", /^config error:/);
    }
  });
});

describe("Linux Playwright browser install", () => {
  it.each(["dev", "work", "personal"] as const)(
    "shows the selected browsers and only enables browser cache protection in dev (%s)",
    async (profile) => {
      const source = await Bun.file(new URL("./linux.install.yaml", import.meta.url)).text();
      const { runtime, logs } = mockRuntime();
      assert.equal(await invoke("diff", profile, source, runtime), 0);
      assert.deepEqual(
        logs.filter((line) => line.startsWith("install / update bun: @playwright/cli")),
        ["install / update bun: @playwright/cli@0.1.22"],
      );
      assert.equal(logs.includes("custom: camoufox"), profile !== "dev");
      const browserInstall = '"$(bun pm bin -g)/playwright-cli" install-browser chrome-for-testing';
      const runCalls = logs.filter((line) => line.startsWith("run: "));
      assert.deepEqual(
        runCalls,
        ["rustup update stable", "rustup target add x86_64-pc-windows-gnu", browserInstall].map(
          (command) =>
            profile === "dev"
              ? `run: export PLAYWRIGHT_SKIP_BROWSER_GC=1; ${command}`
              : `run: ${command}`,
        ),
      );
    },
  );
});

describe("Linux Camoufox install", () => {
  const metadata = { version: "152.0.4", release: "beta.30" };
  const build = "152.0.4-beta.30";
  let root: string;
  let installDir: string;

  beforeEach(() => {
    const testRoot = "/tmp/work/dotfiles";
    mkdirSync(testRoot, { recursive: true });
    root = mkdtempSync(join(testRoot, "linux-camoufox-test-"));
    installDir = join(root, "camoufox");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeBrowser(directory: string, version = build, mode = 0o755): string {
    mkdirSync(directory, { recursive: true });
    const binary = join(directory, "camoufox-bin");
    writeFileSync(binary, "browser fixture", { mode });
    writeFileSync(
      join(directory, "application.ini"),
      `[App]\r\nName=Camoufox\r\nVersion=${version}\r\n`,
    );
    return binary;
  }

  function releaseFixture(
    machine: string,
    assetArch: string,
    extract: (payload: string) => void = (payload) => writeBrowser(payload, build, 0o644),
    beforePublish: () => void = () => {},
  ) {
    const archive = `camoufox-152.0.4-beta.30-lin.${assetArch}.zip`;
    return {
      output(command: readonly string[]) {
        assert.deepEqual(command, ["uname", "-m"]);
        return machine;
      },
      execute(command: readonly string[]) {
        const [program, ...args] = command;
        if (program === "gh") {
          const staging = args.at(-1)!;
          assert.equal(dirname(staging), root);
          assert.deepEqual(args, [
            "release",
            "download",
            "v152.0.4-beta.30",
            "--repo",
            "daijro/camoufox",
            "--pattern",
            archive,
            "--dir",
            staging,
          ]);
          writeFileSync(join(staging, archive), "release fixture");
        } else if (program === "unzip") {
          const payload = args.at(-1)!;
          assert.deepEqual(args, ["-q", join(dirname(payload), archive), "-d", payload]);
          assert.equal(readFileSync(args[1]!, "utf8"), "release fixture");
          extract(payload);
        } else if (program === "mv") {
          beforePublish();
          execFileSync("mv", args);
        } else {
          assert.fail(`Unexpected command: ${command.join(" ")}`);
        }
      },
    };
  }

  const offlineRuntime = {
    output: () => assert.fail("An existing installation must not query external commands"),
    execute: () => assert.fail("An existing installation must not run external commands"),
  };

  it.each([
    ["x86_64", "x86_64"],
    ["aarch64", "arm64"],
  ])(
    "publishes the pinned Linux archive for %s as a complete executable install",
    async (machine, assetArch) => {
      await installCamoufox(releaseFixture(machine, assetArch), installDir);
      assert.deepEqual(readdirSync(root), ["camoufox"]);
      const binary = join(installDir, "camoufox-bin");
      accessSync(binary, constants.X_OK);
      assert.equal(readFileSync(binary, "utf8"), "browser fixture");
      assert.deepEqual(
        JSON.parse(readFileSync(join(installDir, "version.json"), "utf8")),
        metadata,
      );
      await installCamoufox(offlineRuntime, installDir);
    },
  );

  it("keeps an existing same-version browser symlink and user profile without downloading", async () => {
    const binary = writeBrowser(join(installDir, "browsers", "official", `${build}-fixture`));
    const link = join(installDir, "camoufox-bin");
    symlinkSync(binary, link);
    const existingMetadata = JSON.stringify(metadata, null, 2);
    writeFileSync(join(installDir, "version.json"), existingMetadata);
    mkdirSync(join(installDir, "profile"));
    writeFileSync(join(installDir, "profile", "prefs.js"), "profile fixture");

    await installCamoufox(offlineRuntime, installDir);

    assert.equal(readlinkSync(link), binary);
    assert.equal(readFileSync(join(installDir, "version.json"), "utf8"), existingMetadata);
    assert.equal(readFileSync(join(installDir, "profile", "prefs.js"), "utf8"), "profile fixture");
  });

  it.each([
    ["a different browser build", "156.0.1-beta.36", JSON.stringify(metadata), 0o755],
    ["different version metadata", build, '{"version":"156.0.1","release":"beta.36"}', 0o755],
    ["invalid version metadata", build, "{", 0o755],
    ["a non-executable browser", build, JSON.stringify(metadata), 0o644],
  ] as const)(
    "rejects %s without modifying the existing installation",
    async (_case, version, json, mode) => {
      const binary = writeBrowser(installDir, version, mode);
      const versionFile = join(installDir, "version.json");
      writeFileSync(versionFile, json);

      await assert.rejects(
        installCamoufox(offlineRuntime, installDir),
        /Keeping existing Camoufox/,
      );

      assert.equal(readFileSync(binary, "utf8"), "browser fixture");
      assert.equal(readFileSync(versionFile, "utf8"), json);
    },
  );

  it.each(["Version=156.0.1-beta.36\n", "[App]\nVersion=156.0.1-beta.36\n", "[App]"])(
    "rejects ambiguous browser metadata without changing the existing installation (%s)",
    async (extra) => {
      const binary = writeBrowser(installDir);
      const metadataPath = join(installDir, "version.json");
      const applicationPath = join(installDir, "application.ini");
      const application = readFileSync(applicationPath, "utf8") + extra;
      writeFileSync(applicationPath, application);
      writeFileSync(metadataPath, JSON.stringify(metadata));

      await assert.rejects(
        installCamoufox(offlineRuntime, installDir),
        /Keeping existing Camoufox/,
      );
      assert.equal(readFileSync(binary, "utf8"), "browser fixture");
      assert.equal(readFileSync(applicationPath, "utf8"), application);
      assert.equal(readFileSync(metadataPath, "utf8"), JSON.stringify(metadata));
    },
  );

  it("rejects a cache populated only by an existing profile and leaves it intact", async () => {
    mkdirSync(installDir);
    writeFileSync(join(installDir, "profile"), "profile fixture");
    await assert.rejects(installCamoufox(offlineRuntime, installDir), /Keeping existing Camoufox/);
    assert.deepEqual(readdirSync(installDir), ["profile"]);
    assert.equal(readFileSync(join(installDir, "profile"), "utf8"), "profile fixture");
  });

  it("preserves a dangling symlink at the install path", async () => {
    const target = join(root, "missing");
    symlinkSync(target, installDir);
    await assert.rejects(installCamoufox(offlineRuntime, installDir), /Keeping existing Camoufox/);
    assert.equal(readlinkSync(installDir), target);
    assert.deepEqual(readdirSync(root), ["camoufox"]);
  });

  it("rejects an unsupported architecture without staging a download", async () => {
    await assert.rejects(
      installCamoufox({ ...offlineRuntime, output: () => "riscv64" }, installDir),
      /does not support architecture: riscv64/,
    );
    assert.deepEqual(readdirSync(root), []);
  });

  it("does not publish a partial extraction and allows a retry", async () => {
    const partial = releaseFixture("x86_64", "x86_64", (payload) => {
      writeFileSync(join(payload, "camoufox-bin"), "incomplete");
      throw new Error("extraction failed");
    });
    await assert.rejects(installCamoufox(partial, installDir), /extraction failed/);
    assert.deepEqual(readdirSync(root), []);
    await installCamoufox(releaseFixture("x86_64", "x86_64"), installDir);
    await installCamoufox(offlineRuntime, installDir);
  });

  it("does not publish an archive whose browser build differs from the pin", async () => {
    const incorrect = releaseFixture("x86_64", "x86_64", (payload) =>
      writeBrowser(payload, "156.0.1-beta.36"),
    );
    await assert.rejects(
      installCamoufox(incorrect, installDir),
      /expected application.ini for Camoufox/,
    );
    assert.deepEqual(readdirSync(root), []);
  });

  it("does not replace an empty directory created before publishing", async () => {
    const concurrent = releaseFixture("x86_64", "x86_64", undefined, () => mkdirSync(installDir));
    await assert.rejects(installCamoufox(concurrent, installDir));
    assert.deepEqual(readdirSync(root), ["camoufox"]);
    assert.deepEqual(readdirSync(installDir), []);
  });
});

describe.each(["work", "personal"] as const)("Linux %s layered profile", (profile) => {
  it("runs all selected APT entries first, then processes the selected lists in order", async () => {
    const source = `
personal:
  - run: personal-marker
work:
  - apt: work-only-deb
  - run: work-marker
dev:
  - run: dev-marker
  - apt: missing-deb
`;
    const { runtime, calls } = mockRuntime();
    assert.equal(await invoke("sync", profile, source, runtime), 0);
    assert.deepEqual(calls, [
      "sudo -v",
      "dpkg-query -W -f=${db:Status-Status} missing-deb",
      "dpkg-query -W -f=${db:Status-Status} work-only-deb",
      "sudo apt update",
      "sudo apt install -y missing-deb work-only-deb",
      "bash -c dev-marker",
      "bash -c work-marker",
      ...(profile === "personal" ? ["bash -c personal-marker"] : []),
      ...stateReads,
      "brew uninstall --cask extra-cask",
      "brew uninstall extra-formula",
      ...(profile === "work"
        ? [blenderLinkLookup, "sudo rm /usr/local/bin/blender", blenderDirLookup]
        : []),
    ]);
  });

  it("shows only the selected lists in order", async () => {
    const { runtime, logs } = mockRuntime();
    assert.equal(await invoke("diff", profile, layeredConfig, runtime), 0);
    assert.deepEqual(logs, [
      `install profile: ${profile}`,
      "remove brew-cask: extra-cask",
      "remove brew: extra-formula",
      "install / update brew: formula-one",
      "install / update brew: formula-two",
      "run: marker",
      "install / update flatpak: missing-app",
      "install / update apt: missing-deb",
      "install / update brew-cask: cask-one",
      "install / update apt: work-only-deb",
      "run: work-marker",
      profile === "personal" ? "custom: blender" : "remove custom: blender",
    ]);
  });
});

describe("Linux dev profile", () => {
  it("installs selected entries in order without reading removal state or removing packages", async () => {
    const { runtime, calls, errors } = mockRuntime();
    assert.equal(await invoke("sync", "dev", layeredConfig, runtime), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [
      "sudo -v",
      "dpkg-query -W -f=${db:Status-Status} installed-deb",
      "dpkg-query -W -f=${db:Status-Status} missing-deb",
      "sudo apt update",
      "sudo apt install -y --no-remove -- missing-deb",
      "env HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install --quiet formula-one formula-two",
      "bash -c export PLAYWRIGHT_SKIP_BROWSER_GC=1; marker",
      "flatpak info --user installed-app",
      "flatpak info --user missing-app",
      "flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo",
      "flatpak install -y --user flathub missing-app",
      "env HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install --quiet --cask cask-one",
    ]);
  });

  it("continues after APT rejects an install requiring removal", async () => {
    const { runtime, calls, errors } = mockRuntime((command) => {
      if (command[0] === "sudo" && command[2] === "install") {
        assert.ok(command.includes("--no-remove"));
        throw new Error("packages need to be removed");
      }
    });
    assert.equal(await invoke("sync", "dev", layeredConfig, runtime), 1);
    assert.deepEqual(errors, [
      "install apt: installed-deb missing-deb: packages need to be removed",
    ]);
    assert.ok(calls.includes("bash -c export PLAYWRIGHT_SKIP_BROWSER_GC=1; marker"));
  });

  it("reports only selected install, update and run plans", async () => {
    const { runtime, calls, logs } = mockRuntime();
    assert.equal(await invoke("diff", "dev", layeredConfig, runtime), 0);
    assert.deepEqual(calls, [
      "dpkg-query -W -f=${db:Status-Status} installed-deb",
      "flatpak info --user installed-app",
      "flatpak info --user missing-app",
      "dpkg-query -W -f=${db:Status-Status} missing-deb",
    ]);
    assert.deepEqual(logs, [
      "install profile: dev",
      "install / update brew: formula-one",
      "install / update brew: formula-two",
      "run: export PLAYWRIGHT_SKIP_BROWSER_GC=1; marker",
      "install / update flatpak: missing-app",
      "install / update apt: missing-deb",
      "install / update brew-cask: cask-one",
    ]);
  });

  it.each(["diff", "sync"] as const)(
    "rejects a selected personal-only handler in %s",
    async (command) => {
      const { runtime, calls, logs, errors } = mockRuntime();
      const source = "dev: [{ custom: blender }]";
      assert.equal(await invoke(command, "dev", source, runtime), 1);
      assert.deepEqual(calls, command === "sync" ? ["sudo -v"] : []);
      assert.deepEqual(logs, ["install profile: dev"]);
      assert.deepEqual(errors, ["personal-only custom handler in dev config: blender"]);
    },
  );
});

describe.each(["work", "personal"] as const)("Linux legacy %s profile", (profile) => {
  it("keeps install and removal phases in order", async () => {
    const { runtime, calls } = mockRuntime();
    assert.equal(await invoke("sync", profile, legacyConfig, runtime), 0);
    const bunPackages = profile === "personal" ? "work-tool personal-tool" : "work-tool";
    assert.deepEqual(calls, [
      "sudo -v",
      "dpkg-query -W -f=${db:Status-Status} missing-deb",
      "sudo apt update",
      "sudo apt install -y missing-deb",
      `bun add -g --silent ${bunPackages}`,
      ...stateReads,
      "brew uninstall --cask extra-cask",
      "brew uninstall extra-formula",
      ...(profile === "work"
        ? [blenderLinkLookup, "sudo rm /usr/local/bin/blender", blenderDirLookup]
        : []),
    ]);
  });

  it("keeps removal, install and personal handler plans in order", async () => {
    const { runtime, calls, logs } = mockRuntime();
    assert.equal(await invoke("diff", profile, legacyConfig, runtime), 0);
    assert.deepEqual(calls, [
      ...stateReads,
      "dpkg-query -W -f=${db:Status-Status} missing-deb",
      ...(profile === "work" ? [blenderLinkLookup] : []),
    ]);
    assert.deepEqual(logs, [
      `install profile: ${profile}`,
      "remove brew-cask: extra-cask",
      "remove brew: extra-formula",
      "install / update bun: work-tool",
      "install / update apt: missing-deb",
      profile === "work" ? "remove custom: blender" : "install / update bun: personal-tool",
    ]);
  });
});
