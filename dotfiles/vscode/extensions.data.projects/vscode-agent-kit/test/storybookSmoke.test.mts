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

  it("lists the four session stories in the built index", async () => {
    const index = (await (await fetch(`${baseUrl}/index.json`)).json()) as {
      entries: Record<string, unknown>;
    };
    const ids = Object.keys(index.entries);
    for (const id of [
      "sessions-sidebar--active-sessions",
      "sessions-sidebar--all-sessions",
      "sessions-sidebar--active-empty",
      "sessions-sidebar--all-empty",
    ]) {
      expect(ids, `story ${id} missing from index.json`).toContain(id);
    }
  });

  it("renders the active story and operates mode switch and deactivate", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--active-sessions`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".session-row");
    expect(await page.locator(".session-row").count()).toBe(2);
    expect(await page.locator(".indicator.active").count()).toBe(2);

    await page.click('[data-mode="all"]');
    await page.waitForFunction(() => document.querySelectorAll(".session-row").length === 5);
    expect(await page.locator(".indicator.active").count()).toBe(2);

    await page.click(".session-row [data-deactivate]");
    await page.waitForFunction(() => document.querySelectorAll(".indicator.active").length === 1);
    expect(await page.locator(".session-row").count()).toBe(5);
    await page.close();
  });

  it("renders both empty states from the static output", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--active-empty`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".empty");
    expect(await page.locator(".empty").textContent()).toBe("No active sessions");

    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--all-empty`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".empty");
    expect(await page.locator(".empty").textContent()).toBe("No sessions");
    await page.close();
  });

  it("captures a screenshot of the static output without the extension host", async () => {
    const page = await browser!.newPage({ viewport: { width: 320, height: 640 } });
    await page.goto(`${baseUrl}/iframe.html?path=/story/sessions-sidebar--active-sessions`, {
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
