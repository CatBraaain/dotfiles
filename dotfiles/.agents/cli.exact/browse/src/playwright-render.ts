import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SERVER_WAIT_TIMEOUT_MS } from "./config";

const PAGE_LOAD_WAIT_MS = 5_000;

export interface RenderPage {
  once(event: "dialog", listener: () => void): void;
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  waitForLoadState(state: "load" | "networkidle", options: { timeout: number }): Promise<void>;
  evaluate(read: () => string): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
}

interface RemoteBrowser {
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}

export interface RemoteFirefox {
  connect(endpoint: string, options: { timeout: number }): Promise<RemoteBrowser>;
}

export function useDirectPlaywright(
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
): boolean {
  const hasOverrides = Object.keys(env).some((key) => {
    const name = key.toUpperCase();
    return (
      name.startsWith("PLAYWRIGHT_MCP_") &&
      name !== "PLAYWRIGHT_MCP_CONFIG" &&
      name !== "PLAYWRIGHT_MCP_OUTPUT_DIR"
    );
  });
  if (hasOverrides) return false;

  try {
    if (statSync(join(cwd, ".playwright", "cli.config.json"), { throwIfNoEntry: false })) {
      return false;
    }
    const globalConfigPath = join(
      env.PWTEST_CLI_GLOBAL_CONFIG ?? home,
      ".playwright",
      "cli.config.json",
    );
    if (!statSync(globalConfigPath, { throwIfNoEntry: false })) return true;
    const source = readFileSync(globalConfigPath, "utf8").replace(/^\uFEFF/, "");
    const config: unknown = JSON.parse(source);
    return (
      !!config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      Object.keys(config).every((key) => key === "outputDir")
    );
  } catch {
    return false;
  }
}

export async function withRemoteRenderPage<T>(
  firefox: RemoteFirefox,
  endpoint: string,
  url: string,
  budget: { signal: AbortSignal; remainingMs: number },
  read: (page: RenderPage) => Promise<T>,
): Promise<T> {
  if (new URL(url).protocol === "file:") throw new Error('Access to "file:" protocol is blocked');
  const { signal } = budget;
  signal.throwIfAborted();
  const browser = await firefox.connect(endpoint, { timeout: budget.remainingMs });
  const stopped = Promise.withResolvers<never>();
  function abortRender() {
    stopped.reject(signal.reason);
  }
  signal.addEventListener("abort", abortRender, { once: true });

  let dialogError: Error | undefined;
  async function render() {
    signal.throwIfAborted();
    const page = await browser.newPage();
    signal.throwIfAborted();
    page.once("dialog", () => {
      dialogError = new Error("Page opened a JavaScript dialog");
      stopped.reject(dialogError);
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("load", { timeout: PAGE_LOAD_WAIT_MS });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    }
    return read(page);
  }

  let result: T;
  let renderFailed = false;
  try {
    result = await Promise.race([stopped.promise, render()]);
  } catch (error) {
    renderFailed = true;
    throw error;
  } finally {
    signal.removeEventListener("abort", abortRender);
    await disconnect(browser).catch((error: unknown) => {
      if (!renderFailed) throw dialogError ?? error;
    });
  }
  if (dialogError) throw dialogError;
  return result;
}

async function disconnect(browser: RemoteBrowser): Promise<void> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Browser connection close timed out")),
    SERVER_WAIT_TIMEOUT_MS,
  );
  try {
    await Promise.race([browser.close(), deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}
