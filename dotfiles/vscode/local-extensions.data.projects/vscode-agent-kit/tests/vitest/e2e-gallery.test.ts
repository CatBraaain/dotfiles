import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseGalleryCases, serializeGalleryRun } from "../support/e2e-gallery";
import type { GalleryRun, GalleryTest } from "../support/e2e-gallery";

const root = resolve(import.meta.dirname, "../..");
const scratchRoot = "/tmp/work/vscode-agent-kit/unify-e2e-gallery";
const specSource = readFileSync(join(root, "SPEC.md"), "utf8");
const viewerSource = readFileSync(join(root, "e2e-gallery.html"), "utf8");
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=";

interface FixtureRun {
  directory: string;
  gallery: string;
  results: GalleryRun;
  script: string;
  output: string;
  status: number;
}

function runFixture(
  source: string,
  options: { directory?: string; projects?: string[]; maxFailures?: number; grep?: string } = {},
): FixtureRun {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = options.directory ?? mkdtempSync(join(scratchRoot, "e2e-gallery-"));
  writeFileSync(join(directory, "SPEC.md"), specSource);
  copyFileSync(join(root, "e2e-gallery.html"), join(directory, "e2e-gallery.html"));
  writeFileSync(
    join(directory, "fixture.spec.cjs"),
    `const { test, expect } = require(${JSON.stringify(join(root, "node_modules/playwright/test.js"))});
const png = Buffer.from(${JSON.stringify(png)}, "base64");
${source}`,
  );
  writeFileSync(
    join(directory, "playwright.config.cjs"),
    `module.exports = ${JSON.stringify({
      testDir: directory,
      testMatch: "*.spec.cjs",
      fullyParallel: !options.maxFailures,
      workers: options.maxFailures ? 1 : 2,
      retries: options.maxFailures ? 0 : 1,
      repeatEach: options.projects ? 2 : 1,
      projects: options.projects?.map((name) => ({ name })),
      maxFailures: options.maxFailures ?? 0,
      outputDir: join(directory, "test-results"),
      reporter: [[join(root, "tests/support/e2e-gallery-reporter.ts")]],
    })};`,
  );
  const args = [
    join(root, "node_modules/playwright/cli.js"),
    "test",
    "--config",
    join(directory, "playwright.config.cjs"),
  ];
  if (options.grep) args.push("--grep", options.grep);
  let output = "";
  let status = 0;
  try {
    output = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "pipe",
    });
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    status = failure.status;
    output = `${failure.stdout}\n${failure.stderr}`;
  }
  const gallery = join(directory, "dist/e2e-gallery");
  const script = readFileSync(join(gallery, "results.js"), "utf8");
  return { directory, gallery, results: readResults(script), script, output, status };
}

function readResults(script: string): GalleryRun {
  const context: { E2E_GALLERY_RUN?: GalleryRun } = {};
  runInNewContext(script, context);
  if (!context.E2E_GALLERY_RUN) throw new Error("Fixture did not publish E2E results");
  return context.E2E_GALLERY_RUN;
}

function imageUrls(run: GalleryRun): string[] {
  return run.tests.flatMap((test) =>
    test.attempts.flatMap((attempt) =>
      attempt.steps.flatMap((step) =>
        step.images.flatMap((image) => (image.url ? [image.url] : [])),
      ),
    ),
  );
}

function caseTests(run: GalleryRun, id: string): GalleryTest[] {
  return run.tests.filter((test) => test.specId === id);
}

function writeViewerFixture(run: GalleryRun): string {
  const directory = mkdtempSync(join(scratchRoot, "comparison-viewer-"));
  const gallery = join(directory, "dist/e2e-gallery");
  mkdirSync(gallery, { recursive: true });
  copyFileSync(join(root, "e2e-gallery.html"), join(directory, "e2e-gallery.html"));
  writeFileSync(join(gallery, "results.js"), serializeGalleryRun(run));
  for (const url of imageUrls(run)) {
    const target = join(gallery, url);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(png, "base64"));
  }
  return directory;
}

const source = `
test("retry screenshots", { annotation: { type: "spec", description: "E2E-1" } }, async ({}, info) => {
  await test.step("Outer step", async () => {
    await test.step("Inner step", async () => {
      await info.attach("same <script> image", { body: png, contentType: "image/png" });
    });
  });
  for (let index = 0; index < 2; index++) {
    await test.step("Repeated step", async () => {
      await info.attach("same <script> image", { body: png, contentType: "image/png" });
    });
  }
  expect(info.retry).toBe(1);
});
test.skip("skipped case", { annotation: { type: "spec", description: "E2E-2" } }, async () => {});
test("no image", { annotation: { type: "spec", description: "E2E-3" } }, async () => {
  await test.step("Check without image", async () => { expect(1).toBe(1); });
});
test("failure with image", { annotation: { type: "spec", description: "E2E-10" } }, async ({}, info) => {
  await test.step("Failed step", async () => {
    await info.attach("failure image", { body: png, contentType: "image/png" });
    throw new Error("Expected fixture failure <script>");
  });
});
test("outside a step", { annotation: { type: "spec", description: "E2E-10" } }, async ({}, info) => {
  await info.attach("outside image", { body: png, contentType: "image/png" });
});
test("missing asset", { annotation: { type: "spec", description: "E2E-6" } }, async ({}, info) => {
  info.attachments.push({ name: "deleted image", path: info.outputPath("missing.png"), contentType: "image/png" });
});
test("workspace actions", { annotation: { type: "spec", description: "E2E-11" } }, async ({}, info) => {
  await test.step("Unregister a workspace from the list", async () => {
    await info.attach("Unregister menu", { body: png, contentType: "image/png" });
    await info.attach("Workspace unregistered", { body: png, contentType: "image/png" });
  });
});
`;

describe("E2E gallery reporter", () => {
  let run: FixtureRun;
  beforeAll(() => {
    run = runFixture(source, { projects: ["alpha", "beta"] });
    expect(run.output).not.toContain("E2E gallery generation failed");
  }, 30_000);

  it("exports the current canonical SPEC cases in their declared order", () => {
    const { cases, excludedIds } = parseGalleryCases(specSource);
    expect(run.results.cases).toEqual(cases);
    expect(cases.map((entry) => entry.id)).toEqual([
      "E2E-1",
      "E2E-2",
      "E2E-6",
      "E2E-10",
      "E2E-11",
      "E2E-13",
      "E2E-14",
      "E2E-15",
      "E2E-17",
      "E2E-18",
      "E2E-19",
    ]);
    expect(excludedIds).toEqual(["E2E-3", "E2E-7", "E2E-9", "E2E-12", "E2E-16"]);
    expect(run.script).not.toContain("specSource");
    expect(run.script).not.toContain(specSource.split("\n")[0]);
  });

  it("writes only results and images without generating or changing HTML", () => {
    expect(readdirSync(run.gallery).sort()).toEqual(["assets", "results.js"]);
    expect(readFileSync(join(run.directory, "e2e-gallery.html"), "utf8")).toBe(viewerSource);
    expect(readFileSync(join(root, "e2e-gallery.html"), "utf8")).toBe(viewerSource);
  });

  it("keeps failed, skipped and excluded cases distinct", () => {
    expect(run.status).toBe(1);
    expect(run.results.status).toBe("failed");
    expect(caseTests(run.results, "E2E-2")[0].outcome).toBe("Skipped");
    expect(caseTests(run.results, "E2E-3")).toEqual([]);
    expect(caseTests(run.results, "E2E-7")).toEqual([]);
    expect(caseTests(run.results, "E2E-9")).toEqual([]);
    expect(caseTests(run.results, "E2E-10")[0].attempts[0].errors.join("\n")).toContain(
      "Expected fixture failure <script>",
    );
  });

  it("maps images to their nested and repeated test steps, not their attachment names", () => {
    const steps = caseTests(run.results, "E2E-1").flatMap((test) =>
      test.attempts.flatMap((attempt) => attempt.steps),
    );
    expect(steps.some((step) => step.title === "Outer step > Inner step")).toBe(true);
    expect(steps.some((step) => step.title === "Outside test.step")).toBe(false);
    expect(steps.filter((step) => step.title === "Repeated step")).toHaveLength(16);
    const images = steps.flatMap((step) => step.images);
    expect(images).toHaveLength(24);
    expect(images.every((image) => image.name === "same <script> image")).toBe(true);
    expect(run.script).not.toContain("<script>");
  });

  it("never overwrites project, repeat, retry or parallel-worker images", () => {
    const urls = imageUrls(run.results);
    expect(urls).toHaveLength(44);
    expect(new Set(urls).size).toBe(urls.length);
    const retried = caseTests(run.results, "E2E-1");
    expect(new Set(retried.map((test) => test.project))).toEqual(new Set(["alpha", "beta"]));
    expect(retried.every((test) => test.outcome === "Flaky")).toBe(true);
    expect(retried.some((test) => test.repeat === 1)).toBe(true);
    expect(retried.every((test) => test.attempts.some((attempt) => attempt.retry === 1))).toBe(
      true,
    );
    for (const url of urls) {
      expect(url).toMatch(/^assets\/test-\d+\/retry-\d+-parallel-\d+-worker-\d+\/image-\d+\.png$/);
      expect(readFileSync(join(run.gallery, url))).toEqual(Buffer.from(png, "base64"));
    }
    expect(retried[0].attempts[0].steps[1].images[0]).toMatchObject({ width: 1, height: 1 });
  });

  it("keeps workspace captures in order within the unregister step", () => {
    const steps = caseTests(run.results, "E2E-11").flatMap((test) =>
      test.attempts.flatMap((attempt) => attempt.steps),
    );
    expect(steps).toHaveLength(4);
    for (const step of steps) {
      expect(step.title).toBe("Unregister a workspace from the list");
      expect(step.images.map((image) => image.name)).toEqual([
        "Unregister menu",
        "Workspace unregistered",
      ]);
    }
  });

  it("marks missing files as unavailable instead of publishing broken image links", () => {
    const missing = caseTests(run.results, "E2E-6")[0].attempts[0].steps[0].images[0];
    expect(missing.name).toBe("deleted image");
    expect(missing.error).toContain("ENOENT");
    expect(missing.url).toBeUndefined();
  });

  it("replaces the previous run and removes its images and legacy HTML", () => {
    const directory = mkdtempSync(join(scratchRoot, "e2e-gallery-stale-"));
    const first = runFixture(source, { directory, grep: "outside a step" });
    const oldImage = join(first.gallery, imageUrls(first.results)[0]);
    expect(existsSync(oldImage)).toBe(true);
    for (const name of ["stale.png", "e2e-gallery.html", "spec.html", "SPEC.md"])
      writeFileSync(join(first.gallery, name), "old");
    const next = runFixture(source, { directory, grep: "no image" });
    expect(next.status).toBe(0);
    expect(imageUrls(next.results)).toEqual([]);
    expect(existsSync(oldImage)).toBe(false);
    expect(readdirSync(next.gallery)).toEqual(["results.js"]);
    expect(caseTests(next.results, "E2E-1")).toEqual([]);
  }, 30_000);

  it("retains selected but unexecuted cases after a failure stops the run", () => {
    const stopped = runFixture(
      `
      test("stop", { annotation: { type: "spec", description: "E2E-1" } }, async () => { throw new Error("stop now"); });
      test("not reached", { annotation: { type: "spec", description: "E2E-2" } }, async () => {});
    `,
      { maxFailures: 1 },
    );
    expect(stopped.status).toBe(1);
    expect(caseTests(stopped.results, "E2E-1")[0].attempts[0].errors.join("\n")).toContain(
      "stop now",
    );
    const notReached = caseTests(stopped.results, "E2E-2")[0];
    expect(notReached.outcome).toBe("Not run");
    expect(notReached.attempts).toEqual([]);
    expect(notReached.title).toContain("not reached");
  }, 30_000);

  it("publishes completed cases while the runner is still running", () => {
    const partial = runFixture(
      `
      test("first", { annotation: { type: "spec", description: "E2E-1" } }, async ({}, info) => {
        await test.step("Captured step", async () => { await info.attach("partial image", { body: png, contentType: "image/png" }); });
      });
      test("inspect partial results", async () => {
        const { readFileSync } = require("node:fs");
        const { runInNewContext } = require("node:vm");
        const context = {};
        runInNewContext(readFileSync(require("node:path").join(__dirname, "dist/e2e-gallery/results.js"), "utf8"), context);
        expect(context.E2E_GALLERY_RUN.status).toBe("running");
        expect(context.E2E_GALLERY_RUN.tests[0].attempts[0].steps[0].images).toHaveLength(1);
      });
    `,
      { maxFailures: 1 },
    );
    expect(partial.status, partial.output).toBe(0);
    expect(partial.results.status).toBe("passed");
  }, 30_000);

  it("publishes images already captured when the runner is interrupted", () => {
    const interrupted = runFixture(
      `
      test("interrupted", { annotation: { type: "spec", description: "E2E-1" } }, async ({}, info) => {
        await test.step("Interrupted step", async () => {
          await info.attach("before interruption", { body: png, contentType: "image/png" });
          process.kill(process.ppid, "SIGINT");
          await new Promise(() => {});
        });
      });
    `,
      { maxFailures: 1 },
    );
    expect(interrupted.status).not.toBe(0);
    expect(interrupted.results.status).toBe("interrupted");
    expect(caseTests(interrupted.results, "E2E-1")[0].attempts[0].status).toBe("interrupted");
    expect(imageUrls(interrupted.results)).toHaveLength(1);
  }, 30_000);

  describe("fixed file viewer", () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
    });
    beforeEach(async () => {
      page = await browser.newPage({ timezoneId: "Asia/Tokyo" });
    });
    afterEach(async () => {
      await page.close();
    });
    afterAll(async () => {
      await browser.close();
    });

    it("shows attachment labels, failure frames and original images without step or outcome rows", async () => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(pathToFileURL(join(run.directory, "e2e-gallery.html")).href);
      expect(
        await page.locator("section.case[id]").evaluateAll((nodes) => nodes.map((node) => node.id)),
      ).toEqual(run.results.cases.map((entry) => entry.id));
      expect(await page.locator("#run-summary, #run-details").count()).toBe(0);
      expect(await page.locator("body").innerText()).not.toContain("Run:");

      const firstCase = run.results.cases[0];
      const heading = page.locator("#E2E-1 h2");
      expect(await heading.textContent()).toBe(`${firstCase.id} ${firstCase.title}`);
      expect(await heading.getAttribute("title")).toBe(`${firstCase.id} ${firstCase.title}`);
      expect(await heading.evaluate((node) => getComputedStyle(node).textOverflow)).toBe(
        "ellipsis",
      );
      const labels = caseTests(run.results, "E2E-1").flatMap((test) =>
        test.attempts.flatMap((attempt) =>
          attempt.steps.flatMap((step) => step.images.map((image) => image.name)),
        ),
      );
      expect(await page.locator("#E2E-1 .cell .label").allTextContents()).toEqual(labels);
      expect(await page.locator("#E2E-11 .cell .label").allTextContents()).toEqual(
        Array.from({ length: 4 }, () => ["Unregister menu", "Workspace unregistered"]).flat(),
      );
      expect(await page.locator("#E2E-1 .cell").first().getAttribute("title")).toContain(
        "retry 0, worker",
      );
      expect(await page.locator(".steps, .attempt, .test, h3").count()).toBe(0);
      const visibleText = await page.locator("body").innerText();
      expect(visibleText).not.toContain("Outer step");
      expect(visibleText).not.toContain("retry screenshots");
      expect(visibleText).not.toContain("alpha: Flaky");
      expect(await page.locator("#E2E-2").textContent()).toContain("未実行");
      expect(await page.locator("#E2E-3").count()).toBe(0);
      expect(await page.locator("#E2E-6").textContent()).toContain("画像なし");
      expect(await page.locator("#E2E-6 .image-link").count()).toBe(0);
      expect(await page.locator("#E2E-7").count()).toBe(0);
      expect(await page.locator("#E2E-9").count()).toBe(0);
      expect(await page.locator("#E2E-1 img").first().getAttribute("alt")).toBe(
        "same <script> image",
      );
      expect(await page.locator("script").count()).toBe(2);

      const failureMessage = caseTests(run.results, "E2E-10")[0].attempts[0].errors[0];
      const error = page.locator("#E2E-10 > p.error");
      expect(await error.count()).toBe(1);
      expect(await error.textContent()).toBe(failureMessage.split("\n")[0]);
      const errorColor = await error.evaluate((node) => getComputedStyle(node).color);
      expect(await page.locator("#E2E-10 .cell.failed img").count()).toBe(8);
      expect(
        await page
          .locator("#E2E-10 .cell.failed img")
          .first()
          .evaluate((node) => getComputedStyle(node).borderColor),
      ).toBe(errorColor);
      expect(await page.locator("#spec-view, #spec-source").count()).toBe(0);
      expect(await page.locator('a[href="./SPEC.md"]').count()).toBe(0);

      const popup = page.waitForEvent("popup");
      await page.locator(".image-link").first().click();
      const original = await popup;
      await original.waitForLoadState();
      expect(original.url()).toBe(pathToFileURL(join(run.gallery, imageUrls(run.results)[0])).href);
      expect(
        await original.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
      ).toBe(1);
      await original.close();
      expect(errors).toEqual([]);
    });

    it("lays out comparison images in canonical case order", async () => {
      const comparisonCases = run.results.cases;
      const imageCounts: Record<string, number> = { "E2E-10": 1, "E2E-14": 1, "E2E-15": 4 };
      const tests: GalleryTest[] = comparisonCases.map((specCase) => ({
        specId: specCase.id,
        title: "Hidden test name",
        project: "fixture",
        repeat: 0,
        outcome: "Passed",
        attempts: [
          {
            retry: 0,
            worker: 0,
            parallel: 0,
            status: "passed",
            errors: [],
            annotations: [],
            steps: Array.from({ length: imageCounts[specCase.id] ?? 2 }, (_, imageIndex) => ({
              title: `Hidden step ${imageIndex + 1}`,
              status: "Completed",
              images: [
                {
                  name: `Comparison ${imageIndex + 1}`,
                  url: `assets/${specCase.id}/image-${imageIndex + 1}.png`,
                  width: 1,
                  height: 1,
                },
              ],
            })),
          },
        ],
      }));
      const results: GalleryRun = {
        ...run.results,
        started: "2026-01-02T00:04:12.345Z",
        status: "passed",
        errors: ["Runner error first line\nRunner error detail"],
        tests,
      };
      const directory = writeViewerFixture(results);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(pathToFileURL(join(directory, "e2e-gallery.html")).href);
      expect(await page.locator("#run-summary, #run-details").count()).toBe(0);
      const visibleText = await page.locator("body").innerText();
      expect(visibleText).not.toContain("Run:");
      expect(visibleText).not.toContain("2026-01-02");
      expect(visibleText).not.toContain(" images");
      expect(await page.locator("#run-errors").innerText()).toBe("Runner error first line");
      expect(await page.locator(".table").count()).toBe(comparisonCases.length);
      expect(
        await page.locator("section.case[id]").evaluateAll((nodes) => nodes.map((node) => node.id)),
      ).toEqual(comparisonCases.map((entry) => entry.id));
      const loadingCase = comparisonCases.find((entry) => entry.id === "E2E-15")!;
      expect(await page.locator("#E2E-15 h2").textContent()).toBe(
        `${loadingCase.id} ${loadingCase.title}`,
      );
      expect(await page.locator("#E2E-15 .image-link").count()).toBe(4);
      for (const specCase of comparisonCases) {
        const imageCount = imageCounts[specCase.id] ?? 2;
        const table = page.locator(`#${specCase.id} .table`);
        expect(await table.locator(".cell").count()).toBe(imageCount);
        expect(await table.locator(".label").allTextContents()).toEqual(
          Array.from({ length: imageCount }, (_, index) => `Comparison ${index + 1}`),
        );
        expect(
          await table.evaluate(
            (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length,
          ),
        ).toBe(Math.min(imageCount, 2));
      }
      expect(await page.locator("#E2E-9").count()).toBe(0);
      expect(await page.locator("body").innerText()).not.toContain("Hidden");
    });

    it.each([1, 2, 3, 5])(
      "limits %i images to two columns and stacks them at narrow widths",
      async (imageCount) => {
        const originalTest = caseTests(run.results, "E2E-1")[0];
        const originalAttempt = originalTest.attempts[0];
        const originalStep = originalAttempt.steps[0];
        const images = Array.from({ length: imageCount }, (_, index) => ({
          ...originalStep.images[0],
          name: `Image ${index + 1}`,
          url: `assets/image-${index + 1}.png`,
        }));
        const directory = writeViewerFixture({
          ...run.results,
          tests: [
            {
              ...originalTest,
              attempts: [
                {
                  ...originalAttempt,
                  steps: [{ ...originalStep, images }],
                },
              ],
            },
          ],
        });
        await page.goto(pathToFileURL(join(directory, "e2e-gallery.html")).href);

        for (const width of [320, 390, 600, 768, 800, 801, 1440, 2560]) {
          await page.setViewportSize({ width, height: 900 });
          const table = page.locator("#E2E-1 .table");
          const layout = await table.evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              columns: style.gridTemplateColumns.split(" ").length,
              width: node.getBoundingClientRect().width,
              gap: parseFloat(style.columnGap),
              cells: Array.from(node.querySelectorAll(".cell"), (cell) => {
                const bounds = cell.getBoundingClientRect();
                return { top: bounds.top, width: bounds.width };
              }),
            };
          });
          const expectedColumns = width <= 800 ? 1 : Math.min(imageCount, 2);
          expect(layout.columns, `${width}px`).toBe(expectedColumns);
          expect(layout.cells).toHaveLength(imageCount);
          const rows = [...new Set(layout.cells.map((cell) => cell.top))];
          const rowSizes = rows.map(
            (top) => layout.cells.filter((cell) => cell.top === top).length,
          );
          const expectedRowSizes = Array.from(
            { length: Math.ceil(imageCount / expectedColumns) },
            (_, index) => Math.min(expectedColumns, imageCount - index * expectedColumns),
          );
          expect(rowSizes, `${width}px`).toEqual(expectedRowSizes);
          const expectedCellWidth =
            (layout.width - layout.gap * (expectedColumns - 1)) / expectedColumns;
          for (const cell of layout.cells) expect(cell.width).toBeCloseTo(expectedCellWidth, 1);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          );
          expect(overflow, `${width}px`).toBe(false);
        }
      },
    );

    it("instructs the user to run E2E when no result data exists", async () => {
      const directory = mkdtempSync(join(scratchRoot, "e2e-gallery-empty-"));
      copyFileSync(join(root, "e2e-gallery.html"), join(directory, "e2e-gallery.html"));
      await page.goto(pathToFileURL(join(directory, "e2e-gallery.html")).href);
      expect(await page.locator("#no-results").textContent()).toContain("bun run test:e2e");
      expect(await page.locator("#run-summary, #run-details").count()).toBe(0);
      expect(await page.locator("#run-errors").textContent()).toBe("");
      expect(await page.locator("section.case").count()).toBe(0);
      expect(await page.locator("img").count()).toBe(0);
    });
  });
});

describe("SPEC source handling", () => {
  it("reads escaped separators and the capture column without separate case definitions", () => {
    const { cases } = parseGalleryCases(
      "## テストケース\n| E2E-1 | A \\| B | Expected | One final screenshot | E2E |\n### Next",
    );
    expect(cases[0]).toEqual({ id: "E2E-1", title: "A | B" });
  });

  it("excludes cases whose capture column declares no screenshots", () => {
    const { cases, excludedIds } = parseGalleryCases(
      "## テストケース\n| E2E-1 | Shot case | Expected | One screenshot | E2E |\n| E2E-2 | Plain none | Expected | なし | E2E |\n| E2E-3 | Not run | Expected | なし（未実行） | E2E |",
    );
    expect(cases.map((entry) => entry.id)).toEqual(["E2E-1"]);
    expect(excludedIds).toEqual(["E2E-2", "E2E-3"]);
  });

  it("rejects a missing or ambiguous canonical case table", () => {
    expect(() => parseGalleryCases("# Missing")).toThrow("no gallery cases");
    expect(() =>
      parseGalleryCases(
        "## テストケース\n| E2E-1 | A | B | Shot | E2E |\n| E2E-1 | C | D | Shot | E2E |",
      ),
    ).toThrow("Duplicate");
    expect(() => parseGalleryCases("## テストケース\n| E2E-1 | A | B | E2E |")).toThrow(
      "Invalid SPEC test case",
    );
    expect(() => parseGalleryCases("## テストケース\n| E2E-1 | A | B | なし | E2E |")).toThrow(
      "no gallery cases",
    );
  });

  it("serializes markup and JavaScript separators as inert strings", () => {
    const unsafeText = "</script><script>alert(1)</script> & \u2028 \u2029";
    const run: GalleryRun = {
      started: "2026-01-01T00:00:00Z",
      status: "running",
      environment: "fixture",
      errors: [unsafeText],
      tests: [],
      cases: [],
    };
    const script = serializeGalleryRun(run);
    expect(script).not.toMatch(/[<>&\u2028\u2029]/);
    expect(readResults(script)).toEqual(run);
  });
});
