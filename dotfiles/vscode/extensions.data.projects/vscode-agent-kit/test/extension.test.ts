import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import manifest from "../package.json";
import { activate } from "../src/extension";
import { TmuxRuntimeStore, tmuxSocketName } from "../src/tmux";

const api = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  onDidCloseTerminal: vi.fn(),
  registerWebviewViewProvider: vi.fn(),
  watcher: { onDidChange: vi.fn(), onDidCreate: vi.fn(), dispose: vi.fn() },
}));

vi.mock("vscode", () => ({
  commands: { registerCommand: api.registerCommand },
  window: api,
  workspace: { createFileSystemWatcher: () => api.watcher },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  RelativePattern: class {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  },
}));

describe("tmux settings command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fixture/agent");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "/fixture/sessions");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function register() {
    const disposable = { dispose: vi.fn() };
    api.registerCommand.mockReturnValue(disposable);
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
    } as unknown as vscode.ExtensionContext;
    activate(context);
    expect(api.registerCommand).toHaveBeenCalledWith(
      "piSessions.reapplyTmuxSettings",
      expect.any(Function),
    );
    expect(context.subscriptions).toContain(disposable);
    return api.registerCommand.mock.calls[0][1] as () => Promise<void>;
  }

  it("publishes the command in the Pi Sessions category", () => {
    expect(manifest.contributes.commands).toEqual([
      {
        command: "piSessions.reapplyTmuxSettings",
        category: "Pi Sessions",
        title: "Reapply tmux Settings",
      },
    ]);
  });

  it.each([
    [0, "No tmux sessions to update."],
    [2, "tmux settings reapplied."],
  ])("notifies the result for %s managed sessions", async (count, message) => {
    const reapply = vi
      .spyOn(TmuxRuntimeStore.prototype, "reapplySettings")
      .mockResolvedValue(count);
    const command = register();

    await command();

    expect(reapply).toHaveBeenCalledOnce();
    expect(reapply.mock.instances[0]).toMatchObject({
      socketName: tmuxSocketName("/fixture/agent", "/fixture/sessions"),
    });
    expect(api.showInformationMessage).toHaveBeenCalledExactlyOnceWith(message);
    expect(api.showErrorMessage).not.toHaveBeenCalled();
  });

  it("notifies a failure without showing a success message", async () => {
    vi.spyOn(TmuxRuntimeStore.prototype, "reapplySettings").mockRejectedValue(
      new Error("tmux connection lost"),
    );
    const command = register();

    await command();

    expect(api.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      "Failed to reapply tmux settings: tmux connection lost",
    );
    expect(api.showInformationMessage).not.toHaveBeenCalled();
  });
});
