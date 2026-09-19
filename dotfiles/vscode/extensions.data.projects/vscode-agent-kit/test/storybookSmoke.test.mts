// Smoke test for the built static catalog (npm run storybook:build): the
// storybook-static output must serve standalone and render the spec's states
// without the extension host. Skipped when the static build is absent (run
// `npm test`, which builds it first).
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const staticDir = join(process.cwd(), "storybook-static");
const indexAvailable = existsSync(join(staticDir, "index.json"));

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

describe.skipIf(!indexAvailable)("storybook static catalog smoke", () => {
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

  it("lists the session stories in the built index", async () => {
    const index = (await (await fetch(`${baseUrl}/index.json`)).json()) as {
      entries: Record<string, unknown>;
    };
    const ids = Object.keys(index.entries);
    for (const id of [
      "sessions-sidebar--sample-sessions",
      "sessions-sidebar--workspace-all-mode",
      "sessions-sidebar--empty-sessions",
    ]) {
      expect(ids, `story ${id} missing from index.json`).toContain(id);
    }
  });

  it("renders the sample story and operates the workspace mode toggle and archive", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--sample-sessions`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".session-row");
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(await page.locator(".indicator.active").count()).toBe(2);

    await page.click('.group [data-mode="all"]');
    await page.waitForFunction(() => document.querySelectorAll(".session-row").length === 3);
    expect(await page.locator(".indicator.active").count()).toBe(2);
    // The other workspace keeps its own Active mode (per-workspace independence).
    expect(await page.locator(".group").nth(1).locator(".session-row").count()).toBe(1);

    await page.click(".session-row [data-archive]");
    await page.waitForFunction(() => document.querySelectorAll(".indicator.active").length === 1);
    expect(await page.locator(".session-row").count()).toBe(3);

    // Modes are not persisted: a fresh client starts every workspace in Active.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".session-row");
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(await page.locator(".indicator.active").count()).toBe(2);
    await page.close();
  });

  it("renders rows spanning the full row width with the archive overlay at the right edge", async () => {
    const page = await browser!.newPage({ viewport: { width: 320, height: 640 } });
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--sample-sessions`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".session-row");
    const boxes = await page.evaluate(() => {
      const row = document.querySelector(".session-row")!.getBoundingClientRect();
      const button = document.querySelector(".session-button")!.getBoundingClientRect();
      const archive = document.querySelector(".archive")!.getBoundingClientRect();
      return {
        rowWidth: row.width,
        buttonWidth: button.width,
        buttonRight: button.right,
        rowRight: row.right,
        rowTop: row.top,
        rowBottom: row.bottom,
        archiveRight: archive.right,
        archiveTop: archive.top,
        archiveBottom: archive.bottom,
      };
    });
    // The session button is the full-area click target: its box spans the row.
    expect(boxes.buttonWidth).toBeCloseTo(boxes.rowWidth, 1);
    expect(boxes.buttonRight).toBeCloseTo(boxes.rowRight, 1);
    // The archive button overlays the row near its right edge, vertically inside.
    expect(boxes.rowRight - boxes.archiveRight).toBeLessThanOrEqual(8);
    expect(boxes.archiveTop).toBeGreaterThanOrEqual(boxes.rowTop);
    expect(boxes.archiveBottom).toBeLessThanOrEqual(boxes.rowBottom);
    await page.close();
  });

  it("renders the wide preview width", async () => {
    const page = await browser!.newPage({ viewport: { width: 720, height: 640 } });
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--sample-sessions`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".session-row");
    expect(await page.locator(".session-row").count()).toBe(2);
    await page.close();
  });

  it("renders the empty state from the static output", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--empty-sessions`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".empty");
    expect(await page.locator(".empty").textContent()).toBe("No active sessions");
    await page.close();
  });

  it("captures a screenshot of the static output without the extension host", async () => {
    const page = await browser!.newPage({ viewport: { width: 320, height: 640 } });
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--sample-sessions`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".session-row");
    const path = join(tmpdir(), `pi-sessions-storybook-smoke-${process.pid}.png`);
    await page.screenshot({ path });
    const screenshot = await stat(path);
    expect(screenshot.size).toBeGreaterThan(0);
    await page.close();
    await rm(path, { force: true });
  });
});
