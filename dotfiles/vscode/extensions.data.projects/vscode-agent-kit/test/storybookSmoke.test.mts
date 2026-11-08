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
      type TestWindow = Window & { __bridgeMessages?: unknown[] };

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
            const originalPostMessage = bridge.postMessage.bind(bridge);
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
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 440 });
      const row = page.locator(".session-row").first();
      async function rowBounds() {
        return row.evaluate((element) => {
          const { left, right, width } = element.getBoundingClientRect();
          return { left, right, width };
        });
      }
      const before = await rowBounds();
      expect(before).toEqual({ left: 24, right: width - 12, width: width - 36 });
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(440);
      await page.click("[data-mode-toggle]");
      await page.waitForSelector(".session-row.archived");
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBeGreaterThan(
        440,
      );
      expect(await rowBounds()).toEqual(before);
      await page.click("[data-mode-toggle]");
      await expect.poll(() => page.locator(".session-row").count()).toBe(4);
      expect(await rowBounds()).toEqual(before);
      expect(
        await page.locator("header").evaluate((element) => getComputedStyle(element).position),
      ).toBe("static");
      expect(
        await page.locator(".footer").evaluate((element) => getComputedStyle(element).position),
      ).toBe("sticky");
      await page.close();
    },
  );

  it("updates the overlay for mode, group, data, form, and viewport height changes", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 440 });
    const track = page.getByRole("scrollbar", { includeHidden: true });
    await expect.poll(() => track.isHidden()).toBe(true);
    await page.click("[data-mode-toggle]");
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
    await expect.poll(() => track.getAttribute("aria-valuemax")).not.toBe(beforeForm);
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
    await track.press("PageDown");
    await expect.poll(() => track.getAttribute("aria-valuenow")).toBe("180");
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

  it("blocks overlay focus and End scrolling during unregister confirmation", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 180 });
    const track = page.locator(".session-scrollbar");
    await page.locator(".group-header").first().hover();
    await page.locator(".group-unregister").first().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    for (let step = 0; step < 3; step++) await page.keyboard.press("Tab");
    const scrollbarFocused = await track.evaluate((element) => element === document.activeElement);
    await track.dispatchEvent("keydown", { key: "End" });
    console.log(
      JSON.stringify({
        check: "unregister-overlay-End",
        scrollbarFocused,
        scrollBefore,
        scrollAfter: await page.evaluate(() => window.scrollY),
      }),
    );
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(scrollbarFocused).toBe(false);
    expect(await track.isHidden()).toBe(true);
    await track.evaluate((element) => (element as HTMLElement).focus());
    expect(await track.evaluate((element) => element === document.activeElement)).toBe(false);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => track.isVisible()).toBe(true);
    await track.focus();
    await track.press("End");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.close();
  });

  it("suppresses the overlay through a renamed modal wrapper and restores it when closed", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 180 });
    const track = page.locator(".session-scrollbar");
    const dialog = page.getByRole("dialog", { includeHidden: true });
    await dialog.evaluate((element) => {
      element.parentElement!.id = "confirmation-dialog";
    });
    await expect.poll(() => track.isVisible()).toBe(true);
    await page.locator(".group-header").first().hover();
    await page.locator(".group-unregister").first().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await expect.poll(() => track.isHidden()).toBe(true);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await track.dispatchEvent("keydown", { key: "End" });
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => dialog.isHidden()).toBe(true);
    await expect.poll(() => track.isVisible()).toBe(true);
    await track.focus();
    expect(await track.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  it("ends scrollbar dragging and blocks pointer input while unregister confirmation is open", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 180 });
    const track = page.locator(".session-scrollbar");
    const thumb = await page.locator(".session-scrollbar-thumb").boundingBox();
    if (thumb === null) throw new Error("Scroll thumb is missing.");
    await page.mouse.move(thumb.x + 4, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await expect.poll(() => track.getAttribute("data-dragging")).toBe("true");
    await page
      .locator(".group-unregister")
      .first()
      .evaluate((element) => (element as HTMLElement).click());
    await expect.poll(() => track.getAttribute("data-dragging")).toBeNull();
    expect(await track.evaluate((element) => element.hasPointerCapture(1))).toBe(false);
    expect(await track.isHidden()).toBe(true);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.move(316, 150);
    await page.mouse.up();
    await page.mouse.click(316, 90);
    await track.dispatchEvent("pointerdown", {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientY: 150,
    });
    await track.dispatchEvent("pointermove", { pointerId: 1, isPrimary: true, clientY: 170 });
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(await track.getAttribute("data-dragging")).toBeNull();
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
      await page.locator('[data-action="confirmConfirmation"]').click();
      await page.click("#app header [data-mode-toggle]");
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
            const buttonBackground = getComputedStyle(button).backgroundColor;
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

  it("renders the sample story and operates the shared header mode toggle and archive", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    expect(await page.locator(".session-row").count()).toBe(4);

    await page.click("#app header [data-mode-toggle]");
    await page.waitForFunction(() => document.querySelectorAll(".session-row").length === 5);
    expect(
      await page.locator(`.session-row.archived [data-session="${atlasArchivedId}"]`).count(),
    ).toBe(1);
    // The shared mode applies to every workspace group at once: the project
    // group gains its archived row while the others keep theirs.
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
    await page.locator('[data-action="confirmConfirmation"]').click();
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

  it.each([320, 720])(
    "confirms Archive with target, safe focus, cancel, Escape and keyboard at %ipx",
    async (width) => {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 640 });
      await installBridgeMessageRecorder(page);
      const archive = page.locator(`[data-archive="${atlasCurrentId}"]`);
      const dialog = page.getByRole("dialog", { name: "Archive session" });
      const cancel = page.locator('[data-action="cancelConfirmation"]');
      const confirm = page.locator('[data-action="confirmConfirmation"]');
      await archive.focus();
      await archive.press("Enter");
      await expect.poll(() => dialog.isVisible()).toBe(true);
      expect(await page.locator("#confirmation-dialog-target").textContent()).toContain(
        atlasCurrentId,
      );
      expect(await page.locator("#confirmation-dialog-target").textContent()).toContain(
        "Polish the session sidebar",
      );
      expect(await page.locator("#confirmation-dialog-target").textContent()).toContain(
        "~/projects/vscode-pi-sessions",
      );
      expect(await page.locator("#confirmation-dialog-description").textContent()).toBe(
        "Running work will be interrupted. Unsent input may be lost. The saved conversation stays on disk.",
      );
      expect(await cancel.evaluate((button) => document.activeElement === button)).toBe(true);
      expect(await cancel.evaluate((button) => getComputedStyle(button).outlineWidth)).toBe("2px");
      await page.keyboard.press("Enter");
      await expect.poll(() => dialog.isHidden()).toBe(true);
      expect(await archive.evaluate((button) => document.activeElement === button)).toBe(true);

      await archive.press("Enter");
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.isHidden()).toBe(true);
      expect(
        await page.evaluate(
          () => (window as Window & { __bridgeMessages?: unknown[] }).__bridgeMessages,
        ),
      ).toEqual([]);
      expect(await page.locator(".session-row.selected").count()).toBe(1);
      expect(await page.locator(`[data-session="${atlasCurrentId}"]`).count()).toBe(1);

      await archive.press("Enter");
      await page.keyboard.press("Shift+Tab");
      expect(await confirm.evaluate((button) => document.activeElement === button)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await cancel.evaluate((button) => document.activeElement === button)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await confirm.evaluate((button) => document.activeElement === button)).toBe(true);
      const layout = await dialog.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > innerWidth,
        buttons: Array.from(element.querySelectorAll("button")).map((button) => ({
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
        })),
      }));
      expect(layout.overflow).toBe(false);
      expect(layout.width).toBeLessThan(width);
      for (const button of layout.buttons) {
        expect(button.width).toBeGreaterThanOrEqual(24);
        expect(button.height).toBeGreaterThanOrEqual(24);
      }
      await page.keyboard.press("Enter");
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
    const archive = page.locator('[data-archive="4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83"]');
    await archive.focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-action="confirmConfirmation"]').click();
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
    await page.locator('[data-action="confirmConfirmation"]').click();
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

    await page.click("#app header [data-mode-toggle]", { modifiers: ["Control"] });
    expect(await page.locator(".session-row.archived.selected").count()).toBe(0);
    await page.close();
  });

  it("archives a single row through its own Archive regardless of the displayed session", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");

    await page.click(`[data-archive="${worktreeId}"]`);
    await page.locator('[data-action="confirmConfirmation"]').click();

    await page.waitForFunction(
      (gone) => !document.querySelector(`[data-session="${gone}"]`),
      worktreeId,
    );
    expect(await page.locator(`[data-session="${piToolsOtherId}"]`).count()).toBe(1);
    await page.close();
  });

  it("shows the approval bell and keeps icon-free rows aligned at sidebar widths", async () => {
    for (const width of [320, 720]) {
      const page = await openStory("sessions-sidebar--sample-sessions", { width, height: 900 });
      await page.locator("[data-mode]").click();
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
      expect(approval.paths).toEqual([
        "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9",
        "M10 21a2 2 0 0 0 4 0",
      ]);
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
    await page.click("#app header [data-mode-toggle]");
    await expect
      .poll(() => page.locator("#app header [data-mode-toggle]").getAttribute("data-mode"))
      .toBe("all");
    expect(await chevron.getAttribute("aria-expanded")).toBe("false");
    expect(await group.locator(".session-row").count()).toBe(0);
    for (let index = 0; index < 2; index++) await page.locator('[data-action="refresh"]').click();
    expect(await chevron.getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator("#app header [data-mode-toggle]").getAttribute("data-mode")).toBe(
      "all",
    );
    await name.click();
    await expect.poll(() => group.locator(".session-row").count()).toBe(2);
    expect(await openSessionMessages(page)).toEqual([]);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".session-row");
    expect(await chevron.getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator("#app header [data-mode-toggle]").getAttribute("data-mode")).toBe(
      "unarchived",
    );
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
    ).toEqual([{ type: "newSession", cwd: "~/projects/vscode-pi-sessions" }]);
    await page.close();
  });

  it("adds the workspace on Enter and closes the form on Escape", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const toggle = page.locator('[data-action="toggleWorkspaceForm"]');
    const form = page.locator("#workspace-form");
    const input = page.locator("#workspace-path");
    const groupCountBefore = await page.locator(".group").count();

    await toggle.click();
    expect(await form.isVisible()).toBe(true);
    expect(await input.inputValue()).toBe("");

    await input.press("Escape");
    expect(await form.isVisible()).toBe(false);
    expect(await page.locator(".group").count()).toBe(groupCountBefore);

    await toggle.click();
    await input.fill("~/projects/brand-new");
    await input.press("Enter");
    const added = page.locator(".group").filter({ hasText: "brand-new" });
    await expect.poll(() => page.locator(".group").count()).toBe(groupCountBefore + 1);
    expect(await added.locator(".session-row").count()).toBe(0);
    expect(await form.isVisible()).toBe(false); // closed by the refreshed list
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

  it("offers Unregister on every visible group and removes its group", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const agenda = page.locator(".group").filter({ hasText: "agenda" });
    const project = page
      .locator(".group")
      .filter({ has: page.locator('.group-header[title="~/projects/vscode-pi-sessions"]') });

    // The whitelist list shows registered workspaces only, so every visible
    // group offers Unregister.
    expect(await agenda.locator(".group-unregister").count()).toBe(1);
    expect(await agenda.locator(".group-unregister").getAttribute("aria-label")).toBe(
      "Unregister workspace agenda",
    );
    expect(await project.locator(".group-unregister").count()).toBe(1);

    // The button stays hidden until the header is hovered or focused.
    await agenda.locator(".group-header").hover();
    await agenda.locator(".group-unregister").click();
    const dialog = page.locator("#confirmation-dialog");
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await page.locator("#confirmation-dialog-target").textContent()).toBe(
      "~/projects/agenda",
    );
    await page.locator('[data-action="cancelConfirmation"]').click();
    await expect.poll(() => dialog.isHidden()).toBe(true);
    expect(await page.locator(".group").filter({ hasText: "agenda" }).count()).toBe(1);

    await agenda.locator(".group-header").hover();
    await agenda.locator(".group-unregister").click();
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await page.locator('[data-action="confirmConfirmation"]').click();
    await expect.poll(() => page.locator(".group").filter({ hasText: "agenda" }).count()).toBe(0);
    expect(
      await page.evaluate(() => {
        const messages = (window as Window & { __bridgeMessages?: { type?: string }[] })
          .__bridgeMessages;
        if (messages === undefined) throw new Error("Bridge message recorder is not installed.");
        return messages.filter((message) => message.type === "unregisterWorkspace");
      }),
    ).toEqual([{ type: "unregisterWorkspace", cwd: "~/projects/agenda" }]);
    await page.close();
  });

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
    await page.locator('[data-action="confirmConfirmation"]').click();
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
    expect(await page.locator(".mode-button").count()).toBe(0);
    expect(await page.locator(".session-row").count()).toBe(0);
    expect(await page.locator(".empty").count()).toBe(0);
    const historyToggle = page
      .locator("#app header [data-mode-toggle]")
      .describe("Show saved sessions");
    await historyToggle.focus();
    await historyToggle.press("Enter");
    await page.waitForSelector(".session-row");
    // The shared All mode lists every workspace's archived sessions at once.
    expect(await page.locator(".session-row").count()).toBe(5);
    expect(await page.locator(".session-row.archived").count()).toBe(5);
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
