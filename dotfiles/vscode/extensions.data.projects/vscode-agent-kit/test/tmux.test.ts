import { afterEach, describe, expect, it, vi } from "vitest";
import { getuid } from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { TmuxRuntimeStore, piMuxSocketPath } from "../src/tmux";

const socket = "/runtime with spaces/pi-tmux/server.sock";

function pane(target: string, id: string): string {
  const metadata = { id, file: "/saved.jsonl", cwd: "/project", pid: 42 };
  return `${target}\t${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;
}

function setup(panes = [pane("target-A", "A"), pane("target-B", "B")].join("\n")) {
  const execute = vi.fn(async (_executable: string, args: string[]) => {
    if (args[2] === "list-panes") return panes;
    if (args[2] === "list-clients") return "123\t/dev/pts/1\ttarget-A\n456\t/dev/pts/2\ttarget-B\n";
    return "";
  });
  return { store: new TmuxRuntimeStore(socket, execute), execute };
}

afterEach(() => vi.unstubAllEnvs());

describe("piMuxSocketPath", () => {
  it("uses the pi-mux socket in XDG_RUNTIME_DIR", () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "/custom/runtime");
    expect(piMuxSocketPath()).toBe("/custom/runtime/pi-tmux/server.sock");
  });

  it.each([undefined, ""])("falls back to the current uid when runtime dir is %j", (runtimeDir) => {
    vi.stubEnv("XDG_RUNTIME_DIR", runtimeDir);
    expect(piMuxSocketPath()).toBe(`/run/user/${getuid!()}/pi-tmux/server.sock`);
  });
});

describe("TmuxRuntimeStore", () => {
  it("resolves a target by the published Pi ID instead of deriving its tmux name", async () => {
    const { store, execute } = setup();
    expect(await store.resolveTarget("B")).toBe("target-B");
    expect(execute).toHaveBeenCalledExactlyOnceWith("tmux", [
      "-S",
      socket,
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{@pi-tmux-session}",
    ]);
  });

  it("ignores missing or malformed metadata and resolves only an exact ID", async () => {
    const { store } = setup(
      [
        "ordinary\t",
        "broken\tnot-base64",
        "nonobject\tbnVsbA==",
        pane("prefix", "AB"),
        pane("matching", "A"),
      ].join("\n"),
    );
    expect(await store.resolveTarget("A")).toBe("matching");
    expect(await store.resolveTarget("unknown")).toBeUndefined();
  });

  it("resolves a cold display target back to its exact ID, cwd and planned file", async () => {
    const { store } = setup();
    expect(await store.resolveSession("target-B")).toEqual({
      sessionId: "B",
      cwd: "/project",
      file: "/saved.jsonl",
      target: "target-B",
    });
    expect(await store.resolveSession("unknown")).toBeUndefined();
  });

  it.each([
    "broken\tnot-base64",
    "broken\tbnVsbA==",
    `broken\t${Buffer.from(JSON.stringify({ id: "A", cwd: "relative", file: "/saved.jsonl" })).toString("base64")}`,
    `broken\t${Buffer.from(JSON.stringify({ id: "A", cwd: "/project", file: "relative" })).toString("base64")}`,
  ])("ignores invalid cold metadata without guessing its identity: %s", async (metadata) => {
    const { store } = setup(metadata);
    expect(await store.resolveSession("broken")).toBeUndefined();
  });

  it("resolves the displayed client pane ID rather than another Pi in the same session", async () => {
    const { store, execute } = setup();
    const encoded = Buffer.from(JSON.stringify({ id: "B" })).toString("base64");
    execute.mockResolvedValueOnce(`${encoded}\n`);
    const client = { pid: 123, name: "/dev/pts/1", target: "shared" };
    expect(await store.resolveClientSessionId(client)).toBe("B");
    expect(execute).toHaveBeenCalledExactlyOnceWith("tmux", [
      "-S",
      socket,
      "display-message",
      "-p",
      "-c",
      client.name,
      "#{@pi-tmux-session}",
    ]);
  });

  it.each([
    "",
    "invalid",
    ...[null, {}, { id: "" }, { id: 7 }].map((metadata) =>
      Buffer.from(JSON.stringify(metadata)).toString("base64"),
    ),
  ])("does not guess a restored ID from invalid pane metadata: %s", async (encoded) => {
    const { store, execute } = setup();
    execute.mockResolvedValueOnce(encoded);
    expect(
      await store.resolveClientSessionId({ pid: 123, name: "/dev/pts/1", target: "shared" }),
    ).toBeUndefined();
  });

  it.each([
    "no server running on socket",
    "error connecting to /runtime/pi-tmux/server.sock (No such file or directory)",
    "no current target",
    "no sessions",
  ])("treats an absent server as no target without starting a server: %s", async (message) => {
    const { store, execute } = setup();
    execute.mockRejectedValue(new Error(message));
    expect(await store.resolveTarget("A")).toBeUndefined();
    expect(await store.clients()).toEqual([]);
    expect(execute.mock.calls.every(([, args]) => args[0] === "-S")).toBe(true);
  });

  it.each(["permission denied", "spawn tmux ENOENT", "query timed out"])(
    "reports discovery failures without treating them as an absent server: %s",
    async (message) => {
      const { store, execute } = setup();
      execute.mockRejectedValue(new Error(message));
      await expect(store.resolveTarget("A")).rejects.toThrow(message);
      await expect(store.clients()).rejects.toThrow(message);
      expect(execute.mock.calls.every(([, args]) => args[2] !== "kill-session")).toBe(true);
    },
  );

  it("lists client PIDs and switches only the selected client", async () => {
    const { store, execute } = setup();
    const clients = await store.clients();
    expect(clients).toEqual([
      { pid: 123, name: "/dev/pts/1", target: "target-A" },
      { pid: 456, name: "/dev/pts/2", target: "target-B" },
    ]);
    await store.switchClient(clients[0], { sessionId: "B", cwd: "/project", target: "target-B" });
    expect(execute).toHaveBeenLastCalledWith("tmux", [
      "-S",
      socket,
      "switch-client",
      "-c",
      "/dev/pts/1",
      "-t",
      "=target-B",
    ]);
  });

  it("includes the parent PID of a live pi-mux child client", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      await once(child, "spawn");
      const store = new TmuxRuntimeStore(
        socket,
        async () => `${child.pid}\t/dev/pts/child\ttarget-A\n`,
      );
      expect(await store.clients()).toEqual([
        { pid: child.pid, parentPid: process.pid, name: "/dev/pts/child", target: "target-A" },
      ]);
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });

  it("escapes trailing semicolons in client and target arguments without adding commands", async () => {
    const { store, execute } = setup();
    await store.switchClient(
      { pid: 123, name: "client;", target: "old" },
      { sessionId: "B", cwd: "/project", target: "target;" },
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith("tmux", [
      "-S",
      socket,
      "switch-client",
      "-c",
      "client\\;",
      "-t",
      "=target\\;",
    ]);
  });
});
