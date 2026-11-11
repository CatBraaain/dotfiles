import { constants, existsSync, renameSync, writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserServer } from "playwright-core";
import { validateOpuiLang } from "./render.ts";
import {
  SHOT_HEIGHT,
  SHOT_WIDTH,
  type SnapshotCompletion,
  type SnapshotInput,
} from "./snapshot.ts";

export class SnapshotCleanupError extends Error {}

const BROWSER_CLOSE_GRACE_MS = 1_000;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DOCUMENT_URL = "https://openui-preview.invalid/";
const DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"></head><body><div id="root"></div></body></html>`;

export async function buildBrowserBundle(
  signal?: AbortSignal,
): Promise<{ javascript: string; css: string }> {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "bu-"));
  let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  function interrupt(): void {
    child?.kill("SIGKILL");
  }
  try {
    signal?.throwIfAborted();
    child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(import.meta.url),
        "--bundle",
        join(directory, "bundle.json"),
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    const stderr = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const errorOutput = await stderr;
    signal?.throwIfAborted();
    if (exitCode !== 0) throw new Error(`OpenUI bundle process failed: ${errorOutput}`);
    return JSON.parse(await readFile(join(directory, "bundle.json"), "utf8"));
  } finally {
    signal?.removeEventListener("abort", interrupt);
    if (child) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildBundleInProcess(): Promise<{ javascript: string; css: string }> {
  const build = await Bun.build({
    entrypoints: [join(EXTENSION_DIR, "snapshot-browser.js")],
    target: "browser",
    format: "iife",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!build.success) throw new AggregateError(build.logs, "OpenUI browser bundle failed");
  const javascript = build.outputs.find((output) => output.path.endsWith(".js"));
  const css = build.outputs.find((output) => output.path.endsWith(".css"));
  if (!javascript || !css || build.outputs.length !== 2) {
    throw new Error("OpenUI browser bundle must contain only JavaScript and CSS");
  }
  return { javascript: await javascript.text(), css: await css.text() };
}

export async function captureSnapshot(input: SnapshotInput, signal?: AbortSignal): Promise<void> {
  const validated = validateOpuiLang(input.source, input.generatedDir);
  if (!validated.ok) throw new Error(validated.error);
  const browserTempDir = await mkdtemp(join(tmpdir(), "ob-"));
  const previousTemp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  for (const name of Object.keys(previousTemp)) process.env[name] = browserTempDir;
  let server: BrowserServer | undefined;
  const controller = new AbortController();
  const deadlineError = new Error("OpenUI snapshot exceeded the 15-second deadline");
  const timer = setTimeout(
    () => controller.abort(deadlineError),
    Math.max(0, input.deadline - Date.now()),
  );
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let closing: Promise<void> | undefined;
  function closeBrowser(): Promise<void> {
    if (!server) return Promise.resolve();
    return (closing ??= stopBrowserServer(server));
  }
  function onAbort(): void {
    void closeBrowser().catch((error) =>
      console.error(`OpenUI browser cleanup failed: ${String(error)}`),
    );
  }
  combined.addEventListener("abort", onAbort, { once: true });
  try {
    combined.throwIfAborted();
    if (Date.now() >= input.deadline) throw deadlineError;
    const bundle = await buildBrowserBundle(combined);
    combined.throwIfAborted();
    const { chromium } = await import("playwright-core");
    server = await chromium.launchServer({
      host: "127.0.0.1",
      executablePath: await resolveChromiumExecutable(chromium.executablePath()),
      headless: true,
      chromiumSandbox: true,
      timeout: remainingTime(),
    });
    combined.throwIfAborted();
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: remainingTime() });
    const page = await browser.newPage({
      viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      colorScheme: "light",
    });
    let failure = "";
    page.on("pageerror", (error) => {
      failure = String(error);
    });
    let documentServed = false;
    await page.context().route("**/*", async (route) => {
      const request = route.request();
      const isDocument =
        !documentServed &&
        request.url() === DOCUMENT_URL &&
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame();
      if (isDocument) {
        documentServed = true;
        await route.fulfill({ contentType: "text/html", body: DOCUMENT });
        return;
      }
      failure = `Blocked browser reference: ${request.url()}`;
      await route.abort("blockedbyclient");
    });
    await page.goto(DOCUMENT_URL, { timeout: remainingTime(), waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: bundle.css });
    await page.addStyleTag({
      content:
        "body{margin:0;background:var(--openui-background);color:var(--openui-text-neutral-primary);font-family:var(--openui-font-body)}#root{padding:24px}",
    });
    await page.addScriptTag({ content: bundle.javascript });
    await page.evaluate((source) => {
      const runtime = globalThis as typeof globalThis & { __mountOpenui: (source: string) => void };
      runtime.__mountOpenui(source);
    }, input.source);
    await page.waitForFunction(
      () => {
        const runtime = globalThis as typeof globalThis & {
          __openuiSnapshot?: { ready: boolean; error: string };
        };
        return runtime.__openuiSnapshot?.ready || runtime.__openuiSnapshot?.error;
      },
      null,
      { timeout: remainingTime(), polling: "raf" },
    );
    const renderError = await page.evaluate(() => {
      const runtime = globalThis as typeof globalThis & { __openuiSnapshot: { error: string } };
      return runtime.__openuiSnapshot.error;
    });
    if (failure || renderError) throw new Error(failure || renderError);
    combined.throwIfAborted();
    const png = await page.screenshot({ type: "png", fullPage: false, timeout: remainingTime() });
    if (failure) throw new Error(failure);
    combined.throwIfAborted();
    await writeFile(input.pngPath, png);
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    if (Date.now() >= input.deadline) throw deadlineError;
    throw error;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
    await cleanupBrowser();
  }

  async function cleanupBrowser(): Promise<void> {
    try {
      let closeError: unknown;
      try {
        await closeBrowser();
      } catch (error) {
        if (error instanceof SnapshotCleanupError) throw error;
        closeError = error;
      }
      await rm(browserTempDir, { recursive: true, force: true });
      if (closeError) throw closeError;
    } finally {
      for (const [name, value] of Object.entries(previousTemp)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  function remainingTime(): number {
    combined.throwIfAborted();
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) throw deadlineError;
    return remaining;
  }
}

async function stopBrowserServer(server: BrowserServer): Promise<void> {
  let closeError: unknown;
  let killError: unknown;
  let forced = false;
  let kill: Promise<void> | undefined;
  function killBrowser(): Promise<void> {
    return (kill ??= server.kill());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forceClose = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      forced = true;
      void killBrowser().then(resolve, (error) => {
        killError = error;
        resolve();
      });
    }, BROWSER_CLOSE_GRACE_MS);
  });
  try {
    await Promise.race([
      server.close().catch((error: unknown) => {
        closeError = error;
      }),
      forceClose,
    ]);
  } finally {
    clearTimeout(timer);
    try {
      await killBrowser();
    } catch (error) {
      killError = error;
    }
  }
  if (killError)
    throw new SnapshotCleanupError(`OpenUI browser termination failed: ${String(killError)}`);
  if (closeError) throw new Error(`OpenUI browser close failed: ${String(closeError)}`);
  if (forced)
    throw new Error("OpenUI browser graceful close did not finish before forced termination");
}

export async function resolveChromiumExecutable(expectedPath: string): Promise<string> {
  const revisionDir = dirname(dirname(expectedPath));
  const cacheRoot = dirname(revisionDir);
  const executableSuffix = relative(revisionDir, expectedPath);
  const entries = await readdir(cacheRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const revisions = entries
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
  for (const revision of revisions) {
    const executable = join(cacheRoot, revision, executableSuffix);
    try {
      await access(executable, constants.X_OK);
      return executable;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }
  throw new Error(`No existing Chromium executable in browser cache: ${cacheRoot}`);
}

export async function runSnapshot(
  inputPath: string,
  capture: typeof captureSnapshot = captureSnapshot,
): Promise<void> {
  const directory = dirname(inputPath);
  renameSync(join(directory, "pending"), join(directory, "running"));
  writeFileSync(join(directory, "running", "owner.json"), JSON.stringify({ pid: process.pid }));
  const controller = new AbortController();
  function interrupt(): void {
    controller.abort(new Error("OpenUI snapshot interrupted"));
  }
  function checkCancellation(): void {
    if (!existsSync(directory) || existsSync(join(directory, "cancel"))) interrupt();
  }
  const watcher = setInterval(checkCancellation, 20);
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  checkCancellation();
  let completion: SnapshotCompletion;
  try {
    controller.signal.throwIfAborted();
    const input: SnapshotInput = JSON.parse(await readFile(inputPath, "utf8"));
    await capture(input, controller.signal);
    checkCancellation();
    controller.signal.throwIfAborted();
    completion = { ok: true };
  } catch (error) {
    if (error instanceof SnapshotCleanupError) throw error;
    completion = { ok: false, error: String(error) };
  } finally {
    clearInterval(watcher);
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
  writeFileSync(join(directory, "finished.json"), JSON.stringify(completion));
  if (!completion.ok) throw new Error(completion.error);
}

if (import.meta.main) {
  try {
    const inputPath = process.argv[2];
    if (!inputPath) throw new Error("OpenUI snapshot input path is missing");
    if (inputPath === "--bundle") {
      const outputPath = process.argv[3];
      if (!outputPath) throw new Error("OpenUI bundle output path is missing");
      await writeFile(outputPath, JSON.stringify(await buildBundleInProcess()));
    } else {
      await runSnapshot(inputPath);
    }
  } catch (error) {
    console.error(`OpenUI snapshot failed: ${String(error)}`);
    process.exitCode = 1;
  }
}
