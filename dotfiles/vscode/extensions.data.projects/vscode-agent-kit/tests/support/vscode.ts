import { _electron as electron, expect, test as baseTest } from "playwright/test";
import type {
  ElectronApplication,
  Frame,
  Page,
  PlaywrightWorkerArgs,
  TestInfo,
} from "playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PiMuxWorkspace } from "../../src/piMux";
import {
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  startFixedResponseProvider,
  type FixedResponseProvider,
} from "./fixedResponseProvider";

const root = resolve(__dirname, "../..");
const dotfiles = process.env.PI_REVIEW_DOTFILES ?? join(homedir(), "projects/dotfiles/dotfiles");
const realPi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
const realFlock = execFileSync("which", ["flock"], { encoding: "utf8" }).trim();
let compiledPiMux: string | undefined;
const executablePath =
  process.env.PI_REVIEW_VSCODE ??
  join(homedir(), ".cache/agent-kit-screenshots/vscode-1.138.0/VSCode-linux-x64/code");

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
  readonly tmuxSocket = join(this.directory, "runtime/pi-tmux/server.sock");
  private readonly tmuxLock = join(this.directory, "runtime/tmux.lock");
  private readonly closedFile = join(this.directory, "runtime/closed");
  readonly env: Record<string, string> = {
    PATH: `${join(this.directory, "bin")}:${process.env.PATH ?? ""}`,
    NODE_PATH: join(homedir(), ".pi/agent/node_modules"),
    HOME: join(this.directory, "home"),
    USER: "fixture",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    DISPLAY: process.env.DISPLAY ?? "",
    XAUTHORITY: process.env.XAUTHORITY ?? "",
    XDG_RUNTIME_DIR: join(this.directory, "runtime"),
    XDG_CONFIG_HOME: join(this.directory, "home/.config"),
    XDG_CACHE_HOME: join(this.directory, "cache"),
    XDG_DATA_HOME: join(this.directory, "data"),
    PI_CODING_AGENT_DIR: join(this.directory, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(this.directory, "agent/sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_REVIEW_BASE: this.directory,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  readonly sessions: Record<string, SessionFixture> = {};
  readonly gitBefore: Record<string, string> = {};
  responseProvider?: FixedResponseProvider;
  app!: ElectronApplication;
  page!: Page;
  private traceStarted = false;
  private readonly projectDirectories = { A: "project-a", B: "worktree/project-b" };

  prepare(): void {
    this.prepareRepositories();
    this.prepareSessions();
    this.prepareHost();
    this.preparePiMux();
    for (const cwd of new Set([
      this.sessions.A.cwd,
      this.sessions.B.cwd,
      this.sessions.External.cwd,
    ])) {
      this.piMux(["workspace", "register", cwd]);
    }
  }

  piMux(args: string[]): string {
    return execFileSync(join(this.directory, "bin/pi-mux"), args, {
      env: this.env,
      encoding: "utf8",
    });
  }

  listWorkspaces(): PiMuxWorkspace[] {
    return JSON.parse(this.piMux(["list"])) as PiMuxWorkspace[];
  }

  async launch(): Promise<void> {
    if (!existsSync(executablePath))
      throw new Error(
        `VS Code 1.138.0 is required at ${executablePath}; run bun run setup once or set PI_REVIEW_VSCODE.`,
      );
    this.app = await electron.launch({
      executablePath,
      env: this.env,
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

  async close(tracePath?: string): Promise<void> {
    write(this.closedFile, "closed\n");
    try {
      if (this.app && this.traceStarted) {
        this.traceStarted = false;
        await this.app.context().tracing.stop({ path: tracePath });
      }
    } finally {
      try {
        if (this.app) await this.app.close();
      } finally {
        this.tmux(["kill-server"]);
        rmSync(this.tmuxSocket, { force: true });
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
      .getByRole("tab", { name: "Agent Kit", exact: true })
      .describe("Sessions sidebar");
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    let readyFrame: Frame | undefined;
    await expect
      .poll(async () => {
        for (const frame of this.page.frames()) {
          try {
            if (await frame.locator(".group-header").count()) {
              readyFrame = frame;
              return true;
            }
          } catch (error) {
            if (!frame.isDetached()) throw error;
          }
        }
        return false;
      })
      .toBe(true);
    return readyFrame!;
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

  setSessionPhase(key: string, phase: string | null): void {
    const runtime = this.sessionRuntime(key);
    if (runtime === undefined) throw new Error(`Pi-mux runtime not found for session ${key}`);
    const option = JSON.stringify({ version: 1, sessionId: this.sessions[key].id, state: phase });
    const args = ["set-option", "-p", "-t", runtime.target];
    if (phase === null) {
      this.tmux([...args, "-u", "@pi_session_state"]);
      return;
    }
    this.tmux([...args, "@pi_session_state", option]);
  }

  async activateSession(key: string): Promise<void> {
    const frame = await this.sessionFrame();
    const session = this.sessions[key];
    const mode = frame
      .locator(`[data-mode-toggle="${session.cwd}"]`)
      .describe(`${key} workspace All toggle`);
    if ((await mode.getAttribute("data-mode")) === "unarchived") await mode.click();
    const row = frame
      .locator(".session-row")
      .filter({ has: frame.locator(`[data-session="${session.id}"]`) })
      .describe(`${key} conversation`);
    await expect(row).toBeVisible();
    const unarchive = row
      .locator(`[data-unarchive="${session.id}"]`)
      .describe(`${key} explicit normal open`);
    if (await unarchive.count()) await unarchive.click({ steps: 15 });
    await expect(row).not.toHaveClass(/archived/);
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
    await expect
      .poll(() => this.sessionRuntime(key), { message: `Live Pi runtime for ${key}` })
      .toBeDefined();
    const runtime = this.sessionRuntime(key)!;
    await this.expectPiVisible(cwd);
    await expect
      .poll(() => {
        const display = this.snapshot().terminals.find((terminal) => terminal.owned);
        return this.displayClient(display?.pid)?.target === runtime.target;
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
    await expect(tab.locator(".label-description")).toHaveText("~");
    const display = this.snapshot().terminals.find((terminal) => terminal.owned)!;
    expect(readlinkSync(`/proc/${display.pid}/cwd`)).toBe(join(this.directory, "home"));
    if (existsSync(this.sessions[key].session)) {
      const frame = await this.sessionFrame();
      await expect(
        frame
          .locator(`.session-row.selected [data-session="${this.sessions[key].id}"]`)
          .describe("Selected connected conversation"),
      ).toBeVisible();
      await expect(
        frame
          .getByText("Refreshing sessions…", { exact: true })
          .describe("Pending session refresh"),
      ).toHaveCount(0);
    }
    return paneTitle;
  }

  sessionRuntime(key: string) {
    const { id, cwd } = this.sessions[key];
    return this.piProcesses().find((entry) => {
      const encoded = this.tmux([
        "display-message",
        "-p",
        "-t",
        entry.target,
        "#{@pi-tmux-session}",
      ]).trim();
      return (
        entry.cwd === cwd &&
        encoded !== "" &&
        JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).id === id
      );
    });
  }

  displayClient(pid: number | undefined): { pid: number; target: string } | undefined {
    return this.tmux(["list-clients", "-F", "#{client_pid}\t#{session_name}"])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [clientPid, target] = line.split("\t");
        return { pid: Number(clientPid), target };
      })
      .find((client) => {
        if (client.pid === pid) return true;
        try {
          const status = readFileSync(`/proc/${client.pid}/status`, "utf8");
          return Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) === pid;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
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
    const stopping = args[0] === "kill-server";
    const command = stopping ? realFlock : join(this.directory, "bin/tmux");
    const prefix = stopping ? ["--exclusive", "--close", this.tmuxLock, realTmux, "-N"] : [];
    const result = spawnSync(
      command,
      [...prefix, "-S", this.tmuxSocket, "-f", "/dev/null", ...args],
      {
        encoding: "utf8",
        env: this.env,
      },
    );
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout;
    if (
      /no server running|error connecting to .*No such file or directory|no current target|no sessions/.test(
        result.stderr,
      )
    )
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
        // With PI_CODING_AGENT_SESSION_DIR set, pi-mux history lists only the
        // *.jsonl files directly inside the session directory. Fixture files
        // must therefore sit directly in it, not in group subdirectories.
        `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
      );
      write(session, original);
      this.sessions[key] = { id, cwd, session, original };
    }
    const newestBTime = new Date(statSync(this.sessions.B.session).mtimeMs + 1000);
    utimesSync(this.sessions.B.session, newestBTime, newestBTime);
    write(join(this.directory, "fixtures.json"), JSON.stringify(this.sessions, null, 2));
  }

  private preparePiMux(): void {
    const source = join(dotfiles, ".local/cli.exact/pi-mux/src/main.ts");
    if (compiledPiMux === undefined) {
      const buildDirectory = fixtureDirectory();
      compiledPiMux = join(buildDirectory, "pi-mux");
      execFileSync("bun", ["build", "--compile", source, "--outfile", compiledPiMux]);
    }
    for (const directory of [
      "bin",
      "runtime",
      "home/.config/tmux",
      "agent/extensions/pi-mux-bridge",
      "agent/extensions/tools",
    ]) {
      mkdirSync(join(this.directory, directory), { recursive: true, mode: 0o700 });
    }
    symlinkSync(compiledPiMux, join(this.directory, "bin/pi-mux"));
    symlinkSync(realPi, join(this.directory, "bin/pi"));
    write(
      join(this.directory, "bin/tmux"),
      `#!/bin/sh
if [ "$1" != -S ] || [ "$2" != '${this.tmuxSocket}' ]; then
  echo 'Fixture rejected non-isolated tmux command' >&2
  exit 64
fi
for arg do
  case "$arg" in
    start-server|start|new-session|new)
      exec '${realFlock}' --exclusive --close '${this.tmuxLock}' /bin/sh -c '
        if [ -e "$1" ]; then
          echo "Fixture tmux environment is closed" >&2
          exit 64
        fi
        shift
        exec "$@"
      ' sh '${this.closedFile}' '${realTmux}' "$@"
      ;;
  esac
done
exec '${realTmux}' -N "$@"
`,
    );
    chmodSync(join(this.directory, "bin/tmux"), 0o700);
    copyFileSync(join(dotfiles, "tmux/pi.conf"), join(this.directory, "home/.config/tmux/pi.conf"));
    const agentSource = join(dotfiles, ".pi/agent");
    for (const name of ["index.ts", "shared.ts"])
      copyFileSync(
        join(agentSource, "extensions.exact/pi-mux-bridge", name),
        join(this.directory, "agent/extensions/pi-mux-bridge", name),
      );
    copyFileSync(
      join(agentSource, "extensions.exact/tools/background-bash.ts"),
      join(this.directory, "agent/extensions/tools/background-bash.ts"),
    );
    const sourceModules = join(agentSource, "node_modules");
    const installedModules = join(homedir(), ".pi/agent/node_modules");
    symlinkSync(
      existsSync(sourceModules) ? sourceModules : installedModules,
      join(this.directory, "agent/node_modules"),
    );
    const guardrails = join(this.directory, "guardrails.yaml");
    write(
      guardrails,
      `read:\n  - allow: "*"\nwrite:\n  - allow: ${JSON.stringify(this.directory)}\ncommands:\n  - ".*":\n      - allow: []\n`,
    );
    write(
      join(this.directory, "agent/extensions/fixture-tools.ts"),
      `import tools from ${JSON.stringify(join(agentSource, "extensions.exact/tools/index.ts"))};\nexport default function (pi) { tools(pi, ${JSON.stringify(guardrails)}); }\n`,
    );
    write(
      join(this.directory, "agent/settings.json"),
      JSON.stringify({
        quietStartup: true,
        defaultProjectTrust: "never",
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    write(
      join(this.directory, "pi-mux-fixture.json"),
      JSON.stringify(
        { source, binary: compiledPiMux, realPi, realTmux, socket: this.tmuxSocket, env: this.env },
        null,
        2,
      ),
    );
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
      "terminal.integrated.confirmOnKill": "never",
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
  const parent = "/tmp/work/vscode-agent-kit/tmux-runtime";
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "fixture-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export const test = baseTest.extend<{ host: VSCodeFixture; fixedResponse: boolean }>({
  fixedResponse: [false, { option: true }],
  host: provideVSCodeFixture,
});

export async function provideVSCodeFixture(
  {
    playwright,
    fixedResponse,
  }: Pick<PlaywrightWorkerArgs, "playwright"> & { fixedResponse: boolean },
  use: (host: VSCodeFixture) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  void playwright;
  const host = new VSCodeFixture();
  let tracePath: string | undefined;
  let failed = false;
  try {
    host.prepare();
    tracePath = testInfo.outputPath("electron-trace.zip");
    if (fixedResponse) {
      host.responseProvider = await startFixedResponseProvider();
      const settingsPath = join(host.directory, "agent/settings.json");
      write(
        settingsPath,
        JSON.stringify({
          ...JSON.parse(readFileSync(settingsPath, "utf8")),
          defaultProvider: FIXTURE_PROVIDER,
          defaultModel: FIXTURE_MODEL,
        }),
      );
      write(
        join(host.directory, "agent/models.json"),
        JSON.stringify({
          providers: {
            [FIXTURE_PROVIDER]: {
              baseUrl: host.responseProvider.baseUrl,
              api: "openai-completions",
              apiKey: "fixture-not-a-secret",
              models: [{ id: FIXTURE_MODEL, contextWindow: 128000, maxTokens: 1024 }],
            },
          },
        }),
      );
    }
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
    expect(host.tmux(["-V"]).trim()).toBe("tmux 3.8");
    await use(host);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      try {
        await testInfo.attach("fixture and public API observation", {
          body: JSON.stringify(
            {
              directory: host.directory,
              piMux: JSON.parse(readFileSync(join(host.directory, "pi-mux-fixture.json"), "utf8")),
              sessions: host.sessions,
              snapshot: host.snapshot(),
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      } finally {
        try {
          await host.close(tracePath);
        } finally {
          await host.responseProvider?.close();
        }
      }
      if (tracePath !== undefined && existsSync(tracePath))
        await testInfo.attach("trace", {
          path: tracePath,
          contentType: "application/zip",
        });
    } catch (error) {
      if (!failed) throw error;
      console.error("Fixture teardown also failed:", error);
    }
  }
}

export { expect };
