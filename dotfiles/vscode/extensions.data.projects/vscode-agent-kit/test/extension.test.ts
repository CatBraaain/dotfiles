import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import manifest from "../package.json";
import { activate } from "../src/extension";
import { SessionWebviewProvider } from "../src/webview/sessionWebviewProvider";

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

describe("extension commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fixture/agent");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "/fixture/sessions");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function register(commandId = "piSessions.refreshSessions") {
    const disposable = { dispose: vi.fn() };
    api.registerCommand.mockReturnValue(disposable);
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
    } as unknown as vscode.ExtensionContext;
    activate(context);
    expect(api.registerCommand).toHaveBeenCalledWith(commandId, expect.any(Function));
    expect(context.subscriptions).toContain(disposable);
    const registration = api.registerCommand.mock.calls.find(([id]) => id === commandId);
    if (registration === undefined) throw new Error(`Command not registered: ${commandId}`);
    return registration[1] as () => Promise<void>;
  }

  it("does not register or contribute the removed tmux settings command", () => {
    register();
    expect(api.registerCommand.mock.calls.map(([id]) => id)).toEqual([
      "piSessions.refreshSessions",
    ]);
    expect(
      manifest.contributes.commands.some(
        ({ command }) => command === "piSessions.reapplyTmuxSettings",
      ),
    ).toBe(false);
  });

  it("contributes a named refresh icon only to the Sessions view title", () => {
    expect(manifest.contributes.commands).toContainEqual({
      command: "piSessions.refreshSessions",
      category: "Pi Sessions",
      title: "Refresh Sessions",
      icon: "$(refresh)",
    });
    expect(manifest.contributes.menus).toEqual({
      "view/title": [
        {
          command: "piSessions.refreshSessions",
          when: "view == piSessions.sessions",
          group: "navigation",
        },
      ],
      commandPalette: [{ command: "piSessions.refreshSessions", when: "false" }],
    });
    expect(manifest.contributes.viewsContainers.activitybar[0].title).toBe("Pi Sessions");
    expect(manifest.contributes.views.piSessionViews[0].name).toBe("Sessions");
  });

  it("refreshes the registered Sessions provider from the native title command", async () => {
    const refresh = vi.spyOn(SessionWebviewProvider.prototype, "refresh").mockResolvedValue();
    const command = register("piSessions.refreshSessions");
    const provider = api.registerWebviewViewProvider.mock.calls[0][1];

    await command();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.instances[0]).toBe(provider);
    expect(api.showInformationMessage).not.toHaveBeenCalled();
    expect(api.showErrorMessage).not.toHaveBeenCalled();
  });
});
