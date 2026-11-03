import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionLauncher } from "../src/launcher";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { fakeRuntimes } from "./runtimeFixtures";
import { encodeCwdDirName } from "../src/paths";
import { readMetadataStore } from "../src/metadataStore";
import { cleanup, header, tempDir, writeJsonl } from "./fixtures";

const mocks = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  showOpenDialog: vi.fn(),
  terminals: [],
  createTerminal: vi.fn(),
  showErrorMessage: vi.fn(),
  workspaceFolders: [] as { uri: { scheme: string; fsPath: string } }[],
}));

vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  TerminalLocation: { Editor: 1 },
  window: mocks,
  workspace: {
    get workspaceFolders() {
      return mocks.workspaceFolders;
    },
  },
}));

let root: string;
let launcher: SessionLauncher;
let registry: TerminalRegistry;
let onSessionDetected: ReturnType<typeof vi.fn>;
let runtimes: ReturnType<typeof fakeRuntimes>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  root = await tempDir("pi-launcher-test-");
  mocks.workspaceFolders = [{ uri: { scheme: "file", fsPath: root } }];
  mocks.showQuickPick.mockResolvedValue(undefined);
  mocks.showOpenDialog.mockResolvedValue(undefined);
  mocks.createTerminal.mockReturnValue({
    processId: Promise.resolve(123),
    show: vi.fn(),
    dispose: vi.fn(),
    exitStatus: undefined,
  });
  runtimes = fakeRuntimes();
  registry = new TerminalRegistry(runtimes.store, editorTerminals(runtimes.store));
  onSessionDetected = vi.fn();
  launcher = new SessionLauncher({
    sessionDir: join(root, "sessions"),
    metadataPath: join(root, "metadata.json"),
    registry,
    onSessionDetected,
  });
});

afterEach(async () => {
  launcher.dispose();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await cleanup(root);
});

describe("SessionLauncher starting folder selection", () => {
  it("shows distinct full paths for same-named workspaces and history", async () => {
    const history = join(root, "history", "project");
    mocks.workspaceFolders.push({
      uri: { scheme: "file", fsPath: join(root, "current", "project") },
    });

    await launcher.start([history, history, "relative-history"]);

    const [choices, options] = mocks.showQuickPick.mock.calls[0];
    expect(choices.map((choice: { cwd?: string }) => choice.cwd)).toEqual([
      root,
      join(root, "current", "project"),
      history,
      undefined,
    ]);
    expect(choices[1].label).toBe("project");
    expect(choices[2].label).toBe("project");
    expect(choices[1].description).not.toBe(choices[2].description);
    expect(options).toMatchObject({ title: "Start Pi session in…", matchOnDescription: true });
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it("starts Pi in the explicitly selected directory, not the first workspace", async () => {
    const cwd = join(root, "selected");
    await mkdir(cwd);
    mocks.showQuickPick.mockResolvedValue({ cwd });

    await launcher.start([cwd]);

    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Pi", cwd: { fsPath: cwd }, location: 1 }),
    );
    expect(runtimes.mocks.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd,
        args: [
          "--session-id",
          expect.any(String),
          "--session-dir",
          join(root, "sessions", encodeCwdDirName(cwd)),
        ],
      }),
    );
    const terminal = mocks.createTerminal.mock.results[0].value;
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("starts in a directory selected from the native folder dialog", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: undefined });
    mocks.showOpenDialog.mockResolvedValue([{ fsPath: root }]);

    await launcher.start();

    expect(mocks.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      }),
    );
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: root } }),
    );
  });

  it("does not start Pi when the folder dialog is cancelled", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: undefined });

    await launcher.start();

    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(runtimes.mocks.ensure).not.toHaveBeenCalled();
  });

  it("rejects a missing chosen directory before creating a terminal", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: join(root, "missing") });

    await expect(launcher.start()).rejects.toThrow();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(runtimes.mocks.ensure).not.toHaveBeenCalled();
  });

  it.each(["clients", "switchClient"] as const)(
    "retries a failed %s connection with the same Pi before starting another new session",
    async (method) => {
      const metadataPath = join(root, "metadata.json");
      const originalMetadata = JSON.stringify({ version: 1, sentinel: "preserved", sessions: {} });
      await writeFile(metadataPath, originalMetadata);
      mocks.showQuickPick.mockResolvedValue({ cwd: root });
      runtimes.mocks[method].mockRejectedValueOnce(new Error("display connection failed"));

      await expect(launcher.start()).rejects.toThrow("display connection failed");

      const failedId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
      const failedRuntime = runtimes.live.get(failedId);
      expect(runtimes.live.size).toBe(1);
      const groupDir = join(root, "sessions", encodeCwdDirName(root));
      await writeJsonl(groupDir, `new_${failedId}.jsonl`, [header({ id: failedId, cwd: root })]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onSessionDetected).not.toHaveBeenCalled();
      expect(await readFile(metadataPath, "utf8")).toBe(originalMetadata);

      await launcher.start();

      const retriedId = runtimes.mocks.ensure.mock.calls[1][0].sessionId;
      expect(retriedId).toBe(failedId);
      expect(runtimes.live.size).toBe(1);
      expect(runtimes.live.get(retriedId)).toBe(failedRuntime);
      expect(mocks.createTerminal.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(onSessionDetected).toHaveBeenCalledWith(failedId));
      const metadata = readMetadataStore(metadataPath);
      expect(metadata.status === "ok" && metadata.data.sessions?.[failedId].active).toBe(true);

      await launcher.start();

      const nextId = runtimes.mocks.ensure.mock.calls[2][0].sessionId;
      expect(nextId).not.toBe(failedId);
      expect(runtimes.live.size).toBe(2);
    },
  );

  it("retains a failed launch across cancellation, an invalid cwd and another starting folder", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: root });
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("display connection failed"));
    await expect(launcher.start()).rejects.toThrow("display connection failed");
    const failedId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
    const failedRuntime = runtimes.live.get(failedId);

    mocks.showQuickPick.mockResolvedValueOnce(undefined);
    await launcher.start();
    mocks.showQuickPick.mockResolvedValueOnce({ cwd: undefined });
    await launcher.start();
    mocks.showQuickPick.mockResolvedValueOnce({ cwd: join(root, "missing") });
    await expect(launcher.start()).rejects.toThrow();
    expect(runtimes.mocks.ensure).toHaveBeenCalledTimes(1);
    expect(readMetadataStore(join(root, "metadata.json")).status).toBe("empty");

    const otherCwd = join(root, "other");
    await mkdir(otherCwd);
    mocks.showQuickPick.mockResolvedValueOnce({ cwd: otherCwd });
    await launcher.start();
    const otherId = runtimes.mocks.ensure.mock.calls[1][0].sessionId;
    expect(otherId).not.toBe(failedId);

    mocks.showQuickPick.mockResolvedValueOnce({ cwd: join(root, ".") });
    await launcher.start();

    expect(runtimes.mocks.ensure.mock.calls[2][0].sessionId).toBe(failedId);
    expect(runtimes.live.get(failedId)).toBe(failedRuntime);
    expect(runtimes.live.size).toBe(2);
    expect(runtimes.client.target).toBe(failedRuntime?.target);
    expect(mocks.createTerminal).toHaveBeenCalledTimes(2);
  });

  it("reuses a failed launch when another New Session request is already queued", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: root });
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("display connection failed"));

    const results = await Promise.allSettled([launcher.start(), launcher.start()]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    const [failedId, retriedId] = runtimes.mocks.ensure.mock.calls.map(
      ([request]) => request.sessionId,
    );
    expect(retriedId).toBe(failedId);
    expect(runtimes.live.size).toBe(1);
  });

  it("keeps invalid metadata unchanged after reconnecting a failed new session", async () => {
    const metadataPath = join(root, "metadata.json");
    const invalidMetadata = "{ invalid";
    await writeFile(metadataPath, invalidMetadata);
    mocks.showQuickPick.mockResolvedValue({ cwd: root });
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("display connection failed"));
    await expect(launcher.start()).rejects.toThrow("display connection failed");
    const sessionId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
    await writeJsonl(join(root, "sessions", encodeCwdDirName(root)), `new_${sessionId}.jsonl`, [
      header({ id: sessionId, cwd: root }),
    ]);

    await launcher.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalled());

    expect(await readFile(metadataPath, "utf8")).toBe(invalidMetadata);
    expect(runtimes.live.size).toBe(1);
  });

  it("associates overlapping new sessions by their own Pi IDs and shares the display", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: root });
    await Promise.all([launcher.start(), launcher.start()]);
    const [firstId, secondId] = runtimes.mocks.ensure.mock.calls.map(
      ([request]) => request.sessionId,
    );
    expect(firstId).not.toBe(secondId);
    const groupDir = join(root, "sessions", encodeCwdDirName(root));
    await writeJsonl(groupDir, `new_${secondId}.jsonl`, [header({ id: secondId, cwd: root })]);
    await writeJsonl(groupDir, "external_other.jsonl", [header({ id: "other", cwd: root })]);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(onSessionDetected).toHaveBeenCalledTimes(1));
    expect(onSessionDetected).toHaveBeenCalledWith(secondId);

    await writeJsonl(groupDir, `new_${firstId}.jsonl`, [header({ id: firstId, cwd: root })]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(onSessionDetected).toHaveBeenCalledTimes(2));
    expect(onSessionDetected).toHaveBeenLastCalledWith(firstId);
    await registry.run(() =>
      registry.open({ sessionId: firstId, cwd: root, args: ["--session", "/saved.jsonl"] }),
    );
    expect(runtimes.live.size).toBe(2);
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not associate a launched ID with a mismatched header or cwd", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: root });
    await launcher.start();
    const sessionId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
    const groupDir = join(root, "sessions", encodeCwdDirName(root));
    await writeJsonl(groupDir, `new_${sessionId}.jsonl`, [header({ id: "other", cwd: root })]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onSessionDetected).not.toHaveBeenCalled();
    await writeJsonl(groupDir, `new_${sessionId}.jsonl`, [
      header({ id: sessionId, cwd: "/other" }),
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onSessionDetected).not.toHaveBeenCalled();
    expect(readMetadataStore(join(root, "metadata.json")).status).toBe("empty");
  });

  it("detects only the launched runtime ID even when its display is closed", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: root });
    await launcher.start();
    const sessionId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
    registry.onTerminalClosed(mocks.createTerminal.mock.results[0].value);
    await writeJsonl(join(root, "sessions", encodeCwdDirName(root)), `new_${sessionId}.jsonl`, [
      header({ id: sessionId, cwd: root, timestamp: new Date().toISOString() }),
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(onSessionDetected).toHaveBeenCalledWith(sessionId));

    expect(runtimes.live.has(sessionId)).toBe(true);
    const metadata = readMetadataStore(join(root, "metadata.json"));
    expect(metadata.status === "ok" && metadata.data.sessions?.[sessionId].active).toBe(true);
  });
});
