import type { Frame } from "playwright/test";
import type { ExtensionMessage } from "../../src/webview/protocol";
import { expect, test, type VSCodeFixture } from "../support/vscode";

type ControlledWindow = typeof window & {
  sessionListResponses: ExtensionMessage[];
  sessionListControlled: boolean;
};

test(
  "Distinguishes initial loading, retained-list refresh, empty success and retrieval error",
  {
    annotation: [
      { type: "spec", description: "E2E-15" },
      {
        type: "scope",
        description:
          "Real VS Code webview with controlled protocol responses; host I/O outcomes are not under test.",
      },
    ],
  },
  async ({ host }, testInfo) => {
    const content = await reloadWithHeldResponses(host);
    const sessions = content.locator("#sessions").describe("Session list and loading message");
    const status = content.locator("#status").describe("Session retrieval status");
    const rows = content.locator(".session-row").describe("Saved session rows");
    const windowEnvironment = await host.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        bounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
        zoomFactor: window.webContents.getZoomFactor(),
      };
    });
    const renderer = await host.page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
    }));
    const captures: { name: string; width: number; height: number }[] = [];

    async function receive(message: ExtensionMessage): Promise<void> {
      await content.evaluate((message) => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { ...message, sessionListInjected: true } }),
        );
      }, message);
    }

    async function capture(name: string, filename: string): Promise<void> {
      await expect(
        host.page.getByRole("tab", { name: "Agent Kit", exact: true }).describe("Sessions sidebar"),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        host.page.locator(".monaco-workbench").describe("Entire VS Code workbench"),
      ).toBeVisible();
      await host.page
        .locator(".part.sidebar .title-label")
        .describe("Native Sessions title")
        .hover();
      const image = await host.page.screenshot({ path: testInfo.outputPath(filename) });
      const width = image.readUInt32BE(16);
      const height = image.readUInt32BE(20);
      expect(width).toBe(renderer.width * renderer.devicePixelRatio);
      expect(height).toBe(renderer.height * renderer.devicePixelRatio);
      captures.push({ name, width, height });
      await testInfo.attach(name, { body: image, contentType: "image/png" });
    }

    await test.step("Hold the first response and show loading without an empty message", async () => {
      const reload = host.page
        .getByRole("button", { name: "Reload All Pi Sessions", exact: true })
        .describe("Native all-session reload action");
      await expect(reload).toHaveCount(1);
      await expect(reload).toBeVisible();
      await expect(reload).toHaveClass(/codicon-debug-restart/);
      await expect(
        host.page
          .locator(".part.sidebar .composite.title")
          .getByRole("button", { name: /More Actions/ }),
      ).toHaveCount(0);
      await expect(content.locator("header, h1, [data-action=refresh]")).toHaveCount(0);
      await expect(sessions).toHaveText("Loading sessions…");
      await expect(sessions).not.toContainText("No sessions yet");
      await expect(rows).toHaveCount(0);
      await expect(status).toHaveText("");
      await capture("初回loading", "initial-loading.png");
    });

    await test.step("Refresh automatically while retaining the list, selection, modes and collapsed groups", async () => {
      await expect
        .poll(() =>
          content.evaluate(() =>
            (window as ControlledWindow).sessionListResponses.some(
              (message) => message.type === "sessions",
            ),
          ),
        )
        .toBe(true);
      const state = await content.evaluate(() => {
        const response = (window as ControlledWindow).sessionListResponses
          .filter((message) => message.type === "sessions")
          .at(-1);
        if (!response || response.type !== "sessions") throw new Error("No held session response");
        return response.state;
      });
      state.displayedSessionId = host.sessions.A.id;
      const selected = state.groups
        .flatMap((group) => group.sessions)
        .find((session) => session.sessionId === host.sessions.A.id);
      if (!selected) throw new Error("Missing controlled saved session");
      selected.isArchived = false;
      await receive({ type: "sessions", state });
      await expect(
        content.locator(".group-header").describe("Registered work folders"),
      ).toHaveCount(3);
      const mode = content
        .locator(`[data-mode-toggle="${host.sessions.B.cwd}"]`)
        .describe("B workspace display mode");
      await mode.click();
      await expect(mode).toHaveAttribute("data-mode", "all");
      const collapsed = content
        .locator(`[data-toggle-group="${host.sessions.External.cwd}"]`)
        .first()
        .describe("External workspace collapse toggle");
      await collapsed.click();
      await expect(collapsed).toHaveAttribute("aria-expanded", "false");
      const names = content
        .locator(".session-row .session-name")
        .describe("Retained session names");
      const previousNames = await names.allTextContents();
      expect(previousNames.length).toBeGreaterThan(0);
      await receive({ type: "loading", manual: false, displayedSessionId: host.sessions.A.id });
      await expect(status).toHaveText("");
      await expect(names).toHaveText(previousNames);
      await expect(
        content.locator(".selected .session-name").describe("Retained selected session"),
      ).toHaveText("Fixture A");
      await expect(mode).toHaveAttribute("data-mode", "all");
      await expect(collapsed).toHaveAttribute("aria-expanded", "false");
      await expect(sessions).not.toContainText("No sessions yet");
      await capture("自動更新中の一覧保持", "refreshing.png");
    });

    await test.step("Show the empty message only after a successful zero-group response", async () => {
      await receive({ type: "sessions", state: { groups: [] } });
      await expect(sessions).toHaveText("No sessions yet");
      await expect(status).toHaveText("");
      await expect(rows).toHaveCount(0);
      await capture("成功空", "successful-empty.png");
    });

    await test.step("Show a retrieval error guidance in the list area", async () => {
      await receive({ type: "loading", manual: false, displayedSessionId: null });
      await expect(sessions).toHaveText("Loading sessions…");
      await receive({ type: "sessionsError" });
      await expect(sessions).toHaveText("Failed to load sessions. Retrying…");
      await expect(status).toHaveText("");
      await expect(status).not.toHaveClass(/error/);
      await capture("取得error", "retrieval-error.png");
    });

    await test.step("Clear the error guidance when the next retrieval succeeds", async () => {
      await receive({ type: "sessions", state: { groups: [] } });
      await expect(sessions).toHaveText("No sessions yet");
      await expect(status).toHaveText("");
    });

    await testInfo.attach("Window and protocol observation", {
      body: JSON.stringify({
        windowEnvironment,
        renderer,
        captures,
        controlledProtocolResponses: true,
      }),
      contentType: "application/json",
    });
  },
);

async function reloadWithHeldResponses(host: VSCodeFixture): Promise<Frame> {
  await host.app.context().addInitScript(holdSessionResponses);
  await host.page.keyboard.press("F1");
  const command = host.page.locator(".quick-input-widget input").describe("Reload real webviews");
  await command.fill(">Developer: Reload Webviews");
  await command.press("Enter");
  await expect(command).not.toBeVisible();
  let content: Frame | undefined;
  await expect
    .poll(async () => {
      for (const frame of host.page.frames()) {
        try {
          if (
            (await frame.locator("#sessions").count()) &&
            (await frame.evaluate(
              () => (window as ControlledWindow).sessionListControlled === true,
            ))
          ) {
            content = frame;
            return true;
          }
        } catch (error) {
          if (!frame.isDetached()) throw error;
        }
      }
      return false;
    })
    .toBe(true);
  if (!content) throw new Error("Controlled Sessions webview did not become ready");
  await expect(content.locator("header, h1, [data-action=refresh]")).toHaveCount(0);
  return content;
}

function holdSessionResponses(): void {
  const controlled = window as ControlledWindow;
  controlled.sessionListResponses = [];
  controlled.sessionListControlled = true;
  const addEventListener = window.addEventListener.bind(window);
  function holdResponse(event: Event): void {
    const message = (event as MessageEvent).data as ExtensionMessage & {
      sessionListInjected?: boolean;
    };
    if (!message || !["loading", "sessions", "sessionsError", "error"].includes(message.type))
      return;
    if (message.sessionListInjected) return;
    controlled.sessionListResponses.push(message);
    event.stopImmediatePropagation();
  }
  window.addEventListener = function registerListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type === "message") addEventListener("message", holdResponse, { capture: true });
    return addEventListener(type, listener, options);
  };
}
