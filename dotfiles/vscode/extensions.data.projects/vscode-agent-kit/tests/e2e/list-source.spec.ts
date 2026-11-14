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
  },
);
