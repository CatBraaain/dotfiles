import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { camoufoxFailureKind, prepareCamoufoxRetry, type RetryPreparation } from "./backends";
import {
  CAMOUFOX_HEALTH_SESSION_KEY,
  camoufoxBaseUrl,
  camoufoxSessionKey,
  FUNCTIONAL_HEALTH_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  SERVER_WAIT_TIMEOUT_MS,
  stateDir,
} from "./config";
import {
  loadCliPlaywrightCore,
  resolveWindowsNode,
  resolveWindowsPlaywrightCli,
} from "./playwright-cli";
import {
  useDirectPlaywright,
  withRemoteRenderPage,
  type RemoteFirefox,
  type RenderPage,
} from "./playwright-render";
import { ensureCamoufoxServer, camoufoxServerHealthy, recoverCamoufoxServer } from "./server";

declare const document: { documentElement: { outerHTML: string } };

export async function camoufoxRender(url: string, sessionKey: string): Promise<string> {
  await ensureCamoufoxServer(AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
  syncPlaywrightCliConfig();

  const firefox = useDirectPlaywright() ? loadDirectFirefox() : undefined;
  if (!firefox) return renderWithPlaywrightCli(url, sessionKey);

  const clock = new RenderClock(RENDER_TIMEOUT_MS);
  try {
    return await withRemoteRenderPage(firefox, camoufoxBaseUrl(), url, clock, async (page) =>
      renderedHtml(await readRenderedPage(page, CHALLENGE_SIGNALS)),
    );
  } catch (error) {
    throw renderError(error);
  } finally {
    clock.dispose();
  }
}

function loadDirectFirefox(): RemoteFirefox | undefined {
  try {
    const { firefox } = loadCliPlaywrightCore() as { firefox?: RemoteFirefox };
    return typeof firefox?.connect === "function" ? firefox : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return undefined;
    }
    throw renderError(error);
  }
}

function renderError(error: unknown): Error {
  return new Error(`render: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  });
}

async function renderWithPlaywrightCli(url: string, sessionKey: string): Promise<string> {
  // Spec: 実行中の render は server 再起動を待たない（再起動側が全 render
  // スロットの解放を待つため、実行中 render が再起動の完了を待つ循環待ちは
  // 起きない）。再起動が始まっても予算を使い切るまで継続する。
  const clock = new RenderClock(RENDER_TIMEOUT_MS);
  const closePage = async (): Promise<void> => {
    await runPlaywrightCli(
      sessionKey,
      ["close"],
      AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS),
    ).catch(() => {});
  };

  try {
    // Spec: 各実行の冒頭と終了時にセッションを閉じる（cookie / ページ状態の
    // 持ち越し防止。冒頭の閉鎖失敗は無視）。
    await closePage();
    await runPlaywrightCli(sessionKey, ["open", url], clock.signal).catch((error: unknown) => {
      throw renderError(error);
    });
    // Spec: networkidle 待ち（5 秒）と並行して 250ms 間隔で DOM をポーリングし、
    // challenge を検出したら早い方で待ちを切り上げる（challengeWaitSnippet）。
    const codeOutput = await runPlaywrightCli(
      sessionKey,
      ["run-code", challengeWaitSnippet()],
      clock.signal,
    ).catch((error: unknown) => {
      throw renderError(error);
    });
    try {
      return renderedHtml(parseRunCodeResult<RenderedPage>(codeOutput));
    } catch (error) {
      throw renderError(error);
    }
  } finally {
    clock.dispose();
    await closePage();
  }
}

export function runPlaywrightCli(
  sessionKey: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [executable, ...prefixArgs] = playwrightCliCommand();
    execFile(
      executable,
      [...prefixArgs, ...buildPlaywrightCliArgs(sessionKey, args)],
      {
        signal,
        maxBuffer: 64 * 1024 * 1024,
        env: buildPlaywrightCliEnv(process.env, playwrightCliConfigPath()),
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function playwrightCliCommand(): [string, ...string[]] {
  if (process.platform !== "win32") return ["playwright-cli"];

  const { entry, prefix } = resolveWindowsPlaywrightCli();
  return [resolveWindowsNode(prefix), entry];
}

function playwrightCliConfigPath(): string {
  return join(stateDir(), "playwright-cli.config.json");
}

// Spec: playwright-cli のブラウザは firefox で remote endpoint に camoufox を
// 使う。CAMOUFOX_BASE_URL に合わせて config を最新化する（失敗時は既存 config
// で続行）。login 経路（camoufoxRender を通らない）でも使うため export する。
export function syncPlaywrightCliConfig(): void {
  try {
    const configPath = playwrightCliConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, playwrightCliConfigJson(camoufoxBaseUrl()));
  } catch {
    // Keep going with the existing config (same content for the default URL).
  }
}

// Functional health check: a websocket answer alone is not enough (the server
// may accept connections while playwright-cli is wedged), so open a local HTTP
// probe through playwright-cli (spec: server の機能ヘルスチェック).
export async function camoufoxServerResponsive(): Promise<boolean> {
  const deadline = Date.now() + FUNCTIONAL_HEALTH_TIMEOUT_MS;
  const remainingSignal = (): AbortSignal =>
    AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const baseUrl = camoufoxBaseUrl();
  if (!(await camoufoxServerHealthy(baseUrl, remainingSignal()))) return false;
  syncPlaywrightCliConfig();
  // Spec: 機能ヘルスチェックのセッションキーにも render スロット番号が付き、
  // 同時に走るヘルスチェックが同じセッションを共有しない。
  const healthSessionKey = camoufoxSessionKey(CAMOUFOX_HEALTH_SESSION_KEY);
  const probe = await startLocalHttpProbe();
  try {
    await runPlaywrightCli(healthSessionKey, ["close"], remainingSignal()).catch(() => {});
    await runPlaywrightCli(healthSessionKey, ["open", probe.url], remainingSignal());
    return true;
  } catch {
    return false;
  } finally {
    await runPlaywrightCli(healthSessionKey, ["close"], remainingSignal()).catch(() => {});
    await probe.close();
  }
}

interface HttpProbe {
  url: string;
  close: () => Promise<void>;
}

export async function startLocalHttpProbe(): Promise<HttpProbe> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>ok</body></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const CHALLENGE_SIGNALS: readonly RegExp[] = [
  /cdn-cgi\/challenge-platform\//,
  /id="challenge-(?:running|form|stage|error-text)"/,
  /<title[^>]*>\s*Just a moment\.\.\.\s*<\/title>/i,
  /\bcf-turnstile\b/,
  /<form[^>]*\bid="captcha-form"/,
  /<form[^>]*\baction="[^"]*\/sorry\//,
  /<body[^>]*\bonload="[^"]*captcha/i,
  /^(?![\s\S]*(?:class="tF2Cxc"|data-hveid=))[\s\S]*httpservice\/retry\/enablejs/,
];

interface RenderedPage {
  mode: "challenge" | "settled";
  html: string;
}

function challengeWaitSnippet(): string {
  return `async page => (${readRenderedPage.toString()})(page, [${CHALLENGE_SIGNALS.join(",")}])`;
}

async function readRenderedPage(
  page: Pick<RenderPage, "evaluate" | "waitForLoadState" | "waitForTimeout">,
  challengeSignals: readonly RegExp[],
): Promise<RenderedPage> {
  const pollIntervalMs = 250;
  const networkIdleWaitMs = 5_000;
  function grab() {
    return page.evaluate(() => document.documentElement.outerHTML);
  }
  let settled = false;
  const idle = page
    .waitForLoadState("networkidle", { timeout: networkIdleWaitMs })
    .catch(() => {})
    .then(() => {
      settled = true;
    });
  const deadline = Date.now() + networkIdleWaitMs;
  while (!settled && Date.now() < deadline) {
    const html = await grab();
    if (challengeSignals.some((signal) => signal.test(html))) return { mode: "challenge", html };
    await page.waitForTimeout(pollIntervalMs);
  }
  await idle;
  return { mode: "settled", html: await grab() };
}

function renderedHtml({ mode, html }: RenderedPage): string {
  if (mode === "challenge") throw new Error("challenge detected");
  if (typeof html !== "string" || !html) throw new Error("Camoufox returned no HTML");
  return html;
}

// playwright-cli run-code prints the JSON literal of the snippet's return
// value after a `### Result` heading; parse that literal.
export function parseRunCodeResult<T>(output: string): T {
  const lines = output.split("\n");
  const resultIndex = lines.indexOf("### Result");
  const literal = resultIndex === -1 ? undefined : lines[resultIndex + 1];
  if (!literal || (!literal.startsWith('"') && !literal.startsWith("{"))) {
    throw new Error("playwright-cli run-code output has no result");
  }
  return JSON.parse(literal) as T;
}

function playwrightCliConfigJson(baseUrl: string): string {
  return `${JSON.stringify({ browser: { browserName: "firefox", remoteEndpoint: baseUrl } }, null, 2)}\n`;
}

function buildPlaywrightCliEnv(
  base: Record<string, string | undefined>,
  configPath: string,
): Record<string, string | undefined> {
  return { ...base, PLAYWRIGHT_MCP_CONFIG: configPath };
}

function buildPlaywrightCliArgs(sessionKey: string, args: readonly string[]): string[] {
  return [`-s=${sessionKey}`, ...args];
}

// Render deadline for one camoufox run: an active render keeps running across
// a server restart (the restart side waits for render slots, so waiting on the
// restart here would deadlock) and is aborted once the budget is spent.
export class RenderClock {
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly deadlineMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(budgetMs: number) {
    this.signal = this.controller.signal;
    this.deadlineMs = performance.now() + budgetMs;
    this.timer = setTimeout(() => this.controller.abort(), budgetMs);
  }

  get remainingMs(): number {
    return Math.max(1, Math.ceil(this.deadlineMs - performance.now()));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function shouldRetryCamoufox(error: unknown): boolean {
  return camoufoxFailureKind(error) !== "other";
}

export function recoverCamoufoxBeforeRetry(
  error: unknown,
  recoveryRetries: number,
): Promise<RetryPreparation> {
  return prepareCamoufoxRetry(error, recoveryRetries, {
    isServerResponsive: camoufoxServerResponsive,
    restartServer: recoverCamoufoxServer,
  });
}
