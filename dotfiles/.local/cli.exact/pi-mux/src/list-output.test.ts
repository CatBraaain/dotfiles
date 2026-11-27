import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxConfig } from "./configuration";
import { HistorySummaryCache } from "./history-summary";
import { mergeSessionLists, renderTable } from "./list-output";
import { PANE_FORMAT } from "./pane-inventory";
import { platform } from "./platform";
import type { HistoryEntry } from "./saved-sessions";
import { listWorkspaces, type ListedWorkspace } from "./session-list";

const cwd = "/workspace";

describe("Windows active list", () => {
  it("reads both pane-local options without changing the list in at most 21 launches for ten panes", async () => {
    await withWindowsListFixture(async ({ config, sessions, launchCount }) => {
      const workspaces = await listWorkspaces(config, new HistorySummaryCache());
      assert.deepEqual(workspaces, [{ cwd: config.stateDirectory, sessions, empty: [] }]);
      assert.ok(launchCount() <= 21, `psmux launches: ${launchCount()}`);
    });
  });

  it("reports a failed pane option query instead of returning a partial list", async () => {
    await withWindowsListFixture(async ({ config }) => {
      await assert.rejects(
        listWorkspaces(config, new HistorySummaryCache()),
        /tmux show-options failed: can't find pane/,
      );
    }, "error");
  });

  it("rejects a successful exit after only the first pane option reply", async () => {
    await withWindowsListFixture(async ({ config }) => {
      await assert.rejects(
        listWorkspaces(config, new HistorySummaryCache()),
        /tmux show-options failed: incomplete pane option response/,
      );
    }, "truncated");
  });
});

async function withWindowsListFixture(
  check: (fixture: {
    config: TmuxConfig;
    sessions: ListedWorkspace["sessions"];
    launchCount: () => number;
  }) => Promise<void>,
  queryFailure?: "error" | "truncated",
) {
  const root = mkdtempSync(join(tmpdir(), "pi-mux-windows-list-"));
  const config: TmuxConfig = {
    tmux: "psmux-fixture",
    agentDir: root,
    stateDirectory: root,
    directory: root,
    extension: join(root, "index.ts"),
    tmuxConfig: join(root, "pi.conf"),
    env: {},
    socket: join(root, "server.sock"),
  };
  const metadataOption = "@pi_session_state";
  const pendingOption = "@pi_session_state_pending";
  const completionMarker = "pi-mux-pane-options-complete";
  const panes = Array.from({ length: 10 }, (_, index) => {
    const id = `session-${index}`;
    const file = join(root, `${id}.jsonl`);
    writeFileSync(file, '{"type":"session_info","name":"Saved title"}\n');
    const title = `  "引用" 'quotes'\t#{pane_id} %Y\n${completionMarker}\n${index}  `;
    const state = { version: 1, sessionId: id, state: "running" as const, title };
    const publishPending = { attemptAt: index + 1 };
    const values = new Map([
      ...(index === 0 ? [] : [[metadataOption, JSON.stringify(state)] as const]),
      [
        pendingOption,
        index === 1 ? "" : JSON.stringify({ version: 1, sessionId: id, ...publishPending }),
      ],
    ]);
    const session = {
      id,
      file,
      title: index === 0 ? "Saved title" : title,
      state: index === 0 ? null : state.state,
      publishPending: index === 1 ? null : publishPending,
      ...(index === 2 ? { temporary: true as const } : {}),
    };
    const pane = `%${index + 1}`;
    const name = `pi-${index}`;
    const sessionTarget = `$${index + 1}`;
    const metadata = Buffer.from(JSON.stringify({ id, file, cwd: root, pid: index + 100 }));
    const row = [pane, sessionTarget, name, metadata.toString("base64"), index + 100, 0, 1, 1];
    return { session, sessionTarget, target: `=${name}:.${pane}`, row: row.join("\t"), values };
  });
  writeFileSync(
    join(root, "pi-mux-restore.json"),
    JSON.stringify({ version: 1, generation: "", workspaces: [{ cwd: root, sessions: [] }] }),
  );
  const originalPlatform = platform.windows;
  platform.windows = true;
  const spawn = spyOn(Bun, "spawn").mockImplementation((argv) => {
    assert.ok(Array.isArray(argv));
    const [command, flags, targetFlag, target, option, ...rest] = argv.slice(5);
    if (command === "list-panes") {
      assert.deepEqual(argv.slice(5), ["list-panes", "-a", "-F", PANE_FORMAT]);
      return windowsListReply(panes.map(({ row }) => row + "\r\n").join(""));
    }
    if (command === "show-environment") {
      const pane = panes.find(({ sessionTarget }) => sessionTarget === targetFlag);
      assert.ok(pane);
      assert.deepEqual(argv.slice(5), [
        "show-environment",
        "-t",
        pane.sessionTarget,
        "PI_TMUX_TEMPORARY",
      ]);
      return pane.session.temporary
        ? windowsListReply(`PI_TMUX_TEMPORARY=${pane.session.id}\r\n`)
        : windowsListReply("", "unknown variable: PI_TMUX_TEMPORARY", 1);
    }
    assert.equal(command, "show-options");
    assert.equal(targetFlag, "-t");
    const pane = panes.find((entry) => entry.target === target);
    assert.ok(pane, `unexpected pane target: ${target}`);
    if (flags === "-pqv") {
      assert.equal(rest.length, 0);
      const value = pane.values.get(option!);
      return windowsListReply(value === undefined ? "" : value + "\r\n");
    }
    assert.equal(flags, "-pq");
    assert.equal(option, metadataOption);
    assert.deepEqual(rest, [
      ";",
      "show-options",
      "-pq",
      "-t",
      target,
      pendingOption,
      ";",
      "display-message",
      "-p",
      "-t",
      target,
      completionMarker,
    ]);
    const lines = [...pane.values].map(([key, value]) => `${key} ${value}\r\n`);
    if (pane === panes[2]) {
      if (queryFailure === "error") return windowsListReply(lines[0]!, "can't find pane: %3", 1);
      if (queryFailure === "truncated") return windowsListReply(lines[0]!);
    }
    return windowsListReply(`${lines.join("")}${completionMarker}\r\n`);
  });
  try {
    await check({
      config,
      sessions: panes.map(({ session }) => session),
      launchCount: () => spawn.mock.calls.length,
    });
  } finally {
    spawn.mockRestore();
    platform.windows = originalPlatform;
    rmSync(root, { recursive: true, force: true });
  }
}

function windowsListReply(stdout: string, stderr = "", exitCode = 0) {
  return {
    stdout: new Blob([stdout]).stream(),
    stderr: new Blob([stderr]).stream(),
    exited: Promise.resolve(exitCode),
  } as ReturnType<typeof Bun.spawn>;
}

describe("mergeSessionLists", () => {
  it("combines live state with the first matching saved entry", () => {
    const active: ListedWorkspace[] = [
      {
        cwd,
        sessions: [
          {
            id: "shared",
            file: `${cwd}/live.jsonl`,
            title: "Live title",
            state: "waiting-user",
            publishPending: null,
          },
        ],
        empty: [],
      },
    ];
    const saved: HistoryEntry = {
      id: "shared",
      cwd,
      file: `${cwd}/saved.jsonl`,
      title: "Saved title",
      btime: 100,
      mtime: 200,
      size: 300,
    };
    const duplicate = { ...saved, file: `${cwd}/archive/saved.jsonl` };

    assert.deepEqual(mergeSessionLists(active, [saved, duplicate]), [
      {
        cwd,
        sessions: [
          {
            id: "shared",
            file: saved.file,
            title: "Live title",
            state: "waiting-user",
            publishPending: null,
            active: true,
            saved: true,
            btime: 100,
            mtime: 200,
            size: 300,
            history: { cwd, title: "Saved title", source: "normal" },
          },
        ],
      },
    ]);
  });
});

describe("renderTable", () => {
  it("aligns columns by display width, not string length", () => {
    assert.equal(
      renderTable(
        ["ID", "TITLE"],
        [
          ["界", "One"],
          ["a", "Two"],
        ],
      ),
      "ID  TITLE\n界  One\na   Two",
    );
  });
});
