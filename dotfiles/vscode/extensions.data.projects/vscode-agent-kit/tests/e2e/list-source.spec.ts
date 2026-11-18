import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/vscode";

test(
  "Tracks public list membership and title for running Pi while prewarming hidden workspaces",
  { annotation: { type: "spec", description: "E2E-16" } },
  async ({ host }) => {
    let id = "";
    let target = "";
    let file = "";
    let registeredCwds: string[] = [];
    const folders = host.snapshot().folders;
    await test.step("Keep the prewarmed unsaved Pi out of the public list rows", async () => {
      await expect.poll(() => host.piProcesses().length).toBe(3);
      const runtime = host.piProcesses().find(({ cwd }) => cwd === host.sessions.A.cwd)!;
      target = runtime.target;
      await expect
        .poll(() =>
          host.tmux(["display-message", "-p", "-t", target, "#{@pi-tmux-session}"]).trim(),
        )
        .not.toBe("");
      const metadata = JSON.parse(
        Buffer.from(
          host.tmux(["display-message", "-p", "-t", target, "#{@pi-tmux-session}"]).trim(),
          "base64",
        ).toString("utf8"),
      );
      id = metadata.id;
      file = metadata.file;
      expect(existsSync(file)).toBe(false);
      const workspaces = JSON.parse(
        execFileSync(join(host.directory, "bin/pi-mux"), ["list"], {
          env: host.env,
          encoding: "utf8",
        }),
      );
      const workspace = workspaces.find(
        (workspace: { cwd: string }) => workspace.cwd === host.sessions.A.cwd,
      );
      expect(workspace.sessions).toEqual([]);
      expect(workspace.empty).toContainEqual({ id, file });
      const frame = await host.sessionFrame();
      await expect(
        frame.locator(`[data-session="${id}"]`).describe("Unsaved prewarmed Pi"),
      ).toHaveCount(0);
      registeredCwds = host.listWorkspaces().map(({ cwd }) => cwd);
    });
    await test.step("Apply a public title independently of null state and observe automatic list updates", async () => {
      await host.activateSession("A");
      const saved = host.sessionRuntime("A")!;
      expect(saved.target).not.toBe(target);
      host.tmux([
        "set-option",
        "-p",
        "-t",
        saved.target,
        "@pi_session_state",
        JSON.stringify({
          version: 1,
          sessionId: host.sessions.A.id,
          state: null,
          title: "Published running title",
        }),
      ]);
      const frame = await host.sessionFrame();
      const row = frame
        .locator(`[data-session="${host.sessions.A.id}"]`)
        .describe("Published running title row");
      await expect(row.locator(".session-name")).toHaveText("Published running title");
      expect(existsSync(file)).toBe(false);
      expect(host.listWorkspaces().map(({ cwd }) => cwd)).toEqual(registeredCwds);
    });
    await test.step("Register a workspace while Sessions is hidden and observe background prewarming", async () => {
      await host.page
        .getByRole("tab", { name: /Source Control/ })
        .describe("SCM sidebar")
        .click();
      const cwd = join(host.directory, "hidden-workspace");
      mkdirSync(cwd);
      execFileSync(join(host.directory, "bin/pi-mux"), ["workspace", "register", cwd], {
        env: host.env,
      });
      await expect
        .poll(() => host.piProcesses().filter((runtime) => runtime.cwd === cwd))
        .toHaveLength(1);
      const frame = await host.sessionFrame();
      await expect(
        frame.locator(`.group-header[title="${cwd}"]`).describe("Background registered workspace"),
      ).toBeVisible();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${cwd}"]`) });
      await expect(
        group.locator(".session-row").describe("Hidden empty prewarmed Pi rows"),
      ).toHaveCount(0);
    });
    await test.step("Remove all public registrations and retain headers without stale rows", async () => {
      for (const { cwd } of host.listWorkspaces()) host.piMux(["workspace", "unregister", cwd]);
      const frame = await host.sessionFrame();
      await expect(frame.locator(".session-row").describe("Rows after empty list")).toHaveCount(0);
      for (const cwd of registeredCwds) {
        await expect(
          frame.locator(`.group-header[title="${cwd}"]`).describe("Retained workspace header"),
        ).toBeVisible();
      }
      expect(host.listWorkspaces()).toEqual([]);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Restart the extension host and restore headers without prewarming them", async () => {
      await host.restartExtensionHost();
      const frame = await host.sessionFrame();
      for (const cwd of registeredCwds) {
        await expect(
          frame.locator(`.group-header[title="${cwd}"]`).describe("Restored workspace header"),
        ).toBeVisible();
      }
      await expect(frame.locator(".session-row").describe("Restored empty groups")).toHaveCount(0);
      expect(host.listWorkspaces()).toEqual([]);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Unregister a retained-only workspace and keep its header removed after restart", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator(`.group-header[title="${host.sessions.A.cwd}"]`)
        .describe("Retained workspace actions");
      await group.getByRole("button", { name: "Workspace actions", exact: true }).click();
      await frame
        .getByRole("menuitem", { name: "Unregister workspace", exact: true })
        .describe("Remove retained workspace")
        .click();
      await expect(group).toHaveCount(0);
      await host.restartExtensionHost();
      const restored = await host.sessionFrame();
      await expect(
        restored
          .locator(`.group-header[title="${host.sessions.A.cwd}"]`)
          .describe("Removed header"),
      ).toHaveCount(0);
    });
    await test.step("Register the removed cwd again and rediscover its header", async () => {
      host.piMux(["workspace", "register", host.sessions.A.cwd]);
      const frame = await host.sessionFrame();
      await expect(
        frame
          .locator(`.group-header[title="${host.sessions.A.cwd}"]`)
          .describe("Rediscovered header"),
      ).toBeVisible();
      await expect
        .poll(() => host.piProcesses().filter(({ cwd }) => cwd === host.sessions.A.cwd))
        .toHaveLength(1);
      expect(host.snapshot().folders).toEqual(folders);
    });
  },
);
