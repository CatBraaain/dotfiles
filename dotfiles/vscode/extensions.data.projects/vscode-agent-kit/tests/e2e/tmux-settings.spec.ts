import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type VSCodeFixture } from "../support/vscode";

const paneCreationKeys = ["C-MouseDrag1Pane", "C-MouseDrag1Empty"];

function rootBindings(host: VSCodeFixture): string[] {
  return host.tmux(["list-keys", "-T", "root"]).trim().split("\n");
}

function ordinaryMouseBindings(host: VSCodeFixture): string[] {
  return rootBindings(host)
    .filter((line) => /Mouse|Wheel/.test(line))
    .filter((line) => !paneCreationKeys.some((key) => line.includes(key)))
    .map((line) => line.trim().replace(/\s+/g, " "));
}

function expectSettings(host: VSCodeFixture, targets: string[], mouseBindings: string[]): void {
  const bindings = rootBindings(host);
  for (const key of paneCreationKeys)
    expect(bindings.some((line) => line.includes(key))).toBe(false);
  expect(ordinaryMouseBindings(host)).toEqual(mouseBindings);
  expect(host.tmux(["show-options", "-s", "-v", "extended-keys"]).trim()).toBe("on");
  expect(host.tmux(["show-options", "-s", "-v", "extended-keys-format"]).trim()).toBe("csi-u");
  expect(host.tmux(["list-keys", "-T", "root", "S-Enter"]).trim()).toContain(
    "send-keys -H 1b 5b 31 33 3b 32 75",
  );
  for (const target of targets) {
    for (const [option, value] of [
      ["status", "off"],
      ["prefix", "None"],
      ["set-titles", "on"],
      ["set-titles-string", "#{pane_title}"],
      ["mouse", "on"],
    ]) {
      expect(
        host.tmux(["show-options", "-A", "-v", "-t", target, option]).trim(),
        `${target} ${option}`,
      ).toBe(value);
    }
  }
}

async function reapply(host: VSCodeFixture, message: string): Promise<void> {
  await host.page.keyboard.press("F1");
  const command = host.page
    .locator(".quick-input-widget input")
    .describe("tmux settings command palette");
  await command.fill(">Pi Sessions: Reapply tmux Settings");
  await command.press("Enter");
  await expect(
    host.page
      .locator(".notification-list-item-message")
      .filter({ hasText: message })
      .last()
      .describe("tmux settings result notification"),
  ).toBeVisible();
}

function paneIdentities(host: VSCodeFixture): string {
  return host.tmux([
    "list-panes",
    "-a",
    "-F",
    "#{pid}\t#{session_id}\t#{session_name}\t#{pane_id}\t#{pane_pid}",
  ]);
}

test(
  "Reapplies dedicated tmux settings without replacing sessions or Pi processes",
  { annotation: { type: "spec", description: "E2E-16" } },
  async ({ host }, testInfo) => {
    await test.step("Run the published command before starting a tmux server", async () => {
      await reapply(host, "No tmux sessions to update.");
      expect(host.tmux(["list-sessions"])).toBe("");
      expect(host.piProcesses()).toEqual([]);
    });

    let ordinaryMouse: string[] = [];
    await test.step("Keep an unrelated session unchanged when there are no managed targets", async () => {
      host.tmux(["new-session", "-d", "-s", "ordinary-fixture", "sleep", "300"]);
      ordinaryMouse = ordinaryMouseBindings(host);
      expect(ordinaryMouse.length).toBeGreaterThan(10);
      const before = paneIdentities(host);
      const bindings = rootBindings(host);
      for (const key of paneCreationKeys)
        expect(bindings.some((line) => line.includes(key))).toBe(true);
      await reapply(host, "No tmux sessions to update.");
      expect(rootBindings(host)).toEqual(bindings);
      expect(paneIdentities(host)).toBe(before);
    });

    await test.step("Start two real Pi sessions and verify the startup settings on tmux 3.8", async () => {
      expect(host.tmux(["-V"]).trim()).toBe("tmux 3.8");
      for (const key of ["A", "B"]) {
        await host.selectSession(key);
        await host.expectNativeDisplay(key);
      }
      expectSettings(
        host,
        host.piProcesses().map((runtime) => runtime.target),
        ordinaryMouse,
      );
    });

    const runtimes = host.piProcesses();
    const targets = runtimes.map((runtime) => runtime.target);
    const identities = paneIdentities(host);
    expect(runtimes).toHaveLength(2);

    await test.step("Change settings and reconnect without automatic startup reapplication", async () => {
      for (const target of targets) {
        host.tmux(["set-option", "-t", target, "status", "on"]);
        host.tmux(["set-option", "-t", target, "prefix", "C-b"]);
        host.tmux(["set-option", "-t", target, "set-titles", "off"]);
        host.tmux(["set-option", "-t", target, "set-titles-string", "stale-title"]);
      }
      host.tmux(["set-option", "-s", "extended-keys", "off"]);
      host.tmux(["set-option", "-s", "extended-keys-format", "xterm"]);
      host.tmux(["unbind-key", "-n", "S-Enter"]);
      for (const key of paneCreationKeys)
        host.tmux(["bind-key", "-T", "root", key, "new-pane", "-M"]);
      await host.selectSession("A");
      await host.expectNativeDisplay("A");
      expect(host.tmux(["show-options", "-v", "-t", targets[0], "status"]).trim()).toBe("on");
      expect(host.tmux(["show-options", "-s", "-v", "extended-keys"]).trim()).toBe("off");
    });

    await test.step("Hide the sessions and restart the extension host before explicit reapplication", async () => {
      const frame = await host.sessionFrame();
      const statePath = join(host.directory, "agent/session-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state["active-workspaces"] = {};
      writeFileSync(statePath, JSON.stringify(state));
      await expect(frame.locator(".session-row").describe("Hidden session rows")).toHaveCount(0);
      await host.restartExtensionHost();
      expect(host.tmux(["show-options", "-s", "-v", "extended-keys"]).trim()).toBe("off");
    });

    for (const iteration of [1, 2]) {
      await test.step(`Reapply settings to every managed session without replacing processes (${iteration})`, async () => {
        host.tmux(["unbind-key", "-n", "S-Enter"]);
        await reapply(host, "tmux settings reapplied.");
        await expect
          .poll(() => rootBindings(host).some((line) => /S-Enter.*send-keys/.test(line)))
          .toBe(true);
        expectSettings(host, targets, ordinaryMouse);
        expect(paneIdentities(host)).toBe(identities);
        expect(host.piProcesses()).toEqual(runtimes);
        expect(
          host.tmux(["show-options", "-A", "-v", "-t", "ordinary-fixture", "status"]).trim(),
        ).toBe("on");
      });
    }

    await test.step("Probe real Ctrl left-drag input without submitting a Pi message", async () => {
      const target = host.tmux(["list-clients", "-F", "#{session_name}"]).trim();
      const input = host.page
        .getByRole("textbox", { name: /^Terminal [0-9]+/ })
        .describe("Real Pi terminal input");
      await input.focus();
      const screen = host.page
        .locator(".terminal-wrapper .xterm-screen:visible")
        .describe("Real Pi terminal screen");
      const bounds = await screen.boundingBox();
      expect(bounds).not.toBeNull();
      const [cursorRow, rows] = host
        .tmux(["display-message", "-p", "-t", target, "#{cursor_y}\t#{pane_height}"])
        .trim()
        .split("\t")
        .map(Number);
      const x = bounds!.x + 35;
      const y = bounds!.y + ((cursorRow + 0.5) * bounds!.height) / rows;
      await host.page.mouse.move(x, y);
      await host.page.keyboard.down("Control");
      try {
        await host.page.mouse.down();
        await host.page.mouse.move(x + 140, y, { steps: 15 });
        await host.page.mouse.up();
      } finally {
        await host.page.keyboard.up("Control");
      }
      await input.focus();
      await host.page.keyboard.type("tmux-reapply-probe");
      await expect
        .poll(() => host.tmux(["capture-pane", "-p", "-t", target]))
        .toContain("tmux-reapply-probe");
      const captured = host.tmux(["capture-pane", "-p", "-t", target]);
      await testInfo.attach("Ctrl drag input observation", {
        body: JSON.stringify(
          {
            target,
            cursorRow,
            rows,
            bounds,
            drag: { x, y, endX: x + 140 },
            nanInputObserved: /<16;NaN;NaNm/.test(captured),
            captured,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await host.page.keyboard.press("Control+u");
      expect(paneIdentities(host)).toBe(identities);
      expect(host.piProcesses()).toEqual(runtimes);
    });

    await testInfo.attach("tmux 3.8 settings and process evidence", {
      body: JSON.stringify(
        {
          tmuxVersion: host.tmux(["-V"]).trim(),
          socket: host.tmuxSocket,
          ordinaryMouseBindings: ordinaryMouse,
          identities,
          runtimes,
          finalIdentities: paneIdentities(host),
          finalRuntimes: host.piProcesses(),
          rootBindings: rootBindings(host),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  },
);
