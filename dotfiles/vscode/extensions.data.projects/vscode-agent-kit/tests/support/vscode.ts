import { _electron as electron, expect, test as baseTest } from "playwright/test";
import type { ElectronApplication, Frame, Page } from "playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { tmuxSocketName } from "../../src/tmux";
import { encodeCwdDirName } from "../../src/paths";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(__dirname, "../..");
const executablePath =
  process.env.PI_REVIEW_VSCODE ??
  join(homedir(), ".cache/pi-sessions-screenshots/vscode-1.138.0/VSCode-linux-x64/code");

interface SessionFixture {
  id: string;
  cwd: string;
  session: string;
  original: string;
}

export interface Snapshot {
  hostPid: number;
  maxOwnedDisplays: number;
  maxTerminalTabs: number;
  folders: string[];
  activeEditor?: string;
  terminals: {
    name: string;
    pid: number;
    exit?: unknown;
    owned: boolean;
    options?: { name?: string };
  }[];
  tabs: {
    label: string;
    active: boolean;
    terminal: boolean;
    uri?: string;
    original?: string;
    modified?: string;
  }[];
}

export class VSCodeFixture {
  readonly directory = fixtureDirectory();
  readonly tmuxSocket = tmuxSocketName(
    join(this.directory, "agent"),
    join(this.directory, "agent/sessions"),
  );
  readonly sessions: Record<string, SessionFixture> = {};
  readonly gitBefore: Record<string, string> = {};
  app!: ElectronApplication;
  page!: Page;
  private traceStarted = false;
  private readonly projectDirectories = { A: "project-a", B: "worktree/project-b" };

  constructor() {
    this.prepareRepositories();
    this.prepareSessions();
    this.prepareHost();
  }

  async launch(): Promise<void> {
    if (!existsSync(executablePath))
      throw new Error(
        `VS Code 1.138.0 is required at ${executablePath}; run bun run setup once or set PI_REVIEW_VSCODE.`,
      );
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(this.directory, "home"),
      USER: "fixture",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      TMUX_TMPDIR: process.env.TMUX_TMPDIR ?? "/tmp",
      DISPLAY: process.env.DISPLAY ?? "",
      XAUTHORITY: process.env.XAUTHORITY ?? "",
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
      XDG_CONFIG_HOME: join(this.directory, "config"),
      PI_CODING_AGENT_DIR: join(this.directory, "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(this.directory, "agent/sessions"),
      PI_REVIEW_BASE: this.directory,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    this.app = await electron.launch({
      executablePath,
      env,
      args: [
        "--no-sandbox",
        `--extensionDevelopmentPath=${root}`,
        `--user-data-dir=${join(this.directory, "userdata")}`,
        `--extensions-dir=${join(this.directory, "extensions")}`,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--new-window",
        "--window-size=1600,1000",
        join(this.directory, "fixture.code-workspace"),
      ],
      timeout: 30_000,
    });
    await this.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.traceStarted = true;
    this.page = await this.app.firstWindow();
    await this.page.locator(".monaco-workbench").waitFor();
    await expect.poll(() => this.snapshot().hostPid).toBeGreaterThan(0);
  }

  async close(tracePath: string): Promise<void> {
    try {
      if (this.app && this.traceStarted) await this.app.context().tracing.stop({ path: tracePath });
    } finally {
      try {
        if (this.app) await this.app.close();
      } finally {
        this.tmux(["kill-server"]);
      }
    }
  }

  snapshot(): Snapshot {
    const file = join(this.directory, "snapshot.json");
    if (!existsSync(file))
      return {
        hostPid: 0,
        maxOwnedDisplays: 0,
        maxTerminalTabs: 0,
        folders: [],
        terminals: [],
        tabs: [],
      };
    return JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  }

  async sessionFrame(): Promise<Frame> {
    const tab = this.page
      .getByRole("tab", { name: "Pi Sessions", exact: true })
      .describe("Sessions sidebar");
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await expect
      .poll(async () => {
        for (const frame of this.page.frames()) {
          if (await frame.locator(".group-header").count()) return true;
        }
        return false;
      })
      .toBe(true);
    const frames = this.page.frames();
    for (const frame of frames) {
      if (await frame.locator(".group-header").count()) return frame;
    }
    throw new Error("Sessions webview did not become ready");
  }

  async refreshSessions(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Refresh Sessions", exact: true })
      .describe("Native Sessions title refresh")
      .click();
  }

  async selectSession(key: string): Promise<void> {
    const frame = await this.sessionFrame();
    const session = this.sessions[key];
    const row = frame.locator(`[data-session="${session.id}"]`).describe(`${key} saved session`);
    const modeToggle = frame
      .locator(`[data-mode-toggle="${session.cwd}"]`)
      .describe(`${key} workspace All toggle`);
    if ((await modeToggle.getAttribute("data-mode")) === "unarchived")
      await modeToggle.click({ steps: 15 });
    await row.locator(".session-name").describe(`${key} session name`).click({ steps: 15 });
  }

  /** Add a fixture session to its workspace's active-sessions map and reload
   * the list. The shared display stops a still-archived previous display
   * when it moves away, so tests that keep a fixture Pi alive across a
   * switch must make that fixture active first. */
  async activateSession(key: string): Promise<void> {
    const statePath = join(this.directory, "agent/session-state.json");
    const store = JSON.parse(readFileSync(statePath, "utf8")) as {
      "active-workspaces": Record<string, { "active-sessions"?: Record<string, unknown> }>;
    };
    const session = this.sessions[key];
    const workspace = store["active-workspaces"][session.cwd];
    if (workspace === undefined) throw new Error(`workspace is not registered: ${session.cwd}`);
    workspace["active-sessions"] ??= {};
    workspace["active-sessions"][session.id] = {};
    writeFileSync(statePath, JSON.stringify(store));
    await this.refreshSessions();
  }

  async expectPiVisible(cwd?: string): Promise<void> {
    if (cwd !== undefined) {
      await expect
        .poll(() => {
          const targets = this.tmux(["list-clients", "-F", "#{session_name}"]).trim().split("\n");
          return this.piProcesses().some(
            (entry) => entry.cwd === cwd && targets.includes(entry.target),
          );
        })
        .toBe(true);
    }
    await expect
      .poll(() => this.snapshot().tabs.some((tab) => tab.terminal && tab.active))
      .toBe(true);
    const input = this.page
      .getByRole("textbox", { name: /^Terminal [0-9]+/ })
      .describe("Shared Pi TUI input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect
      .poll(() => this.snapshot().terminals.filter((terminal) => terminal.owned))
      .toHaveLength(1);
    await expect.poll(() => this.snapshot().tabs.filter((tab) => tab.terminal)).toHaveLength(1);
    expect(this.snapshot().maxOwnedDisplays).toBe(1);
    expect(this.snapshot().maxTerminalTabs).toBe(1);
  }

  async expectNativeDisplay(key: string): Promise<string> {
    const { cwd } = this.sessions[key];
    await expect.poll(() => this.sessionRuntime(key)).toBeDefined();
    const runtime = this.sessionRuntime(key)!;
    await this.expectPiVisible(cwd);
    await expect
      .poll(() => {
        const display = this.snapshot().terminals.find((terminal) => terminal.owned);
        return this.tmux(["list-clients", "-F", "#{client_pid}\t#{session_name}"])
          .trim()
          .split("\n")
          .includes(`${display?.pid}\t${runtime.target}`);
      })
      .toBe(true);
    await expect
      .poll(() =>
        this.tmux(["display-message", "-p", "-t", runtime.target, "#{pane_title}"]).trim(),
      )
      .toContain(`Fixture ${key}`);
    const paneTitle = this.tmux([
      "display-message",
      "-p",
      "-t",
      runtime.target,
      "#{pane_title}",
    ]).trim();
    await expect
      .poll(() =>
        this.snapshot()
          .terminals.filter((terminal) => terminal.owned)
          .map(({ name }) => name),
      )
      .toEqual([paneTitle]);
    await expect
      .poll(() =>
        this.snapshot()
          .tabs.filter((tab) => tab.terminal)
          .map(({ label, active }) => ({ label, active })),
      )
      .toEqual([{ label: paneTitle, active: true }]);
    const tab = this.page.locator(".tabs-container [role=tab]").describe("Native Pi display tab");
    await expect(tab.locator(".label-name")).toHaveText(paneTitle);
    await expect(tab.locator(".label-description")).toHaveText(basename(cwd));
    const display = this.snapshot().terminals.find((terminal) => terminal.owned)!;
    expect(readlinkSync(`/proc/${display.pid}/cwd`)).toBe(cwd);
    return paneTitle;
  }

  sessionRuntime(key: string) {
    const { cwd, session } = this.sessions[key];
    return this.piProcesses().find(
      (entry) =>
        entry.cwd === cwd &&
        this.tmux(["display-message", "-p", "-t", entry.target, "#{pane_start_command}"]).trim() ===
          `pi --session ${session}`,
    );
  }

  async restartExtensionHost(): Promise<void> {
    const previousPid = this.snapshot().hostPid;
    await this.page.keyboard.press("F1");
    const command = this.page.locator(".quick-input-widget input").describe("Command palette");
    await command.fill(">Developer: Restart Extension Host");
    await command.press("Enter");
    await expect.poll(() => this.snapshot().hostPid).not.toBe(previousPid);
  }

  async openLegacyDisplay(key: string): Promise<void> {
    const runtime = this.sessionRuntime(key)!;
    await this.closePiDisplay();
    write(
      join(this.directory, "legacy-display.json"),
      JSON.stringify({ socketName: this.tmuxSocket, target: runtime.target, cwd: runtime.cwd }),
    );
    await this.page.keyboard.press("F1");
    const command = this.page
      .locator(".quick-input-widget input")
      .describe("Legacy display fixture command");
    await command.fill(">Fixture: Open Legacy Pi Display");
    await command.press("Enter");
    await this.expectPiVisible(runtime.cwd);
    await expect
      .poll(() =>
        this.snapshot()
          .terminals.filter((terminal) => terminal.owned)
          .map((terminal) => terminal.options?.name),
      )
      .toEqual(["Pi"]);
    await expect(this.page.locator(".tabs-container [role=tab] .label-name")).toHaveText("Pi");
  }

  async closePiDisplay(): Promise<void> {
    const label = this.snapshot().tabs.find((tab) => tab.terminal && tab.active)!.label;
    await this.page
      .getByRole("tab", { name: label, exact: true })
      .getByRole("button", { name: "Close (Ctrl+W)", exact: true })
      .describe("Close only the shared Pi display")
      .click();
    await expect
      .poll(() => this.snapshot().terminals.filter((terminal) => terminal.owned))
      .toHaveLength(0);
    await expect.poll(() => this.snapshot().tabs.filter((tab) => tab.terminal)).toHaveLength(0);
  }

  piProcesses(): { pid: number; cwd: string; command: string; target: string }[] {
    const panes = this.tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{pane_pid}\t#{pane_dead}",
    ])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [target, pid, dead] = line.split("\t");
        return { target, pid: Number(pid), dead: dead === "1" };
      })
      .filter((pane) => !pane.dead);
    if (panes.length === 0) return [];
    const processes = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        return match
          ? [
              {
                pid: Number(match[1]),
                parent: Number(match[2]),
                executable: match[3],
                command: match[4],
              },
            ]
          : [];
      });
    return panes.flatMap((pane) => {
      const descendants = new Set([pane.pid]);
      let previousSize = 0;
      while (previousSize !== descendants.size) {
        previousSize = descendants.size;
        for (const entry of processes)
          if (descendants.has(entry.parent)) descendants.add(entry.pid);
      }
      return processes
        .filter(
          (entry) =>
            descendants.has(entry.pid) &&
            (entry.executable === "pi" ||
              (/^(node|bun)$/.test(entry.executable) &&
                /(?:^|\s|\/)pi(?:\s|$)|pi-coding-agent\/.*cli/.test(entry.command))),
        )
        .flatMap((entry) => {
          try {
            return [
              {
                pid: entry.pid,
                cwd: readlinkSync(`/proc/${entry.pid}/cwd`),
                command: entry.command,
                target: pane.target,
              },
            ];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        });
    });
  }

  tmux(args: string[]): string {
    const result = spawnSync("tmux", ["-L", this.tmuxSocket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout;
    if (/no server running|error connecting to .*No such file or directory/.test(result.stderr))
      return "";
    throw new Error(`Fixture tmux ${args.join(" ")} failed: ${result.stderr}`);
  }

  gitState(cwd: string): string {
    return (
      this.git(cwd, ["status", "--porcelain=v1"]) +
      "\n" +
      this.git(cwd, ["diff", "--binary"]) +
      "\n" +
      this.git(cwd, ["ls-files", "--stage"])
    );
  }

  private prepareRepositories(): void {
    mkdirSync(join(this.directory, "home"), { recursive: true });
    const main = join(this.directory, this.projectDirectories.A);
    mkdirSync(main);
    this.git(main, ["init", "-b", "fixture-a"]);
    write(join(main, "same.txt"), "BASE\n");
    write(join(main, "z-preferred.txt"), "BASE preferred\n");
    const files = ["same.txt", "z-preferred.txt"]
      .map((name) => {
        const blob = this.git(main, ["hash-object", "-w", name]);
        return `100644 blob ${blob}\t${name}\n`;
      })
      .sort()
      .join("");
    const tree = this.git(main, ["mktree"], files);
    const commit = this.git(main, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit-tree",
      tree,
      "-m",
      "Fixture",
    ]);
    this.git(main, ["update-ref", "refs/heads/fixture-a", commit]);
    this.git(main, ["read-tree", commit]);
    const worktree = join(this.directory, this.projectDirectories.B);
    this.git(main, ["worktree", "add", "-b", "fixture-b", worktree]);
    const external = join(this.directory, "external");
    this.git(main, ["worktree", "add", "-b", "fixture-external", external]);
    for (const [key, cwd] of [
      ["A", main],
      ["B", worktree],
      ["External", external],
    ]) {
      write(join(cwd, "same.txt"), `${key} changed\n`);
      write(join(cwd, "z-preferred.txt"), `${key} preferred\n`);
      this.gitBefore[cwd] = this.gitState(cwd);
    }
    mkdirSync(join(this.directory, "other"));
  }

  private prepareSessions(): void {
    const store = {
      sentinel: "preserved",
      "active-workspaces": {} as Record<string, { "active-sessions"?: Record<string, unknown> }>,
    };
    const activeByCwd = new Map<string, string[]>();
    const cwds = {
      A: this.projectDirectories.A,
      External: "external",
      Missing: "missing",
      Deleted: this.projectDirectories.A,
      B: this.projectDirectories.B,
    };
    for (const [key, relativeCwd] of Object.entries(cwds)) {
      const id = randomUUID();
      const cwd = join(this.directory, relativeCwd);
      const timestamp = "2026-10-22T00:00:00.000Z";
      const original =
        [
          { type: "session", version: 3, id, timestamp, cwd },
          {
            type: "session_info",
            id: randomUUID().slice(0, 8),
            parentId: null,
            timestamp,
            name: `Fixture ${key}`,
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n";
      const session = join(
        this.directory,
        "agent/sessions",
        // pi stores each session inside the cwd group directory its header cwd maps to
        encodeCwdDirName(cwd),
        `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
      );
      write(session, original);
      this.sessions[key] = { id, cwd, session, original };
      if (key !== "B") {
        // B starts archived: absent from the active-sessions map. Every other
        // fixture session is a member of its workspace.
        const active = activeByCwd.get(cwd) ?? [];
        active.push(id);
        activeByCwd.set(cwd, active);
      }
    }
    // The sidebar lists registered workspaces only (the extension's own
    // settings), so the fixture work folders must be registered or their
    // groups stay hidden. The "missing" cwd of the Missing fixture stays
    // unregistered on purpose.
    for (const folder of [this.projectDirectories.A, this.projectDirectories.B, "external"]) {
      const cwd = join(this.directory, folder);
      const active = activeByCwd.get(cwd) ?? [];
      const activeSessions: Record<string, unknown> = {};
      for (const id of active) activeSessions[id] = {};
      store["active-workspaces"][cwd] = { "active-sessions": activeSessions };
    }
    const newestBTime = new Date(statSync(this.sessions.B.session).mtimeMs + 1000);
    utimesSync(this.sessions.B.session, newestBTime, newestBTime);
    write(join(this.directory, "agent/session-state.json"), JSON.stringify(store));
    write(join(this.directory, "fixtures.json"), JSON.stringify(this.sessions, null, 2));
  }

  private prepareHost(): void {
    const settings = {
      "workbench.startupEditor": "none",
      "update.mode": "none",
      "telemetry.telemetryLevel": "off",
      "extensions.ignoreRecommendations": true,
      "security.workspace.trust.enabled": false,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "git.openRepositoryInParentFolders": "never",
      "git.detectSubmodules": false,
      "files.simpleDialog.enable": true,
      "terminal.integrated.profiles.linux": {
        fixture: { path: "/bin/bash", args: ["--noprofile", "--norc"] },
      },
      "terminal.integrated.defaultProfile.linux": "fixture",
      "terminal.integrated.shellIntegration.enabled": false,
      "terminal.integrated.tabs.title": "${sequence}",
    };
    write(join(this.directory, "userdata/User/settings.json"), JSON.stringify(settings));
    write(
      join(this.directory, "fixture.code-workspace"),
      JSON.stringify({
        folders: [{ path: this.sessions.A.cwd }, { path: this.sessions.B.cwd }],
      }),
    );
    const probe = join(this.directory, "extensions/fixture.probe-0.0.1");
    write(
      join(probe, "package.json"),
      JSON.stringify({
        name: "probe",
        publisher: "fixture",
        version: "0.0.1",
        engines: { vscode: "^1.85.0" },
        main: "index.cjs",
        activationEvents: ["onStartupFinished"],
        contributes: {
          commands: [
            { command: "fixture.openLegacyDisplay", title: "Fixture: Open Legacy Pi Display" },
          ],
        },
      }),
    );
    copyFileSync(join(root, "tests/support/probe.cjs"), join(probe, "index.cjs"));
  }

  private git(cwd: string, args: string[], input?: string): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      input,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: join(this.directory, "home"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  }
}

function fixtureDirectory(): string {
  const parent = "/tmp/work/vscode-pi-sessions/tmux-runtime";
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "fixture-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export const test = baseTest.extend<{ host: VSCodeFixture }>({
  host: async ({ playwright }, use, testInfo) => {
    void playwright;
    const host = new VSCodeFixture();
    const tracePath = testInfo.outputPath("electron-trace.zip");
    try {
      await host.launch();
      await test.step("Check the A/B work folder paths and names", async () => {
        const frame = await host.sessionFrame();
        for (const key of ["A", "B"]) {
          const expectedName = key === "A" ? "project-a" : "project-b";
          const relativeDirectory = key === "A" ? expectedName : join("worktree", expectedName);
          expect(host.sessions[key].cwd).toBe(join(host.directory, relativeDirectory));
          await expect(
            frame
              .getByTitle(host.sessions[key].cwd, { exact: true })
              .locator(".group-title")
              .describe(`${key} work folder name`),
          ).toHaveText(expectedName);
        }
      });
      await use(host);
    } finally {
      await testInfo.attach("fixture and public API observation", {
        body: JSON.stringify(
          {
            directory: host.directory,
            sessions: host.sessions,
            snapshot: host.snapshot(),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await host.close(tracePath);
      if (existsSync(tracePath))
        await testInfo.attach("trace", {
          path: tracePath,
          contentType: "application/zip",
        });
    }
  },
});

export { expect };
