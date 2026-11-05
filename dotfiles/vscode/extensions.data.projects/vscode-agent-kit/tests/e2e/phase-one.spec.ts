import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/vscode";
import type { VSCodeFixture } from "../support/vscode";

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
        await expect(group.getByRole("button", { name: "Unarchived", exact: true })).toBeVisible();
        await expect(group.getByRole("button", { name: "All", exact: true })).toBeVisible();
        await expect(frame.getByText(host.sessions[key].cwd, { exact: true })).toHaveCount(0);
      }
      const emptyGroup = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) })
        .describe("Empty B Unarchived group");
      await expect(emptyGroup.locator(".session-row")).toHaveCount(0);
      await expect(emptyGroup.locator(".empty")).toHaveCount(0);
      await expect(frame.locator(".group-path")).toHaveCount(0);
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
    await test.step("Choose All in the inactive worktree group", async () => {
      const frame = await host.sessionFrame();
      await expect(
        frame
          .locator("section.group")
          .first()
          .locator(".group-header")
          .describe("Top session group heading"),
      ).toHaveAttribute("title", host.sessions.B.cwd);
      const group = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) });
      await group.locator('[data-mode="all"]').describe("Worktree history").click({ steps: 15 });
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
  "Opens an unregistered cwd and reconnects to its Pi without adding a workspace folder",
  {
    tag: "@single-root",
    annotation: { type: "spec", description: "E2E-5" },
  },
  async ({ host }, testInfo) => {
    const folders = host.snapshot().folders;
    const editorTabs = host.snapshot().tabs.filter((tab) => !tab.terminal);
    const addFolder = host.page
      .getByRole("button", { name: "Add folder to workspace", exact: true })
      .describe("Workspace folder notification action");
    await test.step("Open the unregistered session directly in Pi", async () => {
      await host.selectSession("External");
      await host.expectPiVisible(host.sessions.External.cwd);
      await expect(addFolder).toHaveCount(0);
      expect(host.snapshot().folders).toEqual(folders);
      expect(host.snapshot().tabs.filter((tab) => !tab.terminal)).toEqual(editorTabs);
      await testInfo.attach("未登録 cwd の Pi TUI", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    const previousPiPid = host
      .piProcesses()
      .find((entry) => entry.cwd === host.sessions.External.cwd)!.pid;
    await test.step("Switch conversations and return to the same unregistered Pi", async () => {
      await host.selectSession("A");
      await host.expectPiVisible(host.sessions.A.cwd);
      await host.selectSession("External");
      await host.expectPiVisible(host.sessions.External.cwd);
      const processes = host
        .piProcesses()
        .filter((entry) => entry.cwd === host.sessions.External.cwd);
      expect(processes).toHaveLength(1);
      expect(processes[0].pid).toBe(previousPiPid);
      await expect(addFolder).toHaveCount(0);
      expect(host.snapshot().folders).toEqual(folders);
      expect(host.snapshot().tabs.filter((tab) => !tab.terminal)).toEqual(editorTabs);
      await testInfo.attach("再選択後の Pi TUI", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
  },
);

test(
  "New Session がフルパス候補を出し、キャンセル・無効な開始先・別フォルダ選択を安全に扱う",
  { annotation: { type: "spec", description: "E2E-6" } },
  async ({ host }, testInfo) => {
    await test.step("Inspect the native start candidates and cancel", async () => {
      await openNew(host);
      await expect(
        host.page.locator(".quick-input-list").getByText(host.sessions.A.cwd, { exact: true }),
      ).toBeVisible();
      await expect(
        host.page.locator(".quick-input-list").getByText(host.sessions.B.cwd, { exact: true }),
      ).toBeVisible();
      for (const name of ["project-a", "project-b"]) {
        await expect(
          host.page
            .locator(".quick-input-list")
            .getByText(name, { exact: true })
            .describe(`${name} start candidate label`),
        ).toBeVisible();
      }
      await testInfo.attach("候補一覧", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
      await host.page.keyboard.press("Escape");
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Choose a missing start folder and observe a safe error", async () => {
      await openNew(host);
      await host.page
        .locator(".quick-input-list")
        .getByText(host.sessions.Missing.cwd, { exact: true })
        .describe("Missing start candidate")
        .click({ steps: 15 });
      await expect(
        host.page
          .locator(".notification-list-item-message")
          .filter({ hasText: host.sessions.Missing.cwd })
          .first(),
      ).toBeVisible();
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Open another-folder selection and cancel it", async () => {
      await openNew(host);
      await host.page
        .getByText("Choose another folder…", { exact: true })
        .describe("Browse another start folder")
        .click({ steps: 15 });
      await expect(host.page.locator(".quick-input-widget input")).toBeVisible();
      await host.page.keyboard.press("Escape");
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Choose another folder and start real unauthenticated Pi there", async () => {
      await openNew(host);
      await host.page.getByText("Choose another folder…", { exact: true }).click({ steps: 15 });
      const input = host.page.locator(".quick-input-widget input").describe("Another folder path");
      await input.press("Control+a");
      await input.pressSequentially(join(host.directory, "other") + "/", {
        delay: 120,
      });
      await host.page.keyboard.press("Enter");
      await expect
        .poll(() =>
          host.piProcesses().some((process) => process.cwd === join(host.directory, "other")),
        )
        .toBe(true);
      await host.expectPiVisible(join(host.directory, "other"));
      await testInfo.attach("別フォルダで起動", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    await test.step("Choose the worktree candidate and share the same display for another Pi", async () => {
      await openNew(host);
      await host.page
        .locator(".quick-input-list")
        .getByText(host.sessions.B.cwd, { exact: true })
        .describe("Worktree start candidate")
        .click({ steps: 15 });
      await expect
        .poll(() => host.piProcesses().some((process) => process.cwd === host.sessions.B.cwd))
        .toBe(true);
      await host.expectPiVisible(host.sessions.B.cwd);
      expect(host.piProcesses()).toHaveLength(2);
    });
  },
);

test(
  "存在しない cwd・削除済みセッションファイルの選択を安全に扱い、セッション原本と Git を変更しない",
  { annotation: { type: "spec", description: "E2E-7" } },
  async ({ host }, testInfo) => {
    await test.step("Select a missing work folder and keep terminals and metadata unchanged", async () => {
      const metadata = readFileSync(join(host.directory, "agent/session-metadata.json"), "utf8");
      await host.selectSession("Missing");
      await expect(
        host.page
          .locator(".notification-list-item-message")
          .filter({ hasText: host.sessions.Missing.cwd })
          .first(),
      ).toBeVisible();
      await testInfo.attach("不在 cwd のエラー", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
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
      await testInfo.attach("削除済みのエラー", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
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

async function openNew(host: VSCodeFixture): Promise<void> {
  const frame = await host.sessionFrame();
  await frame
    .getByRole("button", { name: "New session", exact: true })
    .describe("Start a new Pi session")
    .click({ steps: 15 });
  await expect(host.page.locator(".quick-input-widget input")).toBeVisible();
}
