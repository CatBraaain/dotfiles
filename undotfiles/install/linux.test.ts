import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { parseConfig, run, type Runtime } from "./linux.ts";
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
  it("defines 74 dev entries, 24 work additions and three personal additions", async () => {
    const { dev, work, personal } = parseConfig(
      await Bun.file(new URL("./linux.install.yaml", import.meta.url)).text(),
    );
    assert.equal(dev.length, 74);
    assert.equal(work.length, 24);
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
    "only enables browser cache protection in dev (%s)",
    async (profile) => {
      const source = await Bun.file(new URL("./linux.install.yaml", import.meta.url)).text();
      const { runtime, logs } = mockRuntime();
      assert.equal(await invoke("diff", profile, source, runtime), 0);
      const browserInstall = "playwright-cli install-browser chrome-for-testing";
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
