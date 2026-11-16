import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EmptySessionPool } from "../src/emptySessionPool";
import * as workDirectory from "../src/workDirectory";
import { PiMux, type PiMuxEmptySession, type PiMuxSession } from "../src/piMux";
import { SessionLauncher } from "../src/launcher";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { fakeRuntimes } from "./runtimeFixtures";
import { cleanup, tempDir } from "./fixtures";

const api = vi.hoisted(() => ({ terminals: [], createTerminal: vi.fn() }));
vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  TerminalLocation: { Editor: 1 },
  window: api,
}));

let root: string;
let statePath: string;
let pool: EmptySessionPool;
let onError: ReturnType<typeof vi.fn<(message: string) => void>>;
let execute: ReturnType<
  typeof vi.fn<(executable: string, args: string[], cwd?: string) => Promise<string>>
>;
let live: Map<string, PiMuxSession & { cwd: string }>;
let registeredCwds: string[];
let saved: Set<string>;
let fileExists: ReturnType<typeof vi.fn<(file: string) => Promise<boolean>>>;
let sequence: number;

beforeEach(async () => {
  root = await tempDir("pi-empty-pool-");
  statePath = join(root, "session-state.json");
  onError = vi.fn();
  live = new Map();
  registeredCwds = [];
  saved = new Set();
  sequence = 0;
  fileExists = vi.fn(async (file) => saved.has(file));
  execute = vi.fn(async (_executable, args, cwd) => {
    if (args[0] === "list") return JSON.stringify(listWorkspaces());
    const physicalCwd = await realpath(cwd!);
    const existing = [...live.values()].find(
      (session) => session.cwd === physicalCwd && !saved.has(session.file),
    );
    if (existing !== undefined) return `Pi session ${existing.id}\n`;
    const id = `new-${++sequence}`;
    live.set(id, {
      id,
      cwd: physicalCwd,
      file: join(root, `${id}.jsonl`),
      state: null,
      title: null,
    });
    return `Pi session ${id}\n`;
  });
  pool = new EmptySessionPool({ mux: new PiMux(execute), fileExists, onError });
  api.createTerminal.mockClear();
});

afterEach(async () => {
  pool.dispose();
  vi.restoreAllMocks();
  await cleanup(root);
});

async function register(cwds: string[]) {
  registeredCwds = cwds;
  await writeFile(statePath, "legacy JSON sentinel");
  pool.syncWorkspaces(cwds);
}

function listWorkspaces() {
  const sessionsByCwd = new Map<string, { saved: PiMuxSession[]; empty: PiMuxEmptySession[] }>();
  for (const { cwd, ...session } of live.values()) {
    const entry = sessionsByCwd.get(cwd) ?? { saved: [], empty: [] };
    if (saved.has(session.file)) entry.saved.push(session);
    else entry.empty.push({ id: session.id, file: session.file });
    sessionsByCwd.set(cwd, entry);
  }
  return [...sessionsByCwd].map(([cwd, { saved: sessions, empty }]) => ({ cwd, sessions, empty }));
}

function newCalls() {
  return execute.mock.calls.filter(([, args]) => args[0] === "new");
}

async function ready(count = 1) {
  await vi.waitFor(() => expect(fileExists).toHaveBeenCalledTimes(count));
}

function firstFile() {
  return live.get("new-1")!.file!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("EmptySessionPool", () => {
  it("prewarms every registered cwd, including empty groups, without a Terminal or active entry", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await register([root, other]);
    await ready(2);
    expect(newCalls()).toHaveLength(2);
    expect(newCalls()).toEqual(
      expect.arrayContaining([
        ["pi-mux", ["new", "--detached"], root],
        ["pi-mux", ["new", "--detached"], other],
      ]),
    );
    expect(await readFile(statePath, "utf8")).toBe("legacy JSON sentinel");
    expect(api.createTerminal).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("tracks physical CLI metadata and refills through the unchanged logical symlink registration", async () => {
    const alias = join(root, "alias");
    await symlink(root, alias);
    await register([alias]);
    await ready();
    expect(live.get("new-1")?.cwd).toBe(root);
    const storeBefore = await readFile(statePath, "utf8");
    saved.add(firstFile());
    pool.onSessionFileChanged(firstFile());
    await ready(3);
    expect(newCalls().map(([, , cwd]) => cwd)).toEqual([alias, alias]);
    expect(live.size).toBe(2);
    expect(await readFile(statePath, "utf8")).toBe(storeBefore);
    expect(onError).not.toHaveBeenCalled();
  });

  it("shares one physical empty Pi across logical registrations and refills only through a remaining alias", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    await symlink(root, first);
    await symlink(root, second);
    await register([first, second]);
    await vi.waitFor(() => expect(fileExists).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(live.size).toBe(1);
    await register([second]);
    const newBeforeSave = newCalls().length;
    const file = firstFile();
    saved.add(file);
    pool.onSessionFileChanged(file);
    pool.onSessionFileChanged(file);
    await vi.waitFor(() => expect(newCalls()).toHaveLength(newBeforeSave + 1));
    await vi.waitFor(() => expect(live.size).toBe(2));
    expect(newCalls().at(-1)?.[2]).toBe(second);
    const next = live.get("new-2")!.file!;
    await register([]);
    saved.add(next);
    pool.onSessionFileChanged(next);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(newCalls()).toHaveLength(newBeforeSave + 1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a shared refill when its original logical registration is removed during save detection", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    await symlink(root, first);
    await symlink(root, second);
    await register([first, second]);
    await vi.waitFor(() => expect(fileExists).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const gate = deferred<boolean>();
    fileExists.mockReturnValueOnce(gate.promise);
    const file = firstFile();
    saved.add(file);
    pool.onSessionFileChanged(file);
    await register([second]);
    const before = newCalls().length;
    gate.resolve(true);
    await vi.waitFor(() => expect(newCalls()).toHaveLength(before + 1));
    await vi.waitFor(() => expect(live.size).toBe(2));
    expect(newCalls().at(-1)?.[2]).toBe(second);
  });

  it("moves an already scheduled refill to the remaining logical registration before invoking the CLI", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    await symlink(root, first);
    await symlink(root, second);
    await register([first, second]);
    await vi.waitFor(() => expect(fileExists).toHaveBeenCalled());
    pool.observeOpened(second, "new-1");
    await vi.waitFor(() => expect(fileExists.mock.calls.length).toBeGreaterThanOrEqual(2));
    const original = workDirectory.requireWorkDirectory;
    const gate = deferred<void>();
    const validating = vi
      .spyOn(workDirectory, "requireWorkDirectory")
      .mockImplementationOnce(async (cwd) => {
        await gate.promise;
        return original(cwd);
      });
    const before = newCalls().length;
    saved.add(firstFile());
    pool.onSessionFileChanged(firstFile());
    await vi.waitFor(() => expect(validating).toHaveBeenCalledWith(first));
    await register([second]);
    gate.resolve();
    await vi.waitFor(() => expect(newCalls()).toHaveLength(before + 1));
    expect(newCalls().at(-1)?.[2]).toBe(second);
    await vi.waitFor(() => expect(live.size).toBe(2));
  });

  it("rejects a truly different physical CLI cwd without watching or refilling its file", async () => {
    const other = join(root, "other");
    await mkdir(other);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (executable, args, cwd) => {
      const result = await original(executable, args, cwd);
      if (args[0] === "new") live.get("new-1")!.cwd = other;
      return result;
    });
    await register([root]);
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("Cannot locate")),
    );
    expect(fileExists).not.toHaveBeenCalled();
    saved.add(firstFile());
    pool.onSessionFileChanged(firstFile());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(newCalls()).toHaveLength(1);
  });

  it("warms only newly registered workspaces after changes from another client", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await register([root]);
    await ready();
    await register([root, other]);
    await ready(2);
    pool.syncWorkspaces(registeredCwds);
    expect(newCalls().map(([, , cwd]) => cwd)).toEqual([root, other]);
  });

  it("reuses an already running empty Pi on activation and extension restart", async () => {
    live.set("preexisting", {
      id: "preexisting",
      cwd: root,
      file: join(root, "empty.jsonl"),
      state: null,
      title: null,
    });
    await register([root]);
    await ready();
    pool.dispose();
    pool = new EmptySessionPool({ mux: new PiMux(execute), fileExists, onError });
    pool.syncWorkspaces(registeredCwds);
    await ready(2);
    expect([...live.keys()]).toEqual(["preexisting"]);
    expect(newCalls()).toHaveLength(2);
  });

  it("refills exactly once on the first saved message without Refresh or assistant completion", async () => {
    await register([root]);
    await ready();
    const file = firstFile();
    saved.add(file);
    pool.onSessionFileChanged(file);
    pool.onSessionFileChanged(file);
    pool.onSessionFileChanged(file);
    await vi.waitFor(() => expect(newCalls()).toHaveLength(2));
    await vi.waitFor(() => expect([...live.keys()]).toEqual(["new-1", "new-2"]));
    pool.onSessionFileChanged(file);
    pool.observeOpened(root, "new-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(newCalls()).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a handled input's unsaved Pi despite change notifications and non-null planned file", async () => {
    await register([root]);
    await ready();
    pool.onSessionFileChanged(firstFile());
    await ready(2);
    expect(newCalls()).toHaveLength(1);
    expect(live.size).toBe(1);
  });

  it("rechecks a file saved before its path was tracked and refills after the original request finishes", async () => {
    const list = deferred<string>();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (executable, args, cwd) =>
      args[0] === "list" && live.size === 1 ? list.promise : original(executable, args, cwd),
    );
    await register([root]);
    await vi.waitFor(() => expect(live.size).toBe(1));
    const file = firstFile();
    saved.add(file);
    pool.onSessionFileChanged(file);
    list.resolve(JSON.stringify(listWorkspaces()));
    await vi.waitFor(() => expect(newCalls()).toHaveLength(2));
    await ready(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("refills after a foreground-created empty Pi saves, even after a failed background startup", async () => {
    execute.mockRejectedValueOnce(new Error("startup failed"));
    await register([root]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    live.set("foreground", {
      id: "foreground",
      cwd: root,
      file: join(root, "foreground.jsonl"),
      state: null,
      title: null,
    });
    pool.observeOpened(root, "foreground");
    await ready();
    saved.add(join(root, "foreground.jsonl"));
    pool.onSessionFileChanged(join(root, "foreground.jsonl"));
    await vi.waitFor(() => expect(newCalls()).toHaveLength(2));
    await ready(3);
    expect(live.size).toBe(2);
  });

  it("tracks a replacement explicitly opened after an empty Pi exits without reviving it automatically", async () => {
    await register([root]);
    await ready();
    live.delete("new-1");
    pool.syncWorkspaces(registeredCwds);
    expect(newCalls()).toHaveLength(1);
    live.set("replacement", {
      id: "replacement",
      cwd: root,
      file: join(root, "replacement.jsonl"),
      state: null,
      title: null,
    });
    pool.observeOpened(root, "replacement");
    await ready(2);
    saved.add(join(root, "replacement.jsonl"));
    pool.onSessionFileChanged(join(root, "replacement.jsonl"));
    await vi.waitFor(() => expect(newCalls()).toHaveLength(2));
    expect(live.has("new-1")).toBe(false);
  });

  it("stops refilling on unregister and reuses the existing Pi on re-registration", async () => {
    await register([root]);
    await ready();
    const file = firstFile();
    await register([]);
    saved.add(file);
    pool.onSessionFileChanged(file);
    expect(newCalls()).toHaveLength(1);
    expect(live.size).toBe(1);
    await register([root]);
    await ready(2);
    expect(newCalls()).toHaveLength(2);
    expect(live.size).toBe(2);
  });

  it("ignores late startup completion after unregister without stopping the started Pi", async () => {
    const gate = deferred<string>();
    execute.mockReturnValueOnce(gate.promise);
    await register([root]);
    await vi.waitFor(() => expect(newCalls()).toHaveLength(1));
    await register([]);
    live.set("late", {
      id: "late",
      cwd: root,
      file: join(root, "late.jsonl"),
      state: null,
      title: null,
    });
    gate.resolve("Pi session late\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(execute.mock.calls).toHaveLength(1);
    expect(live.has("late")).toBe(true);
  });

  it("leaves live Pi and files intact on disposal and ignores late notifications", async () => {
    await register([root]);
    await ready();
    const file = firstFile();
    pool.dispose();
    saved.add(file);
    pool.onSessionFileChanged(file);
    pool.syncWorkspaces(registeredCwds);
    pool.observeOpened(root, "new-1");
    expect(newCalls()).toHaveLength(1);
    expect(live.size).toBe(1);
    expect(saved.has(file)).toBe(true);
  });

  it("reports a cwd-specific failure once, without retrying on unrelated state updates", async () => {
    execute.mockRejectedValueOnce(new Error("pi-mux missing"));
    await register([root]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining(root)));
    expect(onError.mock.calls[0][0]).toContain("pi-mux missing");
    pool.syncWorkspaces(registeredCwds);
    pool.syncWorkspaces(registeredCwds);
    expect(newCalls()).toHaveLength(1);
    await register([]);
    await register([root]);
    await ready();
    expect(newCalls()).toHaveLength(2);
  });

  it("silently skips a missing cwd while prewarming valid workspaces and keeping existing data", async () => {
    const missing = join(root, "missing");
    const history = join(root, "history.jsonl");
    await writeFile(history, "saved conversation\n");
    saved.add(history);
    live.set("preexisting", {
      id: "preexisting",
      cwd: missing,
      file: join(root, "empty.jsonl"),
      state: null,
      title: null,
    });
    const existing = { ...live.get("preexisting")! };
    const validating = vi.spyOn(workDirectory, "requireWorkDirectory");
    await register([missing, root]);
    const original = await readFile(statePath, "utf8");
    await expect(validating.mock.results[0]!.value).rejects.toMatchObject({ code: "ENOENT" });
    await ready();
    expect(newCalls().map(([, , cwd]) => cwd)).toEqual([root]);
    expect(onError).not.toHaveBeenCalled();
    expect(registeredCwds).toEqual([missing, root]);
    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(await readFile(history, "utf8")).toBe("saved conversation\n");
    expect(live.get("preexisting")).toEqual(existing);
    expect(execute.mock.calls.every(([, args]) => ["new", "list"].includes(args[0]!))).toBe(true);
  });

  it("retries a restored cwd only after re-registration rather than ordinary sync updates", async () => {
    const missing = join(root, "missing");
    const validating = vi.spyOn(workDirectory, "requireWorkDirectory");
    await register([missing]);
    await expect(validating.mock.results[0]!.value).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(missing);
    pool.syncWorkspaces(registeredCwds);
    pool.syncWorkspaces(registeredCwds);
    expect(validating).toHaveBeenCalledTimes(1);
    expect(newCalls()).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
    await register([]);
    await register([missing]);
    await ready();
    expect(newCalls().map(([, , cwd]) => cwd)).toEqual([missing]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a non-directory cwd without starting Pi or modifying the store", async () => {
    const file = join(root, "not-a-directory");
    await writeFile(file, "content");
    await register([file]);
    const original = await readFile(statePath, "utf8");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining(file)));
    expect(onError.mock.calls[0]![0]).toContain("Work folder is not a directory");
    expect(newCalls()).toHaveLength(0);
    expect(await readFile(statePath, "utf8")).toBe(original);
  });

  it("reports non-ENOENT directory validation errors", async () => {
    vi.spyOn(workDirectory, "requireWorkDirectory").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await register([root]);
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("permission denied")),
    );
    expect(newCalls()).toHaveLength(0);
  });

  it("reports CLI ENOENT failures after directory validation", async () => {
    execute.mockRejectedValueOnce(
      Object.assign(new Error("spawn pi-mux ENOENT"), { code: "ENOENT" }),
    );
    await register([root]);
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("spawn pi-mux ENOENT")),
    );
    expect(newCalls()).toHaveLength(1);
  });

  it("reports session file ENOENT failures after startup", async () => {
    fileExists.mockRejectedValueOnce(
      Object.assign(new Error("session file ENOENT"), { code: "ENOENT" }),
    );
    await register([root]);
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("session file ENOENT")),
    );
    expect(newCalls()).toHaveLength(1);
  });

  it("starts a New Session independently while a background startup is pending", async () => {
    const background = deferred<string>();
    execute.mockReturnValueOnce(background.promise);
    await register([root]);
    await vi.waitFor(() => expect(newCalls()).toHaveLength(1));
    const runtimes = fakeRuntimes();
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    const pid = deferred<number>();
    const terminal = { processId: pid.promise, show: vi.fn(), dispose: vi.fn() };
    api.createTerminal.mockReturnValue(terminal);
    const launcher = new SessionLauncher({
      registry,
      emptySessions: pool,
      onSessionStarted: vi.fn(),
    });
    const launching = launcher.start(root);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
    expect(api.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ shellArgs: ["open", "new-1"] }),
    );
    expect(runtimes.mocks.newSession).toHaveBeenCalledExactlyOnceWith(root);
    await launching;
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(runtimes.mocks.current).not.toHaveBeenCalled();
    registry.onTerminalClosed(terminal as never);
    expect(registry.displayedSessionId).toBe("new-1");
    launcher.dispose();
    pool.dispose();
    background.resolve("Pi session late\n");
    pid.resolve(123);
  });
});
