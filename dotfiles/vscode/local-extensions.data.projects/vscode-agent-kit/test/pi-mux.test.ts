import { describe, expect, it, vi } from "vitest";
import { PiMux } from "../src/pi-mux";

const liveSession = { id: "A", file: "/saved/A.jsonl", state: "running", title: "Title" };
const emptySession = { id: "empty", file: "/saved/empty.jsonl" };

describe("PiMux", () => {
  it("reads worktrees by complete session ID without using a live session file", async () => {
    const metadata = { id: "chosen-id", worktrees: ["/repo/owned", "/repo/other"] };
    const execute = vi.fn().mockResolvedValue(JSON.stringify(metadata));
    const mux = new PiMux(execute);
    await expect(mux.sessionWorktrees(metadata.id, "/project")).resolves.toEqual(
      metadata.worktrees,
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "pi-mux",
      ["metadata", metadata.id],
      "/project",
    );
  });

  it("distinguishes an unsaved session from other metadata failures", async () => {
    const stderr = "pi-mux: Saved session not found (use the complete ID): chosen-id";
    const error = Object.assign(new Error(stderr), { exitCode: 1, stderr });
    const mux = new PiMux(vi.fn().mockRejectedValue(error));
    await expect(mux.sessionWorktrees("chosen-id", "/project")).resolves.toBeUndefined();
  });

  it("reports metadata failures that are not the missing-session diagnostic", async () => {
    const stderr = "pi-mux: Invalid workspaces in custom entry";
    const error = Object.assign(new Error(stderr), { exitCode: 1, stderr });
    const mux = new PiMux(vi.fn().mockRejectedValue(error));
    await expect(mux.sessionWorktrees("chosen-id", "/project")).rejects.toThrow(stderr);
  });

  it.each([
    { id: "other-id", worktrees: ["/owned"] },
    { id: "chosen-id", worktrees: "invalid" },
    { id: "chosen-id", worktrees: ["relative"] },
    { id: "chosen-id", worktrees: ["/nul\0path"] },
    { id: "chosen-id", worktrees: ["/owned", "/owned"] },
  ])("rejects invalid metadata: %j", async (metadata) => {
    const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(metadata)));
    await expect(mux.sessionWorktrees("chosen-id", "/project")).rejects.toThrow(
      "Invalid pi-mux metadata response",
    );
  });

  it("reloads all sessions without extra arguments or requiring a completion line", async () => {
    const execute = vi.fn().mockResolvedValue("");
    await expect(new PiMux(execute).reloadAllSessions()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledExactlyOnceWith("pi-mux", ["reload"], undefined);
  });

  it("reports a failed all-session reload", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("reload denied"));
    await expect(new PiMux(execute).reloadAllSessions()).rejects.toThrow(
      "pi-mux reload: reload denied",
    );
  });

  it("runs reload with the exact ID and accepts its completion line", async () => {
    const execute = vi.fn().mockResolvedValue("reloaded chosen-id\r\n");
    await expect(new PiMux(execute).reloadSession("chosen-id")).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledExactlyOnceWith("pi-mux", ["reload", "chosen-id"], undefined);
  });

  it.each(["", "reloaded other-id\n"])(
    "rejects reload without target confirmation: %j",
    async (output) => {
      const execute = vi.fn().mockResolvedValue(output);
      await expect(new PiMux(execute).reloadSession("chosen-id")).rejects.toThrow(
        "did not report a completed reload",
      );
    },
  );

  it.each(["registerWorkspace", "unregisterWorkspace"] as const)(
    "uses exact workspace argv and accepts empty stdout for %s",
    async (operation) => {
      const execute = vi.fn().mockResolvedValue("");
      const cwd = "/project with spaces; $literal";
      await expect(new PiMux(execute)[operation](cwd)).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        "pi-mux",
        ["workspace", operation === "registerWorkspace" ? "register" : "unregister", cwd],
        undefined,
      );
    },
  );

  it.each(["registerWorkspace", "unregisterWorkspace"] as const)(
    "reports %s failure without retry or fallback",
    async (operation) => {
      const execute = vi.fn().mockRejectedValue(new Error("workspace denied"));
      await expect(new PiMux(execute)[operation]("/project")).rejects.toThrow(
        /pi-mux workspace .*\/project: workspace denied/,
      );
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("runs detached new in the requested cwd and reads the first line ID", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue("Pi session custom-id\nAttach with: pi-mux open custom-id\n");
    const mux = new PiMux(execute);
    expect(await mux.newSession("/project with spaces;")).toBe("custom-id");
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "pi-mux",
      ["new", "--detached"],
      "/project with spaces;",
    );
  });

  it("accepts a CRLF new response", async () => {
    const execute = vi.fn().mockResolvedValue("Pi session A\r\nAttach with: pi-mux open A\r\n");
    expect(await new PiMux(execute).newSession("/project")).toBe("A");
  });

  it.each(["", "Pi session \n", "warning\nPi session A\n", "Pi session A extra\n"])(
    "rejects an invalid new response without extracting a different line: %j",
    async (output) => {
      const mux = new PiMux(vi.fn().mockResolvedValue(output));
      await expect(mux.newSession("/project")).rejects.toThrow(
        "Invalid pi-mux new response in /project",
      );
    },
  );

  it("closes the exact complete ID once and accepts empty stdout", async () => {
    const sessionId = "A0b12345-6789-4000-8000-0123456789ab";
    const execute = vi.fn().mockResolvedValue("");
    await expect(new PiMux(execute).closeSession(sessionId)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledExactlyOnceWith("pi-mux", ["close", sessionId], undefined);
  });

  it.each(["close failed after Pi exited", "spawn pi-mux ENOENT"])(
    "reports close failures without retrying or falling back: %s",
    async (message) => {
      const execute = vi.fn().mockRejectedValue(new Error(message));
      await expect(new PiMux(execute).closeSession("custom-ID")).rejects.toThrow(
        `pi-mux close custom-ID: ${message}`,
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith("pi-mux", ["close", "custom-ID"], undefined);
    },
  );

  it("closes a temporary candidate conditionally through the public CLI", async () => {
    const execute = vi.fn().mockResolvedValue("");
    await new PiMux(execute).closeTemporarySession("custom-ID");
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "pi-mux",
      ["close", "--if-temporary", "custom-ID"],
      undefined,
    );
  });

  it("reports conditional close failure without retry or fallback", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("close denied"));
    await expect(new PiMux(execute).closeTemporarySession("A")).rejects.toThrow(
      "pi-mux close --if-temporary A: close denied",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([{}, { temporary: true }])(
    "accepts normal or temporary sessions: %j",
    async (attributes) => {
      const workspaces = [
        { cwd: "/project", sessions: [{ ...liveSession, ...attributes }], empty: [] },
      ];
      const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
      expect(await mux.list()).toEqual(workspaces);
      expect(await mux.aliveSessionIds(["A"])).toEqual(new Set(["A"]));
    },
  );

  it.each([{}, { reloadStatus: null }, { reloadStatus: "reloading" }, { reloadStatus: true }])(
    "accepts the active list but ignores an unrecognized or absent reload status: %j",
    async (attributes) => {
      const pending = { ...liveSession, reloadStatus: "waiting-reload" };
      const other = { ...liveSession, id: "B", file: "/saved/B.jsonl" };
      const execute = vi
        .fn()
        .mockResolvedValue(
          JSON.stringify([
            { cwd: "/project", sessions: [pending, { ...other, ...attributes }], empty: [] },
          ]),
        );

      const [workspace] = await new PiMux(execute).list();

      expect(workspace.sessions).toEqual([pending, other]);
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        "pi-mux",
        ["list", "--active", "--json"],
        undefined,
      );
    },
  );

  it.each([{ publishPending: { attemptAt: 1_700_000_000_000 } }, { publishPending: null }, {}])(
    "accepts a valid publishPending attribute: %j",
    async (attributes) => {
      const workspaces = [
        { cwd: "/project", sessions: [{ ...liveSession, ...attributes }], empty: [] },
      ];
      const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
      expect(await mux.list()).toEqual(workspaces);
    },
  );

  it.each([
    { publishPending: {} },
    { publishPending: { attemptAt: 0 } },
    { publishPending: { attemptAt: -1 } },
    { publishPending: { attemptAt: 1.5 } },
    { publishPending: { attemptAt: "1" } },
    { publishPending: "pending" },
    { publishPending: 1 },
  ])("rejects an invalid publishPending attribute: %j", async (attributes) => {
    const workspaces = [
      { cwd: "/project", sessions: [{ ...liveSession, ...attributes }], empty: [] },
    ];
    const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
    await expect(mux.list()).rejects.toThrow("Invalid pi-mux list response");
  });

  it.each([false, null, "true", 1, {}, []])(
    "rejects an invalid temporary attribute: %j",
    async (temporary) => {
      const workspaces = [
        { cwd: "/project", sessions: [{ ...liveSession, temporary }], empty: [] },
      ];
      const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
      await expect(mux.list()).rejects.toThrow("Invalid pi-mux list response");
    },
  );

  it("parses the JSON live list with separate saved and empty sections", async () => {
    const workspaces = [
      { cwd: "/project", sessions: [liveSession], empty: [emptySession] },
      {
        cwd: "/other",
        sessions: [{ id: "unsaved", file: "/saved/unsaved.jsonl", state: null, title: null }],
        empty: [],
      },
      { cwd: "/empty", sessions: [], empty: [] },
    ];
    const execute = vi.fn().mockResolvedValue(JSON.stringify(workspaces));
    expect(await new PiMux(execute).list()).toEqual(workspaces);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "pi-mux",
      ["list", "--active", "--json"],
      undefined,
    );
  });

  it.each([false, true])("keeps a valid settlement with aborted=%s", async (aborted) => {
    const session = { ...liveSession, lastRun: { atMs: 1_700_000_000_000, aborted } };
    const workspaces = [{ cwd: "/project", sessions: [session], empty: [] }];
    const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
    await expect(mux.list()).resolves.toEqual(workspaces);
  });

  it.each([
    null,
    [[]],
    "now",
    {},
    { atMs: "1700000000000", aborted: false },
    { atMs: -1, aborted: false },
    { atMs: 0, aborted: false },
    { atMs: 0.5, aborted: false },
    { atMs: Number.MAX_SAFE_INTEGER + 1, aborted: false },
    { atMs: 1 },
    { atMs: 1, aborted: "false" },
  ])("ignores an invalid optional settlement without rejecting the list: %j", async (lastRun) => {
    const unaffected = { ...liveSession, id: "B", lastRun: { atMs: 1, aborted: false } };
    const workspaces = [
      { cwd: "/project", sessions: [{ ...liveSession, lastRun }, unaffected], empty: [] },
    ];
    const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
    await expect(mux.list()).resolves.toEqual([
      { cwd: "/project", sessions: [liveSession, unaffected], empty: [] },
    ]);
  });

  it("rejects a legacy response without the empty section", async () => {
    const mux = new PiMux(
      vi.fn().mockResolvedValue(JSON.stringify([{ cwd: "/project", sessions: [liveSession] }])),
    );
    await expect(mux.list()).rejects.toThrow("Invalid pi-mux list response");
    expect(await mux.aliveSessionIds(["A"])).toBeNull();
  });

  it("rejects invalid empty entries", async () => {
    const output = JSON.stringify([{ cwd: "/p", sessions: [], empty: [{ id: "A" }] }]);
    const mux = new PiMux(vi.fn().mockResolvedValue(output));
    await expect(mux.list()).rejects.toThrow("Invalid pi-mux list response");
  });

  it("treats empty sessions as alive alongside saved ones", async () => {
    const workspaces = [{ cwd: "/project", sessions: [liveSession], empty: [emptySession] }];
    const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
    expect(await mux.aliveSessionIds(["A", "empty", "missing"])).toEqual(new Set(["A", "empty"]));
  });

  it("returns an empty list when the server is not running", async () => {
    const mux = new PiMux(vi.fn().mockResolvedValue("[]\n"));
    expect(await mux.list()).toEqual([]);
    expect(await mux.aliveSessionIds(["A"])).toEqual(new Set());
  });

  it("uses list membership rather than its state value for liveness", async () => {
    const mux = new PiMux(
      vi
        .fn()
        .mockResolvedValue(
          JSON.stringify([
            { cwd: "/project", sessions: [{ ...liveSession, state: null }], empty: [] },
          ]),
        ),
    );
    expect(await mux.aliveSessionIds(["A", "B"])).toEqual(new Set(["A"]));
  });

  it.each([
    "not json",
    "null",
    "{}",
    "[null]",
    '[{"id":"A"}]',
    '[{"id":42,"cwd":"/p","file":null,"state":null}]',
    '[{"cwd":"relative","sessions":[],"empty":[]}]',
    '[{"cwd":"/p","sessions":null,"empty":[]}]',
    '[{"cwd":"/p","sessions":[],"empty":null}]',
    '[{"cwd":"/p","sessions":[],"empty":{}}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":null,"state":null,"title":null}],"empty":[]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"relative","state":null,"title":null}],"empty":[]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"/saved/A.jsonl","state":null}],"empty":[]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"/saved/A.jsonl","state":7,"title":null}],"empty":[]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"/saved/A.jsonl","state":null,"title":7}],"empty":[]}]',
    '[{"cwd":"/p","sessions":[],"empty":[{"id":"A","file":"relative"}]}]',
  ])("rejects malformed live lists and treats liveness as unknown: %s", async (output) => {
    const mux = new PiMux(vi.fn().mockResolvedValue(output));
    await expect(mux.list()).rejects.toThrow();
    expect(await mux.aliveSessionIds(["A"])).toBeNull();
  });

  it.each(["running", "waiting-approval", "waiting-user", null])(
    "keeps independent title and state fields for %s",
    async (state) => {
      const workspaces = [{ cwd: "/p", sessions: [{ ...liveSession, state }], empty: [] }];
      expect(await new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces))).list()).toEqual(
        workspaces,
      );
    },
  );

  it("switches through the CLI with the target ID and client PID", async () => {
    const execute = vi.fn().mockResolvedValue("");
    expect(await new PiMux(execute).switch("A", 456)).toBe("switched");
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "pi-mux",
      ["switch", "A", "--client-pid", "456"],
      undefined,
    );
  });

  it("propagates a spawn failure from switch instead of treating it as a resolution failure", async () => {
    const execute = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn pi-mux ENOENT"), {
        code: "ENOENT",
      }),
    );
    await expect(new PiMux(execute).switch("A")).rejects.toThrow("pi-mux switch A");
    expect(execute).toHaveBeenCalledOnce();
  });

  describe("current displayed session", () => {
    const current = { id: "A", cwd: "/project", file: "/saved/A.jsonl", target: "pi-A" };
    const displayed = { ...current, clientPid: 123 };
    const terminalPid = 456;

    it("returns the displayed session when the terminal PID differs from the client PID", async () => {
      const execute = vi.fn().mockResolvedValue(`${JSON.stringify([displayed])}\n`);
      expect(await new PiMux(execute).current(terminalPid)).toEqual(current);
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        "pi-mux",
        ["list", "--displayed", "--json", "--client-pid", String(terminalPid)],
        undefined,
      );
    });

    it("returns undefined when the CLI returns an empty list", async () => {
      const execute = vi.fn().mockResolvedValue("[]\n");
      expect(await new PiMux(execute).current(terminalPid)).toBeUndefined();
    });

    it("rejects multiple displayed sessions instead of choosing a client", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue(JSON.stringify([displayed, { ...displayed, clientPid: 124 }]));
      await expect(new PiMux(execute).current(terminalPid)).rejects.toThrow(
        "pi-mux list --displayed returned multiple sessions for PID 456",
      );
    });

    it.each([
      "not json",
      "null",
      JSON.stringify(current),
      "[null]",
      JSON.stringify([current]),
      JSON.stringify([{ ...displayed, clientPid: "123" }]),
      JSON.stringify([{ ...displayed, clientPid: 0 }]),
      JSON.stringify([{ ...displayed, clientPid: 1.5 }]),
      JSON.stringify([{ ...displayed, id: "" }]),
      JSON.stringify([{ ...displayed, cwd: "relative" }]),
      JSON.stringify([{ ...displayed, file: "relative" }]),
      JSON.stringify([{ ...displayed, target: "" }]),
    ])("rejects an invalid displayed list response: %s", async (output) => {
      const mux = new PiMux(vi.fn().mockResolvedValue(output));
      await expect(mux.current(terminalPid)).rejects.toThrow(
        "Invalid pi-mux list --displayed response",
      );
    });

    it.each([
      Object.assign(new Error("tmux query failed"), { exitCode: 1 }),
      Object.assign(new Error("spawn pi-mux ENOENT"), { code: "ENOENT" }),
    ])("propagates a CLI failure: %s", async (failure) => {
      const execute = vi.fn().mockRejectedValue(failure);
      await expect(new PiMux(execute).current(terminalPid)).rejects.toThrow(
        `pi-mux list --displayed --json --client-pid ${terminalPid}: ${failure.message}`,
      );
    });
  });

  it("parses the history list with numeric btime, mtime and size", async () => {
    const entries = [
      {
        id: "newer",
        cwd: "/project",
        file: "/saved/newer.jsonl",
        title: "Newer",
        btime: 100,
        mtime: 2,
        size: 20,
      },
      {
        id: "older",
        cwd: "/project",
        file: "/saved/older.jsonl",
        title: null,
        btime: 50,
        mtime: 1,
        size: 10,
      },
    ];
    const execute = vi.fn().mockResolvedValue(JSON.stringify(entries));
    const mux = new PiMux(execute);
    expect(await mux.history()).toEqual(entries);
    expect(await mux.history("/project")).toEqual(entries);
    expect(execute).toHaveBeenNthCalledWith(1, "pi-mux", ["list", "--saved", "--json"], undefined);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "pi-mux",
      ["list", "--saved", "--json", "--cwd", "/project"],
      undefined,
    );
  });

  it("parses mixed numeric and null btime histories including empty conversations", async () => {
    const entries = [
      {
        id: "newer",
        cwd: "/project",
        file: "/saved/newer.jsonl",
        title: "Newer",
        btime: 100,
        mtime: 2,
        size: 20,
      },
      {
        id: "empty",
        cwd: "/project",
        file: "/saved/empty.jsonl",
        title: null,
        btime: null,
        mtime: null,
        size: 0,
      },
    ];
    const execute = vi.fn().mockResolvedValue(JSON.stringify(entries));
    expect(await new PiMux(execute).history()).toEqual(entries);
  });

  it.each([
    "not json",
    "null",
    "{}",
    '[{"id":"A"}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":true,"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":{},"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":[],"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":1e400,"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":-1e400,"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":NaN,"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":Infinity,"mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":"1","mtime":1,"size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":1,"mtime":"1","size":1}]',
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":1,"mtime":1,"size":"1"}]',
    '[{"id":"A","cwd":"/c","file":"relative","title":null,"btime":1,"mtime":1,"size":1}]',
  ])("rejects an invalid history response: %s", async (output) => {
    const mux = new PiMux(vi.fn().mockResolvedValue(output));
    await expect(mux.history()).rejects.toThrow("Invalid pi-mux history response");
  });

  it("propagates history failures instead of returning an empty list", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("history denied"));
    await expect(new PiMux(execute).history()).rejects.toThrow(
      "pi-mux list --saved --json: history denied",
    );
  });

  it("reports a CLI failure with operation and cwd and does not retry", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("spawn pi-mux ENOENT"));
    const mux = new PiMux(execute);
    await expect(mux.newSession("/project")).rejects.toThrow(
      "pi-mux new --detached in /project: spawn pi-mux ENOENT",
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await mux.aliveSessionIds(["A"])).toBeNull();
  });
});
