import { describe, expect, it, vi } from "vitest";
import { PiMux } from "../src/piMux";

const liveSession = { id: "A", cwd: "/project", file: "/saved/A.jsonl", state: "running" };

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

  it("parses the JSON live list, including unsaved sessions", async () => {
    const sessions = [liveSession, { id: "unsaved", cwd: "/other", file: null, state: null }];
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
      vi.fn().mockResolvedValue(JSON.stringify([{ ...liveSession, state: null }])),
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
  ])("rejects malformed live lists and treats liveness as unknown: %s", async (output) => {
    const mux = new PiMux(vi.fn().mockResolvedValue(output));
    await expect(mux.list()).rejects.toThrow();
    expect(await mux.aliveSessionIds(["A"])).toBeNull();
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
