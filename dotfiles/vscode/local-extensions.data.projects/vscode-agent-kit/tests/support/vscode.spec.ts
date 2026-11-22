import type { Frame, Page } from "playwright/test";
import playwrightConfig from "../../playwright.config";
import { expect, test } from "./vscode";

test("sessionFrame retries stale frames and finds the current Sessions view", async ({ host }) => {
  await test.step("Detach an enumerated frame and reacquire the Sessions view", async () => {
    const detached = await createDetachedFrame(host.page);
    const originalFrames = host.page.frames.bind(host.page);
    let enumerations = 0;
    host.page.frames = function framesWithTransientDetach() {
      enumerations++;
      if (enumerations === 1) return [detached];
      return [detached, ...originalFrames()];
    };
    try {
      const frame = await host.sessionFrame();
      await expect(
        frame.locator("section.group").describe("Recovered Sessions groups"),
      ).toHaveCount(3);
      expect(enumerations).toBeGreaterThan(1);
    } finally {
      host.page.frames = originalFrames;
    }
  });
});

test("sessionFrame returns the ready frame without a second enumeration", async ({ host }) => {
  await test.step("Keep the frame found during the successful readiness check", async () => {
    const detached = await createDetachedFrame(host.page);
    const originalFrames = host.page.frames.bind(host.page);
    let enumerations = 0;
    host.page.frames = function framesDetachingAfterReadiness() {
      enumerations++;
      return enumerations === 1 ? originalFrames() : [detached];
    };
    try {
      const frame = await host.sessionFrame();
      await expect(frame.locator("section.group").describe("Ready Sessions groups")).toHaveCount(3);
      expect(enumerations).toBe(1);
    } finally {
      host.page.frames = originalFrames;
    }
  });
});

test("sessionFrame fails within the existing wait budget when all frames stay detached", async ({
  host,
}) => {
  await test.step("Stop retrying unavailable Sessions frames within the configured budget", async () => {
    const detached = await createDetachedFrame(host.page);
    const originalFrames = host.page.frames.bind(host.page);
    host.page.frames = function onlyDetachedFrames() {
      return [detached];
    };
    const timeoutMs = playwrightConfig.expect!.timeout!;
    const wallClockOverheadMs = 1000;
    const started = performance.now();
    try {
      await expect(host.sessionFrame()).rejects.toThrow(
        `Timeout ${timeoutMs}ms exceeded while waiting on the predicate`,
      );
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeGreaterThan(timeoutMs / 2);
      expect(elapsedMs).toBeLessThanOrEqual(timeoutMs + wallClockOverheadMs);
    } finally {
      host.page.frames = originalFrames;
    }
  });
});

async function createDetachedFrame(page: Page): Promise<Frame> {
  const attached = page.waitForEvent("frameattached");
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.id = "fixture-transient-frame";
    iframe.src = "about:blank";
    document.body.appendChild(iframe);
  });
  const frame = await attached;
  await page.evaluate(() => document.getElementById("fixture-transient-frame")?.remove());
  await expect.poll(() => frame.isDetached()).toBe(true);
  return frame;
}
