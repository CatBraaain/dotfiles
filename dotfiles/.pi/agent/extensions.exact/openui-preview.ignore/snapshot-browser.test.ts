import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, mock, spyOn } from "bun:test";
import { chromium, type Browser, type Page, type ConnectOptions } from "playwright-core";
import { displayLibrary } from "./library.data";
import { captureSnapshot } from "./snapshot-cli";

let workDir: string;
beforeAll(() => {
  mkdirSync("/tmp/work/dotfiles/openui-preview-tests", { recursive: true });
  workDir = mkdtempSync("/tmp/work/dotfiles/openui-preview-tests/browser-");
  writeFileSync(join(workDir, "spec.json"), JSON.stringify(displayLibrary.toSpec()));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});
afterEach(() => {
  mock.restore();
});

const charts = [
  ["bar", 'BarChart(["A", "B"], [Series("Sales", [10, 20])])', ".recharts-bar-rectangle"],
  ["line", 'LineChart(["A", "B"], [Series("Sales", [10, 20])])', ".recharts-line-curve"],
  ["area", 'AreaChart(["A", "B"], [Series("Sales", [10, 20])])', ".recharts-area-curve"],
  [
    "horizontal",
    'HorizontalBarChart(["A", "B"], [Series("Sales", [10, 20])])',
    ".recharts-bar-rectangle",
  ],
  ["pie", 'PieChart(["A", "B"], [10, 20])', ".recharts-sector"],
  [
    "radar",
    'RadarChart(["A", "B", "C"], [Series("Sales", [10, 20, 15])])',
    ".recharts-radar-polygon",
  ],
  ["radial", 'RadialChart(["A", "B"], [10, 20])', ".recharts-radial-bar-sector"],
  [
    "stacked",
    'SingleStackedBarChart(["A", "B"], [10, 20])',
    ".openui-single-stacked-bar-chart-segment",
  ],
  [
    "scatter",
    'ScatterChart([ScatterSeries("Sales", [Point(10, 20), Point(20, 30)])])',
    ".recharts-scatter-symbol",
  ],
] as const;

async function observedSnapshot(
  source: string,
  inspect: (page: Page) => Promise<void> = async () => {},
  signal?: AbortSignal,
) {
  const launched: Browser[] = [];
  let closeCalls = 0;
  const launch = chromium.launchServer.bind(chromium);
  const connect = chromium.connect.bind(chromium);
  spyOn(chromium, "launchServer").mockImplementation(async (options) => {
    assert.equal(options?.chromiumSandbox, true);
    assert.equal(options?.headless, true);
    assert.ok(options?.executablePath);
    assert.match(options.executablePath, /chromium-\d+/);
    const server = await launch(options);
    const close = server.close.bind(server);
    spyOn(server, "close").mockImplementation(async () => {
      closeCalls += 1;
      await close();
    });
    return server;
  });
  spyOn(chromium, "connect").mockImplementation(async (endpoint, options?: ConnectOptions) => {
    const browser = await connect(endpoint as string, options);
    launched.push(browser);
    const newPage = browser.newPage.bind(browser);
    spyOn(browser, "newPage").mockImplementation(async (pageOptions) => {
      const page = await newPage(pageOptions);
      const screenshot = page.screenshot.bind(page);
      spyOn(page, "screenshot").mockImplementation(async (screenshotOptions) => {
        await inspect(page);
        return screenshot(screenshotOptions);
      });
      return page;
    });
    return browser;
  });
  try {
    await captureSnapshot(
      {
        source,
        generatedDir: workDir,
        pngPath: join(workDir, "image.png"),
        deadline: Date.now() + 15_000,
      },
      signal,
    );
  } finally {
    assert.equal(launched.length, 1);
    assert.equal(closeCalls, 1);
    assert.equal(
      launched[0]?.isConnected(),
      false,
      "browser must be closed on success and failure",
    );
  }
}

describe("snapshot browser (uses existing cached Chromium)", () => {
  it("renders Card and Table through React into a regular 960 by 1280 PNG", async () => {
    await observedSnapshot(
      'root = Stack([Card([CardHeader("Report"), TextContent("Revenue rose")]), Table([Col("Name", ["A", "B"]), Col("Value", [10, 20])])])',
      async (page) => {
        assert.equal(
          await page.evaluate(
            () => (globalThis as typeof globalThis & { isSecureContext: boolean }).isSecureContext,
          ),
          true,
        );
        assert.match(await page.locator("#root").innerText(), /Report.*Revenue rose/s);
        assert.deepEqual(await page.locator("tbody td").allTextContents(), ["A", "10", "B", "20"]);
      },
    );
    const png = readFileSync(join(workDir, "image.png"));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 960);
    assert.equal(png.readUInt32BE(20), 1280);
    assert.ok(!png.includes(Buffer.from("<!doctype")));
  }, 20_000);
  for (const [name, component, selector] of charts) {
    it(`captures ${name} chart data after visible geometry settles`, async () => {
      await observedSnapshot(`root = Stack([${component}])`, async (page) => {
        const shapes = page.locator(selector);
        const boxes = (
          await Promise.all((await shapes.all()).map((shape) => shape.boundingBox()))
        ).filter(
          (box): box is NonNullable<typeof box> => box !== null && box.width > 0 && box.height > 0,
        );
        assert.ok(boxes.length > 0, name);
        const error = await page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __openuiSnapshot: { error: string } })
              .__openuiSnapshot.error,
        );
        assert.equal(error, "");
        if (name === "bar") {
          const heights = boxes.map((box) => box.height);
          assert.equal(heights.length, 2);
          assert.ok(Math.abs(heights[1]! / heights[0]! - 2) < 0.05);
        }
      });
    }, 20_000);
  }
  it("captures Tabs in the upstream initial state without activating another tab", async () => {
    await observedSnapshot(
      'root = Stack([Tabs([TabItem("a", "A", [TextContent("first")]), TabItem("b", "B", [TextContent("second")])])])',
      async (page) => {
        assert.equal(
          await page.locator('[role="tabpanel"][data-state="active"]').innerText(),
          "second",
        );
      },
    );
  }, 20_000);
  it("captures the initial Accordion, Carousel, Steps, and first Table page", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => `"row${index}"`).join(",");
    await observedSnapshot(
      `root = Stack([Accordion([AccordionItem("a", "A", [TextContent("first")]), AccordionItem("b", "B", [TextContent("second")])]), Carousel([[TextContent("slide1")], [TextContent("slide2")]]), Steps([StepsItem("Step 1", "Ready")]), Table([Col("Rows", [${rows}])])])`,
      async (page) => {
        assert.match(await page.locator("#root").innerText(), /second/);
        assert.equal(await page.locator("tbody tr").count(), 10);
      },
    );
  }, 20_000);
  it("does not execute input as JavaScript or raw HTML", async () => {
    await observedSnapshot(
      'root = Stack([TextContent("<script>window.inputExecuted=true</script><img src=x onerror=window.inputExecuted=true>")])',
      async (page) => {
        const executed = await page.evaluate(
          () => (globalThis as typeof globalThis & { inputExecuted?: boolean }).inputExecuted,
        );
        assert.equal(executed, undefined);
        assert.equal(await page.locator("#root script").count(), 0);
      },
    );
  }, 20_000);
  for (const reference of [
    "https://example.invalid/photo.png",
    "file:///etc/passwd",
    "http://127.0.0.1:1/photo.png",
  ]) {
    it(`blocks input reference ${reference} and closes the browser`, async () => {
      await assert.rejects(
        observedSnapshot(`root = Stack([Image("image", "${reference}")])`),
        /Blocked browser reference|Image could not be rendered/,
      );
    }, 20_000);
  }
  for (const mode of ["deadline", "interruption"] as const) {
    it(`closes the browser once and cleans temporary data after ${mode}`, async () => {
      const before = new Set(readdirSync(tmpdir()));
      const controller = new AbortController();
      const started = Date.now();
      await assert.rejects(
        observedSnapshot(
          'root = Stack([TextContent("cleanup")])',
          async (page) => {
            if (mode === "interruption") controller.abort(new Error("test browser interruption"));
            await page.waitForFunction(() => false, null, { timeout: 30_000 });
          },
          controller.signal,
        ),
        mode === "deadline" ? /15-second deadline/ : /test browser interruption/,
      );
      if (mode === "deadline") assert.ok(Date.now() - started >= 14_900);
      const leaked = readdirSync(tmpdir()).filter(
        (name) =>
          /^(ob-|playwright-artifacts-|playwright_chromiumdev_profile-)/.test(name) &&
          !before.has(name),
      );
      assert.deepEqual(leaked, []);
    }, 20_000);
  }
  it("does not wait for an unmounted chart in a closed Accordion item", async () => {
    await observedSnapshot(
      'root = Stack([Accordion([AccordionItem("a", "Hidden", [BarChart(["A"], [Series("Sales", [10])])]), AccordionItem("b", "Visible", [TextContent("ready")])])])',
      async (page) => {
        assert.equal(await page.locator("[data-chart]").count(), 0);
        assert.match(await page.locator("#root").innerText(), /ready/);
      },
    );
  }, 20_000);
});
