import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionMessage, WebviewState } from "../src/webview/protocol";
import { webviewAppMarkup } from "../src/webview/webviewHtml";

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

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(webviewAppMarkup);
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
    expect(await page.locator("#sessions").textContent()).not.toContain("No saved sessions");
  }

  async function expectLoaded(): Promise<void> {
    await expect.poll(() => page.locator(".session-row").count()).toBe(1);
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
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

  it("keeps initial loading visible after an unrelated operation error", async () => {
    await expectLoading();
    await failWorkspaceAddition();
    await expectLoading();
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No saved sessions");
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
    expect(await page.locator("#status").getAttribute("class")).toBe("");
  });

  it("keeps refreshing and the existing list visible alongside an operation error", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await page.locator('[data-action="refresh"]').click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    await failWorkspaceAddition();
    expect(await page.locator("#status").textContent()).toContain("Refreshing sessions…");
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    expect(await page.locator(".session-row").count()).toBe(1);
    await receive({ type: "sessions", state });
    await expectLoaded();
    expect(await page.locator("#status").getAttribute("class")).toBe("");
  });

  it("keeps a successful empty list visible after an unrelated operation error", async () => {
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No saved sessions");
    await failWorkspaceAddition();
    expect(await page.locator("#sessions").textContent()).toBe("No saved sessions");
    await page.locator('[data-action="refresh"]').click();
    await expectLoading();
    await receive({ type: "sessions", state });
    await expectLoaded();
    expect(await page.locator("#status").getAttribute("class")).toBe("");
  });

  it("shows loading until the first successful empty response", async () => {
    await expectLoading();
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No saved sessions");
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

  it("shows a first-load error without presenting a successful empty list", async () => {
    await expectLoading();
    await receive({ type: "sessionsError", message: "Failed to read Pi sessions" });
    await expect
      .poll(() => page.locator("#status").textContent())
      .toBe("Failed to read Pi sessions");
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("");
    expect(await page.locator("#status").getAttribute("class")).toBe("error");
  });

  it("keeps rows, selection, modes, and collapsed groups through a manual refresh", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await page.locator('[data-mode-toggle="/workspace/atlas"]').click();
    await page.locator('[data-toggle-group="/workspace/empty"]').first().click();
    await page.locator('[data-action="refresh"]').click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    await receive({ type: "loading" });
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

  it("keeps the last list and selected row when a refresh fails", async () => {
    await receive({ type: "sessions", state });
    await expectLoaded();
    await page.locator('[data-action="refresh"]').click();
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    await receive({ type: "sessionsError", message: "Could not reload sessions" });
    await expect
      .poll(() => page.locator("#status").textContent())
      .toBe("Could not reload sessions");
    expect(await page.locator(".selected .session-name").textContent()).toBe("Atlas current");
    expect(await page.locator(".session-row").count()).toBe(1);
  });

  it("replaces a successful empty list with loading during another fetch", async () => {
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No saved sessions");
    await page.locator('[data-action="refresh"]').click();
    await expectLoading();
    await receive({ type: "sessionsError", message: "Could not reload sessions" });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("");
    await receive({ type: "loading" });
    await expectLoading();
    await receive({ type: "sessions", state: { groups: [] } });
    await expect.poll(() => page.locator("#sessions").textContent()).toBe("No saved sessions");
    await expect.poll(() => page.locator("#status").textContent()).toBe("");
  });

  it("shows host-initiated reloads without dropping registered empty groups", async () => {
    await receive({ type: "sessions", state: { groups: [state.groups[1]] } });
    await expect.poll(() => page.locator(".group-title").allTextContents()).toEqual(["empty"]);
    await receive({ type: "loading" });
    await expect.poll(() => page.locator("#status").textContent()).toBe("Refreshing sessions…");
    expect(await page.locator(".group-title").allTextContents()).toEqual(["empty"]);
    expect(await page.locator(".empty").count()).toBe(0);
    await receive({ type: "sessions", state });
    await expectLoaded();
  });
});
