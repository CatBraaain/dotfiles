import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallProfile } from "./marking";
import { installCamoufox, installWindows } from "./windows";

const wingetSourceId = "Microsoft.Winget.Source_8wekyb3d8bbwe";
const elevationCheck = ["gsudo", "status", "IsElevated"];
const refreshPath = [
  "powershell",
  "-NoProfile",
  "-Command",
  "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
];
const npmInstall = ["cmd", "/c", "npm", "install", "-g", "--ignore-scripts"];
const piInstall = [...npmInstall, "@earendil-works/pi-coding-agent"];
const playwrightInstall = [...npmInstall, "@playwright/cli@0.1.22"];
const trafilaturaInstall = ["uv", "tool", "install", "trafilatura"];
const uvUpdateShell = ["uv", "tool", "update-shell"];
const camoufoxDownload = [
  "gh",
  "release",
  "download",
  "v158.0.1-beta.41",
  "--repo",
  "daijro/camoufox",
  "--pattern",
  "camoufox-158.0.1-beta.41-win.x86_64.zip",
];

function wingetInstall(packageIds: string, ...options: string[]): string[] {
  return ["winget", "install", ...packageIds.trim().split(/\s+/), ...options, "--source", "winget"];
}

const devManaged = `Microsoft.VisualStudioCode Oven-sh.Bun Git.Git Casey.Just OpenJS.NodeJS.LTS
  Microsoft.PowerShell marlocarlo.psmux Canonical.Ubuntu GitHub.cli Microsoft.coreutils gerardog.gsudo`;
const workManaged = `BluePointLilac.ContextMenuManager sordum.EasyContextMenu w4po.ExplorerTabUtility
  AdrienAllard.FileConverter DuongDieuPhap.ImageGlass LocalSend.LocalSend MPC-BE.MPC-BE
  M2Team.NanaZip OpenWhispr.OpenWhispr ShareX.ShareX Microsoft.Sysinternals.Autologon Rime.Weasel
  WinDirStat.WinDirStat Microsoft.WindowsTerminal ZedIndustries.Zed AutoHotkey.AutoHotkey
  RussellBanks.Komac CatBraaain.runx CatBraaain.wintasks astral-sh.uv`;
const personalManaged = `Guru3D.Afterburner CPUID.CPU-Z Rem0o.FanControl GIMP.GIMP.3 ch.LosslessCut
  Mojang.MinecraftLauncher OBSProject.OBSStudio Guru3D.RTSS Meltytech.Shotcut Valve.Steam
  Devolutions.UniGetUI HaraldBoegeholz.h2testw`;

function windowsFixture(configText?: string) {
  const appData = mkdtempSync(join(tmpdir(), "windows-installer-test-"));
  const desktop = join(appData, "Desktop");
  const winget = join(appData, "Microsoft", "WinGet");
  const packages = join(winget, "Packages");
  const links = join(winget, "Links");
  mkdirSync(desktop);
  mkdirSync(links, { recursive: true });
  const desktopShortcut = join(desktop, "App.lnk");
  writeFileSync(desktopShortcut, "desktop shortcut");

  function packageExe(folder: string, file: string) {
    const executable = join(packages, folder, file);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "installed app");
    return executable;
  }

  const commands: string[][] = [];

  async function run(
    profile: InstallProfile,
    ...failingCommands: (
      | "winget"
      | "pi"
      | "playwright"
      | "camoufox"
      | "trafilatura"
      | "update-shell"
    )[]
  ) {
    const previousPath = process.env.Path;
    const previousAppData = process.env.LOCALAPPDATA;
    const npmPaths: (string | undefined)[] = [];
    const errors: string[] = [];
    const lookups: { executable: string; after: string[] | undefined; path: string | undefined }[] =
      [];
    const workingDirectoryOverrides: { command: string | undefined; cwd: string }[] = [];
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((args, options?: { cwd?: string }) => {
      assert.ok(Array.isArray(args), "expected an argument vector");
      commands.push(args);
      const [command] = args;
      if (options?.cwd !== undefined) workingDirectoryOverrides.push({ command, cwd: options.cwd });
      if (command === "cmd") npmPaths.push(process.env.Path);
      const refreshesPath = command === "powershell" && args[3]?.startsWith("[Environment]");
      const stdout = refreshesPath ? "machine;user" : "1.0.0";
      const fails =
        (failingCommands.includes("winget") && command === "winget") ||
        (failingCommands.includes("pi") && args.at(-1) === piInstall.at(-1)) ||
        (failingCommands.includes("playwright") && args.at(-1) === playwrightInstall.at(-1)) ||
        (failingCommands.includes("camoufox") && args.includes("daijro/camoufox")) ||
        (failingCommands.includes("trafilatura") && args.at(-1) === "trafilatura") ||
        (failingCommands.includes("update-shell") && args.at(-1) === "update-shell");
      return {
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
        exitCode: fails ? 1 : 0,
      } as ReturnType<typeof Bun.spawnSync>;
    });
    const relaunch = spyOn(Bun, "spawn").mockImplementation(() =>
      assert.fail("unexpected relaunch"),
    );
    const which = spyOn(Bun, "which").mockImplementation((executable) => {
      lookups.push({ executable, after: commands.at(-1), path: process.env.Path });
      return join(links, "openserp.exe");
    });
    const stderr = spyOn(console, "error").mockImplementation((error) =>
      errors.push(String(error)),
    );
    process.env.LOCALAPPDATA = appData;
    try {
      const readConfig = configText === undefined ? undefined : async () => configText;
      await installWindows(profile, desktop, readConfig);
      return { commands, npmPaths, errors, lookups, workingDirectoryOverrides };
    } finally {
      stderr.mockRestore();
      which.mockRestore();
      relaunch.mockRestore();
      spawn.mockRestore();
      if (previousAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousAppData;
      if (previousPath === undefined) delete process.env.Path;
      else process.env.Path = previousPath;
    }
  }

  return {
    appData,
    desktopShortcut,
    commands,
    links,
    packageExe,
    run,
    dispose: () => rmSync(appData, { recursive: true }),
  };
}

test("dev installs only its selected packages after the elevation check and refreshes PATH for npm", async () => {
  const fixture = windowsFixture();
  try {
    const { commands, npmPaths, errors, lookups } = await fixture.run("dev", "playwright");
    assert.deepEqual(commands, [
      elevationCheck,
      wingetInstall("Docker.DockerDesktop", "--no-upgrade"),
      wingetInstall(devManaged),
      refreshPath,
      piInstall,
      playwrightInstall,
    ]);
    assert.deepEqual(npmPaths, ["machine;user", "machine;user"]);
    assert.deepEqual(lookups, []);
    assert.deepEqual(errors, [`command failed with exit code 1: ${playwrightInstall.join(" ")}`]);
    assert.equal(readFileSync(fixture.desktopShortcut, "utf8"), "desktop shortcut");
  } finally {
    fixture.dispose();
  }
});

test.each([
  [
    String.raw`\\wsl.localhost\Ubuntu\home\user\dotfiles`,
    [{ command: "cmd", cwd: String.raw`C:\Windows` }],
  ],
  [String.raw`C:\Users\user\dotfiles`, []],
])(
  "sets a local working directory only for npm launched from a UNC path: %s",
  async (cwd, expected) => {
    const fixture = windowsFixture("dev: [{ npm: cli-tool }]\nwork: []\npersonal: []");
    const getCwd = spyOn(process, "cwd").mockReturnValue(cwd);
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = String.raw`C:\Windows`;
    try {
      const { workingDirectoryOverrides } = await fixture.run("dev");
      assert.deepEqual(workingDirectoryOverrides, expected);
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      getCwd.mockRestore();
      fixture.dispose();
    }
  },
);

test("pi installation failure is still fatal", async () => {
  const fixture = windowsFixture();
  try {
    await assert.rejects(
      fixture.run("dev", "pi"),
      /command failed with exit code 1: .*pi-coding-agent/,
    );
    assert.deepEqual(fixture.commands.slice(-2), [refreshPath, piInstall]);
  } finally {
    fixture.dispose();
  }
});

test("dev leaves WinGet links unchanged", async () => {
  const fixture = windowsFixture();
  try {
    const bunFolder = `Oven-sh.Bun_${wingetSourceId}`;
    const installedExe = fixture.packageExe(bunFolder, "bun.exe");
    fixture.packageExe(bunFolder, "bunx.exe");
    const existingTarget = join(dirname(installedExe), "old", "bun.exe");
    const existingLink = join(fixture.links, "bun.exe");
    symlinkSync(existingTarget, existingLink, "file");

    await fixture.run("dev");

    assert.deepEqual(readdirSync(fixture.links), ["bun.exe"]);
    assert.equal(readlinkSync(existingLink), existingTarget);
  } finally {
    fixture.dispose();
  }
});

test.each(["work", "personal"] as const)(
  "%s keeps the existing package options and performs cleanup",
  async (profile) => {
    const fixture = windowsFixture();
    try {
      const app = join(fixture.appData, "Programs", "Camoufox");
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, "camoufox.exe"), "installed browser");
      writeFileSync(join(app, "application.ini"), "[App]\nVersion=158.0.1-beta.41\n");
      const nonDevExecutable = fixture.packageExe(
        `RussellBanks.Komac_${wingetSourceId}`,
        "komac.exe",
      );
      const replacedLink = join(fixture.links, "komac.exe");
      writeFileSync(replacedLink, "previous file");

      const { commands, lookups, errors } = await fixture.run(profile, "winget");
      const wingetCommands = [
        wingetInstall(
          "AutoHotkey.AutoHotkey",
          "--silent",
          "--version",
          "1.1.37.02",
          "--no-upgrade",
        ),
        wingetInstall("Docker.DockerDesktop", "--no-upgrade"),
        wingetInstall(devManaged),
        wingetInstall("Google.Chrome Mozilla.Firefox", "--no-upgrade"),
        wingetInstall(workManaged),
      ];
      if (profile === "personal") {
        wingetCommands.push(
          wingetInstall("Discord.Discord", "--no-upgrade"),
          wingetInstall(personalManaged),
        );
      }
      const installerCommands = [
        elevationCheck,
        ...wingetCommands,
        refreshPath,
        piInstall,
        playwrightInstall,
        trafilaturaInstall,
        uvUpdateShell,
      ];
      assert.deepEqual(commands.slice(0, installerCommands.length), installerCommands);
      assert.deepEqual(
        errors,
        wingetCommands.map((args) => `command failed with exit code 1: ${args.join(" ")}`),
      );
      assert.deepEqual(lookups, [
        { executable: "openserp", after: uvUpdateShell, path: "machine;user" },
      ]);
      assert.deepEqual(commands[installerCommands.length], [
        "gh",
        "release",
        "view",
        "--repo",
        "rustdesk/rustdesk",
        "--json",
        "tagName",
        "--jq",
        ".tagName",
      ]);
      assert.equal(commands[installerCommands.length + 1]?.[0], "powershell");
      assert.equal(commands.length, installerCommands.length + 2);
      assert.ok(existsSync(join(app, "version.json")));
      assert.equal(existsSync(fixture.desktopShortcut), false);
      assert.equal(realpathSync(replacedLink), realpathSync(nonDevExecutable));
    } finally {
      fixture.dispose();
    }
  },
);

test.each([
  ["trafilatura", [trafilaturaInstall]],
  ["update-shell", [trafilaturaInstall, uvUpdateShell]],
] as const)(
  "reports a failed uv %s command and continues installing",
  async (failure, uvCommands) => {
    const fixture = windowsFixture(`dev: []
work:
  - winget: astral-sh.uv
  - custom: trafilatura
  - npm: next-tool
personal: []
`);
    try {
      fixture.packageExe("test", "test.exe");
      const { commands, errors } = await fixture.run("work", failure);
      assert.deepEqual(commands, [
        elevationCheck,
        wingetInstall("astral-sh.uv"),
        refreshPath,
        ...uvCommands,
        [...npmInstall, "next-tool"],
      ]);
      assert.deepEqual(errors, [
        `trafilatura install failed: command failed with exit code 1: ${uvCommands.at(-1)!.join(" ")}`,
      ]);
    } finally {
      fixture.dispose();
    }
  },
);

test("relaunches the same installer with gsudo before running any installs", async () => {
  const stopped = new Error("parent process exited");
  const check = spyOn(Bun, "spawnSync").mockImplementation((args) => {
    assert.deepEqual(args, elevationCheck);
    return { exitCode: 1 } as ReturnType<typeof Bun.spawnSync>;
  });
  const relaunch = spyOn(Bun, "spawn").mockImplementation((args) => {
    assert.deepEqual(args, ["gsudo", "-d", process.execPath, join(import.meta.dir, "windows.ts")]);
    return { exited: Promise.resolve(7) } as ReturnType<typeof Bun.spawn>;
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    assert.equal(code, 7);
    throw stopped;
  });
  try {
    await assert.rejects(installWindows("dev"), stopped);
    assert.equal(check.mock.calls.length, 1);
    assert.equal(relaunch.mock.calls.length, 1);
  } finally {
    exit.mockRestore();
    relaunch.mockRestore();
    check.mockRestore();
  }
});

test("installs pinned WinGet entries first, then batches consecutive identical args", async () => {
  const fixture = windowsFixture(`dev:
  - npm: cli-tool
  - winget: Test.First
  - winget: { id: Test.Pinned1, args: [--version, "1.2"] }
  - custom: openserp
  - winget: { id: Test.Second, args: [] }
  - winget: { id: Test.Silent1, args: [--silent] }
  - winget: { id: Test.Silent2, args: [--silent] }
  - winget: { id: Test.Order1, args: [--no-upgrade, --silent] }
  - winget: { id: Test.Order2, args: [--silent, --no-upgrade] }
  - winget: { id: Test.Third }
  - winget: { id: Test.NoUpgrade, args: [--no-upgrade] }
  - winget: { id: Test.Pinned2, args: [--version, "2.3"] }
work: []
personal: []
`);
  try {
    const { commands } = await fixture.run("dev");
    assert.deepEqual(commands, [
      elevationCheck,
      wingetInstall("Test.Pinned1", "--version", "1.2"),
      wingetInstall("Test.Pinned2", "--version", "2.3"),
      wingetInstall("Test.First Test.Second"),
      wingetInstall("Test.Silent1 Test.Silent2", "--silent"),
      wingetInstall("Test.Order1", "--no-upgrade", "--silent"),
      wingetInstall("Test.Order2", "--silent", "--no-upgrade"),
      wingetInstall("Test.Third"),
      wingetInstall("Test.NoUpgrade", "--no-upgrade"),
      refreshPath,
      [...npmInstall, "cli-tool"],
    ]);
  } finally {
    fixture.dispose();
  }
});

test("runs npm and custom in cumulative config order and continues after nonfatal failures", async () => {
  const fixture = windowsFixture(`work:
  - custom: openserp
  - npm: cli-tool
  - winget: Test.WorkOnly
dev:
  - custom: camoufox
  - npm: "@playwright/cli@0.1.22"
  - winget: Test.DevOnly
personal:
  - npm: not-selected
`);
  try {
    fixture.packageExe("test", "test.exe");
    const { commands, lookups, errors } = await fixture.run("work", "camoufox", "playwright");
    const camoufoxCommand = commands[3]!;
    assert.deepEqual(camoufoxCommand.slice(0, camoufoxDownload.length), camoufoxDownload);
    assert.deepEqual(commands, [
      elevationCheck,
      wingetInstall("Test.DevOnly Test.WorkOnly"),
      refreshPath,
      camoufoxCommand,
      playwrightInstall,
      [...npmInstall, "cli-tool"],
    ]);
    assert.deepEqual(lookups, [
      { executable: "openserp", after: playwrightInstall, path: "machine;user" },
    ]);
    assert.deepEqual(errors, [
      `camoufox install failed: command failed with exit code 1: ${camoufoxCommand.join(" ")}`,
      `command failed with exit code 1: ${playwrightInstall.join(" ")}`,
    ]);
    assert.equal(existsSync(fixture.desktopShortcut), false);
  } finally {
    fixture.dispose();
  }
});

test("uses the last value for a duplicate YAML key and installs no undeclared packages", async () => {
  const fixture = windowsFixture(`dev:
  - npm: first
    npm: last
work: [{ winget: Test.WorkOnly }]
personal: []
`);
  try {
    const { commands, lookups } = await fixture.run("dev");
    assert.deepEqual(commands, [elevationCheck, refreshPath, [...npmInstall, "last"]]);
    assert.deepEqual(lookups, []);
  } finally {
    fixture.dispose();
  }
});

test("requires Bun YAML support before starting external operations", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Bun.YAML, "parse")!;
  Object.defineProperty(Bun.YAML, "parse", { value: undefined });
  try {
    await assert.rejects(
      installWindows("dev", undefined, async () => ""),
      /Bun 1\.2\.21/,
    );
  } finally {
    Object.defineProperty(Bun.YAML, "parse", descriptor);
  }
});

test.each([
  ["[]", /must be a map/],
  ["dev: []\nwork: []", /personal must be a list/],
  ["dev: []\nwork: {}\npersonal: []", /work must be a list/],
  ["dev: []\nwork: []\npersonal: []\nother: []", /Unknown .* profile: other/],
  ["dev: []\nwork: []\npersonal: [{ custom: unknown }]", /unknown custom installer/],
])("rejects invalid profiles before external operations: %s", async (configText, error) => {
  const fixture = windowsFixture(configText);
  try {
    await assert.rejects(fixture.run("dev"), error);
    assert.deepEqual(fixture.commands, []);
    assert.equal(readFileSync(fixture.desktopShortcut, "utf8"), "desktop shortcut");
    assert.deepEqual(readdirSync(fixture.links), []);
  } finally {
    fixture.dispose();
  }
});

test.each([
  ["Test.Tool", /must be a map/],
  ["{}", /must have one key/],
  ["{ winget: Test.Tool, npm: cli-tool }", /must have one key/],
  ["{ run: anything }", /unknown key: run/],
  ["{ winget: --force }", /invalid WinGet id/],
  ["{ winget: { id: 1.2 } }", /invalid WinGet id/],
  ["{ winget: [] }", /winget must be an id or a map/],
  ["{ winget: { id: Test.Tool, source: msstore } }", /unknown key: source/],
  ["{ winget: { id: Test.Tool, args: '--silent' } }", /args must be an array/],
  ["{ winget: { id: Test.Tool, args: null } }", /args must be an array/],
  ["{ winget: { id: Test.Tool, args: [--source, msstore] } }", /invalid WinGet argument/],
  ["{ winget: { id: Test.Tool, args: [true] } }", /invalid WinGet argument/],
  ["{ winget: { id: Test.Tool, args: [--silent, --silent] } }", /duplicate WinGet argument/],
  [
    "{ winget: { id: Test.Tool, args: [--version, '1.2', --version, '2.3'] } }",
    /duplicate WinGet argument/,
  ],
  ["{ winget: { id: Test.Tool, args: [--version] } }", /invalid WinGet version/],
  ["{ winget: { id: Test.Tool, args: [--version, 1.2] } }", /invalid WinGet version/],
  ["{ winget: { id: Test.Tool, args: [--version, --silent] } }", /invalid WinGet version/],
  ["{ npm: 1 }", /invalid npm package name/],
  ["{ npm: '--force' }", /invalid npm package name/],
  ["{ npm: 'cli & echo' }", /invalid npm package name/],
  ["{ npm: 'cli%PATH%' }", /invalid npm package name/],
  ["{ npm: '@scope/--force' }", /invalid npm package name/],
  ["{ npm: 'cli@next' }", /invalid npm package name/],
  ["{ npm: 'cli@^1.2.3' }", /invalid npm package name/],
  ["{ npm: 'cli@1.2' }", /invalid npm package name/],
  ["{ npm: 'cli@01.2.3' }", /invalid npm package name/],
  ["{ npm: 'scope/cli' }", /invalid npm package name/],
  ["{ npm: 'cli.tgz' }", /invalid npm package name/],
  ["{ npm: 'cli.tgz@1.2.3' }", /invalid npm package name/],
  ["{ npm: 'cli@file:./cli' }", /invalid npm package name/],
  ["{ npm: 'cli@https://example.test/cli.tgz' }", /invalid npm package name/],
  ["{ npm: 'cli@1.2.3&echo' }", /invalid npm package name/],
  [`{ npm: ${JSON.stringify("@scope/cli@1.2.3\n")} }`, /invalid npm package name/],
  ["{ custom: true }", /custom name must be a string/],
  ["{ custom: constructor }", /unknown custom installer/],
])("rejects invalid entries before external operations: %s", async (entry, error) => {
  const fixture = windowsFixture(`dev: [{ npm: valid }, ${entry}]\nwork: []\npersonal: []`);
  try {
    await assert.rejects(fixture.run("work"), error);
    assert.deepEqual(fixture.commands, []);
    assert.equal(readFileSync(fixture.desktopShortcut, "utf8"), "desktop shortcut");
    assert.deepEqual(readdirSync(fixture.links), []);
  } finally {
    fixture.dispose();
  }
});

function browserFixture(application: string) {
  const appData = mkdtempSync(join(tmpdir(), "camoufox-installer-test-"));
  const browser = join(appData, "Programs", "Camoufox");
  mkdirSync(browser, { recursive: true });
  const executable = join(browser, "camoufox.exe");
  const versionFile = join(browser, "version.json");
  writeFileSync(executable, "installed browser");
  writeFileSync(join(browser, "application.ini"), application);
  return {
    appData,
    browser,
    executable,
    versionFile,
    dispose: () => rmSync(appData, { recursive: true }),
  };
}

test("repairs the metadata without replacing the installed Camoufox", async () => {
  const fixture = browserFixture("[App]\r\nName=Camoufox\r\nVersion=158.0.1-beta.41\r\n");
  try {
    await installCamoufox(fixture.appData);
    assert.deepEqual(JSON.parse(readFileSync(fixture.versionFile, "utf8")), {
      version: "158.0.1",
      release: "beta.41",
    });
    assert.equal(readFileSync(fixture.executable, "utf8"), "installed browser");
  } finally {
    fixture.dispose();
  }
});

test("leaves an existing version file intact", async () => {
  const fixture = browserFixture("[App]\nVersion=158.0.1-beta.41\n");
  const existing = '{"version":"158.0.1","release":"beta.41"}';
  try {
    writeFileSync(fixture.versionFile, existing);
    await installCamoufox(fixture.appData);
    assert.equal(readFileSync(fixture.versionFile, "utf8"), existing);
  } finally {
    fixture.dispose();
  }
});

test("can retry after failing to publish the version file", async () => {
  const fixture = browserFixture("[App]\nVersion=158.0.1-beta.41\n");
  try {
    const publish = spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("Could not publish version file");
    });
    try {
      await assert.rejects(installCamoufox(fixture.appData), /Could not publish version file/);
      assert.deepEqual(readdirSync(fixture.browser).sort(), ["application.ini", "camoufox.exe"]);
    } finally {
      publish.mockRestore();
    }
    await installCamoufox(fixture.appData);
    assert.ok(existsSync(fixture.versionFile));
  } finally {
    fixture.dispose();
  }
});

test("rejects a version outside the App section instead of inventing one", async () => {
  const fixture = browserFixture("[App]\n[Other]\nVersion=158.0.1-beta.41\n");
  try {
    await assert.rejects(installCamoufox(fixture.appData), /Invalid Camoufox version/);
    assert.equal(existsSync(fixture.versionFile), false);
  } finally {
    fixture.dispose();
  }
});

test("keeps a different installed Camoufox without writing metadata", async () => {
  const fixture = browserFixture("[App]\nVersion=159.0-beta.42\n");
  try {
    await assert.rejects(
      installCamoufox(fixture.appData),
      /Expected Camoufox 158\.0\.1-beta\.41, found 159\.0-beta\.42/,
    );
    assert.equal(existsSync(fixture.versionFile), false);
    assert.equal(readFileSync(fixture.executable, "utf8"), "installed browser");
  } finally {
    fixture.dispose();
  }
});

test("rejects metadata that conflicts with the installed version without overwriting it", async () => {
  const fixture = browserFixture("[App]\nVersion=158.0.1-beta.41\n");
  const installed = '{"version":"159.0","release":"beta.42"}';
  try {
    writeFileSync(fixture.versionFile, installed);
    await assert.rejects(
      installCamoufox(fixture.appData),
      /Expected Camoufox .* in .*version\.json/,
    );
    assert.equal(readFileSync(fixture.versionFile, "utf8"), installed);
  } finally {
    fixture.dispose();
  }
});

test("requests and installs the exact Windows Camoufox release", async () => {
  const appData = mkdtempSync(join(tmpdir(), "camoufox-new-install-test-"));
  const commands: string[][] = [];
  const spawn = spyOn(Bun, "spawnSync").mockImplementation((args) => {
    assert.ok(Array.isArray(args));
    commands.push(args);
    if (args[0] === "tar.exe") {
      const browser = args[4]!;
      writeFileSync(join(browser, "camoufox.exe"), "fixture browser");
      writeFileSync(join(browser, "application.ini"), "[App]\nVersion=158.0.1-beta.41\n");
    }
    return { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
  });
  try {
    await installCamoufox(appData);
    assert.equal(commands.length, 2);
    const archive = commands[0]?.at(-1);
    assert.ok(archive?.endsWith("camoufox.zip"));
    assert.deepEqual(commands[0], [...camoufoxDownload, "--output", archive]);
    assert.deepEqual(commands[1], [
      "tar.exe",
      "-xf",
      archive,
      "-C",
      join(dirname(archive!), "browser"),
    ]);
    const browser = join(appData, "Programs", "Camoufox");
    assert.equal(readFileSync(join(browser, "camoufox.exe"), "utf8"), "fixture browser");
    assert.deepEqual(JSON.parse(readFileSync(join(browser, "version.json"), "utf8")), {
      version: "158.0.1",
      release: "beta.41",
    });
  } finally {
    spawn.mockRestore();
    rmSync(appData, { recursive: true });
  }
});
