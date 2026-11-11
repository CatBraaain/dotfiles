import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/vscode";

test(
  "Tracks public list membership and title for unsaved Pi while prewarming hidden workspaces",
  { annotation: { type: "spec", description: "E2E-16" } },
  async ({ host }) => {
    let id = "";
    let target = "";
    let file = "";
    let original = "";
    const statePath = join(host.directory, "agent/session-state.json");
    await test.step("Find the prewarmed unsaved Pi in the public workspace list", async () => {
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
      expect(workspace.sessions).toContainEqual({ id, file, state: null, title: null });
      const frame = await host.sessionFrame();
      await expect(
        frame.locator(`[data-session="${id}"]`).describe("Unsaved list session"),
      ).toBeVisible();
      original = readFileSync(statePath, "utf8");
    });
    await test.step("Apply a public title independently of null state and observe automatic list updates", async () => {
      host.tmux([
        "set-option",
        "-p",
        "-t",
        target,
        "@pi_session_state",
        JSON.stringify({
          version: 1,
          sessionId: id,
          state: null,
          title: "Published unsaved title",
        }),
      ]);
      const frame = await host.sessionFrame();
      const row = frame.locator(`[data-session="${id}"]`).describe("Published unsaved title row");
      await expect(row.locator(".session-name")).toHaveText("Published unsaved title");
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(statePath, "utf8")).toBe(original);
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
      await expect(group.locator(".session-row").describe("Background prewarmed row")).toHaveCount(
        1,
      );
    });
  },
);
