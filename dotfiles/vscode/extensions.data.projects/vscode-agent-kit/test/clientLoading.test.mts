import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionMessage, WebviewState } from "../src/webview/protocol";
import { webviewAppMarkup } from "../src/webview/webviewHtml";
import { webviewStyles } from "../src/webview/webviewStyles";

const sessionId = "session-1";
const state: WebviewState = {
  groups: [
    {
      cwd: "/workspace/atlas",
      label: "atlas",
      sessions: [
        { sessionId, displayName: "Atlas current", updatedAtMs: null, isArchived: false },
        {
          sessionId: "archived-1",
          displayName: "Atlas archived",
          updatedAtMs: null,
          isArchived: true,
        },
      ],
    },
    { cwd: "/workspace/empty", label: "empty", sessions: [] },
  ],
  displayedSessionId: sessionId,
};

describe("session list loading in the mounted client", () => {
  let browser: Browser;
  let page: Page;
  let clientSource: string;

  beforeAll(async () => {
    clientSource = await readFile(join(process.cwd(), "dist-webview/webview/client.js"), "utf8");
    browser = await chromium.launch({ headless: true });
  });

  beforeEach(async ({ task }) => {
    page = await browser.newPage();
    if (task.name.includes("connection") || task.name.includes("two-second")) {
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);
    }
    await page.route("http://localhost/client", (route) =>
      route.fulfill({ contentType: "text/html", body: webviewAppMarkup }),
    );
    await page.goto("http://localhost/client");
    await page.addStyleTag({ content: webviewStyles });
    await page.evaluate(() => {
      const requests: unknown[] = [];
      Object.assign(window, {
        __requests: requests,
        acquireVsCodeApi: () => ({ postMessage: (request: unknown) => requests.push(request) }),
      });
    });
    await page.addScriptTag({ type: "module", content: clientSource });
    await page.waitForFunction(() => {
      const requests = Reflect.get(window, "__requests") as { type: string }[];
      return requests.some((request) => request.type === "ready");
    });
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function receive(message: ExtensionMessage): Promise<void> {
    await page.evaluate(
      (message) => window.dispatchEvent(new MessageEvent("message", { data: message })),
      message,
    );
  }

  async function expectLoading(): Promise<void> {
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("Loading sessions…");
    expect(await page.locator("#sessions").textContent()).not.toContain("No sessions yet");
  }

  async function expectLoaded(errorMessage = ""): Promise<void> {
    await expect.poll(() => page.locator(".session-row").count()).toBe(1);
    await expect.poll(() => page.locator("#status").textContent()).toBe(errorMessage);
    await expect.poll(() => page.locator("#connection-status").textContent()).toBe("");
  }

  async function failWorkspaceAddition(): Promise<void> {
    await page.locator('[data-action="toggleWorkspaceForm"]').click();
    await page.locator("#workspace-path").fill("/missing/workspace");
    await page.locator("#workspace-path").press("Enter");
    const request = await page.evaluate(() =>
      (Reflect.get(window, "__requests") as unknown[]).at(-1),
    );
    expect(request).toEqual({ type: "addWorkspace", path: "/missing/workspace" });
    await receive({ type: "error", message: "Invalid workspace path" });
    await expect
      .poll(() => page.locator("#status").textContent())
      .toContain("Invalid workspace path");
    expect(await page.locator("#status").getAttribute("class")).toBe("error");
  }

  async function newSessionRequests(): Promise<{ cwd: string; requestId: string }[]> {
    return page.evaluate(() =>
      (
        Reflect.get(window, "__requests") as { type: string; cwd: string; requestId: string }[]
      ).filter((request) => request.type === "newSession"),
    );
  }

  async function connectionRequest(): Promise<string> {
    return page.evaluate(() => {
      const requests = Reflect.get(window, "__requests") as { type: string; requestId: string }[];
      return requests.filter((request) => request.type === "ready").at(-1)!.requestId;
    });
  }

  it("places connection feedback above the list while retaining operation feedback in the footer", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await receive({ type: "loading", manual: true });
    await page.clock.runFor(15000);
    await receive({ type: "error", message: "Operation failed" });
    const connection = page.locator("#connection-status");
    expect(await connection.count()).toBe(1);
    await expect.poll(() => connection.textContent()).toBe("Connection lost. Retrying…");
    expect(await connection.getAttribute("role")).toBe("status");
    expect(await connection.getAttribute("aria-live")).toBe("polite");
    expect(await page.locator("#status").textContent()).toBe(
      "Refreshing sessions…\nOperation failed",
    );
    const positions = await page.evaluate(() => {
      const connection = document.querySelector("#connection-status")!;
      const sessions = document.querySelector("#sessions")!;
      const operation = document.querySelector("#status")!;
      return {
        precedesList: Boolean(
          connection.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        aboveList:
          connection.getBoundingClientRect().bottom <= sessions.getBoundingClientRect().top,
        operationInFooter: operation.closest("footer") !== null,
        operationFollowsList: Boolean(
          sessions.compareDocumentPosition(operation) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      };
    });
    expect(positions).toEqual({
      precedesList: true,
      aboveList: true,
      operationInFooter: true,
      operationFollowsList: true,
    });
    await receive({ type: "loading", manual: true, requestId: await connectionRequest() });
    await expect.poll(() => connection.textContent()).toBe("");
    expect(await connection.isVisible()).toBe(false);
    expect(await page.locator("#status").textContent()).toBe(
      "Refreshing sessions…\nOperation failed",
    );
  });

  it("shows a connection error only after ten seconds and recovers without losing the list", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await page.locator('[data-mode-toggle="/workspace/atlas"]').click();
    await page.locator('[data-toggle-group="/workspace/empty"]').first().click();
    await page.clock.runFor(5000);
    const requestId = await connectionRequest();
    await page.clock.runFor(9999);
    expect(await page.locator("#connection-status").textContent()).toBe("");
    await page.clock.runFor(1);
    await expect
      .poll(() => page.locator("#connection-status").textContent())
      .toContain("Connection lost");
    expect(await page.locator("#connection-status").getAttribute("class")).toBe("error");
    expect(await page.locator(".session-row").count()).toBe(2);
    await page.screenshot({ path: "/tmp/work/vscode-pi-sessions/connection-error.png" });
    const updated = structuredClone(state);
    updated.groups[0].sessions[0].displayName = "Recovered session";
    await receive({ type: "sessions", state: updated, requestId });
    await expect.poll(() => page.locator("#connection-status").textContent()).toBe("");
    expect(await page.locator(".selected .session-name").textContent()).toBe("Recovered session");
    await page.screenshot({ path: "/tmp/work/vscode-pi-sessions/connection-recovered.png" });
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(
      await page
        .locator('[data-toggle-group="/workspace/empty"]')
        .first()
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("detects initial connection loss and retries without receiving any list", async () => {
    await page.clock.runFor(10000);
    await expect
      .poll(() => page.locator("#connection-status").textContent())
      .toContain("Connection lost");
    await expectLoading();
    const expired = await connectionRequest();
    await page.clock.runFor(5000);
    const requestId = await connectionRequest();
    expect(requestId).not.toBe(expired);
    await receive({ type: "sessions", state, requestId: expired });
    expect(await page.locator(".session-row").count()).toBe(0);
    await receive({ type: "sessions", state, requestId });
    await expectLoaded();
  });

  it("keeps long acquisitions healthy through connection replies after operation errors expire", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await receive({ type: "loading", manual: true });
    await receive({ type: "error", message: "Operation failed" });
    for (let index = 0; index < 4; index += 1) {
      await page.clock.runFor(5000);
      await receive({ type: "loading", manual: true, requestId: await connectionRequest() });
    }
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    await page.clock.runFor(15000);
    await expect
      .poll(() => page.locator("#connection-status").textContent())
      .toContain("Connection lost");
    await receive({ type: "error", message: "Operation failed" });
    await receive({ type: "sessionsError", requestId: await connectionRequest() });
    await expect.poll(() => page.locator("#status").textContent()).toBe("Operation failed");
    expect(await page.locator(".session-row").count()).toBe(1);
  });

  it("preserves the two-second operation error deadline through connection replay and normal pushes", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await page.clock.runFor(5000);
    await receive({ type: "error", message: "Operation failed" });
    await page.clock.runFor(1000);
    await receive({ type: "sessions", state, requestId: await connectionRequest() });
    await expectLoaded("Operation failed");
    await page.clock.runFor(999);
    await receive({ type: "sessions", state });
    await expectLoaded("Operation failed");
    await page.clock.runFor(1);
    await expectLoaded();
  });

  it.each([
    { message: { type: "loading", manual: false }, remainingStatus: "" },
    { message: { type: "loading", manual: true }, remainingStatus: "Refreshing sessions…" },
    { message: { type: "sessions", state }, remainingStatus: "" },
    { message: { type: "sessionsError" }, remainingStatus: "" },
  ] satisfies { message: ExtensionMessage; remainingStatus: string }[])(
    "keeps the two-second deadline through a list update: $message",
    async ({ message, remainingStatus }) => {
      await receive({ type: "sessions", state });
      await expectLoaded();
      await failWorkspaceAddition();
      await page.clock.runFor(1000);
      await receive(message);
      const status = page.locator("#status");
      const duringError = [remainingStatus, "Invalid workspace path"].filter(Boolean).join("\n");
      await expect.poll(() => status.textContent()).toBe(duringError);
      await page.clock.runFor(999);
      expect(await status.textContent()).toBe(duringError);
      expect(await status.getAttribute("class")).toBe("error");
      await page.clock.runFor(1);
      await expect.poll(() => status.textContent()).toBe(remainingStatus);
      expect(await status.getAttribute("class")).toBe("");
      expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
      expect(await page.locator("#workspace-form").isVisible()).toBe(true);
      expect(await page.locator("#workspace-path").inputValue()).toBe("/missing/workspace");
    },
  );

  it.each(["Operation failed", "Another operation failed"])(
    "restarts the two-second deadline when a new error arrives: %s",
    async (nextMessage) => {
      await receive({ type: "sessions", state });
      await expectLoaded();
      await receive({ type: "error", message: "Operation failed" });
      await page.clock.runFor(1000);
      await receive({ type: "error", message: nextMessage });
      await expectLoaded(nextMessage);
      await page.clock.runFor(1000);
      await expectLoaded(nextMessage);
      await page.clock.runFor(999);
      await expectLoaded(nextMessage);
      await page.clock.runFor(1);
      await expectLoaded();
      expect(await page.locator("#status").getAttribute("class")).toBe("");
    },
  );

  it.each([
    { message: { type: "loading", manual: false }, guidance: "Loading sessions…" },
    { message: { type: "sessions", state: { groups: [] } }, guidance: "No sessions yet" },
    { message: { type: "sessionsError" }, guidance: "Failed to load sessions. Retrying…" },
  ] satisfies { message: ExtensionMessage; guidance: string }[])(
    "expires only the two-second operation error while preserving empty-list guidance: $guidance",
    async ({ message, guidance }) => {
      await receive(message);
      await failWorkspaceAddition();
      await page.clock.runFor(1999);
      expect(await page.locator("#status").textContent()).toBe("Invalid workspace path");
      expect(await page.locator("#sessions").textContent()).toBe(guidance);
      await page.clock.runFor(1);
      await expect.poll(() => page.locator("#status").textContent()).toBe("");
      expect(await page.locator("#sessions").textContent()).toBe(guidance);
      expect(await page.locator("#workspace-form").isVisible()).toBe(true);
      expect(await page.locator("#workspace-path").inputValue()).toBe("/missing/workspace");
    },
  );

  it.each([
    { type: "loading", manual: false },
    { type: "sessions", state: { groups: [] } },
    { type: "sessionsError" },
  ] satisfies ExtensionMessage[])(
    "keeps the two-second deadline through a connection response: $type",
    async (message) => {
      const requestId = await connectionRequest();
      await receive({ type: "error", message: "Operation failed" });
      await page.clock.runFor(1000);
      await receive({ ...message, requestId });
      await expect.poll(() => page.locator("#status").textContent()).toBe("Operation failed");
      await page.clock.runFor(999);
      expect(await page.locator("#status").textContent()).toBe("Operation failed");
      await page.clock.runFor(1);
      await expect.poll(() => page.locator("#status").textContent()).toBe("");
      expect(await page.locator("#connection-status").textContent()).toBe("");
    },
  );

  it("ignores stale connection replies after a normal push", async () => {
    const requestId = await connectionRequest();
    await receive({ type: "sessions", state });
    await expectLoaded();
    await receive({ type: "loading", manual: true, requestId });
    expect(await page.locator("#status").textContent()).toBe("");
    await page.clock.runFor(15000);
    await expect
      .poll(() => page.locator("#connection-status").textContent())
      .toContain("Connection lost");
    await receive({ type: "sessions", state });
    await expectLoaded();
  });

  it("restarts the connection deadline after hidden time", async () => {
    await page.clock.runFor(9000);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const previous = await connectionRequest();
    await page.clock.runFor(60000);
    expect(await connectionRequest()).toBe(previous);
    expect(await page.locator("#connection-status").textContent()).toBe("");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await connectionRequest()).not.toBe(previous);
    await page.clock.runFor(9999);
    expect(await page.locator("#connection-status").textContent()).toBe("");
    await page.clock.runFor(1);
    await expect
      .poll(() => page.locator("#connection-status").textContent())
      .toContain("Connection lost");
  });

  it.each(["click", "Enter", "Space"])(
    "shows the spinner immediately on %s and clears only on completion",
    async (activation) => {
      await receive({ type: "sessions", state });
      await expectLoaded();
      const button = page.locator('[data-new-session="/workspace/atlas"]');
      const before = await button.boundingBox();
      if (activation === "click") await button.click();
      else await button.press(activation);
      await expect.poll(() => button.getAttribute("aria-busy")).toBe("true");
      expect(await button.isEnabled()).toBe(true);
      expect(await button.locator("path").getAttribute("d")).toBe("M21 12a9 9 0 1 1-6.219-8.56");
      expect(await button.boundingBox()).toEqual(before);
      const animation = await button.locator("svg").evaluate((svg) => {
        const style = getComputedStyle(svg);
        return {
          name: style.animationName,
          duration: style.animationDuration,
          timing: style.animationTimingFunction,
        };
      });
      expect(animation).toEqual({ name: "session-spin", duration: "1s", timing: "linear" });
      await receive({ type: "loading", manual: false });
      await receive({ type: "sessions", state });
      await receive({ type: "error", message: "Unrelated operation failed" });
      expect(await button.getAttribute("aria-busy")).toBe("true");
      const [request] = await newSessionRequests();
      await receive({ type: "newSessionFinished", requestId: request.requestId });
      await expect.poll(() => button.getAttribute("aria-busy")).toBe("false");
      expect(await button.locator("path").first().getAttribute("d")).toBe("M5 12h14");
      expect(await button.boundingBox()).toEqual(before);
    },
  );

  it("keeps all same-cwd requests pending and treats other cwds independently", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    const atlas = page.locator('[data-new-session="/workspace/atlas"]');
    const empty = page.locator('[data-new-session="/workspace/empty"]');
    await atlas.click();
    await atlas.click();
    await empty.click();
    const requests = await newSessionRequests();
    expect(requests.map(({ cwd }) => cwd)).toEqual([
      "/workspace/atlas",
      "/workspace/atlas",
      "/workspace/empty",
    ]);
    expect(new Set(requests.map(({ requestId }) => requestId)).size).toBe(3);
    await receive({ type: "newSessionFinished", requestId: requests[0].requestId });
    expect(await atlas.getAttribute("aria-busy")).toBe("true");
    await receive({ type: "newSessionFinished", requestId: requests[2].requestId });
    await expect.poll(() => empty.getAttribute("aria-busy")).toBe("false");
    expect(await atlas.getAttribute("aria-busy")).toBe("true");
    await receive({ type: "newSessionFinished", requestId: requests[0].requestId });
    await receive({ type: "newSessionFinished", requestId: "old-view-request" });
    expect(await atlas.getAttribute("aria-busy")).toBe("true");
    await receive({ type: "newSessionFinished", requestId: requests[1].requestId });
    await expect.poll(() => atlas.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the new-session spinner static under reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await receive({ type: "sessions", state });
    await expectLoaded();
    const button = page.locator('[data-new-session="/workspace/atlas"]');
    await button.click();
    await expect.poll(() => button.getAttribute("aria-busy")).toBe("true");
    const animation = await button
      .locator("svg")
      .evaluate((svg) => getComputedStyle(svg).animationName);
    expect(animation).toBe("none");
    expect(await button.locator("path").getAttribute("d")).toBe("M21 12a9 9 0 1 1-6.219-8.56");
  });

  it("keeps workspace input across automatic snapshots until the add acknowledgement", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await page.locator('[data-action="toggleWorkspaceForm"]').click();
    const input = page.locator("#workspace-path");
    await input.fill("/new/workspace");
    await input.press("Enter");
    await receive({ type: "sessions", state });
    expect(await page.locator("#workspace-form").isVisible()).toBe(true);
    expect(await input.inputValue()).toBe("/new/workspace");
    await receive({ type: "error", message: "Invalid workspace path" });
    await receive({ type: "sessions", state });
    expect(await page.locator("#workspace-form").isVisible()).toBe(true);
    await input.press("Enter");
    await receive({ type: "workspaceAdded" });
    expect(await page.locator("#workspace-form").isHidden()).toBe(true);
    expect(await input.inputValue()).toBe("");
  });

  it("keeps initial loading visible after an unrelated operation error", async () => {
    await expectLoading();
    await failWorkspaceAddition();
    await expectLoading();
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No sessions yet");
    await expect.poll(() => page.locator("#status").textContent()).toBe("Invalid workspace path");
    expect(await page.locator("#status").getAttribute("class")).toBe("error");
  });

  it("shows the refreshing status only for a manual refresh", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();

    await receive({ type: "loading", manual: false, displayedSessionId: sessionId });
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
    expect(await page.locator(".session-row").count()).toBe(1);
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");

    await receive({ type: "loading", manual: true, displayedSessionId: sessionId });
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
  });

  it("shows only the operation error during an automatic refresh", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();

    await receive({ type: "loading", manual: false, displayedSessionId: sessionId });
    await failWorkspaceAddition();

    expect(await page.locator("#status").textContent()).toBe("Invalid workspace path");
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    await receive({ type: "sessions", state });
    await expectLoaded("Invalid workspace path");
  });

  it("keeps refreshing and the existing list visible alongside an operation error", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await receive({ type: "loading", manual: true });
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    await failWorkspaceAddition();
    expect(await page.locator("#status").textContent()).toContain("Refreshing sessions…");
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    expect(await page.locator(".session-row").count()).toBe(1);
    await receive({ type: "sessions", state });
    await expectLoaded("Invalid workspace path");
    expect(await page.locator("#status").getAttribute("class")).toBe("error");
  });

  it("keeps a successful empty list visible after an unrelated operation error", async () => {
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No sessions yet");
    await failWorkspaceAddition();
    expect(await page.locator("#sessions").textContent()).toBe("No sessions yet");
    await receive({ type: "loading", manual: false });
    await expectLoading();
    await receive({ type: "sessions", state });
    await expectLoaded("Invalid workspace path");
    expect(await page.locator("#status").getAttribute("class")).toBe("error");
  });

  it("shows loading until the first successful empty response", async () => {
    await expectLoading();
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No sessions yet");
    expect(await page.locator("#status").textContent()).toBe("");
  });

  it("replaces initial loading with returned sessions and registered empty groups", async () => {
    await expectLoading();
    await receive({ type: "sessions", state });
    await expectLoaded();
    expect(await page.locator(".group-title").allTextContents()).toEqual(["atlas", "empty"]);
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    expect(await page.locator(".empty").count()).toBe(0);
  });

  it("sends an open request whenever the displayed unread session is clicked again", async () => {
    const unreadState = structuredClone(state);
    unreadState.groups[0].sessions[0].state = "waiting-user";
    unreadState.groups[0].sessions[0].hasUnread = true;
    await receive({ type: "sessions", state: unreadState });
    await expectLoaded();
    const sessionButton = page.locator(`.selected [data-session="${sessionId}"]`);
    expect(await sessionButton.getAttribute("title")).toContain("Unread");

    await sessionButton.click();
    await receive({ type: "sessions", state: unreadState });
    await sessionButton.click();

    const openRequests = await page.evaluate(() =>
      (Reflect.get(window, "__requests") as { type: string }[]).filter(
        (request) => request.type === "openSession",
      ),
    );
    expect(openRequests).toEqual([
      { type: "openSession", sessionId },
      { type: "openSession", sessionId },
    ]);
  });

  function unreadState(): WebviewState {
    const next = structuredClone(state);
    Object.assign(next.groups[0].sessions[0], { state: "waiting-user", hasUnread: true });
    return next;
  }

  async function showUnread(): Promise<void> {
    await receive({ type: "sessions", state: unreadState() });
    await expect.poll(() => page.locator(".session-status svg").count()).toBe(1);
  }

  async function startPausedFade(): Promise<void> {
    const next = unreadState();
    next.groups[0].sessions[0].hasUnread = false;
    await receive({ type: "sessions", state: next });
    await page.waitForFunction(() => {
      const animation = document.querySelector(".session-status svg")?.getAnimations()[0];
      if (!animation) return false;
      animation.pause();
      animation.currentTime = 100;
      return true;
    });
  }

  it("fades the acknowledged bell for 200ms without shifting the row", async () => {
    await showUnread();
    const status = page.locator(".session-status");
    const before = await status.boundingBox();
    const nameBefore = await page.locator(".session-name").first().boundingBox();
    await page.locator(`[data-session="${sessionId}"]`).click();
    expect(await status.getAttribute("data-fading")).toBe("false");
    await startPausedFade();
    const halfway = await status.locator("svg").evaluate((svg) => {
      const animation = svg.getAnimations()[0];
      const timing = animation.effect?.getTiming();
      const style = getComputedStyle(svg);
      return { opacity: Number(style.opacity), easing: style.animationTimingFunction, timing };
    });
    expect(halfway.timing).toMatchObject({ duration: 200 });
    expect(halfway.easing).toBe("ease-out");
    expect(halfway.opacity).toBeGreaterThan(0);
    expect(halfway.opacity).toBeLessThan(1);
    expect(await status.boundingBox()).toEqual(before);
    expect(await page.locator(".session-name").first().boundingBox()).toEqual(nameBefore);
    expect(await page.locator(`[data-session="${sessionId}"]`).getAttribute("title")).not.toContain(
      "Unread",
    );
    await status.locator("svg").evaluate((svg) => svg.getAnimations()[0].finish());
    await expect.poll(() => status.locator("svg").count()).toBe(0);
    expect(await status.boundingBox()).toEqual(before);
    expect(await page.locator(".session-name").first().boundingBox()).toEqual(nameBefore);
  });

  it("removes the acknowledged bell immediately with reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await showUnread();
    const next = unreadState();
    next.groups[0].sessions[0].hasUnread = false;
    await receive({ type: "sessions", state: next });
    await expect.poll(() => page.locator(".session-status svg").count()).toBe(0);
    expect(await page.locator(".session-status").getAttribute("data-fading")).toBe("false");
  });

  it("removes an in-flight fade when reduced motion is enabled", async () => {
    await showUnread();
    await startPausedFade();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => page.locator(".session-status svg").count()).toBe(0);
  });

  it("keeps the bell visible when opening fails", async () => {
    await showUnread();
    await page.locator(`[data-session="${sessionId}"]`).click();
    await receive({ type: "error", message: "Failed to open session" });
    expect(await page.locator(".session-status svg").count()).toBe(1);
    expect(await page.locator(".session-status").getAttribute("data-fading")).toBe("false");
    expect(await page.locator(`[data-session="${sessionId}"]`).getAttribute("title")).toContain(
      "Unread",
    );
  });

  it.each([
    { state: "running", hasUnread: false, isArchived: false, icons: 1 },
    { state: "waiting-approval", hasUnread: false, isArchived: false, icons: 1 },
    { state: undefined, hasUnread: false, isArchived: false, icons: 0 },
    { state: "waiting-user", hasUnread: false, isArchived: true, icons: 0 },
    { state: "waiting-user", hasUnread: true, isArchived: false, icons: 1 },
  ] as const)("prioritizes the latest state over a fading bell: %j", async (update) => {
    await showUnread();
    await page.locator('[data-mode-toggle="/workspace/atlas"]').click();
    await startPausedFade();
    const next = unreadState();
    const { icons, ...sessionUpdate } = update;
    Object.assign(next.groups[0].sessions[0], sessionUpdate);
    await receive({ type: "sessions", state: next });
    const status = page.locator(`[data-session="${sessionId}"] .session-status`);
    await expect.poll(() => status.getAttribute("data-fading")).toBe("false");
    expect(await status.locator("svg").count()).toBe(icons);
    expect(await status.getAttribute("data-state")).toBe(update.state ?? null);
  });

  it.each(["running", "waiting-approval", undefined, "archived"] as const)(
    "replaces an unread bell immediately for %s rather than fading",
    async (phase) => {
      await showUnread();
      await page.locator('[data-mode-toggle="/workspace/atlas"]').click();
      const next = unreadState();
      Object.assign(next.groups[0].sessions[0], {
        state: phase === "archived" ? "waiting-user" : phase,
        hasUnread: false,
        isArchived: phase === "archived",
      });
      await receive({ type: "sessions", state: next });
      const status = page.locator(`[data-session="${sessionId}"] .session-status`);
      await expect.poll(() => status.getAttribute("data-unread")).toBe("false");
      expect(await status.getAttribute("data-fading")).toBe("false");
      expect(await status.locator("svg").count()).toBe(
        phase === "running" || phase === "waiting-approval" ? 1 : 0,
      );
    },
  );

  it("shows the retrieval guidance in the list area without a status error", async () => {
    await expectLoading();
    await receive({ type: "sessionsError" });
    await expect
      .poll(() => page.locator("#sessions").textContent())
      .toBe("Failed to load sessions. Retrying…");
    expect(await page.locator("#status").textContent()).toBe("");
    expect(await page.locator("#status").getAttribute("class")).toBe("");
  });

  it("keeps rows, selection, modes, and collapsed groups through a manual refresh", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await page.locator('[data-mode-toggle="/workspace/atlas"]').click();
    await page.locator('[data-toggle-group="/workspace/empty"]').first().click();
    await receive({ type: "loading", manual: true });
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    await receive({ type: "loading", manual: true });
    const updatedState = structuredClone(state);
    updatedState.groups[0].sessions[0].displayName = "Atlas updated";
    await receive({ type: "sessions", state: updatedState });
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas updated");
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(
      await page
        .locator('[data-toggle-group="/workspace/empty"]')
        .first()
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("syncs the displayed session before a scan completes and retains it on failure", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await receive({ type: "loading", manual: false, displayedSessionId: "unsaved-session" });

    await expect.poll(() => page.locator(".selected").count()).toBe(0);
    expect(await page.locator(".session-row").count()).toBe(1);
    expect(await page.locator("#status").textContent()).toBe("");
    await receive({ type: "sessionsError" });
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
    expect(await page.locator(".selected").count()).toBe(0);
    expect(await page.locator(".session-row").count()).toBe(1);
  });

  it("clears selection when loading reports no displayed session", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await receive({ type: "loading", manual: false, displayedSessionId: null });

    await expect.poll(() => page.locator(".selected").count()).toBe(0);
    expect(await page.locator(".session-row").count()).toBe(1);
    expect(await page.locator("#status").textContent()).toBe("");
  });

  it("keeps the last list and selected row when a manual refresh fails", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await receive({ type: "loading", manual: true });
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    await receive({ type: "sessionsError" });
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    expect(await page.locator(".session-row").count()).toBe(1);
  });

  it("replaces a successful empty list with loading during another fetch", async () => {
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No sessions yet");
    await receive({ type: "loading", manual: false });
    await expectLoading();
    await receive({ type: "sessionsError" });
    await expect
      .poll(() => page.locator("#sessions").textContent())
      .toBe("Failed to load sessions. Retrying…");
    await receive({ type: "loading", manual: false });
    await expectLoading();
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No sessions yet");
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
  });

  it("keeps registered empty groups through a quiet host reload", async () => {
    await receive({ type: "sessions", state: { groups: [state.groups[1]] } });
    await expect.poll(() => page.locator(".group-title").allTextContents()).toEqual(["empty"]);
    await receive({ type: "loading", manual: false });
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
    expect(await page.locator(".group-title").allTextContents()).toEqual(["empty"]);
    expect(await page.locator(".empty").count()).toBe(0);
    await receive({ type: "sessions", state });
    await expectLoaded();
  });
});
