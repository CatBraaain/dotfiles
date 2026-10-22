import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  followWorkTarget,
  isWithinDirectory,
  requireWorkDirectory,
} from "../src/workTarget";
import { cleanup, tempDir } from "./fixtures";

const mocks = vi.hoisted(() => ({
  getWorkspaceFolder: vi.fn(),
  updateWorkspaceFolders: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
  getExtension: vi.fn(),
  openRepository: vi.fn(),
  status: vi.fn(),
  activeTextEditor: undefined as
    undefined | { document: { uri: { fsPath: string } } },
}));

vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/first" } }],
    getWorkspaceFolder: mocks.getWorkspaceFolder,
    updateWorkspaceFolders: mocks.updateWorkspaceFolders,
  },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
    get activeTextEditor() {
      return mocks.activeTextEditor;
    },
  },
  commands: { executeCommand: mocks.executeCommand },
  extensions: { getExtension: mocks.getExtension },
}));

let root: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await tempDir("pi-work-target-test-");
  mocks.activeTextEditor = undefined;
  mocks.getWorkspaceFolder.mockReturnValue({});
  mocks.showInformationMessage.mockResolvedValue(undefined);
  mocks.updateWorkspaceFolders.mockReturnValue(true);
  mocks.getExtension.mockReturnValue({
    activate: async () => ({
      getAPI: () => ({
        openRepository: mocks.openRepository,
        repositories: [],
      }),
    }),
  });
  mocks.openRepository.mockResolvedValue(null);
});

afterEach(async () => {
  await cleanup(root);
});

function repository(workingPaths: string[] = [], indexPaths: string[] = []) {
  return {
    rootUri: { fsPath: root },
    status: mocks.status,
    ui: { selected: true },
    state: {
      workingTreeChanges: workingPaths.map((fsPath) => ({ uri: { fsPath } })),
      indexChanges: indexPaths.map((fsPath) => ({ uri: { fsPath } })),
    },
  };
}

describe("work directories", () => {
  it("normalizes an existing absolute directory", async () => {
    expect(await requireWorkDirectory(`${root}/./`)).toBe(root);
  });

  it("rejects a relative cwd", async () => {
    await expect(requireWorkDirectory("relative/project")).rejects.toThrow(
      "absolute path",
    );
  });

  it("rejects a missing cwd", async () => {
    await expect(requireWorkDirectory(join(root, "missing"))).rejects.toThrow();
  });

  it("rejects a file as cwd", async () => {
    const filePath = join(root, "file");
    await writeFile(filePath, "test");
    await expect(requireWorkDirectory(filePath)).rejects.toThrow(
      "not a directory",
    );
  });

  it("uses path segment boundaries rather than matching a path prefix", () => {
    expect(isWithinDirectory(root, root)).toBe(true);
    expect(isWithinDirectory(root, join(root, "file"))).toBe(true);
    expect(isWithinDirectory(root, `${root}-other/file`)).toBe(false);
  });
});

describe("followWorkTarget", () => {
  it("reveals the exact cwd and opens its first native Git diff", async () => {
    const filePath = join(root, "same-name.ts");
    mocks.openRepository.mockResolvedValue(repository([filePath]));

    await followWorkTarget(root);

    expect(mocks.executeCommand.mock.calls).toEqual([
      ["revealInExplorer", { fsPath: root }],
      ["workbench.view.scm"],
      ["git.openChange", { fsPath: filePath }],
    ]);
    expect(mocks.openRepository).toHaveBeenCalledWith({ fsPath: root });
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it("cycles public SCM inputs and restores the requested diff", async () => {
    const target = repository([join(root, "same.txt")]);
    target.ui.selected = false;
    mocks.openRepository.mockResolvedValue(target);
    mocks.executeCommand.mockImplementation(async (command: string) => {
      if (command === "workbench.scm.action.focusNextInput")
        target.ui.selected = true;
    });

    await followWorkTarget(root);

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "workbench.scm.action.focusNextInput",
    );
    expect(mocks.executeCommand).toHaveBeenLastCalledWith("git.openChange", {
      fsPath: join(root, "same.txt"),
    });
    mocks.executeCommand.mockReset();
  });

  it("reports an unreachable SCM repository after restoring the diff", async () => {
    const target = repository([join(root, "same.txt")]);
    target.ui.selected = false;
    mocks.openRepository.mockResolvedValue(target);

    await expect(followWorkTarget(root)).rejects.toThrow(
      "Could not select SCM repository",
    );

    expect(mocks.executeCommand).toHaveBeenLastCalledWith("git.openChange", {
      fsPath: join(root, "same.txt"),
    });
  });

  it("prefers the active file only when it is a change in the selected cwd", async () => {
    const first = join(root, "first.ts");
    const active = join(root, "active.ts");
    mocks.activeTextEditor = { document: { uri: { fsPath: active } } };
    mocks.openRepository.mockResolvedValue(repository([first, active]));

    await followWorkTarget(root, { fsPath: active } as never);

    expect(mocks.executeCommand).toHaveBeenLastCalledWith("git.openChange", {
      fsPath: active,
    });
  });

  it("opens an indexed change when no working tree change exists", async () => {
    const filePath = join(root, "indexed.ts");
    mocks.openRepository.mockResolvedValue(repository([], [filePath]));

    await followWorkTarget(root);

    expect(mocks.executeCommand).toHaveBeenLastCalledWith("git.openChange", {
      fsPath: filePath,
    });
  });

  it("excludes same-named files outside a nested cwd", async () => {
    const cwd = join(root, "nested");
    await mkdir(cwd);
    const ownFile = join(cwd, "same-name.ts");
    mocks.activeTextEditor = {
      document: { uri: { fsPath: join(root, "same-name.ts") } },
    };
    mocks.openRepository.mockResolvedValue(
      repository([join(root, "same-name.ts"), ownFile]),
    );

    await followWorkTarget(cwd);

    expect(mocks.executeCommand).toHaveBeenLastCalledWith("git.openChange", {
      fsPath: ownFile,
    });
  });

  it("does not use a repository outside the cwd ancestry", async () => {
    mocks.openRepository.mockResolvedValue({
      ...repository([join(root, "wrong.ts")]),
      rootUri: { fsPath: `${root}-other` },
    });

    await followWorkTarget(root);

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      `No Git repository for work folder: ${root}`,
    );
  });

  it("keeps Explorer scoped to the cwd when there are no Git changes", async () => {
    mocks.openRepository.mockResolvedValue(repository());

    await followWorkTarget(root);

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      `No Git changes in work folder: ${root}`,
    );
  });

  it("keeps file access when the Git extension is unavailable", async () => {
    mocks.getExtension.mockReturnValue(undefined);

    await followWorkTarget(root);

    expect(mocks.executeCommand).toHaveBeenCalledWith("revealInExplorer", {
      fsPath: root,
    });
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Enable the VS Code Git extension"),
    );
  });

  it("does not add an unregistered folder without explicit consent", async () => {
    mocks.getWorkspaceFolder.mockReturnValue(undefined);

    await followWorkTarget(root);

    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining(root),
      "Add folder to workspace",
    );
    expect(mocks.updateWorkspaceFolders).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("does not block later selections while an add-folder notification stays open", async () => {
    mocks.getWorkspaceFolder.mockReturnValue(undefined);
    mocks.showInformationMessage.mockReturnValue(new Promise(() => {}));

    await followWorkTarget(root);

    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(mocks.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it("adds a folder only after its explicit action and leaves navigation for reselection", async () => {
    mocks.getWorkspaceFolder.mockReturnValue(undefined);
    mocks.showInformationMessage.mockResolvedValue("Add folder to workspace");

    await followWorkTarget(root);

    await vi.waitFor(() =>
      expect(mocks.updateWorkspaceFolders).toHaveBeenCalledWith(1, 0, {
        uri: { fsPath: root },
      }),
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("reports failure to start adding a workspace folder", async () => {
    mocks.getWorkspaceFolder.mockReturnValue(undefined);
    mocks.showInformationMessage.mockResolvedValue("Add folder to workspace");
    mocks.updateWorkspaceFolders.mockReturnValue(false);

    await followWorkTarget(root);

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        `Failed to add session work folder: Could not add work folder to workspace: ${root}`,
      ),
    );
  });

  it("propagates native navigation errors for the provider to display", async () => {
    mocks.executeCommand.mockRejectedValueOnce(
      new Error("Explorer unavailable"),
    );

    await expect(followWorkTarget(root)).rejects.toThrow(
      "Explorer unavailable",
    );
  });
});
