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
const piToolsLockedId = "4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83";
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
    return import("playwright").then(({ chromium }) => chromium.launch());
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

  async function pauseStoryClock(page: Awaited<ReturnType<typeof openStory>>): Promise<void> {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
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
      await clickTimestamp(page, piToolsLockedId, "Meta");
      expect(await openSessionMessages(page)).toEqual([
        { type: "openSession", sessionId: piToolsLockedId },
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
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async () => {} },
        });
      });
      await page.click(`[data-copy="${atlasCurrentId}"]`);
      await page.click(`[data-lock="${atlasCurrentId}"]`);
      await page.click(`[data-archive="${worktreeId}"]`);
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
              row.querySelectorAll(
                ".session-name, .session-timestamp, .copy, .lock, .archive:not(:disabled), .unarchive",
              ),
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

  it("renders the sample story and operates the shared header mode toggle, copy, and archive", async () => {
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

    const copy = page.locator(".session-row [data-copy]").first();
    const copySessionId = await copy.getAttribute("data-copy");
    expect(copySessionId).not.toBeNull();
    await pauseStoryClock(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            document.body.dataset.copiedSessionId = text;
            return Promise.resolve();
          },
        },
      });
    });
    await copy.click();
    expect(await page.locator("body").getAttribute("data-copied-session-id")).toBe(copySessionId);
    await page.waitForSelector(".copy.copied");
    expect(await page.locator(".copy.copied").count()).toBe(1);
    await page.clock.runFor(900);
    expect(await page.locator(".copy.copied").count()).toBe(1);
    await page.clock.runFor(100);
    await expect.poll(() => page.locator(".copy.copied").count()).toBe(0);
    await page.clock.resume();

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

  it("locks a row to disable Archive and unlocks it again", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");

    const lockedArchive = page.locator(`[data-archive="${piToolsLockedId}"]`);
    const lock = page.locator(`[data-lock="${piToolsLockedId}"]`);
    expect(await lockedArchive.isDisabled()).toBe(true);
    expect(await lock.getAttribute("aria-pressed")).toBe("true");

    await lock.click();
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-lock="${id}"]`)?.getAttribute("aria-pressed") === "false",
      piToolsLockedId,
    );
    expect(await lockedArchive.isDisabled()).toBe(false);

    await lock.click();
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-lock="${id}"]`)?.getAttribute("aria-pressed") === "true",
      piToolsLockedId,
    );
    expect(await lockedArchive.isDisabled()).toBe(true);
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
    expect(await page.locator(`[data-session="${piToolsLockedId}"]`).count()).toBe(1);
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

    await page.waitForFunction(
      (gone) => !document.querySelector(`[data-session="${gone}"]`),
      worktreeId,
    );
    expect(await page.locator(`[data-session="${piToolsLockedId}"]`).count()).toBe(1);
    await page.close();
  });

  it("renders 32px full-width rows with mono dates, status dots, and 24px ghost overlays", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions", { width: 320, height: 640 });
    const boxes = await page.evaluate(() => {
      const rowElement = document.querySelector(".session-row")!;
      const row = rowElement.getBoundingClientRect();
      const button = rowElement.querySelector(".session-button")!.getBoundingClientRect();
      const timestampElement = rowElement.querySelector(".session-timestamp")!;
      const timestamp = timestampElement.getBoundingClientRect();
      const dot = rowElement.querySelector(".session-status")!.getBoundingClientRect();
      const copy = rowElement.querySelector(".copy")!.getBoundingClientRect();
      const lock = rowElement.querySelector(".lock")!.getBoundingClientRect();
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
        copyRight: copy.right,
        lockRight: lock.right,
        lockTop: lock.top,
        lockBottom: lock.bottom,
        archiveRight: archive.right,
        archiveTop: archive.top,
        archiveBottom: archive.bottom,
        controls: Array.from(rowElement.querySelectorAll(".copy, .lock, .archive")).map(
          (control) => {
            const box = control.getBoundingClientRect();
            const icon = control.querySelector("svg")!.getBoundingClientRect();
            return {
              width: box.width,
              height: box.height,
              iconWidth: icon.width,
              iconHeight: icon.height,
            };
          },
        ),
      };
    });
    expect(boxes.rowHeight).toBe(32);
    expect(boxes.dotWidth).toBe(10);
    expect(boxes.dotHeight).toBe(10);
    expect(boxes.timestampFont).toContain("mono");
    expect(boxes.timestampSize).toBe("10px");
    expect(boxes.controls).toEqual([
      { width: 24, height: 24, iconWidth: 12, iconHeight: 12 },
      { width: 24, height: 24, iconWidth: 12, iconHeight: 12 },
      { width: 24, height: 24, iconWidth: 12, iconHeight: 12 },
    ]);
    expect(boxes.buttonWidth).toBeCloseTo(boxes.rowWidth, 1);
    expect(boxes.buttonRight).toBeCloseTo(boxes.rowRight, 1);
    expect(boxes.timestampRight).toBeLessThan(boxes.copyRight);
    expect(boxes.copyRight).toBeLessThan(boxes.lockRight);
    expect(boxes.lockRight).toBeLessThanOrEqual(boxes.archiveRight);
    expect(boxes.rowRight - boxes.timestampRight).toBeCloseTo(84, 1);
    expect(boxes.rowRight - boxes.copyRight).toBeCloseTo(52, 1);
    expect(boxes.rowRight - boxes.lockRight).toBeCloseTo(28, 1);
    for (const overlay of [
      [boxes.timestampTop, boxes.timestampBottom],
      [boxes.lockTop, boxes.lockBottom],
      [boxes.archiveTop, boxes.archiveBottom],
    ]) {
      expect(overlay[0]).toBeGreaterThanOrEqual(boxes.rowTop);
      expect(overlay[1]).toBeLessThanOrEqual(boxes.rowBottom);
    }
    expect(boxes.rowRight - boxes.archiveRight).toBeLessThanOrEqual(8);
    await page.locator(".session-button").first().focus();
    await page.keyboard.press("Tab");
    const focusedCopy = await page
      .locator(".copy")
      .first()
      .evaluate((control) => ({
        focused: control === document.activeElement,
        focusVisible: control.matches(":focus-visible"),
        outlineWidth: getComputedStyle(control).outlineWidth,
        radius: getComputedStyle(control).borderRadius,
      }));
    expect(focusedCopy).toEqual({
      focused: true,
      focusVisible: true,
      outlineWidth: "2px",
      radius: "9.6px",
    });
    await page.close();
  });

  it("keeps the copied feedback when the preview clipboard write fails", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await page.evaluate(() => {
      window.addEventListener("unhandledrejection", (event) => event.preventDefault(), {
        once: true,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error("denied")) },
      });
    });

    await pauseStoryClock(page);
    await page.locator(".session-row [data-copy]").first().click();
    await page.waitForSelector(".copy.copied");
    expect(await page.locator(".copy.copied").count()).toBe(1);
    await page.clock.runFor(900);
    expect(await page.locator(".copy.copied").count()).toBe(1);
    await page.clock.runFor(100);
    await expect.poll(() => page.locator(".copy.copied").count()).toBe(0);
    await page.clock.resume();
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

  it("opens the New workspace form and registers a sessionless group with Add", async () => {
    const page = await openStory("sessions-sidebar--sample-sessions");
    await installBridgeMessageRecorder(page);
    const toggle = page.locator('[data-action="toggleWorkspaceForm"]');
    const form = page.locator("#workspace-form");
    const input = page.locator("#workspace-path");
    const groupCountBefore = await page.locator(".group").count();

    await toggle.click();
    expect(await form.isVisible()).toBe(true);
    expect(await input.inputValue()).toBe("");

    await page.locator('[data-action="cancelWorkspaceForm"]').click();
    expect(await form.isVisible()).toBe(false);
    expect(await page.locator(".group").count()).toBe(groupCountBefore);

    await toggle.click();
    await input.fill("~/projects/brand-new");
    await page.locator('[data-action="addWorkspace"]').click();
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
    const dialog = page.locator("#unregister-dialog");
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await page.locator("#unregister-dialog-cwd").textContent()).toBe("~/projects/agenda");
    await page.locator('[data-action="cancelUnregister"]').click();
    await expect.poll(() => dialog.isHidden()).toBe(true);
    expect(await page.locator(".group").filter({ hasText: "agenda" }).count()).toBe(1);

    await agenda.locator(".group-header").hover();
    await agenda.locator(".group-unregister").click();
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await page.locator('[data-action="confirmUnregister"]').click();
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
