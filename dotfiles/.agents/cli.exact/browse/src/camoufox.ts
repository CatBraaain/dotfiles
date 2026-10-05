// Camoufox rendering over the shared server: drive playwright-cli to open the
// URL, poll for challenge pages and read back the DOM. Also holds the camoufox
// retry policy hooks (shouldRetryCamoufox / recoverCamoufoxBeforeRetry) shared
// by the search and fetch backends.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  camoufoxFailureKind,
  prepareCamoufoxRetry,
  type RetryPreparation,
} from "./backends";
import {
  CAMOUFOX_HEALTH_SESSION_KEY,
  camoufoxBaseUrl,
  FUNCTIONAL_HEALTH_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  SERVER_WAIT_TIMEOUT_MS,
  stateDir,
} from "./config";
import { ensureCamoufoxServer, camoufoxServerHealthy, recoverCamoufoxServer } from "./server";

export async function camoufoxRender(url: string, sessionKey: string): Promise<string> {
  await ensureCamoufoxServer(AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
  syncPlaywrightCliConfig();

  const renderSignal = AbortSignal.timeout(RENDER_TIMEOUT_MS);
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
    await closePage();
    await runPlaywrightCli(sessionKey, ["open", url], renderSignal).catch((error: unknown) => {
      throw renderError(error);
    });
    // Spec: networkidle 待ち（5 秒）と並行して 250ms 間隔で DOM をポーリングし、
    // challenge を検出したら早い方で待ちを切り上げる（challengeWaitSnippet）。
    const codeOutput = await runPlaywrightCli(
      sessionKey,
      ["run-code", challengeWaitSnippet()],
      renderSignal,
    ).catch((error: unknown) => {
      throw renderError(error);
    });
    try {
      return parseRenderedPage(codeOutput);
    } catch (error) {
      throw renderError(error);
    }
  } finally {
    await closePage();
  }
}

function runPlaywrightCli(
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
// で続行）。
function syncPlaywrightCliConfig(): void {
  try {
    writeFileSync(playwrightCliConfigPath(), playwrightCliConfigJson(camoufoxBaseUrl()));
  } catch {
    // Keep going with the existing config (same content for the default URL).
  }
}

// Functional health check: a websocket answer alone is not enough (the server
// may accept connections while playwright-cli is wedged), so actually open a
// throwaway page through playwright-cli.
export async function camoufoxServerResponsive(): Promise<boolean> {
  const deadline = Date.now() + FUNCTIONAL_HEALTH_TIMEOUT_MS;
  const remainingSignal = (): AbortSignal =>
    AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const baseUrl = camoufoxBaseUrl();
  if (!(await camoufoxServerHealthy(baseUrl, remainingSignal()))) return false;
  syncPlaywrightCliConfig();
  try {
    await runPlaywrightCli(
      CAMOUFOX_HEALTH_SESSION_KEY,
      ["close"],
      remainingSignal(),
    ).catch(() => {});
    await runPlaywrightCli(
      CAMOUFOX_HEALTH_SESSION_KEY,
      ["open", "about:blank"],
      remainingSignal(),
    );
    return true;
  } catch {
    return false;
  } finally {
    await runPlaywrightCli(
      CAMOUFOX_HEALTH_SESSION_KEY,
      ["close"],
      remainingSignal(),
    ).catch(() => {});
  }
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
  const lines = output.split("\n");
  const resultIndex = lines.indexOf("### Result");
  const literal = resultIndex === -1 ? undefined : lines[resultIndex + 1];
  if (!literal || (!literal.startsWith('"') && !literal.startsWith("{"))) {
    throw new Error("playwright-cli run-code output has no result");
  }
  const { mode, html } = JSON.parse(literal) as { mode?: string; html?: string };
  if (mode === "challenge") throw new Error("challenge detected");
  if (typeof html !== "string" || !html) {
    throw new Error("playwright-cli run-code returned no HTML");
  }
  return html;
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

