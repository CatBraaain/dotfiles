import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionLauncher } from "../src/launcher";
import { TerminalRegistry } from "../src/terminalRegistry";
import { encodeCwdDirName } from "../src/paths";
import { readMetadataStore } from "../src/metadataStore";
import { cleanup, header, tempDir, writeJsonl } from "./fixtures";

const mocks = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  showOpenDialog: vi.fn(),
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
const sessionId = "00000000-0000-4000-8000-000000000003";

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  root = await tempDir("pi-launcher-test-");
  mocks.workspaceFolders = [{ uri: { scheme: "file", fsPath: root } }];
  mocks.showQuickPick.mockResolvedValue(undefined);
  mocks.showOpenDialog.mockResolvedValue(undefined);
  mocks.createTerminal.mockReturnValue({ sendText: vi.fn(), show: vi.fn(), exitStatus: undefined });
  registry = new TerminalRegistry();
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
    mocks.workspaceFolders.push({ uri: { scheme: "file", fsPath: join(root, "current", "project") } });

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

    expect(mocks.createTerminal).toHaveBeenCalledWith({ name: "pi", cwd: { fsPath: cwd }, location: 1 });
    const terminal = mocks.createTerminal.mock.results[0].value;
    expect(terminal.sendText).toHaveBeenCalledWith("pi", true);
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("starts in a directory selected from the native folder dialog", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: undefined });
    mocks.showOpenDialog.mockResolvedValue([{ fsPath: root }]);

    await launcher.start();

    expect(mocks.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }),
    );
    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: { fsPath: root } }));
  });

  it("does not start Pi when the folder dialog is cancelled", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: undefined });

    await launcher.start();

    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it("rejects a missing chosen directory before creating a terminal", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: join(root, "missing") });

    await expect(launcher.start()).rejects.toThrow();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it("maps the detected session to the chosen terminal and marks it active", async () => {
    mocks.showQuickPick.mockResolvedValue({ cwd: root });
    await launcher.start();
    await writeJsonl(join(root, "sessions", encodeCwdDirName(root)), "new.jsonl", [
      header({ id: sessionId, cwd: root, timestamp: new Date().toISOString() }),
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(onSessionDetected).toHaveBeenCalledWith(sessionId));

    const terminal = mocks.createTerminal.mock.results[0].value;
    expect(registry.get(sessionId)).toBe(terminal);
    const metadata = readMetadataStore(join(root, "metadata.json"));
    expect(metadata.status === "ok" && metadata.data.sessions?.[sessionId].active).toBe(true);
  });
});
