import { describe, expect, it, vi } from "vitest";
import { PiMux } from "../src/piMux";

const liveSession = { id: "A", file: "/saved/A.jsonl", state: "running", title: "Title" };

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
      const workspaces = [{ cwd: "/project", sessions: [{ ...liveSession, ...attributes }] }];
      const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
      expect(await mux.list()).toEqual(workspaces);
      expect(await mux.aliveSessionIds(["A"])).toEqual(new Set(["A"]));
    },
  );

  it.each([false, null, "true", 1, {}, []])(
    "rejects an invalid temporary attribute: %j",
    async (temporary) => {
      const workspaces = [{ cwd: "/project", sessions: [{ ...liveSession, temporary }] }];
      const mux = new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces)));
      await expect(mux.list()).rejects.toThrow("Invalid pi-mux list response");
    },
  );

  it("parses the JSON live list, including unsaved sessions", async () => {
    const sessions = [
      { cwd: "/project", sessions: [liveSession] },
      {
        cwd: "/other",
        sessions: [{ id: "unsaved", file: "/saved/unsaved.jsonl", state: null, title: null }],
      },
      { cwd: "/empty", sessions: [] },
    ];
    const execute = vi.fn().mockResolvedValue(JSON.stringify(sessions));
    expect(await new PiMux(execute).list()).toEqual(sessions);
    expect(execute).toHaveBeenCalledExactlyOnceWith("pi-mux", ["list"], undefined);
  });

  it("rejects a legacy phase-only response instead of using a fallback", async () => {
    const mux = new PiMux(
      vi
        .fn()
        .mockResolvedValue(
          JSON.stringify([{ id: "A", cwd: "/project", file: null, phase: "running" }]),
        ),
    );
    await expect(mux.list()).rejects.toThrow("Invalid pi-mux list response");
    expect(await mux.aliveSessionIds(["A"])).toBeNull();
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
          JSON.stringify([{ cwd: "/project", sessions: [{ ...liveSession, state: null }] }]),
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
    '[{"cwd":"relative","sessions":[]}]',
    '[{"cwd":"/p","sessions":null}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":null,"state":null,"title":null}]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"relative","state":null,"title":null}]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"/saved/A.jsonl","state":null}]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"/saved/A.jsonl","state":7,"title":null}]}]',
    '[{"cwd":"/p","sessions":[{"id":"A","file":"/saved/A.jsonl","state":null,"title":7}]}]',
  ])("rejects malformed live lists and treats liveness as unknown: %s", async (output) => {
    const mux = new PiMux(vi.fn().mockResolvedValue(output));
    await expect(mux.list()).rejects.toThrow();
    expect(await mux.aliveSessionIds(["A"])).toBeNull();
  });

  it.each(["running", "waiting-approval", "waiting-user", null])(
    "keeps independent title and state fields for %s",
    async (state) => {
      const workspaces = [{ cwd: "/p", sessions: [{ ...liveSession, state }] }];
      expect(await new PiMux(vi.fn().mockResolvedValue(JSON.stringify(workspaces))).list()).toEqual(
        workspaces,
      );
    },
  );

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
