import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Frame } from "playwright/test";
import type { SessionStateStoreData } from "../../src/sessionStateStore";
import { expect, test, type VSCodeFixture } from "../support/vscode";

test.use({ trace: "on" });

test(
  "Shows saved history with workspace All when a work folder has no unarchived sessions",
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
        const toggle = heading.locator("[data-mode-toggle]").describe(`${key} workspace mode`);
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute("data-mode-toggle", host.sessions[key].cwd);
        await expect(toggle).toHaveAttribute("data-mode", "unarchived");
        await expect(frame.getByText(host.sessions[key].cwd, { exact: true })).toHaveCount(0);
      }
      const emptyGroup = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) })
        .describe("Empty B Unarchived group");
      await expect(emptyGroup.locator(".session-row")).toHaveCount(0);
      await expect(emptyGroup.locator(".empty")).toHaveCount(0);
      await expect(frame.locator(".group-path")).toHaveCount(0);
      await expect(frame.locator("#app header [data-mode-toggle]")).toHaveCount(0);
      await expect(
        frame.getByText("No unarchived sessions. Select All to browse saved sessions.", {
          exact: true,
        }),
      ).toHaveCount(0);
      const layout = await frame.evaluate(() => {
        function rect(element: Element) {
          const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
          return { left, right, top, bottom, width, height };
        }
        const app = document.querySelector("#app")!;
        const footer = document.querySelector(".footer")!;
        const bodyStyle = getComputedStyle(document.body);
        const appStyle = getComputedStyle(app);
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.scrollingElement!.scrollWidth,
          bodyPadding: [
            bodyStyle.paddingTop,
            bodyStyle.paddingRight,
            bodyStyle.paddingBottom,
            bodyStyle.paddingLeft,
          ],
          appPadding: [
            appStyle.paddingTop,
            appStyle.paddingRight,
            appStyle.paddingBottom,
            appStyle.paddingLeft,
          ],
          app: rect(app),
          footer: { ...rect(footer), padding: getComputedStyle(footer).padding },
          rows: Array.from(document.querySelectorAll(".session-row")).map((row) => ({
            row: rect(row),
            name: rect(row.querySelector(".session-name")!),
            status: rect(row.querySelector(".session-status")!),
            timestamp: rect(row.querySelector(".session-timestamp")!),
            action: rect(row.querySelector(".archive, .unarchive")!),
            nameFont: getComputedStyle(row.querySelector(".session-name")!).fontSize,
            timestampFont: getComputedStyle(row.querySelector(".session-timestamp")!).fontSize,
            indent: getComputedStyle(row).marginLeft,
            gap: getComputedStyle(row.querySelector(".session-button")!).gap,
          })),
        };
      });
      const withHostPadding = await frame.evaluate(() => {
        const initialPadding = document.body.style.padding;
        try {
          document.body.style.padding = "0 20px";
          return Array.from(document.querySelectorAll(".session-row")).map((row) => ({
            rowWidth: row.getBoundingClientRect().width,
            nameWidth: row.querySelector(".session-name")!.getBoundingClientRect().width,
          }));
        } finally {
          document.body.style.padding = initialPadding;
        }
      });
      const geometryPath = testInfo.outputPath("sidebar-geometry.json");
      writeFileSync(geometryPath, JSON.stringify({ layout, withHostPadding }, null, 2));
      await testInfo.attach("Real host sidebar geometry", {
        path: geometryPath,
        contentType: "application/json",
      });
      expect(layout.bodyPadding).toEqual(["0px", "0px", "0px", "0px"]);
      expect(layout.appPadding).toEqual(["12px", "12px", "0px", "12px"]);
      expect(layout.app.left).toBe(0);
      expect(layout.app.right).toBe(layout.viewport.width);
      expect(layout.documentWidth).toBe(layout.viewport.width);
      expect(layout.footer.padding).toBe("12px");
      await expect(frame.locator("#app > header, #app h1, #app [data-action=refresh]")).toHaveCount(
        0,
      );
      await expect(
        host.page.getByRole("button", { name: "Refresh Sessions", exact: true }),
      ).toHaveCount(1);
      await expect(frame.locator(".session-scrollbar")).toHaveCSS("width", "12px");
      for (const [index, row] of layout.rows.entries()) {
        expect(row.row.left).toBe(16);
        expect(row.row.right).toBe(layout.viewport.width - 12);
        expect(row.row.height).toBe(32);
        expect(row.row.width).toBe(withHostPadding[index].rowWidth + 40);
        expect(row.name.width).toBe(withHostPadding[index].nameWidth + 40);
        expect(row.indent).toBe("4px");
        expect(row.gap).toBe("8px");
        expect(row.nameFont).toBe("13px");
        expect(row.timestampFont).toBe("10px");
        expect(row.status.width).toBe(12);
        expect(row.status.height).toBe(12);
        expect(row.action.width).toBe(24);
        expect(row.action.height).toBe(24);
        expect(row.timestamp.right).toBe(row.row.right - 36);
        expect(row.action.right).toBe(row.row.right - 4);
        expect(row.status.right).toBeLessThanOrEqual(row.name.left);
        expect(row.name.right).toBeLessThanOrEqual(row.timestamp.left);
        expect(row.timestamp.right).toBeLessThanOrEqual(row.action.left);
        expect(row.action.right).toBeLessThanOrEqual(layout.viewport.width - 12);
      }
      await testInfo.attach("Unarchived（切替前）", {
        body: await host.page.screenshot({ path: testInfo.outputPath("unarchived.png") }),
        contentType: "image/png",
      });
    });
    await test.step("Choose All for B while A stays Unarchived", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.B.cwd, { exact: true }) });
      await group
        .locator("[data-mode-toggle]")
        .describe("B workspace All toggle")
        .click({ steps: 15 });
      await expect(frame.locator(`[data-mode-toggle="${host.sessions.A.cwd}"]`)).toHaveAttribute(
        "data-mode",
        "unarchived",
      );
      await host.refreshSessions();
      await expect(group.locator("[data-mode-toggle]")).toHaveAttribute("data-mode", "all");
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
              .getByRole("tab", { name: "Pi Sessions", exact: true })
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
          await host.page
            .locator(".part.sidebar .title-label")
            .describe("Native Sessions title")
            .hover();
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
        await expect(frame.locator("section.group")).toHaveCount(3);
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
      const button = frame
        .locator('[data-action="toggleWorkspaceForm"]')
        .describe("New workspace footer button");
      const before = await button.boundingBox();
      const icon = frame.locator(".workspace-folder-icon").describe("Decorative workspace folder");
      const iconBefore = await icon.boundingBox();
      const labelStart = await button.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().left;
      });
      const scrollBefore = await frame.evaluate(() => ({
        top: window.scrollY,
        height: document.scrollingElement!.scrollHeight,
      }));
      const listTop = await frame
        .locator("#sessions")
        .evaluate((element) => element.getBoundingClientRect().top);
      expect(listTop).toBe(12);
      expect(await button.evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
        (await frame.evaluate(() => innerHeight)) - listTop,
      );
      await button.click({ steps: 15 });
      await expect(frame.locator("#workspace-form").describe("Workspace path form")).toBeVisible();
      const input = frame.locator("#workspace-path").describe("Workspace path input");
      await expect(button).toBeHidden();
      await expect(input).toBeFocused();
      expect(await input.boundingBox()).toEqual(before);
      await expect(icon).toBeVisible();
      expect(await icon.boundingBox()).toEqual(iconBefore);
      await expect(icon).toHaveAttribute("aria-hidden", "true");
      await expect(icon).toHaveAttribute("focusable", "false");
      expect(await icon.getAttribute("tabindex")).toBeNull();
      expect(
        await input.evaluate((element) => {
          const css = getComputedStyle(element);
          return (
            element.getBoundingClientRect().left +
            parseFloat(css.borderLeftWidth) +
            parseFloat(css.paddingLeft)
          );
        }),
      ).toBe(labelStart);
      expect(
        await frame.evaluate(() => ({
          top: window.scrollY,
          height: document.scrollingElement!.scrollHeight,
        })),
      ).toEqual(scrollBefore);
      await input.fill(folder);
      await testInfo.attach("フォーム入力", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
    });
    await test.step("Add the work folder with Enter and see its group in the list", async () => {
      const frame = await host.sessionFrame();
      await frame.locator("#workspace-path").describe("Workspace path input").press("Enter");
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      await expect(group).toBeVisible();
      await expect(frame.locator("#workspace-form")).not.toBeVisible();
      await expect(frame.locator(".new-workspace")).toBeVisible();
      await expect(frame.locator(".workspace-folder-icon")).toBeVisible();
      await expect(frame.locator("#workspace-path")).toHaveValue("");
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
  async ({ host }, testInfo) => {
    await test.step("Reject a missing workspace path with a safe error", async () => {
      const frame = await host.sessionFrame();
      const groupsBefore = await frame.locator("section.group").count();
      await frame
        .locator('[data-action="toggleWorkspaceForm"]')
        .describe("New workspace footer button")
        .click({ steps: 15 });
      const pathInput = frame.locator("#workspace-path").describe("Workspace path input");
      await pathInput.fill(host.sessions.Missing.cwd);
      await pathInput.press("Enter");
      await expect(
        host.page
          .locator(".notification-list-item-message")
          .filter({ hasText: host.sessions.Missing.cwd })
          .first(),
      ).toBeVisible();
      await expect(frame.locator("#workspace-form")).toBeVisible();
      await expect(frame.locator("#workspace-path")).toHaveValue(host.sessions.Missing.cwd);
      await expect(frame.locator(".new-workspace")).toBeHidden();
      await expect(frame.locator(".workspace-folder-icon")).toBeVisible();
      const status = frame.locator("#status").describe("Workspace registration error");
      await expect(status).toHaveClass("error");
      await expect(status).toContainText(host.sessions.Missing.cwd);
      expect(
        await status.evaluate((element) => {
          const status = element.getBoundingClientRect();
          const input = document.querySelector("#workspace-path")!.getBoundingClientRect();
          return {
            visible: status.top >= 0,
            aboveInput: status.bottom <= input.top,
            gap: innerHeight - input.bottom,
          };
        }),
      ).toEqual({ visible: true, aboveInput: true, gap: 12 });
      await testInfo.attach("無効なパスと入力保持", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
      expect(await frame.locator("section.group").count()).toBe(groupsBefore);
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
    });
    await test.step("Cancel the New workspace form with Escape without changing the list", async () => {
      const frame = await host.sessionFrame();
      const groupsBefore = await frame.locator("section.group").count();
      await frame.locator("#workspace-path").describe("Workspace path input").press("Escape");
      await expect(frame.locator("#workspace-form")).not.toBeVisible();
      await expect(frame.locator(".new-workspace")).toBeVisible();
      await expect(frame.locator(".workspace-folder-icon")).toBeVisible();
      await expect(frame.locator("#workspace-path")).toHaveValue("");
      await testInfo.attach("Escape後のボタン", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
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
  "Unregisters a workspace from the list",
  { annotation: { type: "spec", description: "E2E-11" } },
  async ({ host }, testInfo) => {
    const folder = join(host.directory, "registered");
    await registerWorkFolder(host, folder);

    await test.step("Open and dismiss workspace actions from the keyboard", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      const title = group.locator(".group-title").describe("Workspace menu keyboard trigger");
      const menu = frame.getByRole("menu").describe("Workspace context menu");
      const unregister = menu
        .getByRole("menuitem", { name: "Unregister workspace", exact: true })
        .describe("Workspace Unregister menu item");

      for (const key of ["Shift+F10", "ContextMenu"]) {
        await title.focus();
        await title.press(key);
        await expect(menu).toBeVisible();
        await expect(unregister).toBeFocused();
        await unregister.press("Escape");
        await expect(menu).toBeHidden();
        await expect(title).toBeFocused();
        await expect(group).toHaveCount(1);
      }
    });

    await test.step("Unregister a workspace from the list", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      await expect(
        group.locator("[data-mode-toggle]").describe("Registered workspace mode toggle"),
      ).toBeVisible();
      await expect(
        group.locator(".group-new-session").describe("Registered group New session button"),
      ).toBeVisible();
      await expect(group.locator(".group-unregister")).toHaveCount(0);
      await group
        .locator(".group-header")
        .describe("Registered group context menu trigger")
        .click({ button: "right" });
      const menu = frame.getByRole("menu").describe("Workspace context menu");
      const unregister = menu
        .getByRole("menuitem", { name: "Unregister workspace", exact: true })
        .describe("Workspace Unregister menu item");
      await expect(menu).toBeVisible();
      await expect(unregister).toBeVisible();
      await expect.poll(() => host.snapshot().tabs).toHaveLength(0);
      await testInfo.attach("Unregister menu", {
        body: await host.page.screenshot({ path: testInfo.outputPath("unregister-menu.png") }),
        contentType: "image/png",
      });
      await expect(menu).toBeVisible();
      await expect(unregister).toBeVisible();
      await unregister.click({ steps: 15 });
      await expect(frame.getByRole("dialog").describe("No Unregister confirmation")).toBeHidden();
      await expect(group).toHaveCount(0);
      await expect(menu).toBeHidden();
      for (const session of Object.values(host.sessions)) {
        expect(readFileSync(session.session, "utf8")).toBe(session.original);
      }
      await expect.poll(() => host.snapshot().tabs).toHaveLength(0);
      await testInfo.attach("Workspace unregistered", {
        body: await host.page.screenshot({
          path: testInfo.outputPath("workspace-unregistered.png"),
        }),
        contentType: "image/png",
      });
    });
  },
);

test(
  "セッションのある未登録 cwd を一覧に載せず、削除済みセッションファイルの選択を安全に扱う",
  { annotation: { type: "spec", description: "E2E-7" } },
  async ({ host }) => {
    await test.step("Keep sessions of unregistered work folders out of the list", async () => {
      const frame = await host.sessionFrame();
      // The Missing fixture has a saved session but no workspace registration,
      // so the whitelist list must not show its row at all.
      await expect(frame.locator(`[data-session="${host.sessions.Missing.id}"]`)).toHaveCount(0);
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(host.piProcesses()).toHaveLength(0);
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

test(
  "Archives directly, stops only its Pi and resumes the saved conversation after Unarchive",
  { annotation: { type: "spec", description: "E2E-13" } },
  async ({ host }, testInfo) => {
    const statePath = join(host.directory, "agent/session-state.json");
    const aIsListed = (): boolean => {
      const store = JSON.parse(readFileSync(statePath, "utf8")) as {
        sentinel?: string;
        "active-workspaces": Record<string, { "active-sessions"?: Record<string, unknown> }>;
      };
      const entry = store["active-workspaces"][host.sessions.A.cwd] ?? {};
      return Object.hasOwn(entry["active-sessions"] ?? {}, aId);
    };
    const aId = host.sessions.A.id;
    const rowIn = (frame: Frame, id: string) =>
      frame
        .locator(".session-row")
        .filter({ has: frame.locator(`[data-session="${id}"]`) })
        .describe("Session row");
    let initialA!: ReturnType<VSCodeFixture["piProcesses"]>[number];
    let initialB!: ReturnType<VSCodeFixture["piProcesses"]>[number];
    let sourceA = "";
    let sourceB = "";
    await test.step("Start isolated A and B Pi runtimes and an ordinary fixture tmux session", async () => {
      await host.selectSession("B");
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      initialA = host.piProcesses().find((entry) => entry.cwd === host.sessions.A.cwd)!;
      initialB = host.piProcesses().find((entry) => entry.cwd === host.sessions.B.cwd)!;
      expect(initialA).toBeDefined();
      expect(initialB).toBeDefined();
      sourceA = readFileSync(host.sessions.A.session, "utf8");
      sourceB = readFileSync(host.sessions.B.session, "utf8");
      host.tmux(["new-session", "-d", "-s", "ordinary-fixture", "sleep", "120"]);
      const frame = await host.sessionFrame();
      const toggle = frame
        .locator(`[data-mode-toggle="${host.sessions.A.cwd}"]`)
        .describe("A workspace display mode");
      if ((await toggle.getAttribute("data-mode")) === "all") await toggle.click();
    });
    await test.step("Archive directly, stop only A and view its saved row in All", async () => {
      const frame = await host.sessionFrame();
      await rowIn(frame, aId)
        .locator(`[data-archive="${aId}"]`)
        .describe("A row Archive button")
        .click({ steps: 15 });
      await expect(frame.getByRole("dialog").describe("No Archive confirmation")).toBeHidden();
      await expect(rowIn(frame, aId)).toHaveCount(0);
      await expect.poll(() => existsSync(`/proc/${initialA.pid}`)).toBe(false);
      expect(host.piProcesses().some((entry) => entry.target === initialA.target)).toBe(false);
      expect(
        host.tmux(["list-sessions", "-F", "#{session_name}"]).trim().split("\n"),
      ).not.toContain(initialA.target);
      expect(host.tmux(["list-sessions", "-F", "#{session_name}"])).toContain("ordinary-fixture");
      expect(host.piProcesses().find((entry) => entry.target === initialB.target)?.pid).toBe(
        initialB.pid,
      );
      await expect
        .poll(() => host.snapshot().terminals.filter((terminal) => terminal.owned))
        .toHaveLength(0);
      await expect(
        frame.locator(".session-row.selected").describe("Cleared archive selection"),
      ).toHaveCount(0);
      expect(readFileSync(host.sessions.A.session, "utf8")).toBe(sourceA);
      expect(readFileSync(host.sessions.B.session, "utf8")).toBe(sourceB);
      expect(aIsListed()).toBe(false);
      expect((JSON.parse(readFileSync(statePath, "utf8")) as { sentinel?: string }).sentinel).toBe(
        "preserved",
      );
      await frame
        .locator(`[data-mode-toggle="${host.sessions.A.cwd}"]`)
        .describe("A workspace All toggle")
        .click({ steps: 15 });
      const row = rowIn(frame, aId);
      await expect(row).toHaveClass(/archived/);
      await expect(row.locator(`[data-unarchive="${aId}"]`)).toBeVisible();
      const status = row.locator(".session-status").describe("Archived A empty status slot");
      await expect(status.locator("*")).toHaveCount(0);
      await expect(status).not.toHaveAttribute("data-state");
      await expect(status).toHaveCSS("width", "12px");
      await expect(row.locator(".session-button")).not.toHaveAttribute("title", /Waiting for user/);
      await expect(row.locator(".session-name")).toHaveCSS(
        "color",
        await status.evaluate((element) => getComputedStyle(element).color),
      );
      await host.page
        .locator(".part.sidebar .title-label")
        .describe("Native Sessions title")
        .hover();
      await testInfo.attach("Archive 後（アーカイブ済み行）", {
        body: await host.page.screenshot({ path: testInfo.outputPath("archived.png") }),
        contentType: "image/png",
      });
    });
    await test.step("Unarchive the row and see it back in the default list", async () => {
      const frame = await host.sessionFrame();
      await rowIn(frame, aId)
        .locator(`[data-unarchive="${aId}"]`)
        .describe("Archived A row Unarchive button")
        .click({ steps: 15 });
      const row = rowIn(frame, aId);
      await expect(row).not.toHaveClass(/archived/);
      await expect(row.locator(`[data-archive="${aId}"]`)).toBeVisible();
      const status = row.locator(".session-status").describe("Restored A empty status slot");
      await expect(status.locator("*")).toHaveCount(0);
      await expect(status).not.toHaveAttribute("data-state");
      await expect(status).toHaveCSS("width", "12px");
      await expect(status).toHaveCSS("height", "12px");
      expect(aIsListed()).toBe(true);
      expect(host.piProcesses().some((entry) => entry.target === initialA.target)).toBe(false);
      expect(existsSync(`/proc/${initialA.pid}`)).toBe(false);
      expect(host.snapshot().terminals.filter((terminal) => terminal.owned)).toHaveLength(0);
      expect(readFileSync(host.sessions.A.session, "utf8")).toBe(sourceA);
      expect(readFileSync(host.sessions.B.session, "utf8")).toBe(sourceB);
      expect((JSON.parse(readFileSync(statePath, "utf8")) as { sentinel?: string }).sentinel).toBe(
        "preserved",
      );
      await testInfo.attach("Unarchive 後（未アーカイブ）", {
        body: await host.page.screenshot({ path: testInfo.outputPath("unarchived.png") }),
        contentType: "image/png",
      });
      await frame
        .locator(`[data-mode-toggle="${host.sessions.A.cwd}"]`)
        .describe("A workspace Unarchived toggle")
        .click({ steps: 15 });
      await expect(
        frame.locator(`[data-session="${aId}"]`).describe("A session back in the default view"),
      ).toBeVisible();
    });
    await test.step("Reopen the same saved conversation in a new Pi while retaining saved history and B", async () => {
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      const resumed = host.piProcesses().find((entry) => entry.target === initialA.target)!;
      expect(resumed.pid).not.toBe(initialA.pid);
      expect(
        host.tmux(["display-message", "-p", "-t", resumed.target, "#{pane_start_command}"]).trim(),
      ).toBe(`pi --session ${host.sessions.A.session}`);
      expect(host.piProcesses().find((entry) => entry.target === initialB.target)?.pid).toBe(
        initialB.pid,
      );
      expect(readFileSync(host.sessions.A.session, "utf8").startsWith(sourceA)).toBe(true);
      expect(readFileSync(host.sessions.B.session, "utf8")).toBe(sourceB);
      for (const [cwd, before] of Object.entries(host.gitBefore))
        expect(host.gitState(cwd)).toBe(before);
      await testInfo.attach("Archive runtime and resume evidence", {
        body: JSON.stringify({
          initialA,
          initialB,
          resumed,
          processes: host.piProcesses(),
          terminals: host.snapshot().terminals,
        }),
        contentType: "application/json",
      });
    });
    await test.step("Archive background A while keeping B displayed with its original PID", async () => {
      await host.selectSession("B");
      await host.expectNativeDisplay("B");
      const frame = await host.sessionFrame();
      const displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
      await rowIn(frame, aId)
        .locator(`[data-archive="${aId}"]`)
        .describe("Background A Archive")
        .click();
      await expect(
        frame.getByRole("dialog").describe("No background Archive confirmation"),
      ).toBeHidden();
      await expect(rowIn(frame, aId)).toHaveClass(/archived/);
      await expect(
        frame
          .locator(`.session-row.selected [data-session="${host.sessions.B.id}"]`)
          .describe("B remains displayed"),
      ).toBeVisible();
      expect(host.snapshot().terminals.find((terminal) => terminal.owned)?.pid).toBe(displayPid);
      expect(host.piProcesses().find((entry) => entry.target === initialB.target)?.pid).toBe(
        initialB.pid,
      );
      expect(host.piProcesses().some((entry) => entry.target === initialA.target)).toBe(false);
      expect(host.tmux(["list-sessions", "-F", "#{session_name}"])).toContain("ordinary-fixture");
    });
  },
);

test(
  "Shows execution phase changes for live unarchived sessions",
  {
    annotation: [
      { type: "spec", description: "E2E-14" },
      { type: "spec-section", description: "SPEC.md: execution phase display" },
    ],
  },
  async ({ host }, testInfo) => {
    const statePath = join(host.directory, "agent/session-state.json");
    const workspaceCwd = host.sessions.A.cwd;
    const phases = [
      { key: "A", state: "running", label: "Running", name: "Running" },
      {
        key: "Deleted",
        state: "waiting-approval",
        label: "Waiting for approval",
        name: "Approval",
      },
      { key: "External", state: "waiting-user", label: "Waiting for user", name: "Unread" },
      { key: "B", state: "waiting-user", label: "Waiting for user", name: "Standby" },
    ] as const;
    await test.step("Prepare four conversations in one workspace in update order", async () => {
      const store = JSON.parse(readFileSync(statePath, "utf8")) as SessionStateStoreData;
      const activeSessions = store["active-workspaces"][workspaceCwd]["active-sessions"]!;
      const sessionDirectory = dirname(host.sessions.A.session);
      for (const [index, { key }] of phases.entries()) {
        const fixture = host.sessions[key];
        const entries = fixture.original
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        entries[0].cwd = workspaceCwd;
        entries[0].timestamp = new Date(Date.UTC(2026, 9, 22, 4 - index)).toISOString();
        const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        const session = join(sessionDirectory, basename(fixture.session));
        writeFileSync(session, original);
        if (session !== fixture.session) unlinkSync(fixture.session);
        host.sessions[key] = { ...fixture, cwd: workspaceCwd, session, original };
        activeSessions[fixture.id] = {};
      }
      store["active-workspaces"] = { [workspaceCwd]: { "active-sessions": activeSessions } };
      writeFileSync(statePath, JSON.stringify(store));
      const frame = await host.sessionFrame();
      await host.refreshSessions();
      await expect(
        frame.locator("section.group").describe("Only the shared workspace"),
      ).toHaveCount(1);
      await expect(
        frame.locator(".session-row").describe("Four prepared conversations"),
      ).toHaveCount(4);
    });
    await test.step("Open four existing conversations in live panes", async () => {
      for (const { key } of phases) {
        await host.selectSession(key);
        await host.expectNativeDisplay(key);
      }
      const frame = await host.sessionFrame();
      for (const toggle of await frame.locator(".group-header [data-mode-toggle]").all()) {
        if ((await toggle.getAttribute("data-mode")) === "all") {
          await toggle.describe("Workspace Unarchived toggle").click({ steps: 15 });
        }
      }
    });

    async function expectPhase(
      key: string,
      { state, label, hasUnread = false }: (typeof phases)[number] & { hasUnread?: boolean },
    ) {
      expect(host.sessionRuntime(key)).toBeDefined();
      const frame = await host.sessionFrame();
      const row = frame
        .locator(".session-row")
        .filter({ has: frame.locator(`[data-session="${host.sessions[key].id}"]`) })
        .describe(`Live ${key} session row`);
      const status = row.locator(".session-status").describe(`${key} ${state} status slot`);
      await expect(row).toBeVisible();
      await expect(row).not.toHaveClass(/archived/);
      await expect(status).toHaveAttribute("data-state", state);
      await expect(status).toHaveAttribute("data-unread", String(hasUnread));
      await expect(status).toHaveCSS("width", "12px");
      await expect(status).toHaveCSS("height", "12px");
      await expect(row.locator(".session-button")).toHaveAttribute("title", new RegExp(label));
      if (hasUnread)
        await expect(row.locator(".session-button")).toHaveAttribute("title", /Unread/);
      else await expect(row.locator(".session-button")).not.toHaveAttribute("title", /Unread/);
      if (state === "waiting-user" && !hasUnread) {
        await expect(status.locator("svg").describe(`${key} has no status icon`)).toHaveCount(0);
        return;
      }
      const icon = status.locator("svg").describe(`${key} ${state} icon`);
      await expect(icon).toBeVisible();
      await expect(icon).toHaveAttribute("fill", "none");
      await expect(icon).toHaveAttribute("stroke", "currentColor");
      if (state === "running") {
        await expect(icon.locator("path")).toHaveAttribute("d", "M21 12a9 9 0 1 1-6.219-8.56");
        await expect(icon).toHaveCSS("animation-name", "session-spin");
        await host.page.emulateMedia({ reducedMotion: "reduce" });
        await expect(icon).toHaveCSS("animation-name", "none");
        await host.page.emulateMedia({ reducedMotion: "no-preference" });
        await expect(icon).toHaveCSS("animation-name", "session-spin");
      } else {
        await expect(icon.locator("path")).toHaveCount(2);
        const expectedPaths =
          state === "waiting-approval"
            ? ["M9 4v16", "M15 4v16"]
            : ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9", "M10 21a2 2 0 0 0 4 0"];
        for (const [index, path] of expectedPaths.entries()) {
          await expect(icon.locator("path").nth(index)).toHaveAttribute("d", path);
        }
        await expect(icon).toHaveCSS("animation-name", "none");
      }
    }

    for (const phase of phases.slice(0, 3)) {
      await test.step(`Show ${phase.state} for live A (SPEC execution phase display)`, async () => {
        const store = JSON.parse(readFileSync(statePath, "utf8")) as SessionStateStoreData;
        store["active-workspaces"][host.sessions.A.cwd]["active-sessions"]![
          host.sessions.A.id
        ].state = phase.state;
        writeFileSync(statePath, JSON.stringify(store));
        await expectPhase("A", { ...phase, hasUnread: phase.state === "waiting-user" });
      });
    }

    async function openLiveSession(key: string) {
      const frame = await host.sessionFrame();
      await frame
        .locator(`[data-session="${host.sessions[key].id}"] .session-name`)
        .describe(`${key} live session name`)
        .click({ steps: 15 });
      await host.expectNativeDisplay(key);
    }

    await test.step("Open the unread completion and clear its bell", async () => {
      await openLiveSession("A");
      await expectPhase("A", phases[2]);
      await openLiveSession("External");
      await expectPhase("A", phases[2]);
    });

    await test.step("Complete a displayed run as read and keep it read after switching away", async () => {
      await openLiveSession("A");
      for (const phase of [phases[0], phases[2]]) {
        const store = JSON.parse(readFileSync(statePath, "utf8")) as SessionStateStoreData;
        store["active-workspaces"][host.sessions.A.cwd]["active-sessions"]![
          host.sessions.A.id
        ].state = phase.state;
        writeFileSync(statePath, JSON.stringify(store));
        await expectPhase("A", phase);
      }
      await openLiveSession("External");
      await expectPhase("A", phases[2]);
    });

    await test.step("Show running, approval, unread, and read standby in one workspace without a conversation display", async () => {
      await host.closePiDisplay();
      const store = JSON.parse(readFileSync(statePath, "utf8")) as SessionStateStoreData;
      const unreadSession = host.sessions.External;
      store["active-workspaces"][unreadSession.cwd]["active-sessions"]![unreadSession.id].state =
        "running";
      writeFileSync(statePath, JSON.stringify(store));
      await expectPhase("External", phases[0]);
      for (const phase of phases) {
        const { cwd, id, session } = host.sessions[phase.key];
        expect(cwd).toBe(workspaceCwd);
        store["active-workspaces"][cwd]["active-sessions"]![id].state = phase.state;
        appendFileSync(
          session,
          JSON.stringify({
            type: "session_info",
            id: randomUUID().slice(0, 8),
            parentId: null,
            timestamp: new Date().toISOString(),
            name: phase.name,
          }) + "\n",
        );
      }
      writeFileSync(statePath, JSON.stringify(store));
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .describe("Shared workspace with all four states");
      await expect(group).toHaveCount(1);
      await expect(group.locator(".group-header")).toHaveAttribute("title", workspaceCwd);
      await expect(group.locator("[data-mode-toggle]")).toHaveAttribute("data-mode", "unarchived");
      await expect(group.locator(".session-name").describe("States in update order")).toHaveText(
        phases.map((phase) => phase.name),
      );
      for (const phase of phases) {
        await expectPhase(phase.key, { ...phase, hasUnread: phase.key === "External" });
        await expect(
          group.locator(`[data-session="${host.sessions[phase.key].id}"]`),
        ).toBeVisible();
      }
      await expect(
        group.locator(".session-status[data-state]").describe("Four live states in the same group"),
      ).toHaveCount(4);
      await expect.poll(() => host.snapshot().tabs).toHaveLength(0);
      await host.page
        .locator(".part.sidebar .title-label")
        .describe("Native Sessions title")
        .hover();
      await testInfo.attach("running / waiting-approval / unread completion / read standby", {
        body: await host.page.screenshot({
          path: testInfo.outputPath("session-list-phases.png"),
        }),
        contentType: "image/png",
      });
    });
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
  const pathInput = frame.locator("#workspace-path").describe("Workspace path input");
  await pathInput.fill(folder);
  await pathInput.press("Enter");
  await expect(
    frame
      .locator("section.group")
      .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
      .describe("Registered work folder group"),
  ).toBeVisible();
}
