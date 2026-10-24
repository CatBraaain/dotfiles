import {
  _electron as electron,
  expect,
  test as baseTest,
} from "playwright/test";
import type { ElectronApplication, Frame, Page } from "playwright/test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(__dirname, "../..");
const executablePath =
  process.env.PI_REVIEW_VSCODE ??
  join(
    homedir(),
    ".cache/pi-sessions-screenshots/vscode-1.138.0/VSCode-linux-x64/code",
  );

interface SessionFixture {
  id: string;
  cwd: string;
  session: string;
  original: string;
}

export interface Snapshot {
  hostPid: number;
  folders: string[];
  activeEditor?: string;
  terminals: { name: string; pid: number; exit?: unknown }[];
  tabs: {
    label: string;
    active: boolean;
    uri?: string;
    original?: string;
    modified?: string;
  }[];
  repositories: { root: string; selected: boolean }[];
}

export class VSCodeFixture {
  readonly directory = mkdtempSync(join(tmpdir(), "pi-sessions-review-"));
  readonly sessions: Record<string, SessionFixture> = {};
  readonly gitBefore: Record<string, string> = {};
  app!: ElectronApplication;
  page!: Page;
  private traceStarted = false;

  constructor() {
    this.prepareRepositories();
    this.prepareSessions();
    this.prepareHost();
  }

  async launch(singleRoot = false): Promise<void> {
    if (!existsSync(executablePath))
      throw new Error(
        `VS Code 1.138.0 is required at ${executablePath}; run bun run screenshot once or set PI_REVIEW_VSCODE.`,
      );
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(this.directory, "home"),
      USER: "fixture",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
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
        singleRoot
          ? this.sessions.A.cwd
          : join(this.directory, "fixture.code-workspace"),
      ],
      timeout: 30_000,
    });
    await this.app
      .context()
      .tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.traceStarted = true;
    this.page = await this.app.firstWindow();
    await this.page.locator(".monaco-workbench").waitFor();
    await expect.poll(() => this.snapshot().hostPid).toBeGreaterThan(0);
    await expect
      .poll(() => this.snapshot().repositories.length, { timeout: 30_000 })
      .toBeGreaterThan(0);
  }

  async close(tracePath: string): Promise<void> {
    if (!this.app) return;
    try {
      if (this.traceStarted)
        await this.app.context().tracing.stop({ path: tracePath });
    } finally {
      await this.app.close();
    }
  }

  snapshot(): Snapshot {
    const file = join(this.directory, "snapshot.json");
    if (!existsSync(file))
      return {
        hostPid: 0,
        folders: [],
        terminals: [],
        tabs: [],
        repositories: [],
      };
    return JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  }

  async command(title: string): Promise<void> {
    await this.page.keyboard.press("Escape");
    await this.page.keyboard.press("Control+Shift+P");
    const input = this.page
      .locator(".quick-input-widget input")
      .describe("Command Palette");
    await input.pressSequentially(title, { delay: 120 });
    await this.page.keyboard.press("Enter");
  }

  async sessionFrame(): Promise<Frame> {
    await this.command("View: Show Agent Sessions");
    await expect
      .poll(async () => {
        for (const frame of this.page.frames()) {
          if (await frame.locator(".group-path").count()) return true;
        }
        return false;
      })
      .toBe(true);
    const frames = this.page.frames();
    for (const frame of frames) {
      if (await frame.locator(".group-path").count()) return frame;
    }
    throw new Error("Sessions webview did not become ready");
  }

  async selectSession(key: string): Promise<void> {
    const frame = await this.sessionFrame();
    const session = this.sessions[key];
    const group = frame
      .locator("section.group")
      .filter({ has: frame.getByText(session.cwd, { exact: true }) })
      .describe(`${key} work folder`);
    const row = frame
      .locator(`[data-session="${session.id}"]`)
      .describe(`${key} saved session`);
    if (!(await row.count()))
      await group
        .locator('[data-mode="all"]')
        .describe("All saved sessions")
        .click({ steps: 15 });
    await row
      .locator(".session-name")
      .describe(`${key} session name`)
      .click({ steps: 15 });
  }

  async expectDiff(key: string, name = "same.txt"): Promise<void> {
    const expectedPath = join(this.sessions[key].cwd, name);
    await expect
      .poll(
        () =>
          this.snapshot().tabs.some(
            (tab) =>
              tab.active &&
              tab.modified === `file://${expectedPath}` &&
              tab.original?.startsWith("git:"),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(() => this.snapshot().activeEditor)
      .toBe(`file://${expectedPath}`);
  }

  piProcesses(): { pid: number; cwd: string; command: string }[] {
    const processes = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return match
          ? {
              pid: Number(match[1]),
              parent: Number(match[2]),
              command: match[3],
            }
          : undefined;
      })
      .filter((entry) => entry !== undefined);
    const descendants = new Set(
      this.snapshot().terminals.map((terminal) => terminal.pid),
    );
    for (let depth = 0; depth < 8; depth++) {
      for (const entry of processes) {
        if (descendants.has(entry.parent)) descendants.add(entry.pid);
      }
    }
    return processes
      .filter(
        (entry) => descendants.has(entry.pid) && /\bpi\b/.test(entry.command),
      )
      .map((entry) => ({
        pid: entry.pid,
        command: entry.command,
        cwd: readlinkSync(`/proc/${entry.pid}/cwd`),
      }));
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
    const main = join(this.directory, "project");
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
    const worktree = join(this.directory, "worktree/project");
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
    const metadata = {
      version: 1,
      sentinel: "preserved",
      sessions: {} as Record<string, { active: boolean; sentinel: string }>,
    };
    const cwds = {
      A: "project",
      B: "worktree/project",
      External: "external",
      Missing: "missing",
      Deleted: "project",
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
        key,
        `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
      );
      write(session, original);
      this.sessions[key] = { id, cwd, session, original };
      metadata.sessions[id] = { active: key !== "B", sentinel: "preserved" };
    }
    write(
      join(this.directory, "agent/session-metadata.json"),
      JSON.stringify(metadata),
    );
    write(
      join(this.directory, "fixtures.json"),
      JSON.stringify(this.sessions, null, 2),
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
    };
    write(
      join(this.directory, "userdata/User/settings.json"),
      JSON.stringify(settings),
    );
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
      }),
    );
    copyFileSync(
      join(root, "tests/support/probe.cjs"),
      join(probe, "index.cjs"),
    );
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
      await host.launch(testInfo.tags.includes("@single-root"));
      await use(host);
    } finally {
      if (host.page && !host.page.isClosed())
        await testInfo.attach("VS Code final screen", {
          body: await host.page.screenshot(),
          contentType: "image/png",
        });
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
