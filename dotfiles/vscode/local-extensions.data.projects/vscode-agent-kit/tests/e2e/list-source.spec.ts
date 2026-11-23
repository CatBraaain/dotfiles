import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/vscode";

test(
  "Tracks public list membership and title for running Pi",
  { annotation: { type: "spec", description: "E2E-16" } },
  async ({ host }) => {
    let registeredCwds: string[] = [];
    const agentsFolder = join(host.directory, "home", ".agents", "workspace");
    await test.step("Show registered workspace headers without starting Pi", async () => {
      const frame = await host.sessionFrame();
      registeredCwds = host.listWorkspaces().map(({ cwd }) => cwd);
      for (const cwd of registeredCwds)
        await expect(frame.locator(`.group-header[title="${cwd}"]`)).toBeVisible();
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Apply a public title independently of null state and observe automatic list updates", async () => {
      await host.activateSession("A");
      const saved = host.sessionRuntime("A")!;
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
      expect(host.listWorkspaces().map(({ cwd }) => cwd)).toEqual(registeredCwds);
    });
    await test.step("Register a workspace while Sessions is hidden", async () => {
      await host.page
        .getByRole("tab", { name: /Source Control/ })
        .describe("SCM sidebar")
        .click();
      const cwd = join(host.directory, "hidden-workspace");
      mkdirSync(cwd);
      execFileSync(join(host.directory, "bin/pi-mux"), ["workspace", "register", cwd], {
        env: host.env,
      });
      await expect.poll(() => host.snapshot().folders).toContain(cwd);
      const frame = await host.sessionFrame();
      await expect(
        frame.locator(`.group-header[title="${cwd}"]`).describe("Background registered workspace"),
      ).toBeVisible();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${cwd}"]`) });
      await expect(group.locator(".session-row")).toHaveCount(0);
      expect(host.piProcesses().filter((process) => process.cwd === cwd)).toHaveLength(0);
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
    await test.step("Restart the extension host and restore headers", async () => {
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
      await group.click({ button: "right" });
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
      expect(host.piProcesses().filter(({ cwd }) => cwd === host.sessions.A.cwd)).toHaveLength(0);
      await expect
        .poll(() => host.snapshot().folders)
        .toEqual([
          agentsFolder,
          host.sessions.A.cwd,
          host.sessions.B.cwd,
          host.sessions.External.cwd,
        ]);
    });
  },
);
