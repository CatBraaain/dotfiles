// Camoufox rendering over the shared server: drive playwright-cli to open the
// URL, poll for challenge pages and read back the DOM. Also holds the camoufox
// retry policy hooks (shouldRetryCamoufox / recoverCamoufoxBeforeRetry) shared
// by the search and fetch backends.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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
  ensureCamoufoxServer,
  camoufoxServerHealthy,
  recoverCamoufoxServer,
  restartInFlight as restartLockInFlight,
  waitForRestartToFinish,
} from "./server";

export async function camoufoxRender(url: string, sessionKey: string): Promise<string> {
  await ensureCamoufoxServer(AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
  syncPlaywrightCliConfig();

  // Spec: レンダーのタイムアウトは実働のみで計る。ステップの合間に他ジョブの
  // server 再起動を検知したら計時を止め、再起動の完了後に残り時間で続行する
  // （再起動待ちでタイマーを消耗し、自分も復旧再起動を発火する連鎖を防ぐ）。
  const clock = new RenderClock(RENDER_TIMEOUT_MS);
  const renderError = (error: unknown): Error =>
    new Error(`render: ${error instanceof Error ? error.message : String(error)}`);

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
    clock.awaitTurn();
    await closePage();
    clock.awaitTurn();
    await runPlaywrightCli(sessionKey, ["open", url], clock.signal).catch((error: unknown) => {
      throw renderError(error);
    });
    // Spec: networkidle 待ち（5 秒）と並行して 250ms 間隔で DOM をポーリングし、
    // challenge を検出したら早い方で待ちを切り上げる（challengeWaitSnippet）。
    clock.awaitTurn();
    const codeOutput = await runPlaywrightCli(
      sessionKey,
      ["run-code", challengeWaitSnippet()],
      clock.signal,
    ).catch((error: unknown) => {
      throw renderError(error);
    });
    try {
      return parseRenderedPage(codeOutput);
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
    execFile(
      "playwright-cli",
      buildPlaywrightCliArgs(sessionKey, args),
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

function playwrightCliConfigPath(): string {
  return join(stateDir(), "playwright-cli.config.json");
}

// Spec: playwright-cli のブラウザは firefox で remote endpoint に camoufox を
// 使う。CAMOUFOX_BASE_URL に合わせて config を最新化する（失敗時は既存 config
// で続行）。login 経路（camoufoxRender を通らない）でも使うため export する。
export function syncPlaywrightCliConfig(): void {
  try {
    writeFileSync(playwrightCliConfigPath(), playwrightCliConfigJson(camoufoxBaseUrl()));
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

const CHALLENGE_POLL_INTERVAL_MS = 250;
const NETWORK_IDLE_WAIT_MS = 5_000;

function challengeWaitSnippet(): string {
  const signals = CHALLENGE_SIGNALS.map((signal) => [signal.source, signal.flags]);
  return `async page => {
  const challengeSignals = ${JSON.stringify(signals)}.map(([source, flags]) => new RegExp(source, flags));
  const grab = () => page.evaluate(() => document.documentElement.outerHTML);
  let settled = false;
  const idle = page.waitForLoadState('networkidle', { timeout: ${NETWORK_IDLE_WAIT_MS} }).catch(() => {}).then(() => { settled = true; });
  const deadline = Date.now() + ${NETWORK_IDLE_WAIT_MS};
  while (!settled && Date.now() < deadline) {
    const html = await grab();
    if (challengeSignals.some((signal) => signal.test(html))) return { mode: 'challenge', html };
    await page.waitForTimeout(${CHALLENGE_POLL_INTERVAL_MS});
  }
  await idle;
  return { mode: 'settled', html: await grab() };
}`;
}

function parseRenderedPage(output: string): string {
  const { mode, html } = parseRunCodeResult<{ mode?: string; html?: string }>(output);
  if (mode === "challenge") throw new Error("challenge detected");
  if (typeof html !== "string" || !html) {
    throw new Error("playwright-cli run-code returned no HTML");
  }
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

// Render deadline that counts only actual render time: while another job holds
// the restart lock (a server restart is in flight), the clock pauses so the
// wait does not consume the render budget (spec: 再起動検知中はレンダータイマーを
// 進めない).
export class RenderClock {
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly restartInFlight: () => boolean;
  private readonly awaitRestartFinish: () => void;
  private remainingMs: number;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private segmentStartedAt: number | undefined;

  constructor(
    budgetMs: number,
    restartInFlight: () => boolean = restartLockInFlight,
    awaitRestartFinish: () => void = waitForRestartToFinish,
  ) {
    this.remainingMs = budgetMs;
    this.restartInFlight = restartInFlight;
    this.awaitRestartFinish = awaitRestartFinish;
    this.signal = this.controller.signal;
    this.resume();
  }

  // Pauses the clock while a restart holds the lock, blocks until it finishes,
  // then resumes the remaining budget. Call between playwright-cli steps.
  awaitTurn(): void {
    if (this.disposed || !this.restartInFlight()) return;
    this.pause();
    while (this.restartInFlight()) {
      this.awaitRestartFinish();
    }
    this.resume();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.segmentStartedAt = undefined;
    this.disposed = true;
  }

  private pause(): void {
    if (this.segmentStartedAt === undefined || this.signal.aborted) return;
    clearTimeout(this.timer);
    const elapsed = Date.now() - this.segmentStartedAt;
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.segmentStartedAt = undefined;
  }

  private resume(): void {
    if (this.signal.aborted) return;
    if (this.remainingMs <= 0) {
      this.controller.abort();
      return;
    }
    this.segmentStartedAt = Date.now();
    this.timer = setTimeout(() => this.controller.abort(), this.remainingMs);
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
