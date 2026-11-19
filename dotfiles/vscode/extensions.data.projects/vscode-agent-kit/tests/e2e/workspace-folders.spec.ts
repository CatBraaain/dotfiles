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
    const baseline = [main, host.sessions.B.cwd, external];

    await test.step("Show the Explorer to observe workspaceFolders", async () => {
      await host.page.keyboard.press("Control+Shift+E");
      await expect(host.page.locator(".explorer-viewlet").describe("Explorer view")).toBeVisible();
    });

    await test.step("Sync the registered workspaces and the existing worktrees into workspaceFolders", async () => {
      await expect.poll(() => host.snapshot().folders).toEqual(baseline);
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
      await expect.poll(() => host.snapshot().folders).toEqual([...baseline, worktree]);
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
    "フォルダモードの起動で untitled ワークスペースへ遷移し、タイトルバーからフォルダ名を除く",
    { annotation: { type: "spec", description: "E2E-18" } },
    async ({ host }, testInfo) => {
      const agentsWorkspace = join(host.directory, "home", ".agents", "agents-workspace");

      await test.step("Start a folder-mode window on the agents workspace", async () => {
        // The folder-mode default title carries the rootName; the extension
        // is not activated until the Sessions view opens.
        await expect.poll(() => host.page.title()).toContain("agents-workspace");
        await expect.poll(() => host.snapshot().folders).toEqual([agentsWorkspace]);
        await testInfo.attach("Before promotion", {
          body: await host.page.screenshot({ path: testInfo.outputPath("before-promotion.png") }),
          contentType: "image/png",
        });
      });

      await test.step("Open the Sessions view and take the untitled transition with the title write", async () => {
        await host.page
          .getByRole("tab", { name: "Agent Kit", exact: true })
          .describe("Sessions sidebar")
          .click();
        // The template removes both the folder-mode rootName and the
        // transient "Untitled (Workspace)" default rootName.
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
        // Folder 0 is kept with identical content through the transition.
        await expect.poll(() => host.snapshot().folders?.[0]).toBe(agentsWorkspace);
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
