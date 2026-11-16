import { execFileSync } from "node:child_process";
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
import { setTimeout as sleep } from "node:timers/promises";
import type { Frame } from "playwright/test";
import { expect, test, type VSCodeFixture } from "../support/vscode";
import { PiMux } from "../../src/piMux";
import {
  FIXTURE_MODEL,
  FIXTURE_PROMPT,
  FIXTURE_PROVIDER,
  FIXTURE_REPLY,
} from "../support/fixedResponseProvider";

/** One recorded #status mutation while a workspace registration error arrives. */
interface RegistrationStatusObservation {
  className: string;
  text: string;
  status?: { top: number; bottom: number };
  input?: { top: number; bottom: number };
  viewportHeight?: number;
}

test.use({ trace: "on" });

test(
  "Shows saved history with workspace All alongside a prewarmed unsaved Pi",
  { annotation: { type: "spec", description: "E2E-1" } },
  async ({ host }, testInfo) => {
    await test.step("Inspect work folder groups and hidden prewarmed Unarchived rows", async () => {
      const frame = await host.sessionFrame();
      await expect(
        frame.locator(".session-row").describe("Unsaved prewarmed Pi rows stay hidden"),
      ).toHaveCount(0);
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
      await expect(emptyGroup.locator(`[data-session="${host.sessions.B.id}"]`)).toHaveCount(0);
      await expect(emptyGroup.locator(".empty")).toHaveCount(0);
      await expect(frame.locator(".group-path")).toHaveCount(0);
      await expect(frame.locator("#app header [data-mode-toggle]")).toHaveCount(0);
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
        };
      });
      const geometryPath = testInfo.outputPath("sidebar-geometry.json");
      writeFileSync(geometryPath, JSON.stringify({ layout }, null, 2));
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

for (const theme of ["Dark Modern", "Light Modern"]) {
  test(
    `Keeps compact workspace headers and balanced session backgrounds across selection states in ${theme}`,
    { annotation: { type: "design", description: "DESIGN.md: session row hierarchy" } },
    async ({ host }, testInfo) => {
      await test.step(`Check session background geometry in ${theme}`, async () => {
        await host.page.keyboard.press("Control+Shift+P");
        const picker = host.page.locator(".quick-input-widget input").describe("Theme picker");
        await picker.fill(">Preferences: Color Theme");
        await host.page.getByRole("option", { name: /Preferences: Color Theme/ }).click();
        await picker.fill(theme);
        await host.page.getByRole("option", { name: theme, exact: true }).click();
        await host.activateSession("A");
        await host.activateSession("Deleted");
        const frame = await host.sessionFrame();
        await expect(frame.locator("body")).toHaveClass(
          theme.includes("Light") ? /vscode-light/ : /vscode-dark/,
        );
        const mode = frame.locator(`[data-mode-toggle="${host.sessions.A.cwd}"]`);
        if ((await mode.getAttribute("data-mode")) === "unarchived") await mode.click();
        await expect(
          frame.locator(".session-row").describe("Saved A and Deleted conversation rows"),
        ).toHaveCount(2);
        const button = frame
          .locator(`[data-session="${host.sessions.A.id}"]`)
          .describe("Session background and focus target");
        await host.expectPiVisible(host.sessions.A.cwd);

        async function appearance() {
          return button.evaluate((element) => {
            function rect(target: Element) {
              const { left, right, top, bottom, width, height } = target.getBoundingClientRect();
              return { left, right, top, bottom, width, height };
            }
            function tokenColor(name: string) {
              const sample = document.createElement("span");
              sample.style.color = `var(${name})`;
              document.body.append(sample);
              const color = getComputedStyle(sample).color;
              sample.remove();
              return color;
            }
            const row = element.closest(".session-row")!;
            const style = getComputedStyle(element);
            const paint = getComputedStyle(element, "::before");
            const box = element.getBoundingClientRect();
            const paintLeft = box.left + parseFloat(style.borderLeftWidth) + parseFloat(paint.left);
            return {
              button: rect(element),
              paint: {
                left: paintLeft,
                right: paintLeft + parseFloat(paint.width),
                height: parseFloat(paint.height),
              },
              workspaceName: rect(row.closest(".group")!.querySelector(".group-title")!),
              chevron: rect(row.closest(".group")!.querySelector(".group-chevron")!),
              chevronIcon: rect(row.closest(".group")!.querySelector(".group-chevron svg")!),
              name: rect(row.querySelector(".session-name")!),
              status: rect(row.querySelector(".session-status")!),
              timestamp: rect(row.querySelector(".session-timestamp")!),
              archive: rect(row.querySelector(".archive, .unarchive")!),
              buttonBackground: style.backgroundColor,
              buttonOutline: style.outlineStyle,
              background: paint.backgroundColor,
              outlineStyle: paint.outlineStyle,
              outlineWidth: paint.outlineWidth,
              outlineOffset: paint.outlineOffset,
              pointerEvents: paint.pointerEvents,
              content: paint.content,
              isolation: style.isolation,
              zIndex: paint.zIndex,
              hoverColor: tokenColor("--vscode-list-hoverBackground"),
              activeColor: tokenColor("--vscode-list-activeSelectionBackground"),
              inactiveColor: tokenColor("--vscode-list-inactiveSelectionBackground"),
              viewportWidth: innerWidth,
            };
          });
        }

        await host.page.locator(".part.sidebar .title-label").hover();
        const idle = await appearance();
        expect(idle.button.left).toBe(4);
        expect(idle.name.left).toBe(29);
        expect(idle.status.left).toBe(9);
        expect(idle.paint.left).toBe(idle.button.left);
        expect(idle.name.left).toBe(idle.workspaceName.left + 1);
        expect(idle.workspaceName.left).toBe(28);
        expect(idle.chevron.left).toBe(4);
        expect(idle.chevron.width).toBe(24);
        expect(idle.chevron.height).toBe(24);
        expect(idle.chevronIcon.left).toBe(10);
        expect(idle.workspaceName.left - idle.chevron.right).toBe(0);
        expect(idle.paint.right).toBe(idle.button.right);
        expect(idle.paint.height).toBe(32);
        expect(idle.pointerEvents).toBe("none");
        expect(idle.content).toBe('""');
        expect(idle.isolation).toBe("isolate");
        expect(idle.zIndex).toBe("-1");
        expect(idle.button.right).toBe(idle.viewportWidth - 12);
        expect(idle.timestamp.right).toBe(idle.button.right - 36);
        expect(idle.archive.right).toBe(idle.button.right - 4);
        await button.hover();
        await expect.poll(async () => (await appearance()).background).toBe(idle.hoverColor);
        const hover = await appearance();
        await button.focus();
        await host.page.keyboard.press("Tab");
        await host.page.keyboard.press("Shift+Tab");
        await expect(button).toBeFocused();
        const focus = await appearance();
        expect(focus.buttonOutline).toBe("none");
        expect(focus.outlineStyle).toBe("solid");
        expect(focus.outlineWidth).toBe("2px");
        expect(focus.outlineOffset).toBe("-2px");
        await button.press("Enter");
        await expect(button.locator("..")).toHaveClass(/selected/);
        await host.page.locator(".part.sidebar .title-label").hover();
        await button.blur();
        await expect.poll(async () => (await appearance()).background).toBe(idle.inactiveColor);
        const selected = await appearance();
        await button.focus();
        await expect.poll(async () => (await appearance()).background).toBe(idle.activeColor);
        const selectedFocus = await appearance();
        for (const state of [hover, focus, selected, selectedFocus]) {
          expect(state.buttonBackground).toBe("rgba(0, 0, 0, 0)");
          expect(state.button).toEqual(idle.button);
          expect(state.paint).toEqual(idle.paint);
          expect(state.name).toEqual(idle.name);
          expect(state.status).toEqual(idle.status);
          expect(state.timestamp).toEqual(idle.timestamp);
          expect(state.archive).toEqual(idle.archive);
        }
        await testInfo.attach(`${theme} session states`, {
          body: JSON.stringify({ idle, hover, focus, selected, selectedFocus }, null, 2),
          contentType: "application/json",
        });
        await button.blur();
        await expect.poll(async () => (await appearance()).background).toBe(idle.inactiveColor);
        await testInfo.attach(`${theme} selected`, {
          body: await host.page.screenshot({ path: testInfo.outputPath("selected.png") }),
          contentType: "image/png",
        });
        await host.selectSession("A");
        await host.expectPiVisible(host.sessions.A.cwd);
        await host.closePiDisplay();
        host.setSessionPhase("A", "waiting-approval");
        const status = button
          .locator(".session-status")
          .describe("Approval icon to the left of the session name");
        await expect(status).toHaveAttribute("data-state", "waiting-approval");
        await expect(status.locator("svg")).toBeVisible();
        await button.blur();
        await expect.poll(async () => (await appearance()).background).toBe(idle.inactiveColor);
        const approval = await appearance();
        expect(approval.status).toEqual(idle.status);
        expect(approval.name).toEqual(idle.name);
        expect(approval.paint).toEqual(idle.paint);
        expect(approval.status.left).toBeGreaterThan(approval.paint.left);
        expect(
          await status.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              document
                .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
                ?.closest(".session-button") === element.closest(".session-button")
            );
          }),
        ).toBe(true);
        await testInfo.attach(`${theme} approval icon and selected`, {
          body: await host.page.screenshot({
            path: testInfo.outputPath("approval-selected.png"),
          }),
          contentType: "image/png",
        });
      });
    },
  );
}

test(
  "Switches between A/B conversations with Pi-notified titles",
  { annotation: { type: "spec", description: "E2E-2" } },
  async ({ host }, testInfo) => {
    testInfo.setTimeout(150_000);
    const firstPids = new Map<string, number>();
    const selections = ["A", "B", "A", "B"];
    await host.activateSession("A");
    await host.activateSession("B");
    for (const [index, key] of selections.entries()) {
      const isLastSelection = index === selections.length - 1;
      await test.step(`Select ${key} and open its Pi terminal`, async () => {
        await host.selectSession(key);
      });
      await test.step(`Check the real ${key} Pi process cwd and PID reuse`, async () => {
        await expect.poll(() => host.sessionRuntime(key)).toBeDefined();
        const matches = host
          .piProcesses()
          .filter((process) => process.target === host.sessionRuntime(key)?.target);
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
        const runtime = host.sessionRuntime(key)!;
        const startCommand = host
          .tmux(["display-message", "-p", "-t", runtime.target, "#{pane_start_command}"])
          .trim();
        const encoded = host
          .tmux(["display-message", "-p", "-t", runtime.target, "#{@pi-tmux-session}"])
          .trim();
        const metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        const sessionPath = metadata.file;
        expect(metadata).toMatchObject({
          id: host.sessions[key].id,
          file: host.sessions[key].session,
          cwd: runtime.cwd,
          pid: runtime.pid,
          startup: "ready",
        });
        expect(startCommand).toContain(host.sessions[key].session);
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
          .filter((entry) => [...firstPids.values()].includes(entry.pid))
          .map((entry) => entry.pid)
          .sort(),
      ).toEqual([...firstPids.values()].sort());
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      expect(host.sessionRuntime("A")?.pid).toBe(firstPids.get("A"));
      await host.selectSession("B");
      await host.expectNativeDisplay("B");
      expect(host.sessionRuntime("B")?.pid).toBe(firstPids.get("B"));
    });
    await test.step("Switch same-cwd conversations without replacing the display or their Pi processes", async () => {
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      await host.activateSession("Deleted");
      await host.expectNativeDisplay("Deleted");
      const displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
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
    await test.step("Rediscover existing Pi and keep native title forwarding after extension host restart", async () => {
      const pids = host
        .piProcesses()
        .map((entry) => entry.pid)
        .sort();
      const runtime = host.piProcesses().find((entry) => entry.pid === firstPids.get("A"))!;
      await host.restartExtensionHost();
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      expect(
        host.tmux(["show-options", "-A", "-v", "-t", runtime.target, "set-titles"]).trim(),
      ).toBe("on");
      expect(
        host.tmux(["show-options", "-A", "-v", "-t", runtime.target, "set-titles-string"]).trim(),
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
      expect(host.sessionRuntime("B")?.pid).toBe(firstPids.get("B"));
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
    await expect.poll(() => host.piProcesses().length).toBe(3);
    const baseline = host
      .piProcesses()
      .map(({ pid }) => pid)
      .sort((a, b) => a - b);
    await test.step("Discard the workspace draft when focus moves to the editor", async () => {
      await host.page.keyboard.press("Control+N");
      const editor = host.page
        .locator(".editor-instance .monaco-editor")
        .first()
        .describe("Untitled editor focus target");
      await expect(editor).toBeVisible();
      const frame = await host.sessionFrame();
      const groupsBefore = await frame.locator("section.group").count();
      const button = frame.locator(".new-workspace").describe("New workspace footer button");
      const input = frame.locator("#workspace-path").describe("Workspace path input");
      await button.click({ steps: 15 });
      await input.fill(host.sessions.Missing.cwd);
      await editor.click({ position: { x: 80, y: 40 } });
      await expect(frame.locator("#workspace-form")).toBeHidden();
      await expect(button).toBeVisible();
      await expect(input).toHaveValue("");
      await expect(editor).toHaveClass(/focused/);
      expect(await frame.locator("section.group").count()).toBe(groupsBefore);
      expect(host.snapshot().terminals).toHaveLength(0);
      await testInfo.attach("Workspace draft discarded after editor focus", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
      await button.click({ steps: 15 });
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await input.press("Escape");
    });
    await test.step("Reject a missing workspace path with a safe error", async () => {
      const frame = await host.sessionFrame();
      const groupsBefore = await frame.locator("section.group").count();
      await frame
        .locator('[data-action="toggleWorkspaceForm"]')
        .describe("New workspace footer button")
        .click({ steps: 15 });
      const pathInput = frame.locator("#workspace-path").describe("Workspace path input");
      await pathInput.fill(host.sessions.Missing.cwd);
      // The registration error in #status is transient: the periodic list
      // refresh delivers a new list and clears it within about a second.
      // Record the status element before submitting so the assertions do
      // not race the next refresh.
      await frame.evaluate(() => {
        const status = document.querySelector("#status")!;
        const observed: RegistrationStatusObservation[] = [];
        Object.defineProperty(window, "__registrationStatus", {
          value: observed,
          configurable: true,
        });
        new MutationObserver(() => {
          const entry: RegistrationStatusObservation = {
            className: status.className,
            text: status.textContent ?? "",
          };
          if (status.className === "error") {
            const box = status.getBoundingClientRect();
            const input = document.querySelector("#workspace-path")!.getBoundingClientRect();
            entry.status = { top: box.top, bottom: box.bottom };
            entry.input = { top: input.top, bottom: input.bottom };
            entry.viewportHeight = innerHeight;
          }
          observed.push(entry);
        }).observe(status, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
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
      await expect
        .poll(() =>
          frame.evaluate((path) => {
            const observed =
              (
                window as unknown as {
                  __registrationStatus?: { className: string; text: string }[];
                }
              ).__registrationStatus ?? [];
            return observed.some(
              ({ className, text }) => className === "error" && text.includes(path!),
            );
          }, host.sessions.Missing.cwd),
        )
        .toBe(true);
      const errored = await frame.evaluate((path) => {
        const observed =
          (
            window as unknown as {
              __registrationStatus?: RegistrationStatusObservation[];
            }
          ).__registrationStatus ?? [];
        return observed.find(
          ({ className, text }) => className === "error" && text.includes(path!),
        );
      }, host.sessions.Missing.cwd);
      expect(errored).toBeDefined();
      expect(errored!.status!.top).toBeGreaterThanOrEqual(0);
      expect(errored!.status!.bottom).toBeLessThanOrEqual(errored!.input!.top);
      expect(errored!.viewportHeight! - errored!.input!.bottom).toBe(12);
      await testInfo.attach("無効なパスと入力保持", {
        body: await host.page.screenshot(),
        contentType: "image/png",
      });
      expect(await frame.locator("section.group").count()).toBe(groupsBefore);
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(
        host
          .piProcesses()
          .map(({ pid }) => pid)
          .sort((a, b) => a - b),
      ).toEqual(baseline);
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
      expect(
        host
          .piProcesses()
          .map(({ pid }) => pid)
          .sort((a, b) => a - b),
      ).toEqual(baseline);
    });
  },
);

test(
  "登録済みワークスペースの New session で、その cwd で新しい Pi を起動できる",
  { annotation: { type: "spec", description: "E2E-10" } },
  async ({ host }, testInfo) => {
    const folder = join(host.directory, "registered");
    await registerWorkFolder(host, folder);

    await test.step("Display a saved session before launching a new one", async () => {
      await host.selectSession("A");
      await host.expectPiVisible(host.sessions.A.cwd);
      const frame = await host.sessionFrame();
      await expect(
        frame
          .locator(".session-row.selected")
          .filter({ has: frame.locator(`[data-session="${host.sessions.A.id}"]`) })
          .describe("Displayed saved session selection"),
      ).toHaveCount(1);
    });

    await test.step("Launch Pi from the registered group plus button", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      const newSession = group
        .locator(".group-new-session")
        .describe("Registered group New session button");
      await newSession.evaluate((button) => {
        button.setAttribute("data-observed-busy", "false");
        new MutationObserver((changes) => {
          if (
            button.getAttribute("aria-busy") === "true" ||
            changes.some((change) => change.oldValue === "true")
          )
            button.setAttribute("data-observed-busy", "true");
        }).observe(button, {
          attributes: true,
          attributeFilter: ["aria-busy"],
          attributeOldValue: true,
        });
      });
      await newSession.click({ steps: 15 });
      await expect
        .poll(() => host.piProcesses().some((process) => process.cwd === folder))
        .toBe(true);
      await host.expectPiVisible(folder);
      await expect(newSession).toHaveAttribute("data-observed-busy", "true");
      await expect(newSession).toHaveAttribute("aria-busy", "false");
      await expect(
        frame
          .locator(".session-row.selected")
          .describe("No selected rows while the new session is unsaved"),
      ).toHaveCount(0);
      const runtime = host.piProcesses().find((entry) => entry.cwd === folder)!;
      const encoded = host
        .tmux(["display-message", "-p", "-t", runtime.target, "#{@pi-tmux-session}"])
        .trim();
      const metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      await expect
        .poll(() =>
          host
            .listWorkspaces()
            .find(({ cwd }) => cwd === folder)
            ?.empty.map(({ id }) => id),
        )
        .toEqual([metadata.id]);
      expect(existsSync(metadata.file)).toBe(false);
      await expect(
        group.locator(".session-row").describe("Unsaved new session rows stay hidden"),
      ).toHaveCount(0);
      const displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
      await group.locator(".group-new-session").click();
      await host.expectPiVisible(folder);
      await expect
        .poll(() => host.snapshot().terminals.find((terminal) => terminal.owned)?.pid)
        .toBe(displayPid);
      expect(host.piProcesses().filter((entry) => entry.cwd === folder)).toEqual([runtime]);
      expect(existsSync(metadata.file)).toBe(false);
      const otherCwd = host.sessions.B.cwd;
      await frame
        .locator(`.group-header[title="${otherCwd}"] .group-new-session`)
        .describe("Other cwd New session")
        .click();
      await host.expectPiVisible(otherCwd);
      const other = host.piProcesses().find((entry) => entry.cwd === otherCwd)!;
      expect(other.pid).not.toBe(runtime.pid);
      expect(host.piProcesses().filter((entry) => entry.cwd === folder)).toEqual([runtime]);
      await group.locator(".group-new-session").click();
      await host.expectPiVisible(folder);
      expect(host.piProcesses().filter((entry) => entry.cwd === folder)).toEqual([runtime]);
      expect(existsSync(metadata.file)).toBe(false);
      await testInfo.attach("Unsaved same-cwd session reuse", {
        body: JSON.stringify({
          metadata,
          runtime,
          snapshot: host.snapshot(),
          workspaces: host.listWorkspaces(),
        }),
        contentType: "application/json",
      });
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

    await test.step("Toggle workspace actions and dismiss the context menu with the pointer", async () => {
      const frame = await host.sessionFrame();
      const group = frame
        .locator("section.group")
        .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
        .describe("Registered work folder group");
      const header = group.locator(".group-header").describe("Workspace context menu trigger");
      const trigger = group.locator(".group-workspace-menu").describe("Workspace menu toggle");
      const menu = frame.getByRole("menu").describe("Workspace context menu");
      for (const expanded of [true, false, true]) {
        await trigger.click();
        await expect(menu).toHaveCount(expanded ? 1 : 0);
        await expect(trigger).toHaveAttribute("aria-expanded", String(expanded));
      }
      await trigger.click();
      await header.click({ button: "right" });
      await expect(menu).toBeVisible();
      await frame.locator("#app").click({ position: { x: 0, y: 0 } });
      await expect(menu).toBeHidden();
      await expect(group).toHaveCount(1);
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
        .getByRole("button", { name: "Workspace actions", exact: true })
        .describe("Registered group ellipsis menu trigger")
        .click();
      const menu = frame.getByRole("menu").describe("Workspace actions menu");
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
      await expect
        .poll(() => host.piProcesses().filter(({ cwd }) => cwd === folder))
        .toHaveLength(1);
      await expect
        .poll(() => host.piProcesses().filter(({ cwd }) => cwd !== folder))
        .toHaveLength(3);
      const otherPids = host
        .piProcesses()
        .filter(({ cwd }) => cwd !== folder)
        .map(({ pid }) => pid)
        .sort((a, b) => a - b);
      await unregister.click({ steps: 15 });
      await expect(frame.getByRole("dialog").describe("No Unregister confirmation")).toBeHidden();
      await expect(group).toHaveCount(0);
      await expect
        .poll(() => host.piProcesses().filter(({ cwd }) => cwd === folder))
        .toHaveLength(0);
      host.piMux(["restore"]);
      expect(host.listWorkspaces().some(({ cwd }) => cwd === folder)).toBe(false);
      expect(
        host
          .piProcesses()
          .map(({ pid }) => pid)
          .sort((a, b) => a - b),
      ).toEqual(otherPids);
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
  "Excludes unregistered cwd history and automatically removes a deleted saved conversation",
  { annotation: { type: "spec", description: "E2E-7" } },
  async ({ host }) => {
    await expect.poll(() => host.piProcesses().length).toBe(3);
    const baseline = host
      .piProcesses()
      .map(({ pid }) => pid)
      .sort((a, b) => a - b);
    await test.step("Keep sessions of unregistered work folders out of the list", async () => {
      const frame = await host.sessionFrame();
      // The Missing fixture has a saved session but no workspace registration,
      // so the whitelist list must not show its row at all.
      await expect(frame.locator(`[data-session="${host.sessions.Missing.id}"]`)).toHaveCount(0);
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(
        host
          .piProcesses()
          .map(({ pid }) => pid)
          .sort((a, b) => a - b),
      ).toEqual(baseline);
    });
    await test.step("Delete only the dummy saved session and observe its automatic removal", async () => {
      const frame = await host.sessionFrame();
      const mode = frame.locator(`[data-mode-toggle="${host.sessions.Deleted.cwd}"]`);
      if ((await mode.getAttribute("data-mode")) === "unarchived") await mode.click();
      const row = frame
        .locator(`[data-session="${host.sessions.Deleted.id}"]`)
        .describe("Deleted saved conversation");
      await expect(row).toBeVisible();
      unlinkSync(host.sessions.Deleted.session);
      await expect(row).toHaveCount(0);
      expect(host.snapshot().terminals).toHaveLength(0);
      expect(
        host
          .piProcesses()
          .map(({ pid }) => pid)
          .sort((a, b) => a - b),
      ).toEqual(baseline);
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

test.describe("First assistant response through a loopback fixture provider", () => {
  test.use({ fixedResponse: true });

  test(
    "Lists the new session after real Pi saves its first assistant response and reuses its Terminal",
    {
      annotation: [
        { type: "spec", description: "E2E-9" },
        {
          type: "scope",
          description:
            "Real Pi processes and saves a fixed loopback HTTP response. This does not test model inference or an external provider.",
        },
      ],
    },
    async ({ host }, testInfo) => {
      const folder = host.sessions.A.cwd;
      const mux = new PiMux(async (_executable, args) => host.piMux(args));
      let session!: NonNullable<Awaited<ReturnType<PiMux["current"]>>>;
      let runtime!: ReturnType<VSCodeFixture["piProcesses"]>[number];
      let displayPid = 0;
      const existingSources = new Map<string, string>();

      function savedEntries(): Record<string, unknown>[] {
        if (!existsSync(session.file)) return [];
        const source = readFileSync(session.file, "utf8");
        return source
          .slice(0, source.lastIndexOf("\n"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      }

      await test.step("Open a new Pi from its workspace and record its unsaved session ID", async () => {
        await expect.poll(() => host.piProcesses().length, { timeout: 30_000 }).toBe(3);
        await host.activateSession("B");
        await expect.poll(() => host.sessionRuntime("B")).toBeDefined();
        const frame = await host.sessionFrame();
        const group = frame
          .locator("section.group")
          .filter({ has: frame.locator(`.group-header[title="${folder}"]`) })
          .describe("New conversation workspace");
        await group
          .locator(".group-new-session")
          .describe("New session button")
          .click({ steps: 15 });
        await host.page.locator(".terminal.xterm").describe("Focus the Pi Terminal").click();
        await host.expectPiVisible(folder);
        displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
        await expect.poll(() => mux.current(displayPid)).toMatchObject({ cwd: folder });
        session = (await mux.current(displayPid))!;
        runtime = host.piProcesses().find((process) => process.target === session.target)!;
        expect(runtime).toMatchObject({ cwd: folder });
        expect(existsSync(session.file)).toBe(false);
        expect(Object.values(host.sessions).map(({ id }) => id)).not.toContain(session.id);
        await expect(group.locator(".session-row")).toHaveCount(0);
        await expect(frame.locator(".session-row.selected")).toHaveCount(0);
        await expect(
          host.page.locator(".terminal.xterm").describe("Real Pi TUI with the fixture model"),
        ).toContainText(FIXTURE_MODEL);
        for (const fixture of Object.values(host.sessions)) {
          const source = readFileSync(fixture.session, "utf8");
          expect(source.startsWith(fixture.original)).toBe(true);
          existingSources.set(fixture.session, source);
        }
      });

      await test.step("Send a prompt through the Terminal and let real Pi save a successful assistant reply", async () => {
        const input = host.page
          .getByRole("textbox", { name: /^Terminal [0-9]+/ })
          .describe("Real Pi prompt input");
        await input.pressSequentially(FIXTURE_PROMPT, { delay: 120 });
        await input.press("Enter");
        await expect
          .poll(() => savedEntries())
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "session", id: session.id, cwd: folder }),
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({
                  role: "user",
                  content: expect.arrayContaining([{ type: "text", text: FIXTURE_PROMPT }]),
                }),
              }),
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({
                  role: "assistant",
                  provider: FIXTURE_PROVIDER,
                  model: FIXTURE_MODEL,
                  stopReason: "stop",
                  content: [{ type: "text", text: FIXTURE_REPLY }],
                }),
              }),
            ]),
          );
        expect(host.responseProvider?.requests).toEqual([{ model: FIXTURE_MODEL, stream: true }]);
        await expect(
          host.page.locator(".terminal.xterm").describe("Saved Pi reply in the TUI"),
        ).toContainText(FIXTURE_REPLY);
      });

      await test.step("Find the unarchived selected row without Refresh and match its public Terminal session", async () => {
        const frame = await host.sessionFrame();
        const row = frame
          .locator(".session-row")
          .filter({ has: frame.locator(`[data-session="${session.id}"]`) })
          .describe("Automatically detected new conversation");
        await expect(frame.locator(`[data-mode-toggle="${folder}"]`)).toHaveAttribute(
          "data-mode",
          "unarchived",
        );
        await expect(row).toBeVisible();
        await expect(row).not.toHaveClass(/archived/);
        await expect(row).toHaveClass(/selected/);
        await expect(frame.locator(".session-row.selected")).toHaveCount(1);
        await expect
          .poll(() => mux.current(displayPid))
          .toMatchObject({
            id: session.id,
            cwd: folder,
            file: session.file,
          });
        const saved = host.listWorkspaces().find(({ cwd }) => cwd === folder)!.sessions;
        expect(saved).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: session.id, file: session.file })]),
        );
      });

      await test.step("Switch away and reselect the saved conversation without replacing Pi or its Terminal", async () => {
        const original = readFileSync(session.file, "utf8");
        await host.selectSession("B");
        await expect.poll(async () => (await mux.current(displayPid))?.id).toBe(host.sessions.B.id);
        const frame = await host.sessionFrame();
        await frame
          .locator(`[data-session="${session.id}"] .session-name`)
          .describe("Reselect the new saved conversation")
          .click({ steps: 15 });
        await host.page
          .locator(".terminal.xterm")
          .describe("Focus the reselected Pi Terminal")
          .click();
        await host.expectPiVisible(folder);
        await expect
          .poll(() => mux.current(displayPid))
          .toMatchObject({
            id: session.id,
            cwd: folder,
            file: session.file,
          });
        expect(
          host
            .snapshot()
            .terminals.filter((terminal) => terminal.owned)
            .map(({ pid }) => pid),
        ).toEqual([displayPid]);
        expect(host.piProcesses().find((process) => process.pid === runtime.pid)).toMatchObject({
          pid: runtime.pid,
          cwd: folder,
        });
        await expect(
          frame.locator(`.session-row.selected [data-session="${session.id}"]`),
        ).toBeVisible();
        expect(readFileSync(session.file, "utf8")).toBe(original);
        for (const [file, before] of existingSources)
          expect(readFileSync(file, "utf8")).toBe(before);
        for (const [cwd, before] of Object.entries(host.gitBefore))
          expect(host.gitState(cwd)).toBe(before);
        await testInfo.attach(
          "First assistant session evidence (fixed response, not model inference)",
          {
            body: JSON.stringify(
              {
                endpoint: host.responseProvider?.baseUrl,
                requests: host.responseProvider?.requests,
                session,
                runtime,
                displayPid,
                entries: savedEntries(),
                workspaces: host.listWorkspaces(),
                snapshot: host.snapshot(),
              },
              null,
              2,
            ),
            contentType: "application/json",
          },
        );
      });
    },
  );
});

test(
  "Archives directly, stops only its Pi and reopens the saved conversation after Unarchive",
  { annotation: { type: "spec", description: "E2E-13" } },
  async ({ host }, testInfo) => {
    const aIsListed = (): boolean => {
      const workspaces = JSON.parse(
        execFileSync(join(host.directory, "bin/pi-mux"), ["list"], {
          env: host.env,
          encoding: "utf8",
        }),
      ) as { sessions: { id: string; temporary?: true }[] }[];
      return workspaces.some(({ sessions }) =>
        sessions.some(({ id, temporary }) => id === aId && temporary !== true),
      );
    };
    const aId = host.sessions.A.id;
    const rowIn = (frame: Frame, id: string) =>
      frame
        .locator(".session-row")
        .filter({ has: frame.locator(`[data-session="${id}"]`) })
        .describe("Session row");
    let initialA!: ReturnType<VSCodeFixture["piProcesses"]>[number];
    let initialB!: ReturnType<VSCodeFixture["piProcesses"]>[number];
    let unarchivedA!: ReturnType<VSCodeFixture["piProcesses"]>[number];
    let temporaryA!: ReturnType<VSCodeFixture["piProcesses"]>[number];
    let sourceA = "";
    let sourceB = "";
    let replacementId = "";
    let displayPid = 0;
    await test.step("Start isolated A and B Pi runtimes and an ordinary fixture tmux session", async () => {
      await host.activateSession("A");
      await host.activateSession("B");
      await host.selectSession("B");
      await host.selectSession("A");
      await host.activateSession("Deleted");
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      initialA = host.sessionRuntime("A")!;
      initialB = host.sessionRuntime("B")!;
      displayPid = host.snapshot().terminals.find((terminal) => terminal.owned)!.pid;
      expect(initialA).toBeDefined();
      expect(initialB).toBeDefined();
      sourceA = readFileSync(host.sessions.A.session, "utf8");
      sourceB = readFileSync(host.sessions.B.session, "utf8");
      host.tmux(["new-session", "-d", "-s", "ordinary-fixture", "sleep", "120"]);
      execFileSync(join(host.directory, "bin/pi-mux"), ["snapshot"], { env: host.env });
      host.piMux(["restore"]);
      expect(aIsListed()).toBe(true);
      const frame = await host.sessionFrame();
      const toggle = frame
        .locator(`[data-mode-toggle="${host.sessions.A.cwd}"]`)
        .describe("A workspace display mode");
      if ((await toggle.getAttribute("data-mode")) === "all") await toggle.click();
      const candidates = frame
        .locator("section.group")
        .filter({ has: frame.getByTitle(host.sessions.A.cwd, { exact: true }) })
        .locator(".session-row [data-session]")
        .describe("Same-cwd replacement rows");
      const ids = await candidates.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-session")),
      );
      replacementId = ids.find((id) => id !== aId) ?? "";
      expect(replacementId).not.toBe("");
    });
    await test.step("Archive directly, switch the existing tab and view the saved row in All", async () => {
      const frame = await host.sessionFrame();
      await rowIn(frame, aId)
        .locator(`[data-archive="${aId}"]`)
        .describe("A row Archive button")
        .click({ steps: 15 });
      await expect(frame.getByRole("dialog").describe("No Archive confirmation")).toBeHidden();
      await expect(rowIn(frame, aId)).toHaveCount(0);
      await expect.poll(() => existsSync(`/proc/${initialA.pid}`)).toBe(false);
      host.piMux(["restore"]);
      expect(aIsListed()).toBe(false);
      expect(host.piProcesses().some((entry) => entry.target === initialA.target)).toBe(false);
      expect(
        host.tmux(["list-sessions", "-F", "#{session_name}"]).trim().split("\n"),
      ).not.toContain(initialA.target);
      expect(host.tmux(["list-sessions", "-F", "#{session_name}"])).toContain("ordinary-fixture");
      expect(host.piProcesses().find((entry) => entry.target === initialB.target)?.pid).toBe(
        initialB.pid,
      );
      await expect
        .poll(() =>
          host
            .snapshot()
            .terminals.filter((terminal) => terminal.owned)
            .map((terminal) => terminal.pid),
        )
        .toEqual([displayPid]);
      await expect(
        frame
          .locator(`.session-row.selected [data-session="${replacementId}"]`)
          .describe("Selected same-cwd replacement"),
      ).toBeVisible();
      await expect
        .poll(() => {
          const target = host.tmux(["list-clients", "-F", "#{session_name}"]).trim();
          const encoded = host
            .tmux(["display-message", "-p", "-t", target, "#{@pi-tmux-session}"])
            .trim();
          return encoded === ""
            ? undefined
            : (JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { id: string }).id;
        })
        .toBe(replacementId);
      expect(readFileSync(host.sessions.A.session, "utf8")).toBe(sourceA);
      expect(readFileSync(host.sessions.B.session, "utf8")).toBe(sourceB);
      expect(aIsListed()).toBe(false);
      expect(host.listWorkspaces().some(({ cwd }) => cwd === host.sessions.A.cwd)).toBe(true);
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
    await test.step("Browse archived A temporarily without adding it to the restore snapshot", async () => {
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      temporaryA = host.sessionRuntime("A")!;
      const frame = await host.sessionFrame();
      await expect(rowIn(frame, aId)).toHaveClass(/archived/);
      const workspaces = JSON.parse(
        execFileSync(join(host.directory, "bin/pi-mux"), ["list"], {
          env: host.env,
          encoding: "utf8",
        }),
      ) as { sessions: { id: string; temporary?: true }[] }[];
      expect(
        workspaces.flatMap(({ sessions }) => sessions).find(({ id }) => id === aId)?.temporary,
      ).toBe(true);
      execFileSync(join(host.directory, "bin/pi-mux"), ["snapshot"], { env: host.env });
      host.piMux(["restore"]);
      expect(aIsListed()).toBe(false);
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      expect(host.sessionRuntime("A")?.pid).toBe(temporaryA.pid);
      expect(aIsListed()).toBe(false);
    });
    await test.step("Unarchive the existing temporary Pi through normal open", async () => {
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
      await host.expectNativeDisplay("A");
      unarchivedA = host.piProcesses().find((entry) => entry.target === initialA.target)!;
      expect(unarchivedA.pid).toBe(temporaryA.pid);
      expect(unarchivedA.pid).not.toBe(initialA.pid);
      expect(existsSync(`/proc/${initialA.pid}`)).toBe(false);
      expect(
        host.tmux(["display-message", "-p", "-t", unarchivedA.target, "#{pane_start_command}"]),
      ).toContain(host.sessions.A.session);
      expect(readFileSync(host.sessions.A.session, "utf8").startsWith(sourceA)).toBe(true);
      expect(readFileSync(host.sessions.B.session, "utf8")).toBe(sourceB);
      expect(host.listWorkspaces().some(({ cwd }) => cwd === host.sessions.A.cwd)).toBe(true);
      await testInfo.attach("Unarchive 後（未アーカイブ・再開表示）", {
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
    await test.step("Reopen the same conversation without starting Pi again while retaining saved history and B", async () => {
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      const resumed = host.piProcesses().find((entry) => entry.target === initialA.target)!;
      // the Unarchive already started this Pi: the selection must not start it again
      expect(resumed.pid).toBe(unarchivedA.pid);
      expect(resumed.pid).not.toBe(initialA.pid);
      expect(
        host.tmux(["display-message", "-p", "-t", resumed.target, "#{pane_start_command}"]),
      ).toContain(host.sessions.A.session);
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
    await test.step("Archive background A while keeping B and a shell in the same tmux session", async () => {
      await host.selectSession("B");
      await host.expectNativeDisplay("B");
      const aPane = host
        .tmux(["display-message", "-p", "-t", unarchivedA.target, "#{pane_id}"])
        .trim();
      const bPane = host
        .tmux(["display-message", "-p", "-t", initialB.target, "#{pane_id}"])
        .trim();
      host.tmux(["join-pane", "-d", "-h", "-s", aPane, "-t", bPane]);
      const [shellPane, shellPid] = host
        .tmux([
          "split-window",
          "-d",
          "-h",
          "-P",
          "-F",
          "#{pane_id}\t#{pane_pid}",
          "-t",
          bPane,
          "/bin/bash",
          "--noprofile",
          "--norc",
        ])
        .trim()
        .split("\t");
      expect(host.piProcesses().find((entry) => entry.pid === unarchivedA.pid)?.target).toBe(
        initialB.target,
      );
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
      expect(host.piProcesses().some((entry) => entry.pid === initialB.pid)).toBe(true);
      await expect.poll(() => existsSync(`/proc/${unarchivedA.pid}`)).toBe(false);
      expect(host.piProcesses().some((entry) => entry.pid === unarchivedA.pid)).toBe(false);
      expect(host.tmux(["list-panes", "-a", "-F", "#{pane_id}"]).trim().split("\n")).toContain(
        shellPane,
      );
      expect(existsSync(`/proc/${shellPid}`)).toBe(true);
      expect(host.tmux(["list-sessions", "-F", "#{session_name}"])).toContain("ordinary-fixture");
    });
    await test.step("Close only the previous temporary A after a successful switch to normal B", async () => {
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      const temporary = host.sessionRuntime("A")!;
      await host.selectSession("B");
      await host.expectNativeDisplay("B");
      await expect.poll(() => existsSync(`/proc/${temporary.pid}`)).toBe(false);
      expect(host.sessionRuntime("B")?.pid).toBe(initialB.pid);
      expect(readFileSync(host.sessions.A.session, "utf8").startsWith(sourceA)).toBe(true);
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
    testInfo.setTimeout(150_000);
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
    let registeredCwds: string[] = [];
    await test.step("Prepare four conversations in one workspace in update order", async () => {
      await expect.poll(() => host.piProcesses().length).toBe(3);
      for (const { cwd } of host.listWorkspaces()) host.piMux(["workspace", "unregister", cwd]);
      const sessionDirectory = dirname(host.sessions.A.session);
      // The list sorts saved rows by history btime (the header timestamp), so
      // the four headers carry distinct timestamps that match the phases
      // order.
      for (const [reverseIndex, { key }] of [...phases].reverse().entries()) {
        const index = phases.length - 1 - reverseIndex;
        const fixture = host.sessions[key];
        const entries = fixture.original
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        entries[0].cwd = workspaceCwd;
        entries[0].timestamp = new Date(Date.UTC(2026, 9, 22, 4 - index)).toISOString();
        const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        const session = join(sessionDirectory, basename(fixture.session));
        if (existsSync(session)) unlinkSync(session);
        writeFileSync(session, original);
        if (session !== fixture.session) unlinkSync(fixture.session);
        host.sessions[key] = { ...fixture, cwd: workspaceCwd, session, original };
        if (reverseIndex < phases.length - 1) await sleep(50);
      }
      host.piMux(["workspace", "register", workspaceCwd]);
      const frame = await host.sessionFrame();
      await host.refreshSessions();
      await expect(
        frame.locator("section.group").describe("Only the shared workspace"),
      ).toHaveCount(1);
      const mode = frame.locator(`[data-mode-toggle="${workspaceCwd}"]`);
      if ((await mode.getAttribute("data-mode")) === "unarchived") await mode.click();
      await expect(
        frame.locator(".session-row").describe("Four prepared conversations"),
      ).toHaveCount(4);
      registeredCwds = host.listWorkspaces().map(({ cwd }) => cwd);
    });
    await test.step("Open four existing conversations in live panes", async () => {
      for (const { key } of phases) {
        await host.activateSession(key);
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
        host.setSessionPhase("A", phase.state);
        await expectPhase("A", { ...phase, hasUnread: phase.state === "waiting-user" });
        expect(host.listWorkspaces().map(({ cwd }) => cwd)).toEqual(registeredCwds);
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

    await test.step("Keep a displayed completion unread until its row is explicitly selected", async () => {
      await openLiveSession("A");
      for (const phase of [phases[0], phases[2]]) {
        host.setSessionPhase("A", phase.state);
        await expectPhase("A", { ...phase, hasUnread: phase.state === "waiting-user" });
        expect(host.listWorkspaces().map(({ cwd }) => cwd)).toEqual(registeredCwds);
      }
      await openLiveSession("External");
      await expectPhase("A", { ...phases[2], hasUnread: true });
      await openLiveSession("A");
      await expectPhase("A", phases[2]);
    });

    await test.step("Show running, approval, unread, and read standby in one workspace without a conversation display", async () => {
      await host.closePiDisplay();
      host.setSessionPhase("External", "running");
      await expectPhase("External", phases[0]);
      for (const phase of phases) {
        const { cwd, session } = host.sessions[phase.key];
        expect(cwd).toBe(workspaceCwd);
        host.setSessionPhase(phase.key, phase.state);
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
      await host.refreshSessions();
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
      await testInfo.attach("running / waiting-approval / waiting-user", {
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
