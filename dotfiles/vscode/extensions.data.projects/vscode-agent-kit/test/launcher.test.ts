import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
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
  terminals: [],
  createTerminal: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  TerminalLocation: { Editor: 1 },
  window: mocks,
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
  mocks.createTerminal.mockImplementation((creationOptions: vscode.TerminalOptions) => {
    const terminal = {
      creationOptions,
      processId: Promise.resolve(123),
      show: vi.fn(),
      dispose: vi.fn(),
      exitStatus: undefined,
    };
    terminal.dispose.mockImplementation(() =>
      registry.onTerminalClosed(terminal as unknown as vscode.Terminal),
    );
    return terminal;
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

describe("SessionLauncher launch cwd", () => {
  it("launches Pi in the requested directory", async () => {
    const cwd = join(root, "selected");
    await mkdir(cwd);

    await launcher.start(cwd);

    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: cwd }, location: 1 }),
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

  it("resolves the requested directory spelling before launching", async () => {
    await launcher.start(`${root}/.`);
    const requestedCwd = runtimes.mocks.ensure.mock.calls[0][0].cwd;

    expect(requestedCwd).toBe(root);
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: root } }),
    );
  });

  it("rejects a missing launch directory before creating a terminal", async () => {
    await expect(launcher.start(join(root, "missing"))).rejects.toThrow();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(runtimes.mocks.ensure).not.toHaveBeenCalled();
  });

  it.each(["clients", "switchClient"] as const)(
    "retries a failed %s connection with the same Pi before starting another new session",
    async (method) => {
      const metadataPath = join(root, "metadata.json");
      const originalMetadata = JSON.stringify({ version: 1, sentinel: "preserved", sessions: {} });
      await writeFile(metadataPath, originalMetadata);
      runtimes.mocks[method].mockRejectedValueOnce(new Error("display connection failed"));

      await expect(launcher.start(root)).rejects.toThrow("display connection failed");

      const failedId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
      const failedRuntime = runtimes.live.get(failedId);
      expect(runtimes.live.size).toBe(1);
      const groupDir = join(root, "sessions", encodeCwdDirName(root));
      await writeJsonl(groupDir, `new_${failedId}.jsonl`, [header({ id: failedId, cwd: root })]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onSessionDetected).not.toHaveBeenCalled();
      expect(await readFile(metadataPath, "utf8")).toBe(originalMetadata);

      await launcher.start(root);

      const retriedId = runtimes.mocks.ensure.mock.calls[1][0].sessionId;
      expect(retriedId).toBe(failedId);
      expect(runtimes.live.size).toBe(1);
      expect(runtimes.live.get(retriedId)).toBe(failedRuntime);
      expect(mocks.createTerminal.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(onSessionDetected).toHaveBeenCalledWith(failedId));
      const metadata = readMetadataStore(metadataPath);
      expect(metadata.status === "ok" && metadata.data.sessions?.[failedId].active).toBe(true);

      await launcher.start(root);

      const nextId = runtimes.mocks.ensure.mock.calls[2][0].sessionId;
      expect(nextId).not.toBe(failedId);
      expect(runtimes.live.size).toBe(2);
    },
  );

  it("retains a failed launch across an invalid cwd and another starting folder", async () => {
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("display connection failed"));
    await expect(launcher.start(root)).rejects.toThrow("display connection failed");
    const failedId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
    const failedRuntime = runtimes.live.get(failedId);

    await expect(launcher.start(join(root, "missing"))).rejects.toThrow();
    expect(runtimes.mocks.ensure).toHaveBeenCalledTimes(1);
    expect(readMetadataStore(join(root, "metadata.json")).status).toBe("empty");

    const otherCwd = join(root, "other");
    await mkdir(otherCwd);
    await launcher.start(otherCwd);
    const otherId = runtimes.mocks.ensure.mock.calls[1][0].sessionId;
    expect(otherId).not.toBe(failedId);

    await launcher.start(root);

    expect(runtimes.mocks.ensure.mock.calls[2][0].sessionId).toBe(failedId);
    expect(runtimes.live.get(failedId)).toBe(failedRuntime);
    expect(runtimes.live.size).toBe(2);
    expect(runtimes.client.target).toBe(failedRuntime?.target);
    expect(mocks.createTerminal).toHaveBeenCalledTimes(3);
  });

  it("reuses a failed launch when another New Session request is already queued", async () => {
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("display connection failed"));

    const results = await Promise.allSettled([launcher.start(root), launcher.start(root)]);

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
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("display connection failed"));
    await expect(launcher.start(root)).rejects.toThrow("display connection failed");
    const sessionId = runtimes.mocks.ensure.mock.calls[0][0].sessionId;
    await writeJsonl(join(root, "sessions", encodeCwdDirName(root)), `new_${sessionId}.jsonl`, [
      header({ id: sessionId, cwd: root }),
    ]);

    await launcher.start(root);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalled());

    expect(await readFile(metadataPath, "utf8")).toBe(invalidMetadata);
    expect(runtimes.live.size).toBe(1);
  });

  it("associates overlapping new sessions by their own Pi IDs and shares the display", async () => {
    await Promise.all([launcher.start(root), launcher.start(root)]);
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
    await launcher.start(root);
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
    await launcher.start(root);
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
