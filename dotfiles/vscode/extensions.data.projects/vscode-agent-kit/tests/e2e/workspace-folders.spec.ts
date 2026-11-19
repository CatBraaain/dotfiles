import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "../support/vscode";
import { UNTITLED_TITLE_TEMPLATE } from "../../src/folderSync";

function fixtureGit(host: { directory: string }, cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: join(host.directory, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

test(
  "本体リポジトリの worktree を作成・削除すると workspaceFolders に反映する",
  { annotation: { type: "spec", description: "E2E-17" } },
  async ({ host }, testInfo) => {
    const main = host.sessions.A.cwd;
    const external = join(host.directory, "external");
    const worktree = join(host.directory, "wt-fixture-new");
    // The saved workspace opens with the main repository as folder 0, so
    // the startup swap prepends the agents workspace; the worktrees of the
    // main repository follow it in folder-name order (fixture-b,
    // fixture-external), and `external` is a registered pi-mux workspace.
    const agentsWorkspace = join(host.directory, "home", ".agents", "agents-workspace");
    const baseline = [agentsWorkspace, main, host.sessions.B.cwd, external];

    await test.step("Show the Explorer to observe workspaceFolders", async () => {
      await host.page.keyboard.press("Control+Shift+E");
      await expect(host.page.locator(".explorer-viewlet").describe("Explorer view")).toBeVisible();
    });

    await test.step("Sync the registered workspaces and the existing worktrees into workspaceFolders", async () => {
      await expect.poll(() => host.snapshot().folders).toEqual(baseline);
    });

    await test.step("Scramble the managed folder order and observe the sync restoring it without closing tabs", async () => {
      await host.openTextFile(join("worktree/project-b", "same.txt"));
      await host.swapLastTwoFolders();
      await expect
        .poll(() => host.snapshot().folders.slice(-2))
        .toEqual([external, host.sessions.B.cwd]);
      // The next sync reorders the managed folders back into the pi-mux
      // list order and keeps the editor tab open.
      await expect.poll(() => host.snapshot().folders, { timeout: 20_000 }).toEqual(baseline);
      await expect
        .poll(() => host.snapshot().tabs.some((tab) => tab.uri?.endsWith("same.txt")))
        .toBe(true);
    });

    await test.step("Create a worktree of the main repository and observe the managed folder", async () => {
      const registeredBefore = host
        .listWorkspaces()
        .map(({ cwd }) => cwd)
        .sort();
      fixtureGit(host, main, ["worktree", "add", "-b", "fixture-new", worktree]);
      const row = host.page
        .locator(".explorer-viewlet .monaco-list-row", { hasText: "fixture-new" })
        .describe("Added worktree folder row");
      await expect(row).toBeVisible();
      // The new worktree is not a pi-mux workspace, so it takes the
      // worktree position directly after its main repository, before the
      // registered worktree workspaces at their pi-mux list positions.
      await expect
        .poll(() => host.snapshot().folders)
        .toEqual([agentsWorkspace, main, worktree, host.sessions.B.cwd, external]);
      // The worktree is a workspaceFolders entry only; pi-mux keeps the
      // same registration.
      expect(
        host
          .listWorkspaces()
          .map(({ cwd }) => cwd)
          .sort(),
      ).toEqual(registeredBefore);
      await testInfo.attach("Worktree added", {
        body: await host.page.screenshot({ path: testInfo.outputPath("worktree-added.png") }),
        contentType: "image/png",
      });
    });

    await test.step("Remove the worktree and observe the managed folder removal", async () => {
      fixtureGit(host, main, ["worktree", "remove", worktree]);
      await expect(
        host.page
          .locator(".explorer-viewlet .monaco-list-row", { hasText: "fixture-new" })
          .describe("Removed worktree folder row"),
      ).toBeHidden();
      await expect.poll(() => host.snapshot().folders).toEqual(baseline);
      await testInfo.attach("Worktree removed", {
        body: await host.page.screenshot({ path: testInfo.outputPath("worktree-removed.png") }),
        contentType: "image/png",
      });
    });
  },
);

test.describe("folder-mode startup", () => {
  test.use({ folderMode: true });

  test(
    "フォルダモードの起動でフォルダ0を agents-workspace に付け替え、untitled ワークスペースへ遷移し、タイトルバーからフォルダ名を除く",
    { annotation: { type: "spec", description: "E2E-18" } },
    async ({ host }, testInfo) => {
      const agentsWorkspace = join(host.directory, "home", ".agents", "agents-workspace");
      const openedFolder = join(host.directory, "other");

      await test.step("Observe the folder-0 swap with the untitled transition and the title write", async () => {
        // The extension activates on startup (onStartupFinished), so the
        // swap happens without opening the Sessions view. The swap edits
        // the folders of the folder-mode window, which moves it to an
        // untitled workspace whose folder 0 is the agents workspace; the
        // opened folder is kept at position 1.
        await expect
          .poll(() => host.page.title())
          .toBe("[Extension Development Host] Visual Studio Code");
        await expect
          .poll(() =>
            host.app.evaluate(
              ({
                BrowserWindow,
              }: {
                BrowserWindow: { getAllWindows(): { getTitle(): string }[] };
              }) => BrowserWindow.getAllWindows().map((window) => window.getTitle()),
            ),
          )
          .toEqual(["[Extension Development Host] Visual Studio Code"]);
        // The template is written to the untitled workspace's own scope.
        await expect
          .poll(() => host.snapshot().windowTitle?.workspaceValue)
          .toBe(UNTITLED_TITLE_TEMPLATE);
        // Folder 0 is swapped: the agents workspace takes position 0 and
        // the opened folder is kept at position 1. The opened folder is a
        // registered workspace, so the sync keeps this shape.
        await expect.poll(() => host.snapshot().folders).toEqual([agentsWorkspace, openedFolder]);
        await testInfo.attach("After promotion", {
          body: await host.page.screenshot({
            path: testInfo.outputPath("after-promotion.png"),
          }),
          contentType: "image/png",
        });
      });
    },
  );
});
