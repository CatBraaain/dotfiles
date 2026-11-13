import { describe, expect, it, vi } from "vitest";
import { PiMux } from "../src/piMux";

const liveSession = { id: "A", file: "/saved/A.jsonl", state: "running", title: "Title" };
const emptySession = { id: "empty", file: "/saved/empty.jsonl" };

describe("PiMux", () => {
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
    expect(execute).toHaveBeenCalledExactlyOnceWith("pi-mux", ["list"], undefined);
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

  it("switches through the CLI and reports a failed resolution as false", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(Object.assign(new Error("Session not found: B"), { code: 1 }));
    const mux = new PiMux(execute);
    expect(await mux.switch("A", 456)).toBe(true);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "pi-mux",
      ["switch", "A", "--client-pid", "456"],
      undefined,
    );
    expect(await mux.switch("B")).toBe(false);
    expect(execute).toHaveBeenNthCalledWith(2, "pi-mux", ["switch", "B"], undefined);
    expect(execute).toHaveBeenCalledTimes(2);
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

  it("parses the current session for a client", async () => {
    const current = { id: "A", cwd: "/project", file: "/saved/A.jsonl", target: "pi-A" };
    const execute = vi.fn().mockResolvedValue(`${JSON.stringify(current)}\n`);
    const mux = new PiMux(execute);
    expect(await mux.current(456)).toEqual(current);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "pi-mux",
      ["current", "--client-pid", "456"],
      undefined,
    );
  });

  it("returns undefined when current cannot resolve the client", async () => {
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error("no client"), { code: 1 }));
    expect(await new PiMux(execute).current()).toBeUndefined();
    expect(execute).toHaveBeenCalledExactlyOnceWith("pi-mux", ["current"], undefined);
  });

  it.each([
    "not json",
    "null",
    '{"id":"A"}',
    '{"id":"A","cwd":"relative","file":"/f","target":"t"}',
    '{"id":"A","cwd":"/c","file":"relative","target":"t"}',
    '{"id":"A","cwd":"/c","file":"/f","target":""}',
  ])("rejects an invalid current response: %s", async (output) => {
    const mux = new PiMux(vi.fn().mockResolvedValue(output));
    await expect(mux.current()).rejects.toThrow("Invalid pi-mux current response");
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
    expect(execute).toHaveBeenNthCalledWith(1, "pi-mux", ["history"], undefined);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "pi-mux",
      ["history", "--cwd", "/project"],
      undefined,
    );
  });

  it("parses the history list with null mtime for conversations without message entries", async () => {
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
        btime: 60,
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
    '[{"id":"A","cwd":"/c","file":"/f","title":null,"btime":null,"mtime":1,"size":1}]',
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
    await expect(new PiMux(execute).history()).rejects.toThrow("pi-mux history: history denied");
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
