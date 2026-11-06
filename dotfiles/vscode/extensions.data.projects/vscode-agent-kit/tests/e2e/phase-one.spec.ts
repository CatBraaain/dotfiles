import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type VSCodeFixture } from "../support/vscode";

test.use({ trace: "on" });

test(
  "Shows saved history with All when a work folder has no unarchived sessions",
  { annotation: { type: "spec", description: "E2E-1" } },
  async ({ host }, testInfo) => {
    await test.step("Inspect the work folder groups and the empty B Unarchived group", async () => {
      const frame = await host.sessionFrame();
      for (const key of ["A", "B"]) {
        const group = frame
          .locator("section.group")
          .filter({ has: frame.getByTitle(host.sessions[key].cwd, { exact: true }) })
          .describe(`${key} work folder group`);
        const heading = group.locator(".group-header").describe(`${key} work folder heading`);
        await expect(heading).toBeVisible();
        await expect(heading).toHaveAttribute("title", host.sessions[key].cwd);
        await expect(heading.locator(".group-title")).toHaveText(
          key === "A" ? "project-a" : "project-b",
        );
        await expect(group.locator(".mode-button")).toHaveCount(0);
        await expect(frame.getByText(host.sessions[key].cwd, { exact: true })).toHaveCount(0);
      }
      const emptyGroup = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) })
        .describe("Empty B Unarchived group");
      await expect(emptyGroup.locator(".session-row")).toHaveCount(0);
      await expect(emptyGroup.locator(".empty")).toHaveCount(0);
      await expect(frame.locator(".group-path")).toHaveCount(0);
      await expect(frame.locator("#app header [data-mode-toggle]")).toHaveAttribute(
        "data-mode",
        "unarchived",
      );
      await expect(
        frame.getByText("No unarchived sessions. Select All to browse saved sessions.", {
          exact: true,
        }),
      ).toHaveCount(0);
      await testInfo.attach("Unarchived（切替前）", {
        body: await host.page.screenshot({ path: testInfo.outputPath("unarchived.png") }),
        contentType: "image/png",
      });
    });
    await test.step("Choose All in the shared header toggle", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) });
      await frame
        .locator("#app header [data-mode-toggle]")
        .describe("Shared All toggle")
        .click({ steps: 15 });
      await expect(
        group
          .locator(`[data-session="${host.sessions.B.id}"]`)
          .describe("Saved inactive B session in its work folder"),
      ).toBeVisible();
      await testInfo.attach("All（履歴）", {
        body: await host.page.screenshot({ path: testInfo.outputPath("all.png") }),
        contentType: "image/png",
      });
    });
  },
);

test(
  "Switches between A/B conversations with Pi-notified titles",
  { annotation: { type: "spec", description: "E2E-2" } },
  async ({ host }, testInfo) => {
    const firstPids = new Map<string, number>();
    const selections = ["A", "B", "A", "B"];
    for (const [index, key] of selections.entries()) {
      const isLastSelection = index === selections.length - 1;
      await test.step(`Select ${key} and open its Pi terminal`, async () => {
        await host.selectSession(key);
      });
      await test.step(`Check the real ${key} Pi process cwd and PID reuse`, async () => {
        await expect
          .poll(() => host.piProcesses().some((process) => process.cwd === host.sessions[key].cwd))
          .toBe(true);
        const matches = host
          .piProcesses()
          .filter((process) => process.cwd === host.sessions[key].cwd);
        expect(matches).toHaveLength(1);
        const pi = matches[0];
        const priorPid = firstPids.get(key);
        if (priorPid !== undefined) expect(pi.pid).toBe(priorPid);
        else firstPids.set(key, pi.pid);
        await testInfo.attach(`${key} real process evidence`, {
          body: JSON.stringify(host.piProcesses(), null, 2),
          contentType: "application/json",
        });
      });
      await test.step(`Check ${key} saved session identity and normal Pi TUI`, async () => {
        const title = await host.expectNativeDisplay(key);
        const displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
        const terminalInput = host.page
          .getByRole("textbox", { name: /^Terminal [0-9]+/ })
          .describe("Shared Pi command input");
        const runtime = host.piProcesses().find((entry) => entry.cwd === host.sessions[key].cwd)!;
        const startCommand = host
          .tmux(["display-message", "-p", "-t", runtime.target, "#{pane_start_command}"])
          .trim();
        expect(startCommand).toBe(`pi --session ${host.sessions[key].session}`);
        const sessionPath = startCommand.slice("pi --session ".length);
        const sessionHeader = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0]);
        expect(sessionHeader).toMatchObject({
          type: "session",
          id: host.sessions[key].id,
          cwd: runtime.cwd,
        });
        await testInfo.attach(`${key} saved session identity`, {
          body: JSON.stringify({
            ...runtime,
            startCommand,
            paneTitle: host
              .tmux(["display-message", "-p", "-t", runtime.target, "#{pane_title}"])
              .trim(),
            nativeTitle: title,
            processArgs: readFileSync(`/proc/${runtime.pid}/cmdline`, "utf8")
              .split("\0")
              .filter(Boolean),
            sessionPath,
            sessionHeader,
          }),
          contentType: "application/json",
        });
        const terminalScreen = host.page.locator(".terminal.xterm").describe("Real Pi TUI");
        await expect(terminalScreen).toContainText(host.sessions[key].cwd);
        await expect(terminalScreen).toContainText(`• Fixture ${key}`);
        if (index === selections.length - 2 || isLastSelection) {
          const displayTarget = host.tmux(["list-clients", "-F", "#{session_name}"]).trim();
          const frame = await host.sessionFrame();
          await expect(
            host.page
              .getByRole("tab", { name: "Agent Sessions", exact: true })
              .describe("Active Sessions sidebar"),
          ).toHaveAttribute("aria-selected", "true");
          const selectedRow = frame
            .locator(".session-row.selected")
            .describe("Selected conversation");
          await expect(selectedRow).toHaveCount(1);
          await expect(
            selectedRow
              .locator(`[data-session="${host.sessions[key].id}"]`)
              .describe(`${key} selected before capturing its Pi TUI`),
          ).toBeVisible();
          await frame.locator("h1").describe("Neutral Sessions heading").hover();
          await expect
            .poll(() =>
              host
                .snapshot()
                .terminals.filter((terminal) => terminal.owned)
                .map(({ name, pid }) => ({ name, pid })),
            )
            .toEqual([{ name: title, pid: displayPid }]);
          await expect
            .poll(() =>
              host
                .snapshot()
                .tabs.filter((tab) => tab.terminal)
                .map(({ label, active }) => ({ label, active })),
            )
            .toEqual([{ label: title, active: true }]);
          await expect(terminalInput).toBeFocused();
          await expect(terminalScreen).toContainText(host.sessions[key].cwd);
          await expect(terminalScreen).toContainText(`• Fixture ${key}`);
          expect(host.tmux(["list-clients", "-F", "#{session_name}"]).trim()).toBe(displayTarget);
          expect(
            host.piProcesses().filter((entry) => entry.target === displayTarget),
          ).toMatchObject([{ pid: firstPids.get(key), cwd: host.sessions[key].cwd }]);
          const otherKey = key === "A" ? "B" : "A";
          await expect(
            frame
              .locator(`[data-session="${host.sessions[otherKey].id}"]`)
              .describe("Other conversation remains visible"),
          ).toBeVisible();
          await expect(
            frame
              .locator(".session-row:not(.selected) .session-button:hover")
              .describe("Hovered non-selected conversations"),
          ).toHaveCount(0);
          await expect
            .poll(() =>
              frame
                .locator(".session-row:not(.selected) .session-button")
                .evaluateAll((buttons) =>
                  buttons
                    .map((button) => getComputedStyle(button).backgroundColor)
                    .filter((color) => color !== "rgba(0, 0, 0, 0)"),
                ),
            )
            .toEqual([]);
          await expect(terminalInput).toHaveValue("");
          await expect(terminalScreen).not.toContainText("Session Info");
          await testInfo.attach(`${key} の Pi TUI`, {
            body: await host.page.screenshot({ path: testInfo.outputPath(`${key}-pi-tui.png`) }),
            contentType: "image/png",
          });
        }
        expect(
          readFileSync(host.sessions[key].session, "utf8").startsWith(host.sessions[key].original),
        ).toBe(true);
        expect(host.gitState(host.sessions[key].cwd)).toBe(host.gitBefore[host.sessions[key].cwd]);
      });
    }
    await test.step("Close only the shared display and reconnect to the same A and B processes", async () => {
      await host.closePiDisplay();
      expect(
        host
          .piProcesses()
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual([...firstPids.values()].sort());
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      expect(host.piProcesses().find((entry) => entry.cwd === host.sessions.A.cwd)?.pid).toBe(
        firstPids.get("A"),
      );
      await host.selectSession("B");
      await host.expectNativeDisplay("B");
      expect(host.piProcesses().find((entry) => entry.cwd === host.sessions.B.cwd)?.pid).toBe(
        firstPids.get("B"),
      );
    });
    await test.step("Switch same-cwd conversations without replacing the display or their Pi processes", async () => {
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      const displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
      await host.selectSession("Deleted");
      await host.expectNativeDisplay("Deleted");
      const pids = host
        .piProcesses()
        .map((entry) => entry.pid)
        .sort();
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      expect(host.snapshot().terminals.find((terminal) => terminal.owned)!.pid).toBe(displayPid);
      expect(
        host
          .piProcesses()
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual(pids);
      for (const [key, pid] of firstPids)
        expect(
          host
            .piProcesses()
            .some((entry) => entry.cwd === host.sessions[key].cwd && entry.pid === pid),
        ).toBe(true);
    });
    await test.step("Rediscover existing Pi and restore native title forwarding after extension host restart", async () => {
      const pids = host
        .piProcesses()
        .map((entry) => entry.pid)
        .sort();
      const runtime = host.piProcesses().find((entry) => entry.pid === firstPids.get("A"))!;
      host.tmux(["set-option", "-t", runtime.target, "set-titles", "off"]);
      await host.restartExtensionHost();
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      expect(host.tmux(["show-options", "-v", "-t", runtime.target, "set-titles"]).trim()).toBe(
        "on",
      );
      expect(
        host.tmux(["show-options", "-v", "-t", runtime.target, "set-titles-string"]).trim(),
      ).toBe("#{pane_title}");
      expect(
        host
          .piProcesses()
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual(pids);
      await host.selectSession("B");
      await host.expectNativeDisplay("B");
      expect(
        host
          .piProcesses()
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual(pids);
    });
    await test.step("Replace a restored legacy fixed-name tab in the same cwd without restarting Pi", async () => {
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      const pids = host
        .piProcesses()
        .map((entry) => entry.pid)
        .sort();
      await host.openLegacyDisplay("A");
      const legacy = host.snapshot();
      const legacyDisplay = legacy.terminals.find((terminal) => terminal.owned)!;
      await host.restartExtensionHost();
      await expect
        .poll(() =>
          host
            .snapshot()
            .terminals.filter((terminal) => terminal.owned)
            .map(({ pid, name }) => ({ pid, name })),
        )
        .toEqual([{ pid: legacyDisplay.pid, name: "Pi" }]);
      const restored = host.snapshot();

      await host.selectSession("A");
      const title = await host.expectNativeDisplay("A");
      const migrated = host.snapshot();
      const display = migrated.terminals.find((terminal) => terminal.owned)!;
      expect(display.pid).not.toBe(legacyDisplay.pid);
      expect(display.options).not.toHaveProperty("name");
      expect(
        host
          .piProcesses()
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual(pids);
      await testInfo.attach("Legacy display migration", {
        body: JSON.stringify({ title, pids, legacy, restored, migrated }),
        contentType: "application/json",
      });
      await host.selectSession("B");
      await host.expectNativeDisplay("B");
      expect(
        host
          .piProcesses()
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual(pids);
    });
    await test.step("Restart only an exited selected Pi from its saved session", async () => {
      const runtime = host.piProcesses().find((entry) => entry.pid === firstPids.get("A"))!;
      process.kill(runtime.pid, "SIGTERM");
      await expect
        .poll(() => host.piProcesses().some((entry) => entry.pid === runtime.pid))
        .toBe(false);
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      const restarted = host.piProcesses().filter((entry) => entry.target === runtime.target);
      expect(restarted).toHaveLength(1);
      expect(restarted[0].pid).not.toBe(firstPids.get("A"));
      expect(host.piProcesses().find((entry) => entry.cwd === host.sessions.B.cwd)?.pid).toBe(
        firstPids.get("B"),
      );
    });
  },
);

test(
  "SCM から Sessions へ戻っても、Refresh なしで一覧を復元する",
  { annotation: { type: "spec", description: "E2E-3" } },
  async ({ host }) => {
    const selections = ["B", "A", "B", "A"];
    for (const key of selections) {
      await test.step(`Return from SCM and select ${key} without Refresh`, async () => {
        await host.selectSession(key);
        await host.expectPiVisible(host.sessions[key].cwd);
        const scm = host.page
          .getByRole("tab", { name: /Source Control/ })
          .describe("Source Control sidebar");
        await scm.click();
        await expect(scm).toHaveAttribute("aria-selected", "true");
        const frame = await host.sessionFrame();
        await expect(frame.locator("section.group")).toHaveCount(4);
        await expect(
          frame
            .getByTitle(host.sessions.B.cwd, { exact: true })
            .describe("Restored B work folder heading"),
        ).toBeVisible();
      });
    }
  },
);

test(
  "New Workspace で入力したフルパスのワークスペースを登録できる",
  { annotation: { type: "spec", description: "E2E-6" } },
  async ({ host }, testInfo) => {
    const folder = join(host.directory, "registered");
    mkdirSync(folder, { recursive: true });

    await test.step("Open the New workspace form and fill a work folder path", async () => {
      const frame = await host.sessionFrame();
      await frame
        .locator('[data-action="toggleWorkspaceForm"]')
        .describe("New workspace footer button")
        .click({ steps: 15 });
      await expect(frame.locator("#workspace-form").describe("Workspace path form")).toBeVisible();
      await frame.locator("#workspace-path").describe("Workspace path input").fill(folder);
      await testInfo.attach("フォーム入力", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    await test.step("Add the work folder and see its group in the list", async () => {
      const frame = await host.sessionFrame();
      await frame.locator("#workspace-path").describe("Workspace path input").fill(folder);
      await frame
        .locator('[data-action="addWorkspace"]')
        .describe("Add workspace button")
        .click({ steps: 15 });
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      await expect(group).toBeVisible();
      await expect(frame.locator("#workspace-form")).not.toBeVisible();
      await testInfo.attach("ワークスペース追加後", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
  },
);

test(
  "New Workspace のキャンセルと無効なパスを安全に扱える",
  { annotation: { type: "spec", description: "E2E-12" } },
  async ({ host }) => {
    await test.step("Reject a missing workspace path with a safe error", async () => {
      const frame = await host.sessionFrame();
      const groupsBefore = await frame.locator("section.group").count();
      await frame
        .locator('[data-action="toggleWorkspaceForm"]')
        .describe("New workspace footer button")
        .click({ steps: 15 });
      await frame
        .locator("#workspace-path")
        .describe("Workspace path input")
        .fill(host.sessions.Missing.cwd);
      await frame
        .locator('[data-action="addWorkspace"]')
        .describe("Add workspace button")
        .click({ steps: 15 });
      await expect(
        host.page
          .locator(".notification-list-item-message")
          .filter({ hasText: host.sessions.Missing.cwd })
          .first(),
      ).toBeVisible();
      await expect(frame.locator("#workspace-form")).toBeVisible();
      await expect(frame.locator("#workspace-path")).toHaveValue(host.sessions.Missing.cwd);
      expect(await frame.locator("section.group").count()).toBe(groupsBefore);
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Cancel the New workspace form without changing the list", async () => {
      const frame = await host.sessionFrame();
      const groupsBefore = await frame.locator("section.group").count();
      await frame
        .locator('[data-action="cancelWorkspaceForm"]')
        .describe("Cancel adding the workspace")
        .click({ steps: 15 });
      await expect(frame.locator("#workspace-form")).not.toBeVisible();
      expect(await frame.locator("section.group").count()).toBe(groupsBefore);
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
    });
  },
);

test(
  "登録済みワークスペースの New session で、その cwd で新しい Pi を起動できる",
  { annotation: { type: "spec", description: "E2E-10" } },
  async ({ host }, testInfo) => {
    const folder = join(host.directory, "registered");
    await registerWorkFolder(host, folder);

    await test.step("Launch Pi from the registered group plus button", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      await group
        .locator(".group-new-session")
        .describe("Registered group New session button")
        .click({ steps: 15 });
      await expect
        .poll(() => host.piProcesses().some((process) => process.cwd === folder))
        .toBe(true);
      await host.expectPiVisible(folder);
      await testInfo.attach("登録 cwd で起動", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
  },
);

test(
  "ワークスペース登録解除が確認を挟み、起動中の Pi を残して登録だけを外す",
  { annotation: { type: "spec", description: "E2E-11" } },
  async ({ host }) => {
    const folder = join(host.directory, "registered");
    await registerWorkFolder(host, folder);

    await test.step("Keep the registration when the confirmation is cancelled", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      await group.locator(".group-header").hover();
      await group
        .locator(".group-unregister")
        .describe("Registered group Unregister button")
        .click({ steps: 15 });
      await frame.getByRole("button", { name: "Cancel", exact: true }).click({ steps: 15 });
      await expect(group).toBeVisible();
    });
    await test.step("Unregister after confirmation while Pi keeps running", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      await group
        .locator(".group-new-session")
        .describe("Registered group New session button")
        .click({ steps: 15 });
      await expect
        .poll(() => host.piProcesses().some((process) => process.cwd === folder))
        .toBe(true);

      await group.locator(".group-header").hover();
      await group.locator(".group-unregister").click({ steps: 15 });
      await frame
        .getByRole("button", { name: "Unregister", exact: true })
        .describe("Confirm unregistering")
        .click({ steps: 15 });
      await expect(group).toHaveCount(0);
      expect(host.piProcesses().some((process) => process.cwd === folder)).toBe(true); // unregistering never stops Pi
    });
  },
);

test(
  "存在しない cwd・削除済みセッションファイルの選択を安全に扱い、セッション原本と Git を変更しない",
  { annotation: { type: "spec", description: "E2E-7" } },
  async ({ host }) => {
    await test.step("Select a missing work folder and keep terminals and metadata unchanged", async () => {
      const metadata = readFileSync(join(host.directory, "agent/session-metadata.json"), "utf8");
      await host.selectSession("Missing");
      await expect(
        host.page
          .locator(".notification-list-item-message")
          .filter({ hasText: host.sessions.Missing.cwd })
          .first(),
      ).toBeVisible();
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
      expect(readFileSync(join(host.directory, "agent/session-metadata.json"), "utf8")).toBe(
        metadata,
      );
    });
    await test.step("Delete only the dummy session after listing it and select the stale row", async () => {
      const frame = await host.sessionFrame();
      unlinkSync(host.sessions.Deleted.session);
      await frame
        .locator(`[data-session="${host.sessions.Deleted.id}"] .session-name`)
        .describe("Stale deleted session")
        .click({ steps: 15 });
      await expect(
        host.page
          .locator(".notification-list-item-message")
          .filter({
            hasText: `Session file no longer exists: ${host.sessions.Deleted.id}`,
          })
          .first(),
      ).toBeVisible();
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Compare dummy original files, Git index and worktree contents", async () => {
      for (const [key, session] of Object.entries(host.sessions)) {
        if (key !== "Deleted") expect(readFileSync(session.session, "utf8")).toBe(session.original);
      }
      for (const [cwd, original] of Object.entries(host.gitBefore))
        expect(host.gitState(cwd)).toBe(original);
    });
  },
);

test(
  "実 Pi の最初の assistant 応答による新規セッションの検出と active 付与",
  { annotation: { type: "spec", description: "E2E-9" } },
  async () => {
    test.skip(
      true,
      "No model credentials or provider are configured in the isolated fixture. Synthetic JSONL detection is not evidence of a real Pi assistant response.",
    );
  },
);

/** Register a real folder through the New workspace form and wait for its group. */
async function registerWorkFolder(host: VSCodeFixture, folder: string): Promise<void> {
  mkdirSync(folder, { recursive: true });
  const frame = await host.sessionFrame();
  await frame
    .locator('[data-action="toggleWorkspaceForm"]')
    .describe("New workspace footer button")
    .click({ steps: 15 });
  await frame.locator("#workspace-path").describe("Workspace path input").fill(folder);
  await frame.locator('[data-action="addWorkspace"]').describe("Add workspace button").click({
    steps: 15,
  });
  await expect(
    frame
      .locator("section.group")
      .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
      .describe("Registered work folder group"),
  ).toBeVisible();
}
