// Smoke test for the built static catalog (`bun run storybook:build`): the
// storybook-static output must serve standalone and render the spec's states
// without the extension host. Skipped when the static build is absent or
// stale (`bun run test`, which rebuilds it first).
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClientState } from "../src/webview/client";

const staticDir = join(process.cwd(), "storybook-static");
const indexFile = join(staticDir, "index.json");

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

// Sample session ids from stories/demoBridge.ts.
const atlasCurrentId = "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10";
const atlasArchivedId = "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61";
const piToolsPlainId = "3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72";
const piToolsOtherId = "4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83";
const worktreeId = "5b6c4a2d-9e1f-4c3b-af2a-4d5e6f7a8b94";
const projectModeSelector = '[data-mode-toggle="~/projects/vscode-pi-sessions"]';
const worktreeModeSelector = '[data-mode-toggle="~/.agents/worktrees/vscode-pi-sessions"]';
const piToolsModeSelector = '[data-mode-toggle="~/projects/pi-tools"]';

// A stale static build renders old DOM and silently fails selector waits, so
// skip unless the catalog is newer than its inputs (stories, webview sources,
// Storybook config).
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    const mtimeMs =
      entry.isDirectory() && !entry.isSymbolicLink()
        ? newestMtimeMs(entryPath)
        : statSync(entryPath).mtimeMs;
    if (mtimeMs > newest) newest = mtimeMs;
  }
  return newest;
}

const staticBuildFresh =
  existsSync(indexFile) &&
  ["stories", "src", ".storybook"].every((inputDir) => {
    const inputPath = join(process.cwd(), inputDir);
    return existsSync(inputPath) && statSync(indexFile).mtimeMs >= newestMtimeMs(inputPath);
  });

if (!staticBuildFresh) {
  console.warn(
    "Skipping storybook static catalog smoke: storybook-static is missing or older than its inputs. Run `bun run test` to rebuild it first.",
  );
}

describe.skipIf(!staticBuildFresh)("storybook static catalog smoke", () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl = "";
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;

  function launchBrowser() {
    return import("playwright").then(({ chromium }) =>
      chromium.launch({
        ignoreDefaultArgs: ["--hide-scrollbars"],
        args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar"],
      }),
    );
  }

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        let path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        if (path === "" || path.endsWith("/")) path += "index.html";
        const body = await readFile(join(staticDir, path));
        res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    try {
      browser = await launchBrowser();
    } catch {
      throw new Error("Playwright Chromium is unavailable; run: npx playwright install chromium");
    }
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function openStory(path: string, viewport?: { width: number; height: number }) {
    const page = await browser!.newPage(viewport ? { viewport } : undefined);
    await page.goto(`${baseUrl}/iframe.html?path=/story/${path}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".session-row");
    return page;
  }

  async function installBridgeMessageRecorder(
    page: Awaited<ReturnType<typeof openStory>>,
  ): Promise<void> {
    await page.evaluate(() => {
      type Fiber = {
        child: Fiber | null;
        memoizedProps: unknown;
        sibling: Fiber | null;
      };
      type ClientBridge = { postMessage(message: unknown): void };
      type TestWindow = Window & {
        __bridgeMessages?: unknown[];
        __removeWorkspace?: (cwd: string) => void;
        __reverseWorkspaces?: () => void;
        __refreshSessions?: () => void;
      };

      const sessionsRoot = document.querySelector("#sessions");
      if (!(sessionsRoot instanceof HTMLElement)) {
        throw new Error("Sessions root is missing.");
      }
      const rootKey = Object.keys(sessionsRoot).find((key) => key.startsWith("__reactContainer$"));
      if (rootKey === undefined) throw new Error("React root is missing.");

      const containerRoot = Reflect.get(sessionsRoot, rootKey) as {
        stateNode?: { current?: Fiber | null };
      };
      const pendingFibers: Fiber[] = [];
      const currentRoot = containerRoot.stateNode?.current;
      if (currentRoot?.child) pendingFibers.push(currentRoot.child);

      const bridgeMessages: unknown[] = [];
      (window as TestWindow).__bridgeMessages = bridgeMessages;
      while (pendingFibers.length > 0) {
        const fiber = pendingFibers.pop()!;
        const props = fiber.memoizedProps;
        if (typeof props === "object" && props !== null && "bridge" in props) {
          const bridge = props.bridge as ClientBridge | undefined;
          if (bridge !== undefined && typeof bridge.postMessage === "function") {
            if ("store" in props) {
              const store = props.store as {
                getSnapshot(): { state: ClientState };
                setSessions(state: ClientState): void;
              };
              (window as TestWindow).__reverseWorkspaces = () => {
                const { state } = store.getSnapshot();
                store.setSessions({ ...state, groups: [...state.groups].reverse() });
              };
              (window as TestWindow).__removeWorkspace = (cwd) => {
                const { state } = store.getSnapshot();
                store.setSessions({
                  ...state,
                  groups: state.groups.filter((group) => group.cwd !== cwd),
                });
              };
            }
            const originalPostMessage = bridge.postMessage.bind(bridge);
            (window as TestWindow).__refreshSessions = () =>
              originalPostMessage({ type: "refresh" });
            bridge.postMessage = (message) => {
              bridgeMessages.push(message);
              originalPostMessage(message);
            };
            return;
          }
        }
        if (fiber.child !== null) pendingFibers.push(fiber.child);
        if (fiber.sibling !== null) pendingFibers.push(fiber.sibling);
      }
      throw new Error("Mounted webview bridge is missing.");
    });
  }

  async function refreshSessions(page: Awaited<ReturnType<typeof openStory>>): Promise<void> {
    await page.evaluate(() => {
      const refresh = (window as Window & { __refreshSessions?: () => void }).__refreshSessions;
      if (refresh === undefined) throw new Error("Host refresh control is not installed.");
      refresh();
    });
  }

  async function clearBridgeMessages(page: Awaited<ReturnType<typeof openStory>>): Promise<void> {
    await page.evaluate(() => {
      const messages = (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages;
      if (messages === undefined) throw new Error("Bridge message recorder is not installed.");
      messages.length = 0;
    });
  }

  async function openSessionMessages(page: Awaited<ReturnType<typeof openStory>>) {
    return page.evaluate(() => {
      const messages = (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages;
      if (messages === undefined) throw new Error("Bridge message recorder is not installed.");
      return messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "openSession",
      );
    });
  }

  async function clickTimestamp(
    page: Awaited<ReturnType<typeof openStory>>,
    sessionId: string,
    modifier?: "Control" | "Meta" | "Shift",
  ): Promise<void> {
    const timestamp = page
      .locator(".session-row")
      .filter({ has: page.locator(`[data-session="${sessionId}"]`) })
      .locator(".session-timestamp");
    await timestamp.scrollIntoViewIfNeeded();
    const box = await timestamp.boundingBox();
    if (box === null) throw new Error("Timestamp is not visible.");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hitSession = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("[data-session]")?.getAttribute("data-session"),
      { x, y },
    );
    expect(hitSession).toBe(sessionId);
    if (modifier !== undefined) await page.keyboard.down(modifier);
    try {
      await page.mouse.click(x, y);
    } finally {
      if (modifier !== undefined) await page.keyboard.up(modifier);
    }
  }

  it.each([320, 390, 720])(
    "keeps row bounds unchanged when mode switching adds document overflow at %ipx",
    async (width) => {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 384 });
      const row = page.locator(".session-row").first();
      async function rowBounds() {
        return row.evaluate((element) => {
          const { left, right, width } = element.getBoundingClientRect();
          return { left, right, width };
        });
      }
      const before = await rowBounds();
      expect(before).toEqual({ left: 4, right: width - 12, width: width - 16 });
      const contentAndPaint = await row.evaluate((element) => {
        const button = element.querySelector(".session-button")!;
        const box = button.getBoundingClientRect();
        const border = parseFloat(getComputedStyle(button).borderLeftWidth);
        const paint = getComputedStyle(button, "::before");
        const paintLeft = box.left + border + parseFloat(paint.left);
        return {
          workspaceNameLeft: element
            .closest(".group")!
            .querySelector(".group-title")!
            .getBoundingClientRect().left,
          nameLeft: element.querySelector(".session-name")!.getBoundingClientRect().left,
          statusLeft: element.querySelector(".session-status")!.getBoundingClientRect().left,
          paintLeft,
          paintRight: paintLeft + parseFloat(paint.width),
        };
      });
      expect(contentAndPaint).toEqual({
        workspaceNameLeft: 28,
        nameLeft: 29,
        statusLeft: 9,
        paintLeft: 4,
        paintRight: width - 12,
      });
      const nameWidths = await row.evaluate((element) => {
        const sessionRow = element as HTMLElement;
        const name = sessionRow.querySelector(".session-name")!;
        const current = name.getBoundingClientRect().width;
        const initialMarginLeft = sessionRow.style.marginLeft;
        sessionRow.style.marginLeft = "0px";
        const withLargerIndent = name.getBoundingClientRect().width;
        sessionRow.style.marginLeft = initialMarginLeft;
        return { current, withLargerIndent };
      });
      expect(nameWidths.current).toBe(nameWidths.withLargerIndent + 8);
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(384);
      await page.click(projectModeSelector);
      await page.waitForSelector(".session-row.archived");
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBeGreaterThan(
        384,
      );
      expect(await rowBounds()).toEqual(before);
      await page.click(projectModeSelector);
      await expect.poll(() => page.locator(".session-row").count()).toBe(4);
      expect(await rowBounds()).toEqual(before);
      expect(await page.locator("#app > header, #app h1, #app [data-action=refresh]").count()).toBe(
        0,
      );
      expect(
        await page.locator(".footer").evaluate((element) => getComputedStyle(element).position),
      ).toBe("sticky");
      await page.close();
    },
  );

  it("updates the overlay for mode, group, data, form, and viewport height changes", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 384 });
    const track = page.getByRole("scrollbar", { includeHidden: true });
    await expect.poll(() => track.isHidden()).toBe(true);
    await page.click(projectModeSelector);
    await expect.poll(() => track.isVisible()).toBe(true);
    const originalHeight = await page
      .locator(".session-scrollbar-thumb")
      .evaluate((element) => element.getBoundingClientRect().height);
    await page.locator(".group-chevron").nth(1).click();
    await expect.poll(() => track.isHidden()).toBe(true);
    await page.locator(".group-chevron").nth(1).click();
    await expect.poll(() => track.isVisible()).toBe(true);
    await page.locator(".group-new-session").first().click();
    await expect
      .poll(() =>
        page
          .locator(".session-scrollbar-thumb")
          .evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeLessThan(originalHeight);
    const beforeForm = await track.getAttribute("aria-valuemax");
    await page.locator(".new-workspace").click();
    await expect.poll(() => page.locator("#workspace-path").isVisible()).toBe(true);
    await expect.poll(() => track.getAttribute("aria-valuemax")).toBe(beforeForm);
    await page.locator("#workspace-path").press("Escape");
    await expect.poll(() => track.getAttribute("aria-valuemax")).toBe(beforeForm);
    await page.setViewportSize({ width: 320, height: 1000 });
    await expect.poll(() => track.isHidden()).toBe(true);
    await page.setViewportSize({ width: 320, height: 180 });
    await expect.poll(() => track.isVisible()).toBe(true);
    await expect
      .poll(async () => Number(await track.getAttribute("aria-valuemax")))
      .toBeGreaterThan(180);
    await page.close();
  });

  it("shows the overlay on hover and scroll, and retains it during drag or keyboard focus", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 180 });
    const track = page.getByRole("scrollbar");
    async function opacity() {
      return track.evaluate((element) => getComputedStyle(element).opacity);
    }
    await page.mouse.move(-10, -10);
    await expect.poll(opacity).toBe("0");
    await page.locator(".session-row").first().hover();
    await expect.poll(opacity).toBe("1");
    await page.mouse.move(-10, -10);
    await expect.poll(opacity).toBe("0");
    await page.evaluate(() => window.scrollBy(0, 40));
    await expect.poll(opacity).toBe("1");
    await expect.poll(opacity).toBe("0");
    await page.keyboard.press("Tab");
    await track.focus();
    await expect.poll(opacity).toBe("1");
    expect(
      await track.evaluate((element) => ({
        visible: element.matches(":focus-visible"),
        outline: getComputedStyle(element).outlineWidth,
      })),
    ).toEqual({ visible: true, outline: "2px" });
    await page.keyboard.press("Tab");
    await page.evaluate(() => window.scrollTo(0, 0));
    const thumb = await page.locator(".session-scrollbar-thumb").boundingBox();
    if (thumb === null) throw new Error("Scroll thumb is missing.");
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(-10, 90);
    await expect.poll(() => track.getAttribute("data-dragging")).toBe("true");
    await expect.poll(opacity).toBe("1");
    await page.mouse.up();
    await expect.poll(() => track.getAttribute("data-dragging")).toBeNull();
    await page.close();
  });

  it("scrolls the document by thumb drag, track click, and wheel input", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 180 });
    const track = page.getByRole("scrollbar");
    async function scrollTop() {
      return page.evaluate(() => document.scrollingElement!.scrollTop);
    }
    const thumb = await page.locator(".session-scrollbar-thumb").boundingBox();
    if (thumb === null) throw new Error("Scroll thumb is missing.");
    await page.mouse.move(thumb.x + 4, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(thumb.x + 4, 160, { steps: 5 });
    await page.mouse.up();
    await expect.poll(scrollTop).toBeGreaterThan(150);
    const maximum = Number(await track.getAttribute("aria-valuemax"));
    await track.click({ position: { x: 1, y: 1 } });
    await expect.poll(scrollTop).toBe(0);
    await track.click({ position: { x: 1, y: 179 } });
    await expect.poll(scrollTop).toBe(maximum);
    await page.mouse.move(100, 90);
    await page.mouse.wheel(0, -100);
    await expect.poll(scrollTop).toBeLessThan(maximum);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector("#sessions")!).overflowY),
    ).toBe("visible");
    await page.close();
  });

  it("preserves native document keyboard scrolling outside the overlay", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 180 });
    await page.locator(".session-button").first().focus();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => page.evaluate(() => document.scrollingElement!.scrollTop))
      .toBeGreaterThan(0);
    await page.close();
  });

  it("exposes scroll bounds and keyboard controls and cancels a captured drag", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 180 });
    const track = page.getByRole("scrollbar", { name: "Sessions scroll position" });
    await track.focus();
    expect(await track.getAttribute("aria-controls")).toBe("app");
    expect(await track.getAttribute("aria-orientation")).toBe("vertical");
    expect(await track.getAttribute("aria-valuemin")).toBe("0");
    await track.press("End");
    await expect
      .poll(async () => Number(await track.getAttribute("aria-valuenow")))
      .toBe(Number(await track.getAttribute("aria-valuemax")));
    await track.press("PageUp");
    await track.press("Home");
    await expect.poll(() => track.getAttribute("aria-valuenow")).toBe("0");
    await track.press("ArrowDown");
    await expect.poll(() => track.getAttribute("aria-valuenow")).toBe("40");
    await track.press("ArrowUp");
    await expect.poll(() => track.getAttribute("aria-valuenow")).toBe("0");
    const pageDownPosition = Math.min(180, Number(await track.getAttribute("aria-valuemax")));
    await track.press("PageDown");
    await expect
      .poll(async () => Number(await track.getAttribute("aria-valuenow")))
      .toBe(pageDownPosition);
    await track.press("Home");
    await expect.poll(() => track.getAttribute("aria-valuenow")).toBe("0");
    const thumb = await page.locator(".session-scrollbar-thumb").boundingBox();
    if (thumb === null) throw new Error("Scroll thumb is missing.");
    await page.mouse.move(thumb.x + 4, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.setViewportSize({ width: 320, height: 160 });
    await page.mouse.move(thumb.x + 4, 150);
    await expect
      .poll(() => page.evaluate(() => document.scrollingElement!.scrollTop))
      .toBeGreaterThan(0);
    await track.dispatchEvent("pointercancel", { pointerId: 1 });
    await expect.poll(() => track.getAttribute("data-dragging")).toBeNull();
    await page.mouse.up();
    await page.close();
  });

  it.each([320, 720])(
    "treats timestamp clicks with modifiers like plain clicks at %ipx",
    async (width) => {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 640 });
      await installBridgeMessageRecorder(page);

      await clickTimestamp(page, atlasCurrentId, "Control");
      expect(await openSessionMessages(page)).toEqual([
        { type: "openSession", sessionId: atlasCurrentId },
      ]);

      await clearBridgeMessages(page);
      await clickTimestamp(page, piToolsOtherId, "Meta");
      expect(await openSessionMessages(page)).toEqual([
        { type: "openSession", sessionId: piToolsOtherId },
      ]);

      await clearBridgeMessages(page);
      await clickTimestamp(page, worktreeId, "Shift");
      expect(await openSessionMessages(page)).toEqual([
        { type: "openSession", sessionId: worktreeId },
      ]);

      await clearBridgeMessages(page);
      await clickTimestamp(page, atlasCurrentId);
      expect(await openSessionMessages(page)).toEqual([
        { type: "openSession", sessionId: atlasCurrentId },
      ]);
      // The catalog has no terminal, so the displayed mark never moves.
      expect(await page.locator(".session-row.selected").count()).toBe(1);
      expect(
        await page.locator(".session-row.selected [data-session]").getAttribute("data-session"),
      ).toBe(atlasCurrentId);
      console.log(
        JSON.stringify({
          check: "timestamp-clicks",
          width,
          paths: ["Control", "Meta", "Shift", "plain"],
          openMessagesPerPath: 1,
        }),
      );

      await clearBridgeMessages(page);
      await page.click(`[data-archive="${worktreeId}"]`);
      await page.click(worktreeModeSelector);
      await page.locator(`[data-unarchive="${worktreeId}"]`).click();
      expect(await openSessionMessages(page)).toEqual([]);
      expect(
        await page.locator(".session-row.selected [data-session]").getAttribute("data-session"),
      ).toBe(atlasCurrentId);
      await page.close();
    },
  );

  it.each([
    { theme: "dark", width: 320 },
    { theme: "dark", width: 720 },
    { theme: "light", width: 320 },
    { theme: "light", width: 720 },
  ])(
    "keeps row text and enabled controls readable in $theme at $width px",
    async ({ theme, width }) => {
      const page = await openStory("sessions-sidebar--all-mode", { width, height: 640 });
      await page.waitForSelector(".session-row.archived");
      if (theme === "light") {
        await page.addStyleTag({
          content: `:root {
        --vscode-foreground: #333333;
        --vscode-sideBar-background: #f8f8f8;
        --vscode-descriptionForeground: #616161;
        --vscode-list-hoverBackground: #e8e8e8;
        --vscode-toolbar-hoverBackground: #e8e8e8;
        --vscode-list-inactiveSelectionBackground: #e4e6f1;
        --vscode-list-inactiveSelectionForeground: #333333;
        --vscode-disabledForeground: #a5a5a5;
      }`,
        });
      }

      for (const state of ["default", "selected-hover", "foreground-fallback"]) {
        // The catalog marks the displayed session (atlasCurrentId) as the
        // selected row in every state; the states differ only in hover and
        // fallback styling.
        if (state === "selected-hover") {
          await page
            .locator(`[data-session="${atlasCurrentId}"]`)
            .hover({ position: { x: 12, y: 12 } });
        }
        if (state === "foreground-fallback") {
          await page.addStyleTag({
            content: ":root { --vscode-list-inactiveSelectionForeground: initial; }",
          });
          await page.mouse.move(0, 639);
        }
        const samples = await page.evaluate(() => {
          function luminance(color: string): number {
            const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
            const linear = channels.map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
          }
          function contrast(foreground: string, background: string): number {
            const a = luminance(foreground);
            const b = luminance(background);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }
          return Array.from(document.querySelectorAll(".session-row")).flatMap((row) => {
            const button = row.querySelector(".session-button")!;
            const buttonBackground = getComputedStyle(button, "::before").backgroundColor;
            const background =
              buttonBackground === "rgba(0, 0, 0, 0)"
                ? getComputedStyle(document.body).backgroundColor
                : buttonBackground;
            return Array.from(
              row.querySelectorAll(".session-name, .session-timestamp, .archive, .unarchive"),
            ).map((element) => {
              const style = getComputedStyle(element);
              const paintedBackground =
                style.backgroundColor === "rgba(0, 0, 0, 0)" ? background : style.backgroundColor;
              return {
                row: row.className,
                target: element.className,
                foreground: style.color,
                background: paintedBackground,
                minimum: element.matches(".session-name, .session-timestamp") ? 4.5 : 3,
                ratio: contrast(style.color, paintedBackground),
              };
            });
          });
        });
        for (const sample of samples) {
          expect(
            sample.ratio,
            JSON.stringify({ theme, width, state, ...sample }),
          ).toBeGreaterThanOrEqual(sample.minimum);
        }
        console.log(JSON.stringify({ check: "row-contrast", theme, width, state, samples }));
      }
      await page.close();
    },
  );

  it("lists the session stories in the built index", async () => {
    const index = (await (await fetch(`${baseUrl}/index.json`)).json()) as {
      entries: Record<string, unknown>;
    };
    const ids = Object.keys(index.entries);
    for (const id of [
      "sessions-sidebar--sample-sessions",
      "sessions-sidebar--all-mode",
      "sessions-sidebar--empty-sessions",
    ]) {
      expect(ids, `story ${id} missing from index.json`).toContain(id);
    }
  });

  it("renders the sample story and operates the workspace mode toggle and archive", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    expect(await page.locator(".session-row").count()).toBe(4);

    await page.click(projectModeSelector);
    await page.waitForFunction(() => document.querySelectorAll(".session-row").length === 5);
    expect(
      await page.locator(`.session-row.archived [data-session="${atlasArchivedId}"]`).count(),
    ).toBe(1);
    expect(await page.locator(projectModeSelector).getAttribute("data-mode")).toBe("all");
    expect(await page.locator(worktreeModeSelector).getAttribute("data-mode")).toBe("unarchived");
    expect(await page.locator(piToolsModeSelector).getAttribute("data-mode")).toBe("unarchived");
    const groupByTitle = (title: string) =>
      page.locator(".group").filter({ has: page.locator(`.group-header[title="${title}"]`) });
    expect(await groupByTitle("~/projects/pi-tools").locator(".session-row").count()).toBe(2);
    expect(
      await groupByTitle("~/.agents/worktrees/vscode-pi-sessions").locator(".session-row").count(),
    ).toBe(1);
    expect(
      await groupByTitle("~/projects/vscode-pi-sessions").locator(".session-row").count(),
    ).toBe(2);

    await page.click(`[data-archive="${atlasCurrentId}"]`);
    await page.waitForFunction(
      (id) => document.querySelector(`.session-row.archived [data-session="${id}"]`) !== null,
      atlasCurrentId,
    );
    // The archived row stays visible in All mode; it disappears from the default view.
    expect(await page.locator(".session-row").count()).toBe(5);

    // Archived rows carry an Unarchive overlay; clicking it is the only way back.
    expect(await page.locator(".session-row.archived [data-unarchive]").count()).toBe(2);
    await page.click(`[data-unarchive="${atlasArchivedId}"]`);
    await page.waitForFunction(
      (id) => document.querySelector(`.session-row:not(.archived) [data-session="${id}"]`) !== null,
      atlasArchivedId,
    );
    expect(await page.locator(".session-row.archived").count()).toBe(1);

    // Modes are not persisted: a fresh client starts every workspace in Unarchived.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".session-row");
    expect(await page.locator(".session-row").count()).toBe(4);
    await page.close();
  });

  it.each([
    { activation: "click", width: 320 },
    { activation: "Enter", width: 320 },
    { activation: "Space", width: 320 },
    { activation: "click", width: 720 },
    { activation: "Enter", width: 720 },
    { activation: "Space", width: 720 },
  ])("toggles only its workspace with $activation at $width px", async ({ activation, width }) => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 640 });
    await installBridgeMessageRecorder(page);
    const toggles = page.locator(".group-header [data-mode-toggle]");
    expect(await toggles.count()).toBe(4);
    expect(await page.locator("#app header [data-mode-toggle]").count()).toBe(0);
    for (const toggle of await toggles.all()) {
      expect(await toggle.isVisible()).toBe(true);
      expect(await toggle.getAttribute("data-mode")).toBe("unarchived");
      expect(await toggle.getAttribute("aria-label")).toBe("Show all sessions");
    }
    const toggle = page.locator(projectModeSelector);
    const before = await toggle.boundingBox();
    expect(before?.width).toBe(24);
    expect(before?.height).toBe(24);
    if (activation === "click") await toggle.click();
    else await toggle.press(activation);
    await expect.poll(() => toggle.getAttribute("data-mode")).toBe("all");
    expect(await toggle.getAttribute("aria-label")).toBe("Show unarchived sessions");
    expect(await toggle.locator("svg").getAttribute("data-mode-icon")).toBe("all");
    expect(await toggle.boundingBox()).toEqual(before);
    expect(await page.locator(worktreeModeSelector).getAttribute("data-mode")).toBe("unarchived");
    expect(await page.locator(piToolsModeSelector).getAttribute("data-mode")).toBe("unarchived");
    expect(await page.locator('.group-chevron[aria-expanded="true"]').count()).toBe(4);
    expect(await page.locator(".session-row.selected").count()).toBe(1);
    expect(
      await page.evaluate(
        () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
      ),
    ).toEqual([]);
    await page.close();
  });

  it("keeps same-named cwd modes independent across row changes and refresh", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const projectMode = page.locator(projectModeSelector);
    const worktreeMode = page.locator(worktreeModeSelector);
    await page.locator(`[data-archive="${worktreeId}"]`).click();
    await expect.poll(() => page.locator(`[data-session="${worktreeId}"]`).count()).toBe(0);
    await projectMode.click();
    await expect.poll(() => page.locator(`[data-session="${atlasArchivedId}"]`).count()).toBe(1);
    expect(await page.locator(`[data-session="${worktreeId}"]`).count()).toBe(0);
    await worktreeMode.press("Enter");
    await expect.poll(() => page.locator(`[data-session="${worktreeId}"]`).count()).toBe(1);
    await projectMode.press("Space");
    await expect.poll(() => page.locator(`[data-session="${atlasArchivedId}"]`).count()).toBe(0);
    expect(await page.locator(`[data-session="${worktreeId}"]`).count()).toBe(1);
    await refreshSessions(page);
    expect(await projectMode.getAttribute("data-mode")).toBe("unarchived");
    expect(await worktreeMode.getAttribute("data-mode")).toBe("all");
    await page.locator(".new-workspace").click();
    await page.locator("#workspace-path").fill("/workspace/another");
    await page.locator("#workspace-path").press("Enter");
    await expect.poll(() => page.locator(".group-header").count()).toBe(5);
    expect(
      await page.locator('[data-mode-toggle="/workspace/another"]').getAttribute("data-mode"),
    ).toBe("unarchived");
    expect(await projectMode.getAttribute("data-mode")).toBe("unarchived");
    expect(await worktreeMode.getAttribute("data-mode")).toBe("all");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".session-row");
    expect(await projectMode.getAttribute("data-mode")).toBe("unarchived");
    expect(await worktreeMode.getAttribute("data-mode")).toBe("unarchived");
    await page.close();
  });

  it.each([
    ["click", 320],
    ["Enter", 320],
    ["click", 720],
    ["Enter", 720],
  ] as const)(
    "archives directly once with %s at %ipx without confirmation",
    async (activation, width) => {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 640 });
      await installBridgeMessageRecorder(page);
      const archive = page.locator(`[data-archive="${atlasCurrentId}"]`);
      if (activation === "click") await archive.click();
      else await archive.press(activation);

      expect(await page.locator("#confirmation-dialog").isHidden()).toBe(true);
      await expect.poll(() => page.locator(`[data-session="${atlasCurrentId}"]`).count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([{ type: "archiveSession", sessionId: atlasCurrentId }]);
      expect(await page.locator(".session-row.selected").count()).toBe(0);
      expect(await openSessionMessages(page)).toEqual([]);
      await page.close();
    },
  );

  it("offers one enabled row action and keeps IDs in the row hints", async () => {
    const page = await openStory("sessions-sidebar--all-mode");
    await page.waitForSelector(".session-row.archived");
    expect(await page.locator("[data-copy], [data-lock], [data-locked]").count()).toBe(0);
    const rows = page.locator(".session-row");
    for (const row of await rows.all()) {
      const button = row.locator(".session-button");
      const id = await button.getAttribute("data-session");
      expect(await button.getAttribute("title")).toContain(id);
      const action = row.locator("[data-archive], [data-unarchive]");
      expect(await action.count()).toBe(1);
      expect(await action.isEnabled()).toBe(true);
    }
    await installBridgeMessageRecorder(page);
    await page.locator(piToolsModeSelector).click();
    const archive = page.locator('[data-archive="4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83"]');
    await archive.focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-unarchive="4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83"]').waitFor();
    expect(await openSessionMessages(page)).toEqual([]);
    expect(await page.locator(".session-row.selected").count()).toBe(1);
    await page.close();
  });

  it("treats modifier clicks like plain clicks and archives a single row", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);

    await page.click(`[data-session="${atlasCurrentId}"]`, { modifiers: ["Control"] });
    expect(await openSessionMessages(page)).toEqual([
      { type: "openSession", sessionId: atlasCurrentId },
    ]);
    expect(await page.locator(".session-row.selected").count()).toBe(1);

    await clearBridgeMessages(page);
    await page.click(`[data-session="${worktreeId}"]`, { modifiers: ["Meta"] });
    expect(await openSessionMessages(page)).toEqual([
      { type: "openSession", sessionId: worktreeId },
    ]);

    await clearBridgeMessages(page);
    await page.click(`[data-session="${piToolsPlainId}"]`, { modifiers: ["Shift"] });
    expect(await openSessionMessages(page)).toEqual([
      { type: "openSession", sessionId: piToolsPlainId },
    ]);
    // The catalog has no terminal, so the displayed mark never moves.
    expect(await page.locator(".session-row.selected").count()).toBe(1);
    expect(
      await page.locator(".session-row.selected [data-session]").getAttribute("data-session"),
    ).toBe(atlasCurrentId);

    await page.click(`[data-archive="${worktreeId}"]`);
    await page.waitForFunction(() => document.querySelectorAll(".session-row").length === 3);
    expect(await page.locator(`[data-session="${piToolsOtherId}"]`).count()).toBe(1);
    expect(await page.locator(`[data-session="${worktreeId}"]`).count()).toBe(0);
    await page.close();
  });

  it("keeps only the displayed session selected with Ctrl+A focused on the list", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");

    await page.locator(`[data-session="${atlasCurrentId}"]`).focus();
    await page.keyboard.press("Control+a");
    // Ctrl+A no longer selects rows: the displayed session alone carries the mark.
    expect(await page.locator(".session-row.selected").count()).toBe(1);

    await page.click(projectModeSelector, { modifiers: ["Control"] });
    expect(await page.locator(".session-row.archived.selected").count()).toBe(0);
    await page.close();
  });

  it("archives a single row through its own Archive regardless of the displayed session", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");

    await page.click(`[data-archive="${worktreeId}"]`);

    await page.waitForFunction(
      (gone) => !document.querySelector(`[data-session="${gone}"]`),
      worktreeId,
    );
    expect(await page.locator(`[data-session="${piToolsOtherId}"]`).count()).toBe(1);
    await page.close();
  });

  it("shows the approval pause and keeps icon-free rows aligned at sidebar widths", async () => {
    for (const width of [320, 720]) {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 900 });
      await page.locator(projectModeSelector).click();
      const statuses = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".session-row")).map((row) => {
          const button = row.querySelector(".session-button")!;
          const slot = row.querySelector(".session-status")!;
          const icon = slot.querySelector("svg");
          const name = row.querySelector(".session-name")!;
          const timestamp = row.querySelector(".session-timestamp")!;
          return {
            phase: slot.getAttribute("data-state"),
            archived: slot.getAttribute("data-archived"),
            childCount: slot.childElementCount,
            slotWidth: slot.getBoundingClientRect().width,
            slotHeight: slot.getBoundingClientRect().height,
            nameLeft: name.getBoundingClientRect().left,
            color: getComputedStyle(slot).color,
            nameColor: getComputedStyle(name).color,
            timestampColor: getComputedStyle(timestamp).color,
            paths: Array.from(slot.querySelectorAll("path")).map((path) => path.getAttribute("d")),
            iconWidth: icon?.getBoundingClientRect().width,
            iconHeight: icon?.getBoundingClientRect().height,
            fill: icon === null ? undefined : getComputedStyle(icon).fill,
            title: button.getAttribute("title"),
          };
        }),
      );
      expect(statuses.map((status) => [status.slotWidth, status.slotHeight])).toEqual(
        statuses.map(() => [12, 12]),
      );
      expect(new Set(statuses.map((status) => status.nameLeft)).size).toBe(1);
      const approval = statuses.find((status) => status.phase === "waiting-approval")!;
      expect(approval.paths).toEqual(["M9 4v16", "M15 4v16"]);
      expect(approval.color).toBe("rgb(204, 167, 0)");
      expect([approval.iconWidth, approval.iconHeight, approval.fill]).toEqual([12, 12, "none"]);
      expect(approval.title).toContain("Waiting for approval");
      const waitingUser = statuses.find((status) => status.phase === "waiting-user")!;
      expect(waitingUser.childCount).toBe(0);
      expect(waitingUser.title).toContain("Waiting for user");
      const archived = statuses.find((status) => status.archived === "true")!;
      expect(archived.childCount).toBe(0);
      expect(archived.nameColor).toBe("rgb(157, 157, 157)");
      expect(archived.timestampColor).toBe(archived.nameColor);
      const phaseAbsent = statuses.find(
        (status) => status.phase === null && status.archived === "false",
      )!;
      expect(phaseAbsent.childCount).toBe(0);
      await page.locator(`[data-unarchive="${atlasArchivedId}"]`).click();
      await page.locator(`[data-archive="${atlasArchivedId}"]`).waitFor();
      const restoredStatus = await page
        .locator(`[data-session="${atlasArchivedId}"] .session-status`)
        .evaluate((slot) => ({
          archived: slot.getAttribute("data-archived"),
          phase: slot.getAttribute("data-state"),
          childCount: slot.childElementCount,
          slotWidth: slot.getBoundingClientRect().width,
        }));
      expect(restoredStatus).toEqual({
        archived: "false",
        phase: null,
        childCount: 0,
        slotWidth: 12,
      });
      await page.close();
    }
  });

  it("rotates the running spinner and keeps it stationary with reduced motion", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    const spinner = page.locator('.session-status[data-state="running"] svg');
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const moving = await spinner.evaluate((icon) => {
      const style = getComputedStyle(icon);
      return {
        name: style.animationName,
        duration: style.animationDuration,
        timing: style.animationTimingFunction,
        iterations: style.animationIterationCount,
        color: style.color,
        paths: Array.from(icon.querySelectorAll("path")).map((path) => path.getAttribute("d")),
      };
    });
    expect(moving).toEqual({
      name: "session-spin",
      duration: "1s",
      timing: "linear",
      iterations: "infinite",
      color: "rgb(115, 201, 145)",
      paths: ["M21 12a9 9 0 1 1-6.219-8.56"],
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const stationary = await spinner.evaluate((icon) => ({
      animation: getComputedStyle(icon).animationName,
      transform: getComputedStyle(icon).transform,
      width: icon.getBoundingClientRect().width,
      height: icon.getBoundingClientRect().height,
    }));
    expect(stationary).toEqual({ animation: "none", transform: "none", width: 12, height: 12 });
    expect(
      await page.locator(`[data-session="${atlasCurrentId}"]`).getAttribute("title"),
    ).toContain("Running");
    await page.close();
  });

  it("renders 32px full-width rows with mono dates, status slots, and 24px ghost overlays", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 640 });
    const boxes = await page.evaluate(() => {
      const rowElement = document.querySelector(".session-row")!;
      const row = rowElement.getBoundingClientRect();
      const button = rowElement.querySelector(".session-button")!.getBoundingClientRect();
      const timestampElement = rowElement.querySelector(".session-timestamp")!;
      const timestamp = timestampElement.getBoundingClientRect();
      const dot = rowElement.querySelector(".session-status")!.getBoundingClientRect();
      const archive = rowElement.querySelector(".archive")!.getBoundingClientRect();
      return {
        rowHeight: row.height,
        rowWidth: row.width,
        buttonWidth: button.width,
        buttonRight: button.right,
        rowRight: row.right,
        rowTop: row.top,
        rowBottom: row.bottom,
        timestampRight: timestamp.right,
        timestampTop: timestamp.top,
        timestampBottom: timestamp.bottom,
        timestampFont: getComputedStyle(timestampElement).fontFamily,
        timestampSize: getComputedStyle(timestampElement).fontSize,
        dotWidth: dot.width,
        dotHeight: dot.height,
        archiveRight: archive.right,
        archiveTop: archive.top,
        archiveBottom: archive.bottom,
        controls: Array.from(rowElement.querySelectorAll(".archive")).map((control) => {
          const box = control.getBoundingClientRect();
          const icon = control.querySelector("svg")!.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            iconWidth: icon.width,
            iconHeight: icon.height,
          };
        }),
      };
    });
    expect(boxes.rowHeight).toBe(32);
    expect(boxes.dotWidth).toBe(12);
    expect(boxes.dotHeight).toBe(12);
    expect(boxes.timestampFont).toContain("mono");
    expect(boxes.timestampSize).toBe("10px");
    expect(boxes.controls).toEqual([{ width: 24, height: 24, iconWidth: 12, iconHeight: 12 }]);
    expect(boxes.buttonWidth).toBeCloseTo(boxes.rowWidth, 1);
    expect(boxes.buttonRight).toBeCloseTo(boxes.rowRight, 1);
    expect(boxes.timestampRight).toBeLessThan(boxes.archiveRight);
    expect(boxes.rowRight - boxes.timestampRight).toBeCloseTo(36, 1);
    for (const overlay of [
      [boxes.timestampTop, boxes.timestampBottom],
      [boxes.archiveTop, boxes.archiveBottom],
    ]) {
      expect(overlay[0]).toBeGreaterThanOrEqual(boxes.rowTop);
      expect(overlay[1]).toBeLessThanOrEqual(boxes.rowBottom);
    }
    expect(boxes.rowRight - boxes.archiveRight).toBeLessThanOrEqual(8);
    await page.locator(".session-button").first().focus();
    await page.keyboard.press("Tab");
    const focusedArchive = await page
      .locator(".archive")
      .first()
      .evaluate((control) => ({
        focused: control === document.activeElement,
        focusVisible: control.matches(":focus-visible"),
        outlineWidth: getComputedStyle(control).outlineWidth,
        radius: getComputedStyle(control).borderRadius,
      }));
    expect(focusedArchive).toEqual({
      focused: true,
      focusVisible: true,
      outlineWidth: "2px",
      radius: "9.6px",
    });
    await page.close();
  });

  it.each([
    { theme: "dark", width: 320 },
    { theme: "light", width: 320 },
    { theme: "dark", width: 720 },
    { theme: "light", width: 720 },
  ])(
    "shares a stable disclosure hover surface without highlighting workspace actions in $theme at $width px",
    async ({ theme, width }) => {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 640 });
      if (theme === "light") {
        await page.addStyleTag({
          content: ":root { --vscode-list-hoverBackground: #e8e8e8; }",
        });
      }
      const header = page.locator(".group-header").first().describe("Workspace header");
      const surface = header.locator(".group-toggle").describe("Shared disclosure background");
      const title = header.locator(".group-title").describe("Workspace name");
      const controls = header.locator("button").describe("Workspace header controls");
      const hoverBackground = theme === "light" ? "rgb(232, 232, 232)" : "rgb(42, 45, 46)";
      const transparent = "rgba(0, 0, 0, 0)";
      const idleBounds = await controls.evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().toJSON()),
      );
      expect(idleBounds[0]).toMatchObject({ x: 4, width: 24, height: 24 });
      expect(idleBounds[1].x).toBe(28);
      expect(await surface.evaluate((element) => getComputedStyle(element).gap)).toBe("0px");
      expect(await surface.evaluate((element) => getComputedStyle(element).borderRadius)).toBe(
        "9.6px",
      );
      expect(
        await surface.evaluate((element) => getComputedStyle(element).transitionDuration),
      ).toBe("0s");
      expect(
        await surface
          .locator(".group-workspace-menu, .group-mode-toggle, .group-new-session")
          .count(),
      ).toBe(0);

      for (const label of ["agenda", "workspace-with-a-long-unbroken-name-".repeat(5)]) {
        await title.evaluate((element, text) => {
          element.textContent = text;
        }, label);
        expect(
          await title.evaluate((element) => {
            const style = getComputedStyle(element);
            return [
              style.paddingLeft,
              style.paddingRight,
              style.fontSize,
              style.fontWeight,
              style.textOverflow,
            ];
          }),
        ).toEqual(["0px", "6px", "14px", "600", "ellipsis"]);
        if (label !== "agenda") {
          expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            true,
          );
        }

        const labelBounds = await controls.evaluateAll((buttons) =>
          buttons.map((button) => button.getBoundingClientRect().toJSON()),
        );
        expect(labelBounds[2]).toMatchObject({ width: 24, height: 24 });
        expect(labelBounds[2].x).toBeCloseTo(labelBounds[1].x + labelBounds[1].width);
        expect(labelBounds.slice(3)).toEqual(idleBounds.slice(3));
        for (const selector of [
          ".group-chevron",
          ".group-title",
          ".group-workspace-menu",
          ".group-mode-toggle",
          ".group-new-session",
        ]) {
          const control = header.locator(selector);
          await control.hover();
          const isDisclosure = selector === ".group-chevron" || selector === ".group-title";
          expect(
            await surface.evaluate((element) => getComputedStyle(element).backgroundColor),
          ).toBe(isDisclosure ? hoverBackground : transparent);
          expect(
            await controls.evaluateAll((buttons) =>
              buttons.map((button) => getComputedStyle(button).backgroundColor),
            ),
          ).toEqual([
            transparent,
            transparent,
            selector === ".group-workspace-menu" ? hoverBackground : transparent,
            selector === ".group-mode-toggle" ? hoverBackground : transparent,
            selector === ".group-new-session" ? hoverBackground : transparent,
          ]);
          expect(
            await controls.evaluateAll((buttons) =>
              buttons.map((button) => button.getBoundingClientRect().toJSON()),
            ),
          ).toEqual(labelBounds);
        }
      }

      await title.evaluate((element) => {
        element.textContent = "agenda";
      });
      await page.mouse.move(1, 1);
      await header.locator(".group-chevron").focus();
      await page.keyboard.press("Shift+Tab");
      for (const selector of [
        ".group-chevron",
        ".group-title",
        ".group-mode-toggle",
        ".group-new-session",
      ]) {
        await page.keyboard.press("Tab");
        expect(
          await header.locator(selector).evaluate((element) => ({
            focused: document.activeElement === element,
            visible: element.matches(":focus-visible"),
            outlineWidth: getComputedStyle(element).outlineWidth,
            height: element.getBoundingClientRect().height,
          })),
        ).toEqual({ focused: true, visible: true, outlineWidth: "2px", height: 24 });
      }
      expect(
        await controls.evaluateAll((buttons) =>
          buttons.map((button) => button.getBoundingClientRect().toJSON()),
        ),
      ).toEqual(idleBounds);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.close();
    },
  );

  it("collapses groups from chevrons and names while the mode and refresh preserve the state", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const group = page
      .locator(".group")
      .filter({ has: page.locator('.group-header[title="~/projects/vscode-pi-sessions"]') });
    const chevron = group.locator(".group-chevron").describe("Project group chevron");
    const name = group.locator(".group-title").describe("Project group name");
    expect(await chevron.getAttribute("aria-expanded")).toBe("true");

    await chevron.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => chevron.getAttribute("aria-expanded")).toBe("false");
    expect(await group.locator(".session-row").count()).toBe(0);
    expect(await chevron.locator("path").getAttribute("d")).toBe("m9 18 6-6-6-6");
    await name.click();
    await expect.poll(() => group.locator(".session-row").count()).toBe(1);
    expect(await chevron.getAttribute("aria-expanded")).toBe("true");

    await name.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => chevron.getAttribute("aria-expanded")).toBe("false");
    await page.click(projectModeSelector);
    await expect
      .poll(() => page.locator(projectModeSelector).getAttribute("data-mode"))
      .toBe("all");
    expect(await chevron.getAttribute("aria-expanded")).toBe("false");
    expect(await group.locator(".session-row").count()).toBe(0);
    for (let index = 0; index < 2; index++) await refreshSessions(page);
    expect(await chevron.getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator(projectModeSelector).getAttribute("data-mode")).toBe("all");
    await name.click();
    await expect.poll(() => group.locator(".session-row").count()).toBe(2);
    expect(await openSessionMessages(page)).toEqual([]);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".session-row");
    expect(await chevron.getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator(projectModeSelector).getAttribute("data-mode")).toBe("unarchived");
    expect(await group.locator(".session-row").count()).toBe(1);
    await page.close();
  });

  it("adds a row to the requested group from its New session button", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const group = page
      .locator(".group")
      .filter({ has: page.locator('.group-header[title="~/projects/vscode-pi-sessions"]') });
    const plus = group.locator(".group-new-session").describe("Project group New session button");
    expect(await plus.getAttribute("aria-label")).toBe("New session in vscode-pi-sessions");
    const rowsBefore = await group.locator(".session-row").count();

    await plus.click();

    await expect.poll(() => group.locator(".session-row").count()).toBe(rowsBefore + 1);
    const added = group.locator(".session-row", { hasText: "New Pi session" });
    await added.waitFor();
    expect(
      await page.evaluate(() => {
        const messages = (window as Window & { __bridgeMessages?: { type?: string }[] })
          .__bridgeMessages;
        if (messages === undefined) throw new Error("Bridge message recorder is not installed.");
        return messages.filter((message) => message.type === "newSession");
      }),
    ).toEqual([
      { type: "newSession", cwd: "~/projects/vscode-pi-sessions", requestId: expect.any(String) },
    ]);
    expect(await group.locator(".group-new-session").getAttribute("aria-busy")).toBe("false");
    await page.close();
  });

  it.each([320, 390, 720].flatMap((width) => [180, 844].map((height) => ({ width, height }))))(
    "replaces the footer button in place without scrolling at $width x $height",
    async ({ width, height }) => {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height });
      const button = page.locator(".new-workspace").describe("New workspace footer button");
      const input = page.locator("#workspace-path").describe("Workspace path input");
      const footer = page.locator(".footer");
      const icon = page.locator(".workspace-folder-icon").describe("Decorative workspace folder");
      const listTop = await page
        .locator("#sessions")
        .evaluate((element) => element.getBoundingClientRect().top);
      expect(listTop).toBe(12);
      async function documentBounds() {
        return page.evaluate(() => ({
          top: window.scrollY,
          height: document.scrollingElement!.scrollHeight,
          width: document.scrollingElement!.scrollWidth,
        }));
      }

      for (const position of ["start", "end"]) {
        await page.evaluate((position) => {
          window.scrollTo(0, position === "start" ? 0 : document.scrollingElement!.scrollHeight);
        }, position);
        const buttonBefore = await button.boundingBox();
        const iconBefore = await icon.boundingBox();
        const labelStart = await button.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().left;
        });
        const footerBefore = await footer.boundingBox();
        const documentBefore = await documentBounds();
        expect(buttonBefore).toEqual({
          x: 24,
          y: height - listTop - 32,
          width: width - 48,
          height: 32,
        });
        expect(documentBefore.width).toBe(width);
        expect(iconBefore).toEqual({ x: 35, y: height - listTop - 24, width: 16, height: 16 });
        expect(labelStart).toBe(57);
        expect(await icon.getAttribute("aria-hidden")).toBe("true");
        expect(await icon.getAttribute("focusable")).toBe("false");
        expect(await icon.getAttribute("tabindex")).toBeNull();

        await button.click();
        await expect.poll(() => input.isVisible()).toBe(true);
        expect(await button.isHidden()).toBe(true);
        expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await input.boundingBox()).toEqual(buttonBefore);
        expect(await icon.boundingBox()).toEqual(iconBefore);
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
        expect(await icon.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
          "none",
        );
        await page.mouse.click(43, height - listTop - 16);
        expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await footer.boundingBox()).toEqual(footerBefore);
        expect(await documentBounds()).toEqual(documentBefore);

        await input.press("Escape");
        expect(await input.isHidden()).toBe(true);
        expect(await button.boundingBox()).toEqual(buttonBefore);
        expect(await icon.boundingBox()).toEqual(iconBefore);
        expect(await footer.boundingBox()).toEqual(footerBefore);
        expect(await documentBounds()).toEqual(documentBefore);
      }
      await page.close();
    },
  );

  it.each([320, 390])("reserves footer status space only for text at width %s", async (width) => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 844 });
    const status = page.locator("#status").describe("Workspace status message");
    async function footerSpacing() {
      return page.evaluate(() => {
        const footer = document.querySelector(".footer")!;
        const button = document.querySelector(".new-workspace")!;
        const status = document.querySelector("#status")!;
        const footerBounds = footer.getBoundingClientRect();
        const buttonBounds = button.getBoundingClientRect();
        const statusBounds = status.getBoundingClientRect();
        return {
          topGap:
            buttonBounds.top -
            footerBounds.top -
            parseFloat(getComputedStyle(footer).borderTopWidth),
          bottomGap: innerHeight - buttonBounds.bottom,
          statusHeight: statusBounds.height,
          statusGap: buttonBounds.top - statusBounds.bottom,
        };
      });
    }

    const emptySpacing = await footerSpacing();
    expect(emptySpacing.topGap).toBe(12);
    expect(emptySpacing.bottomGap).toBe(12);
    expect(emptySpacing.statusHeight).toBe(0);

    await status.evaluate((element) => {
      element.textContent = "Workspace path does not exist.";
    });
    const messageSpacing = await footerSpacing();
    expect(messageSpacing.statusHeight).toBeGreaterThanOrEqual(16);
    expect(messageSpacing.statusGap).toBe(8);
    expect(messageSpacing.bottomGap).toBe(12);

    await status.evaluate((element) => {
      element.textContent = "";
    });
    expect(await footerSpacing()).toEqual(emptySpacing);
    await page.close();
  });

  it.each(
    ["click", "focus", "Tab", "Shift+Tab", "window blur"].flatMap((activation) =>
      ["", "/tmp/unsubmitted-workspace"].map((draft) => ({ activation, draft })),
    ),
  )(
    "closes the workspace form on $activation with draft '$draft'",
    async ({ activation, draft }) => {
      const page = await openStory("sessions-sidebar--sample-sessions");
      await installBridgeMessageRecorder(page);
      const button = page.locator(".new-workspace").describe("New workspace footer button");
      const form = page.locator("#workspace-form").describe("Workspace path form");
      const input = page.locator("#workspace-path").describe("Workspace path input");
      const heading = page
        .locator(".group-title")
        .first()
        .describe("Workspace heading focus target");
      const groupCountBefore = await page.locator(".group").count();
      const headingExpanded = await heading.getAttribute("aria-expanded");
      await button.click();
      await input.fill(draft);

      if (activation === "click") await heading.click();
      else if (activation === "focus") await heading.focus();
      else if (activation === "window blur") {
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      } else await input.press(activation);

      await expect.poll(() => form.isHidden()).toBe(true);
      expect(await button.isVisible()).toBe(true);
      expect(await button.getAttribute("aria-expanded")).toBe("false");
      expect(await input.inputValue()).toBe("");
      expect(await page.locator(".group").count()).toBe(groupCountBefore);
      if (activation === "click" || activation === "focus") {
        expect(await heading.evaluate((element) => element === document.activeElement)).toBe(true);
      }
      if (activation === "click") {
        expect(await heading.getAttribute("aria-expanded")).toBe(
          headingExpanded === "true" ? "false" : "true",
        );
      }
      expect(
        await page.evaluate(() =>
          (window as Window & { __bridgeMessages?: { type?: string }[] }).__bridgeMessages?.filter(
            (message) => message.type === "addWorkspace",
          ),
        ),
      ).toEqual([]);

      await button.click();
      expect(await input.inputValue()).toBe("");
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.close();
    },
  );

  it("keeps the workspace draft and focus during a list refresh", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const input = page.locator("#workspace-path").describe("Workspace path draft");
    await page.locator(".new-workspace").click();
    await input.fill("/tmp/unsubmitted-workspace");
    await page.evaluate(() => {
      const refresh = (window as Window & { __refreshSessions?: () => void }).__refreshSessions;
      if (refresh === undefined) throw new Error("Session refresh hook is missing.");
      refresh();
    });
    expect(await page.locator("#workspace-form").isVisible()).toBe(true);
    expect(await input.inputValue()).toBe("/tmp/unsubmitted-workspace");
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  it("adds the workspace on Enter and closes the form on Escape", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const toggle = page.locator('[data-action="toggleWorkspaceForm"]');
    const form = page.locator("#workspace-form");
    const input = page.locator("#workspace-path");
    const groupCountBefore = await page.locator(".group").count();

    await toggle.focus();
    await toggle.press("Enter");
    expect(await form.isVisible()).toBe(true);
    expect(await toggle.isHidden()).toBe(true);
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await input.inputValue()).toBe("");

    await input.fill("   ");
    await input.press("Enter");
    expect(await input.inputValue()).toBe("   ");
    expect(await form.isVisible()).toBe(true);
    await input.fill("~/projects/ime-pending");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    expect(await form.isVisible()).toBe(true);
    expect(await input.inputValue()).toBe("~/projects/ime-pending");
    expect(
      await page.evaluate(() =>
        (window as Window & { __bridgeMessages?: { type?: string }[] }).__bridgeMessages?.filter(
          (message) => message.type === "addWorkspace",
        ),
      ),
    ).toEqual([]);

    await input.press("Escape");
    expect(await form.isVisible()).toBe(false);
    expect(await toggle.isVisible()).toBe(true);
    expect(await input.inputValue()).toBe("");
    expect(await page.locator(".group").count()).toBe(groupCountBefore);

    await toggle.click();
    await input.fill("  ~/projects/brand-new  ");
    await input.press("Enter");
    const added = page.locator(".group").filter({ hasText: "brand-new" });
    await expect.poll(() => page.locator(".group").count()).toBe(groupCountBefore + 1);
    expect(await added.locator(".session-row").count()).toBe(0);
    expect(await form.isVisible()).toBe(false);
    expect(await toggle.isVisible()).toBe(true);
    expect(await input.inputValue()).toBe("");
    expect(
      await page.evaluate(() => {
        const messages = (window as Window & { __bridgeMessages?: { type?: string }[] })
          .__bridgeMessages;
        if (messages === undefined) throw new Error("Bridge message recorder is not installed.");
        return messages.filter((message) => message.type === "addWorkspace");
      }),
    ).toEqual([{ type: "addWorkspace", path: "~/projects/brand-new" }]);
    await page.close();
  });

  it("shows the registered-only workspace as an empty group", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    const agenda = page.locator(".group").filter({ hasText: "agenda" });

    await expect.poll(() => agenda.locator(".group-title").textContent()).toBe("agenda");
    expect(await agenda.locator(".session-row").count()).toBe(0);
    await page.close();
  });

  it.each([
    { theme: "dark", width: 320 },
    { theme: "light", width: 320 },
    { theme: "dark", width: 720 },
    { theme: "light", width: 720 },
  ])(
    "keeps workspace menus inside the viewport in $theme at $width px",
    async ({ theme, width }) => {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 640 });
      if (theme === "light") {
        await page.addStyleTag({
          content: `:root {
        --vscode-foreground: #333333;
        --vscode-sideBar-background: #f8f8f8;
        --vscode-list-hoverBackground: #e8e8e8;
      }`,
        });
      }
      await installBridgeMessageRecorder(page);
      const groups = page.locator(".group").describe("Workspace groups");
      const firstHeader = groups.first().locator(".group-header");
      const before = await firstHeader.boundingBox();
      const documentSize = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        top: window.scrollY,
      }));
      expect(await page.locator(".group-unregister").count()).toBe(0);
      expect(await groups.locator(".group-mode-toggle").count()).toBe(await groups.count());
      expect(await groups.locator(".group-new-session").count()).toBe(await groups.count());

      for (const header of await groups.locator(".group-header").all()) {
        await header.locator(".group-title").press("Enter");
        expect(await header.locator(".group-title").getAttribute("aria-expanded")).toBe("false");
        await header.click({ button: "right" });
        await expect.poll(() => page.getByRole("menuitem").count()).toBe(1);
        expect(
          await page.getByRole("menuitem").evaluate((item) => item === document.activeElement),
        ).toBe(false);
        await page.mouse.click(0, 0);
        expect(await page.getByRole("menu").count()).toBe(0);
        await header.locator(".group-title").press("Space");
        expect(await header.locator(".group-title").getAttribute("aria-expanded")).toBe("true");
      }

      for (const point of [
        { x: 1, y: 1 },
        { x: width - 1, y: 639 },
      ]) {
        await firstHeader.evaluate((element, point) => {
          element.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: point.x,
              clientY: point.y,
              button: 2,
            }),
          );
        }, point);
        const menu = page.getByRole("menu").describe("Workspace context menu");
        const bounds = await menu.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(4);
        expect(bounds!.y).toBeGreaterThanOrEqual(4);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 4);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(636);
        expect((await page.getByRole("menuitem").boundingBox())!.height).toBeGreaterThanOrEqual(32);
        expect(await firstHeader.boundingBox()).toEqual(before);
        expect(
          await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            top: window.scrollY,
          })),
        ).toEqual(documentSize);
        await page.mouse.click(0, 0);
      }
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([]);
      await page.close();
    },
  );

  it("reveals workspace actions only while their own hit target is hovered", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    const header = page.locator('.group-header[title="~/projects/agenda"]');
    const trigger = header.locator(".group-workspace-menu");
    const before = await trigger.boundingBox();
    await page.mouse.move(1, 1);
    expect(await trigger.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    await header.locator(".group-title").hover();
    expect(await trigger.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    await trigger.hover();
    expect(await trigger.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    await page.mouse.move(1, 1);
    await trigger.focus();
    expect(await trigger.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    expect(await trigger.boundingBox()).toEqual(before);
    await page.close();
  });

  it("toggles workspace menus open closed and open on consecutive pointer clicks", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    const trigger = page.locator('.group-header[title="~/projects/agenda"] .group-workspace-menu');
    for (const count of [1, 0, 1]) {
      await trigger.click();
      await expect.poll(() => page.getByRole("menu").count()).toBe(count);
      expect(await trigger.getAttribute("aria-expanded")).toBe(String(count === 1));
    }
    await page.close();
  });

  it("keeps workspace menu controls out of keyboard navigation and ignores menu keys", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const header = page.locator('.group-header[title="~/projects/agenda"]');
    const trigger = header.locator(".group-workspace-menu");
    expect(await trigger.getAttribute("tabindex")).toBe("-1");
    await header.locator(".group-title").focus();
    await page.keyboard.press("Tab");
    expect(
      await header
        .locator(".group-mode-toggle")
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    for (const key of ["Enter", "Space"]) {
      await trigger.press(key);
      expect(await page.getByRole("menu").count()).toBe(0);
    }
    await trigger.click();
    const item = page.getByRole("menuitem");
    expect(await item.getAttribute("tabindex")).toBe("-1");
    expect(await item.evaluate((element) => element === document.activeElement)).toBe(false);
    for (const key of ["Enter", "Space", "Escape", "Tab", "Shift+Tab"]) {
      await item.press(key);
      expect(await page.getByRole("menu").count()).toBe(1);
    }
    await page.mouse.click(0, 0);
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(false);
    expect(
      await page.evaluate(
        () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
      ),
    ).toEqual([]);
    await page.close();
  });

  it.each([false, true])(
    "opens the ellipsis menu when collapsed=%s without other actions",
    async (collapsed) => {
      const page = await openStory("sessions-sidebar--sample-sessions", {
        width: 320,
        height: 640,
      });
      await installBridgeMessageRecorder(page);
      const header = page.locator('.group-header[title="~/projects/agenda"]');
      const title = header.locator(".group-title");
      if (collapsed) await title.click();
      const trigger = header.getByRole("button", { name: "Workspace actions", exact: true });
      const before = await trigger.boundingBox();
      expect(await trigger.getAttribute("title")).toBe("Workspace actions");
      expect(await trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(await trigger.getAttribute("aria-expanded")).toBe("false");
      expect(await trigger.locator("svg").getAttribute("width")).toBe("12");
      await trigger.click();
      const menu = page.getByRole("menu");
      await expect.poll(() => menu.count()).toBe(1);
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeCloseTo(Math.max(4, Math.min(before!.x, 320 - bounds.width - 4)));
      expect(bounds.y).toBeCloseTo(before!.y + before!.height);
      expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      expect(await title.getAttribute("aria-expanded")).toBe(String(!collapsed));
      expect(await header.locator(".group-mode-toggle").getAttribute("data-mode")).toBe(
        "unarchived",
      );
      expect(
        await page.getByRole("menuitem").evaluate((item) => item === document.activeElement),
      ).toBe(false);
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([]);
      await page.mouse.click(0, 0);
      expect(await trigger.getAttribute("aria-expanded")).toBe("false");
      expect(await trigger.boundingBox()).toEqual(before);
      await page.close();
    },
  );

  it.each([
    ["~/projects/agenda", 0, "pointer"],
    ["~/projects/vscode-pi-sessions", 1, "pointer"],
    ["~/.agents/worktrees/vscode-pi-sessions", 1, "pointer"],
    ["~/projects/agenda", 0, "ellipsis"],
    ["~/projects/vscode-pi-sessions", 1, "ellipsis"],
    ["~/.agents/worktrees/vscode-pi-sessions", 1, "ellipsis"],
  ] as const)(
    "unregisters %s directly once with %s sessions via %s without confirmation",
    async (cwd, sessionCount, invocation) => {
      const page = await openStory("sessions-sidebar--sample-sessions", {
        width: 320,
        height: 640,
      });
      await installBridgeMessageRecorder(page);
      const groups = page.locator(".group");
      const group = groups.filter({ has: page.locator(`.group-header[title="${cwd}"]`) });
      const groupCountBefore = await groups.count();
      expect(await group.locator(".session-row").count()).toBe(sessionCount);
      if (invocation === "pointer") await group.locator(".group-header").click({ button: "right" });
      else await group.locator(".group-workspace-menu").click();
      const unregister = page
        .getByRole("menuitem", { name: "Unregister workspace", exact: true })
        .describe("Workspace Unregister menu item");
      expect(await unregister.evaluate((item) => item === document.activeElement)).toBe(false);
      await unregister.click();

      expect(await page.getByRole("menu").count()).toBe(0);
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await page.locator("#confirmation-dialog").isHidden()).toBe(true);
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([{ type: "unregisterWorkspace", cwd }]);
      await expect.poll(() => group.count()).toBe(0);
      expect(await groups.count()).toBe(groupCountBefore - 1);
      expect(await openSessionMessages(page)).toEqual([]);
      await page.close();
    },
  );

  it.each(
    ["pointer", "scroll", "resize", "blur"].flatMap((dismissal) =>
      ["context", "ellipsis"].map((invocation) => ({ dismissal, invocation })),
    ),
  )(
    "dismisses $invocation workspace menus with $dismissal without sending a request",
    async ({ dismissal, invocation }) => {
      const page = await openStory("sessions-sidebar--sample-sessions");
      await installBridgeMessageRecorder(page);
      const header = page.locator('.group-header[title="~/projects/agenda"]');
      if (invocation === "ellipsis") await header.locator(".group-workspace-menu").click();
      else await header.click({ button: "right" });
      await expect.poll(() => page.getByRole("menu").count()).toBe(1);
      expect(await header.locator(".group-workspace-menu").getAttribute("aria-expanded")).toBe(
        "true",
      );
      if (dismissal === "pointer") await page.mouse.click(0, 0);
      else if (dismissal === "scroll")
        await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
      else if (dismissal === "resize") await page.setViewportSize({ width: 720, height: 600 });
      else if (dismissal === "blur")
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect.poll(() => page.getByRole("menu").count()).toBe(0);
      expect(await header.locator(".group-workspace-menu").getAttribute("aria-expanded")).toBe(
        "false",
      );
      expect(await header.locator(".group-title").getAttribute("aria-expanded")).toBe("true");
      expect(await header.locator(".group-mode-toggle").getAttribute("data-mode")).toBe(
        "unarchived",
      );
      expect(
        await page.locator(".session-row.selected [data-session]").getAttribute("data-session"),
      ).toBe(atlasCurrentId);
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([]);
      await page.close();
    },
  );

  it.each(["context", "ellipsis"])(
    "replaces the menu target when another same-named workspace opens its %s menu",
    async (invocation) => {
      const page = await openStory("sessions-sidebar--sample-sessions");
      await installBridgeMessageRecorder(page);
      for (const cwd of [
        "~/projects/vscode-pi-sessions",
        "~/.agents/worktrees/vscode-pi-sessions",
      ]) {
        const header = page.locator(`.group-header[title="${cwd}"]`);
        if (invocation === "context") await header.click({ button: "right" });
        else await header.locator(".group-workspace-menu").click();
        expect(await page.getByRole("menu").count()).toBe(1);
        expect(await header.locator(".group-workspace-menu").getAttribute("aria-expanded")).toBe(
          "true",
        );
      }
      expect(await page.getByRole("menu").count()).toBe(1);
      await page.getByRole("menuitem").click();
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([{ type: "unregisterWorkspace", cwd: "~/.agents/worktrees/vscode-pi-sessions" }]);
      expect(
        await page.locator('.group-header[title="~/projects/vscode-pi-sessions"]').count(),
      ).toBe(1);
      await page.close();
    },
  );

  it.each([
    ["~/projects/vscode-pi-sessions", "remove preceding"],
    ["~/.agents/worktrees/vscode-pi-sessions", "remove preceding"],
    ["~/projects/vscode-pi-sessions", "reverse"],
    ["~/.agents/worktrees/vscode-pi-sessions", "reverse"],
  ] as const)("preserves menu target for %s after %s", async (cwd, update) => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const header = page.locator(`.group-header[title="${cwd}"]`);
    await header.click({ button: "right" });
    await expect.poll(() => page.getByRole("menu").count()).toBe(1);
    const lastCwd = await page.locator(".group-header").last().getAttribute("title");
    await page.evaluate((update) => {
      const testWindow = window as Window & {
        __removeWorkspace?: (cwd: string) => void;
        __reverseWorkspaces?: () => void;
      };
      if (update === "remove preceding") testWindow.__removeWorkspace!("~/projects/agenda");
      else testWindow.__reverseWorkspaces!();
    }, update);
    if (update === "remove preceding") {
      await expect
        .poll(() => page.locator('.group-header[title="~/projects/agenda"]').count())
        .toBe(0);
    } else {
      await expect
        .poll(() => page.locator(".group-header").first().getAttribute("title"))
        .toBe(lastCwd);
    }
    expect(await page.getByRole("menu").count()).toBe(1);
    await header.locator(".group-workspace-menu").click();
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(
      await page.evaluate(
        () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
      ),
    ).toEqual([]);
    await page.close();
  });

  it("closes a workspace menu when its target disappears from incoming state", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const cwd = "~/projects/agenda";
    await page.locator(`.group-header[title="${cwd}"]`).click({ button: "right" });
    await expect.poll(() => page.getByRole("menu").count()).toBe(1);
    await page.evaluate((cwd) => {
      const removeWorkspace = (window as Window & { __removeWorkspace?: (cwd: string) => void })
        .__removeWorkspace;
      if (removeWorkspace === undefined) throw new Error("Workspace updater is missing.");
      removeWorkspace(cwd);
    }, cwd);
    await expect.poll(() => page.getByRole("menu").count()).toBe(0);
    expect(await page.locator(`.group-header[title="${cwd}"]`).count()).toBe(0);
    expect(
      await page.evaluate(
        () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
      ),
    ).toEqual([]);
    await page.close();
  });

  it.each([
    ".group-chevron",
    ".group-title",
    ".group-workspace-menu",
    ".group-mode-toggle",
    ".group-new-session",
  ])(
    "ignores workspace menu shortcuts on %s without activating the header control",
    async (selector) => {
      const page = await openStory("sessions-sidebar--sample-sessions");
      await installBridgeMessageRecorder(page);
      const header = page.locator('.group-header[title="~/projects/vscode-pi-sessions"]');
      const trigger = header.locator(selector);
      for (const shortcut of ["Shift+F10", "ContextMenu"]) {
        await trigger.press(shortcut);
        expect(await page.getByRole("menu").count()).toBe(0);
        expect(await trigger.evaluate((item) => item === document.activeElement)).toBe(true);
        expect(await header.locator(".group-title").getAttribute("aria-expanded")).toBe("true");
        expect(await header.locator(".group-mode-toggle").getAttribute("data-mode")).toBe(
          "unarchived",
        );
      }
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([]);
      await page.close();
    },
  );

  it("keeps the displayed session's mark across collapsing and archiving other rows", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const group = page
      .locator(".group")
      .filter({ has: page.locator('.group-header[title="~/projects/vscode-pi-sessions"]') });
    const chevron = group.locator(".group-chevron");
    expect(await chevron.getAttribute("aria-expanded")).toBe("true");
    // The displayed session's row is the only selected row.
    expect(await page.locator(".session-row.selected").count()).toBe(1);

    await chevron.click();
    await expect.poll(() => chevron.getAttribute("aria-expanded")).toBe("false");
    // Collapsing the displayed session's group hides the only selected row.
    expect(await page.locator(".session-row.selected").count()).toBe(0);
    await group.locator(".group-title").click();
    await expect.poll(() => page.locator(".session-row.selected").count()).toBe(1);
    await chevron.click();
    await expect.poll(() => chevron.getAttribute("aria-expanded")).toBe("false");
    await page.locator(`[data-archive="${worktreeId}"]`).click();
    await expect.poll(() => page.locator(`[data-session="${worktreeId}"]`).count()).toBe(0);
    expect(await chevron.getAttribute("aria-expanded")).toBe("false");
    await group.locator(".group-title").click();
    await expect
      .poll(() => page.locator(`.session-row.selected [data-session="${atlasCurrentId}"]`).count())
      .toBe(1);
    expect(await openSessionMessages(page)).toEqual([]);
    await page.close();
  });

  it("renders the wide preview width", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 720, height: 640 });
    expect(await page.locator(".session-row").count()).toBe(4);
    await page.close();
  });

  it("keeps empty Unarchived group headings and modes without guidance text", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--empty-sessions`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".group-header");
    // Three session cwds plus the registered-only workspace (sample data).
    expect(await page.locator(".group-header").count()).toBe(4);
    expect(await page.locator(".group-header [data-mode-toggle]").count()).toBe(4);
    expect(await page.locator("#app header [data-mode-toggle]").count()).toBe(0);
    expect(await page.locator(".session-row").count()).toBe(0);
    expect(await page.locator(".empty").count()).toBe(0);
    const historyToggle = page.locator(projectModeSelector).describe("Show saved sessions");
    await historyToggle.focus();
    await historyToggle.press("Enter");
    await page.waitForSelector(".session-row");
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(await page.locator(".session-row.archived").count()).toBe(2);
    expect(await page.locator(worktreeModeSelector).getAttribute("data-mode")).toBe("unarchived");
    expect(await page.locator(piToolsModeSelector).getAttribute("data-mode")).toBe("unarchived");
    await page.locator(piToolsModeSelector).click();
    expect(await page.locator(".session-row.archived").count()).toBe(4);
    await page.locator(worktreeModeSelector).press("Space");
    expect(await page.locator(".session-row.archived").count()).toBe(5);
    const emptyMode = page.locator('[data-mode-toggle="~/projects/agenda"]');
    await emptyMode.press("Enter");
    expect(await emptyMode.getAttribute("data-mode")).toBe("all");
    expect(await page.locator(".session-row").count()).toBe(5);
    await page.close();
  });

  it("shows distinct same-named worktree heading hints without horizontal overflow at sidebar widths", async () => {
    for (const width of [320, 720]) {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 640 });
      const headings = page.locator(".group-header").describe("Work folder heading hints");
      const hints = await headings.evaluateAll((headers) =>
        headers.map((header) => header.getAttribute("title")),
      );
      expect(hints).toContain("~/projects/vscode-pi-sessions");
      expect(hints).toContain("~/.agents/worktrees/vscode-pi-sessions");
      expect(await page.locator(".group-path").count()).toBe(0);
      const hasOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(hasOverflow).toBe(false);
      await page.close();
    }
  });

  it("captures a screenshot of the static output without the extension host", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 640 });
    const path = join(tmpdir(), `pi-sessions-storybook-smoke-${process.pid}.png`);
    await page.screenshot({ path });
    const screenshot = await stat(path);
    expect(screenshot.size).toBeGreaterThan(0);
    await page.close();
    await rm(path, { force: true });
  });
});
