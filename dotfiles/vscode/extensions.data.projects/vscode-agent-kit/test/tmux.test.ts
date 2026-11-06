import { describe, expect, it, vi } from "vitest";
import { TmuxRuntimeStore, tmuxSocketName } from "../src/tmux";

function setup(onCommand?: (args: string[]) => Promise<void> | void) {
  const panes = new Map<string, number>();
  const execute = vi.fn(async (_executable: string, args: string[]) => {
    await onCommand?.(args);
    const command = args[4];
    if (command === "list-panes")
      return [...panes].map(([name, dead]) => `${name}\t${dead}\n`).join("");
    if (command === "new-session") {
      const target = args[args.indexOf("-s") + 1];
      if (panes.has(target)) throw new Error(`duplicate session: ${target}`);
      panes.set(target, 0);
      return "";
    }
    if (command === "list-clients") return "123\t/dev/pts/1\tpi-A\n456\t/dev/pts/2\tpi-B\n";
    return "";
  });
  return { store: new TmuxRuntimeStore("test-socket", execute), execute, panes };
}

describe("TmuxRuntimeStore", () => {
  it("uses a stable isolated socket based on agent and session roots, not workspace folders", () => {
    expect(tmuxSocketName("/agent", "/sessions")).toBe(tmuxSocketName("/agent/.", "/sessions"));
    expect(tmuxSocketName("/other-agent", "/sessions")).not.toBe(
      tmuxSocketName("/agent", "/sessions"),
    );
    expect(tmuxSocketName("/agent", "/other-sessions")).not.toBe(
      tmuxSocketName("/agent", "/sessions"),
    );
  });

  it("starts one Pi with argv-safe paths and without user tmux configuration", async () => {
    const { store, execute } = setup();
    const launch = {
      sessionId: "A",
      cwd: "/project with spaces",
      args: ["--session", "/sessions/a; file.jsonl"],
    };
    const first = await store.ensure(launch);
    const again = await store.ensure(launch);
    expect(again).toEqual(first);
    const starts = execute.mock.calls.filter(([, args]) => args[4] === "new-session");
    expect(starts).toHaveLength(1);
    expect(starts[0][1].slice(0, 4)).toEqual(["-L", "test-socket", "-f", "/dev/null"]);
    expect(starts[0][1]).toContain("/project with spaces");
    expect(starts[0][1]).toContain("/sessions/a; file.jsonl");
    expect(starts[0][1]).toContain("pi");
    expect(starts[0][1].join(" ")).toContain("set-option -s extended-keys on");
    expect(starts[0][1].slice(-2)).toEqual(["prefix", "None"]);
  });

  it("requests the csi-u extended-keys format that pi reads best", async () => {
    const { store, execute } = setup();
    await store.ensure({ sessionId: "A", cwd: "/project", args: [] });

    const formatCalls = execute.mock.calls
      .map(([, args]) => args)
      .filter((args) => args[4] === "set-option" && args.includes("extended-keys-format"));
    expect(formatCalls).toHaveLength(1);
    expect(formatCalls[0].slice(-4)).toEqual(["set-option", "-s", "extended-keys-format", "csi-u"]);
  });

  it("still starts pi when the tmux server does not know extended-keys-format", async () => {
    const { store, execute } = setup((args) => {
      if (args[4] === "set-option" && args.includes("extended-keys-format"))
        throw new Error("invalid option: extended-keys-format");
    });

    const runtime = await store.ensure({ sessionId: "A", cwd: "/project", args: [] });
    expect(runtime.sessionId).toBe("A");
    expect(runtime.target).toMatch(/^pi-/);
    expect(execute.mock.calls.map(([, args]) => args.join(" "))).toContain(
      "-L test-socket -f /dev/null set-option -s extended-keys-format csi-u",
    );
  });

  it("still fails loudly when the tmux server rejects the format for another reason", async () => {
    const { store } = setup((args) => {
      if (args[4] === "set-option" && args.includes("extended-keys-format"))
        throw new Error("no server running on test-socket");
    });

    await expect(store.ensure({ sessionId: "A", cwd: "/project", args: [] })).rejects.toThrow(
      /no server running/,
    );
  });

  it.each([
    [";", "\\;"],
    ["trailing;", "trailing\\;"],
    ["one\\;", "one\\\\;"],
    ["two\\\\;", "two\\\\\\;"],
    ["many;;", "many;\\;"],
    ["middle;value", "middle;value"],
    ["trailing\\", "trailing\\"],
    ["", ""],
  ])("preserves cwd and launch argument data through tmux escaping: %j", async (input, escaped) => {
    const { store, execute } = setup();
    await store.ensure({ sessionId: "A", cwd: `/project/${input}`, args: ["--session", input] });

    const starts = execute.mock.calls.filter(([, args]) => args[4] === "new-session");
    expect(starts).toHaveLength(1);
    const args = starts[0][1];
    expect(args[args.indexOf("-c") + 1]).toBe(`/project/${escaped}`);
    const piIndex = args.indexOf("pi");
    expect(args.slice(piIndex + 1, piIndex + 4)).toEqual(["--session", escaped, ";"]);
    expect(args.filter((argument) => argument === ";")).toHaveLength(3);
  });

  it.each(["PATH", "HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"])(
    "escapes trailing semicolons in the %s launch environment value",
    async (key) => {
      vi.stubEnv(key, "/fixture\\;");
      try {
        const { store, execute } = setup();
        await store.ensure({ sessionId: "A", cwd: "/project", args: [] });

        const starts = execute.mock.calls.filter(([, args]) => args[4] === "new-session");
        expect(starts).toHaveLength(1);
        expect(starts[0][1]).toContain(`${key}=/fixture\\\\;`);
        expect(starts[0][1].filter((argument) => argument === ";")).toHaveLength(3);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("recovers the same runtime when concurrent hosts race to create it", async () => {
    const { store, execute, panes } = setup();
    const otherHost = new TmuxRuntimeStore("test-socket", execute);
    const launch = { sessionId: "A", cwd: "/a", args: ["--session", "/a.jsonl"] };

    const [first, second] = await Promise.all([store.ensure(launch), otherHost.ensure(launch)]);

    expect(first).toEqual(second);
    expect(panes.size).toBe(1);
  });

  it("rediscovers live Pi after constructing a new runtime store", async () => {
    const { store, execute } = setup();
    const launch = { sessionId: "A", cwd: "/a", args: ["--session", "/a.jsonl"] };
    await store.ensure(launch);
    const restored = new TmuxRuntimeStore("test-socket", execute);
    await restored.ensure(launch);
    expect(execute.mock.calls.filter(([, args]) => args[4] === "new-session")).toHaveLength(1);
  });

  it("forwards raw pane titles on new and rediscovered runtimes in its isolated server", async () => {
    const { store, execute } = setup();
    const launch = { sessionId: "A", cwd: "/a", args: ["--session", "/a.jsonl"] };
    const runtime = await store.ensure(launch);
    const titleCommands = [
      "set-option",
      "-t",
      runtime.target,
      "set-titles",
      "on",
      ";",
      "set-option",
      "-t",
      runtime.target,
      "set-titles-string",
      "#{pane_title}",
    ];
    expect(execute).toHaveBeenLastCalledWith("tmux", [
      "-L",
      "test-socket",
      "-f",
      "/dev/null",
      ...titleCommands,
    ]);

    execute.mockClear();
    const restored = new TmuxRuntimeStore("test-socket", execute);
    expect(await restored.ensure(launch)).toEqual(runtime);
    expect(execute.mock.calls.some(([, args]) => args[4] === "new-session")).toBe(false);
    expect(execute).toHaveBeenLastCalledWith("tmux", [
      "-L",
      "test-socket",
      "-f",
      "/dev/null",
      ...titleCommands,
    ]);
  });

  it("restarts only a selected exited runtime and preserves the other runtime", async () => {
    const { store, execute, panes } = setup();
    const a = { sessionId: "A", cwd: "/a", args: ["--session", "/a.jsonl"] };
    const b = { sessionId: "B", cwd: "/b", args: ["--session", "/b.jsonl"] };
    const runtimeA = await store.ensure(a);
    const runtimeB = await store.ensure(b);
    panes.delete(runtimeA.target);
    expect(await store.isAlive(runtimeA)).toBe(false);
    expect(execute.mock.calls.filter(([, args]) => args[4] === "new-session")).toHaveLength(2);
    await store.ensure(a);
    expect(await store.isAlive(runtimeB)).toBe(true);
    expect(execute.mock.calls.filter(([, args]) => args[4] === "new-session")).toHaveLength(3);
  });

  it("switches the explicitly selected client without detaching other clients", async () => {
    const { store, execute } = setup();
    const clients = await store.clients();
    await store.switchClient(clients[0], { sessionId: "B", cwd: "/b", target: "pi-B" });
    expect(execute).toHaveBeenLastCalledWith("tmux", [
      "-L",
      "test-socket",
      "-f",
      "/dev/null",
      "switch-client",
      "-c",
      "/dev/pts/1",
      "-t",
      "pi-B",
    ]);
    expect(execute.mock.calls.every(([, args]) => !args.includes("attach-session"))).toBe(true);
  });

  it("escapes client identifiers as data without adding commands", async () => {
    const { store, execute } = setup();
    await store.switchClient(
      { pid: 123, name: "/dev/pts/client\\;", target: "pi-A" },
      { sessionId: "B", cwd: "/b", target: "pi-B;" },
    );

    expect(execute).toHaveBeenLastCalledWith("tmux", [
      "-L",
      "test-socket",
      "-f",
      "/dev/null",
      "switch-client",
      "-c",
      "/dev/pts/client\\\\;",
      "-t",
      "pi-B\\;",
    ]);
  });

  it("reports missing tmux with the command and isolated target instead of treating it as no server", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("spawn tmux ENOENT"));
    const store = new TmuxRuntimeStore("test-socket", execute);
    await expect(store.ensure({ sessionId: "A", cwd: "/a", args: [] })).rejects.toThrow(
      /tmux list-panes.*test-socket.*ENOENT/,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("treats only an absent isolated server as empty", async () => {
    const { store, execute } = setup();
    execute.mockRejectedValueOnce(
      new Error("error connecting to /tmp/tmux-x/test-socket (No such file or directory)"),
    );
    await store.ensure({ sessionId: "A", cwd: "/a", args: [] });
    expect(execute.mock.calls.filter(([, args]) => args[4] === "new-session")).toHaveLength(1);
  });

  it("surfaces a failed launch instead of retrying or changing the other runtime", async () => {
    const { store, execute } = setup();
    await store.ensure({ sessionId: "B", cwd: "/b", args: [] });
    execute
      .mockImplementationOnce(async () => "")
      .mockRejectedValueOnce(new Error("new-session denied"));
    await expect(store.ensure({ sessionId: "A", cwd: "/a", args: [] })).rejects.toThrow(
      /new-session.*denied/,
    );
    expect(execute.mock.calls.filter(([, args]) => args[4] === "new-session")).toHaveLength(2);
  });
});
