import { it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_WAIT_TIMEOUT_MS } from "./config";
import { useDirectPlaywright, withRemoteRenderPage, type RemoteFirefox } from "./playwright-render";

it("keeps the CLI path when it would apply custom settings", () => {
  const root = mkdtempSync(join(tmpdir(), "browse-playwright-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const configPath = join(home, ".playwright", "cli.config.json");
  try {
    assert.equal(useDirectPlaywright({}, cwd, home), true);
    assert.equal(
      useDirectPlaywright({ PLAYWRIGHT_MCP_ALLOWED_ORIGINS: "https://example.test" }, cwd, home),
      false,
    );
    mkdirSync(join(home, ".playwright"), { recursive: true });
    writeFileSync(configPath, '{"outputDir":"artifacts"}');
    assert.equal(useDirectPlaywright({ PLAYWRIGHT_MCP_OUTPUT_DIR: "artifacts" }, cwd, home), true);
    writeFileSync(configPath, '{"network":{"blockedOrigins":["https://example.test"]}}');
    assert.equal(useDirectPlaywright({}, cwd, home), false);
    writeFileSync(configPath, '{"outputDir":"artifacts"}');
    mkdirSync(join(cwd, ".playwright"), { recursive: true });
    writeFileSync(join(cwd, ".playwright", "cli.config.json"), "{}");
    assert.equal(useDirectPlaywright({}, cwd, home), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(onClose?: (openDialog: () => void) => Promise<void>) {
  const events: string[] = [];
  let dialog: (() => void) | undefined;
  function openDialog() {
    dialog?.();
  }
  const firefox: RemoteFirefox = {
    async connect(endpoint, { timeout }) {
      events.push(`connect ${endpoint} ${timeout}`);
      return {
        async newPage() {
          events.push("private page");
          return {
            once(_event, listener) {
              dialog = listener;
            },
            async goto(url, options) {
              events.push(`${options.waitUntil} ${url}`);
            },
            async waitForLoadState(state, options) {
              events.push(`${state} ${options.timeout}`);
              const error = new Error("load timeout");
              error.name = "TimeoutError";
              throw error;
            },
            async evaluate(read) {
              return read();
            },
            async waitForTimeout() {},
          };
        },
        async close() {
          events.push("disconnect");
          await onClose?.(openDialog);
        },
      };
    },
  };
  return { firefox, events, openDialog };
}

const endpoint = "ws://127.0.0.1:9378/camoufox";
const url = "https://example.test/?literal=a&percent=%PATH%";
const never = new Promise<never>(() => {});

function budget(controller = new AbortController()) {
  return { signal: controller.signal, remainingMs: 12_345 };
}

it("waits for DOMContentLoaded and briefly for load, then reads from a private page and disconnects", async () => {
  const { firefox, events } = fixture();
  const html = await withRemoteRenderPage(firefox, endpoint, url, budget(), (page) =>
    page.evaluate(() => "<html>ready</html>"),
  );
  assert.equal(html, "<html>ready</html>");
  assert.deepEqual(events, [
    `connect ${endpoint} 12345`,
    "private page",
    `domcontentloaded ${url}`,
    "load 5000",
    "disconnect",
  ]);
});

it("rejects file URLs before connecting", async () => {
  const { firefox, events } = fixture();
  await assert.rejects(
    withRemoteRenderPage(firefox, endpoint, "file:///private", budget(), () => never),
    /file:.*blocked/,
  );
  assert.deepEqual(events, []);
});

it("disconnects without returning DOM after a dialog", async () => {
  const { firefox, events, openDialog } = fixture();
  await assert.rejects(
    withRemoteRenderPage(firefox, endpoint, url, budget(), async () => {
      openDialog();
      return "must not be returned";
    }),
    /dialog/i,
  );
  assert.equal(events.at(-1), "disconnect");
});

it("disconnects when the overall render budget expires during DOM extraction", async () => {
  const { firefox, events } = fixture();
  const controller = new AbortController();
  await assert.rejects(
    withRemoteRenderPage(firefox, endpoint, url, budget(controller), () => {
      controller.abort();
      return never;
    }),
    /aborted/i,
  );
  assert.equal(events.at(-1), "disconnect");
});

it("preserves a dialog opened during a failed disconnect", async () => {
  const { firefox } = fixture(async (openDialog) => {
    openDialog();
    throw new Error("disconnect failed");
  });
  await assert.rejects(
    withRemoteRenderPage(firefox, endpoint, url, budget(), async () => "must not be returned"),
    /dialog/i,
  );
});

it("bounds cleanup time without replacing the render error", async () => {
  const { firefox, events } = fixture(() => never);
  const nativeSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      <Args extends unknown[]>(callback: (...args: Args) => void, delay?: number, ...args: Args) =>
        nativeSetTimeout(callback, delay === SERVER_WAIT_TIMEOUT_MS ? 0 : delay, ...args),
      { __promisify__: nativeSetTimeout.__promisify__ },
    ),
  );
  const renderError = new Error("render failed");
  try {
    await assert.rejects(
      withRemoteRenderPage(firefox, endpoint, url, budget(), async () => {
        throw renderError;
      }),
      (error) => error === renderError,
    );
    assert.equal(events.at(-1), "disconnect");
    assert.ok(timer.mock.calls.some(([, delay]) => delay === SERVER_WAIT_TIMEOUT_MS));
  } finally {
    timer.mockRestore();
  }
});
