import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser } from "playwright";
import { expect, it } from "vitest";

it("serves and renders the sample catalog through bun run storybook", async ({
  signal,
  onTestFinished,
}) => {
  const scratchRoot = "/tmp/work/vscode-pi-sessions";
  await mkdir(scratchRoot, { recursive: true });
  const home = await mkdtemp(join(scratchRoot, "storybook-dev-"));
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  let browser: Promise<Browser> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  let exitStatus: string | undefined;
  let output = "";
  let baseUrl = "";

  function appendOutput(chunk: Buffer): void {
    const logLimit = 16_000;
    output = (output + chunk.toString()).slice(-logLimit);
  }

  function cleanup(): Promise<void> {
    return (cleanupPromise ??= stop());
  }

  async function stop(): Promise<void> {
    try {
      await (await browser)?.close();
    } finally {
      try {
        if (server?.pid !== undefined) {
          try {
            signalGroup(server.pid, "SIGTERM");
            await Promise.race([closed, delay(3_000)]);
          } finally {
            signalGroup(server.pid, "SIGKILL");
          }
          await closed;
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }

  function abortWork(): void {
    void cleanup().catch((error) => console.error("Storybook dev cleanup failed", error));
  }

  onTestFinished(cleanup, 30_000);
  workSignal.addEventListener("abort", abortWork, { once: true });

  try {
    const port = await unusedPort();
    workSignal.throwIfAborted();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      "bun",
      [
        "run",
        "storybook",
        "--ci",
        "--no-open",
        "--disable-telemetry",
        "--no-version-updates",
        "--host",
        "127.0.0.1",
        "--exact-port",
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
          STORYBOOK_DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
        },
      },
    );
    server.on("error", (error) => {
      exitStatus = error.message;
    });
    server.stdout!.on("data", appendOutput);
    server.stderr!.on("data", appendOutput);
    closed = new Promise<void>((resolve) => {
      server!.once("close", (code, signal) => {
        exitStatus ??= `code=${code}, signal=${signal}`;
        resolve();
      });
    });

    const deadline = Date.now() + 60_000;
    let lastResponse = "no response";
    while (true) {
      workSignal.throwIfAborted();
      if (exitStatus !== undefined) throw new Error(`Storybook exited: ${exitStatus}`);
      if (Date.now() >= deadline) throw new Error(`Storybook startup timed out: ${lastResponse}`);
      try {
        const response = await fetch(baseUrl, {
          signal: AbortSignal.any([workSignal, AbortSignal.timeout(1_000)]),
        });
        const html = await response.text();
        lastResponse = `HTTP ${response.status}`;
        if (response.ok && html.includes("storybook-root")) break;
      } catch (error) {
        lastResponse = String(error);
      }
      await delay(100, undefined, { signal: workSignal });
    }

    const sampleStory = "sessions-sidebar--sample-sessions";
    const index = await fetch(`${baseUrl}/index.json`, {
      signal: AbortSignal.any([workSignal, AbortSignal.timeout(15_000)]),
    });
    expect(index.status).toBe(200);
    expect(await index.json()).toMatchObject({ entries: { [sampleStory]: { id: sampleStory } } });

    workSignal.throwIfAborted();
    browser = chromium.launch({ headless: true, timeout: 15_000 });
    const openedBrowser = await browser;
    workSignal.throwIfAborted();
    const page = await openedBrowser.newPage();
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort(),
    );
    await page.goto(`${baseUrl}/?path=/story/${sampleStory}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
      signal: workSignal,
    });
    const sampleSession = page
      .frameLocator("#storybook-preview-iframe")
      .locator('[data-session="1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10"]');
    await sampleSession.waitFor({ state: "visible", timeout: 15_000, signal: workSignal });
    expect(await sampleSession.isVisible()).toBe(true);
  } catch (error) {
    throw new Error(`Storybook dev catalog failed at ${baseUrl}\n${output}`, { cause: error });
  } finally {
    workSignal.removeEventListener("abort", abortWork);
    await cleanup();
  }
}, 120_000);

async function unusedPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  if (address === null || typeof address === "string") throw new Error("No TCP port was reserved");
  return address.port;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
