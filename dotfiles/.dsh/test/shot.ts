/**
 * Take review screenshots of the fixture pages without booting dsh.
 *
 * Prerequisite: `bun run render.ts` (the fixture html files must exist).
 * Starts `serve.ts` as a child process, drives a playwright-cli Chromium
 * session over the light and dark fixture pages, and writes into `dist/`:
 * - `fixture.png`        light, all review cases
 * - `fixture-hover.png`  light, a session-list row hovered (case 4 hover actions)
 * - `fixture-dark.png`   dark, all review cases
 *
 * The screenshot review contract lives in REVIEW.md.
 */
import { join } from "node:path";

const playwrightSession = `dsh-shot-${process.pid}`;
const serveReadyTimeoutMs = 30_000;
const serveUrlPattern = /http:\/\/localhost:[0-9]+\//;
const viewport = { width: 1280, height: 900 };

const screenshotNames = ["fixture.png", "fixture-hover.png", "fixture-dark.png"];

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

async function runPlaywright(command: readonly string[], cwd: string): Promise<string> {
  const result = await runCommand(
    ["playwright-cli", `-s=${playwrightSession}`, "--json", ...command],
    cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `playwright-cli ${command[0]} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return parsePlaywrightResult(result.stdout);
}

function parsePlaywrightResult(stdout: string): string {
  try {
    const response = JSON.parse(stdout) as { result?: unknown };
    return typeof response.result === "string"
      ? response.result
      : JSON.stringify(response.result ?? response);
  } catch {
    return stdout;
  }
}

/** Wait until `serve.ts` prints its URL on stdout, or fail on exit / timeout. */
async function waitForServeUrl(serve: Bun.Subprocess): Promise<string> {
  const stdout = serve.stdout;
  if (!(stdout instanceof ReadableStream)) {
    throw new Error("fixture server stdout is not piped");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  const firstUrlInOutput = (async () => {
    for await (const chunk of stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const url = buffered.match(serveUrlPattern)?.[0];
      if (url) return url;
    }
    return null;
  })();
  const url = await Promise.race([
    firstUrlInOutput,
    serve.exited.then(() => null),
    Bun.sleep(serveReadyTimeoutMs).then(() => null),
  ]);
  if (url) return url;
  const stderrStream = serve.stderr;
  const stderr =
    stderrStream instanceof ReadableStream ? await new Response(stderrStream).text() : "";
  throw new Error(
    `fixture server did not become ready within ${serveReadyTimeoutMs / 1000}s${stderr ? `:\n${stderr}` : ""}`,
  );
}

async function stopServe(serve: Bun.Subprocess): Promise<void> {
  try {
    serve.kill();
  } catch {
    // The server may have already exited.
  }
  await Promise.race([serve.exited, Bun.sleep(1_000)]);
  try {
    serve.kill("SIGKILL");
  } catch {
    // The server may have already exited.
  }
  await serve.exited;
}

function screenshotScript(lightUrl: string, darkUrl: string): string {
  return `async page => {
    await page.setViewportSize({ width: ${viewport.width}, height: ${viewport.height} });
    await page.goto(${JSON.stringify(lightUrl)});
    await page.screenshot({ path: "dist/fixture.png" });
    await page.locator(".session-list-row").first().hover();
    await page.screenshot({ path: "dist/fixture-hover.png" });
    await page.goto(${JSON.stringify(darkUrl)});
    await page.screenshot({ path: "dist/fixture-dark.png" });
  }`;
}

async function main(): Promise<void> {
  const cwd = import.meta.dir;
  for (const name of ["fixture.html", "fixture-dark.html"]) {
    if (!(await Bun.file(join(cwd, "dist", name)).exists())) {
      throw new Error(`dist/${name} is missing. Run \`bun run render.ts\` first.`);
    }
  }

  const serve = Bun.spawn(["bun", "run", "serve.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
  let browserStarted = false;
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (browserStarted) await runPlaywright(["close"], cwd).catch(() => {});
    await stopServe(serve);
  };
  const requestShutdown = (exitCode: number): void => {
    void cleanup().finally(() => process.exit(exitCode));
  };
  const handleInterrupt = (): void => requestShutdown(130);
  const handleTermination = (): void => requestShutdown(143);
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);

  try {
    const serveUrl = await waitForServeUrl(serve);
    const baseUrl = new URL(serveUrl).origin;
    browserStarted = true;
    await runPlaywright(["open", "--browser=chromium", "about:blank"], cwd);
    await Bun.sleep(1_000);
    await runPlaywright(["run-code", screenshotScript(`${baseUrl}/`, `${baseUrl}/dark`)], cwd);
    for (const name of screenshotNames) {
      if (!(await Bun.file(join(cwd, "dist", name)).exists())) {
        throw new Error(`screenshot was not written: dist/${name}`);
      }
    }
    console.log(`screenshots written: ${screenshotNames.map((name) => `dist/${name}`).join(", ")}`);
  } finally {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTermination);
    await cleanup();
  }
}

await main();
