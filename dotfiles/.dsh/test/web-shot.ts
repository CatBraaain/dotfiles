import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const readinessTimeoutMs = 60_000;
const playwrightSession = `dsh-web-shot-${process.pid}`;
const tokenUrlPattern = /http:\/\/127\.0\.0\.1:[0-9]+\/\?token=[A-Za-z0-9_-]+/;
const screenshotNames = ["web-fixture.png"] as const;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

function redactToken(value: string): string {
  return value.replace(tokenUrlPattern, "<redacted token URL>");
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

async function runPlaywright(command: readonly string[], cwd: string): Promise<string> {
  const result = await runCommand(
    ["playwright-cli", `-s=${playwrightSession}`, "--json", ...command],
    cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `playwright-cli ${command[0]} failed:\n${redactToken(result.stderr || result.stdout)}`,
    );
  }
  return parsePlaywrightResult(result.stdout);
}

async function waitForTokenUrl(logPath: string, serverExited: () => boolean): Promise<string> {
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    const log = await Bun.file(logPath).text().catch(() => "");
    const tokenUrl = log.match(tokenUrlPattern)?.[0];
    if (tokenUrl) return tokenUrl;
    if (serverExited()) throw new Error("dsh web exited before its token URL was ready");
    await Bun.sleep(100);
  }
  throw new Error(`dsh web token URL was not ready within ${readinessTimeoutMs / 1000}s`);
}

async function processTree(rootPid: number): Promise<number[]> {
  const result = await runCommand(["ps", "-eo", "pid=,ppid="], process.cwd());
  if (result.exitCode !== 0) return [];

  const children = new Map<number, number[]>();
  for (const line of result.stdout.trim().split("\n")) {
    const [pidText, parentPidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    children.set(parentPid, [...(children.get(parentPid) ?? []), pid]);
  }

  const descendants: number[] = [];
  const visit = (parentPid: number): void => {
    for (const childPid of children.get(parentPid) ?? []) {
      descendants.push(childPid);
      visit(childPid);
    }
  };
  visit(rootPid);
  return descendants.reverse();
}

function killProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited while the process tree was collected.
  }
}

async function stopServer(server: Bun.Subprocess): Promise<void> {
  const descendants = await processTree(server.pid);
  for (const pid of descendants) killProcess(pid, "SIGTERM");
  killProcess(server.pid, "SIGTERM");
  await Promise.race([server.exited, Bun.sleep(1_000)]);
  for (const pid of descendants) killProcess(pid, "SIGKILL");
  killProcess(server.pid, "SIGKILL");
  await server.exited;
}

async function takeScreenshots(tokenUrl: string, cwd: string): Promise<void> {
  const origin = new URL(tokenUrl).origin;
  const fixtureUrl = `${origin}/?fixture`;
  const result = await runPlaywright(
    [
      "run-code",
      `async page => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const externalRequests = [];
        const pageErrors = [];
        const isLoopback = value => /^(https?|ws):\\/\\/127\\.0\\.0\\.1(?::[0-9]+)?(?:\\/|$)/.test(value);
        page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
        page.on("websocket", socket => {
          if (!isLoopback(socket.url())) externalRequests.push("websocket " + socket.url());
        });
        await page.route("**/*", async route => {
          const request = route.request();
          if (!isLoopback(request.url())) {
            externalRequests.push(request.method() + " " + request.url());
            await route.abort();
            return;
          }
          await route.continue();
        });
        await page.goto(${JSON.stringify(tokenUrl)});
        await page.goto(${JSON.stringify(fixtureUrl)}, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
          for (const dialog of document.querySelectorAll('[role="dialog"]')) {
            if (!dialog.textContent?.includes("Internal Testing Notice")) continue;
            // The stock Modal wraps the panel and its pointer-catching mask in
            // one [role=presentation] root; remove that, not the app tree.
            const modalRoot = dialog.closest('[role="presentation"]');
            (modalRoot ?? dialog).remove();
          }
        });
        // A real click is not actionable here (the modal's React state keeps
        // pointer blockers alive after DOM removal), so synthesize the click
        // React's delegated listener picks up.
        const clicked = await page.evaluate(() => {
          const row = [...document.querySelectorAll(".session-list-row")]
            .find((candidate) => candidate.textContent?.includes("Fixture 历史会话"));
          if (!row) return false;
          row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        });
        if (!clicked) {
          throw new Error("fixture history row not found in the session list");
        }
        await page.waitForTimeout(1000);
        // The fixture seeds a multi-step pending-question card followed by a
        // permission-approval card; dismiss every step so the shot shows the
        // composer instead of the pending overlays.
        for (let step = 0; step < 8; step += 1) {
          const dismissed = await page.evaluate(() => {
            const button = [...document.querySelectorAll("button")]
              .find((candidate) => {
                const label = candidate.textContent ?? "";
                return label.includes("Skip this question") || label === "Reject";
              });
            if (!button) return false;
            button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return true;
          });
          if (!dismissed) break;
          await page.waitForTimeout(400);
        }
        if (externalRequests.length > 0) {
          throw new Error("external network activity detected: " + externalRequests.join("; "));
        }
        if (pageErrors.length > 0) {
          throw new Error("page errors detected: " + pageErrors.join("; "));
        }
        const transcriptVisible = await page.getByText("用户字面量").first().isVisible().catch(() => false);
        if (!transcriptVisible) {
          throw new Error("fixture transcript did not render after opening the history session");
        }
        const title = await page.title();
        if (!title.includes("Fixture 历史会话")) {
          throw new Error("browser title does not reflect the open session: " + title);
        }
        await page.evaluate(() => document.body.setAttribute("data-ds-dark-theme", ""));
        await page.screenshot({ path: "dist/web-fixture.png", fullPage: true });
        return { title, url: page.url() };
      }`,
    ],
    cwd,
  );
  console.log(`web screenshots written: ${screenshotNames.join(", ")} (${result})`);
}

async function main(): Promise<void> {
  const cwd = import.meta.dir;
  const tempDir = await mkdtemp(join(tmpdir(), "dsh-web-shot-"));
  const logPath = join(tempDir, "dsh-web.log");
  let server: Bun.Subprocess | undefined;
  let browserStarted = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (browserStarted) await runPlaywright(["close"], cwd).catch(() => {});
      if (server) await stopServer(server);
      await rm(tempDir, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  const requestShutdown = (exitCode: number): void => {
    void cleanup().finally(() => process.exit(exitCode));
  };
  const handleInterrupt = (): void => requestShutdown(130);
  const handleTermination = (): void => requestShutdown(143);
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);

  try {
    server = Bun.spawn(["setsid", "script", "-qfec", "dsh web --no-open --port 0", logPath], {
      cwd: tempDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    let serverExited = false;
    void server.exited.then(() => {
      serverExited = true;
    });

    const tokenUrl = await waitForTokenUrl(logPath, () => serverExited);
    browserStarted = true;
    await runPlaywright(["open", "--browser=chromium", "about:blank"], cwd);
    await takeScreenshots(tokenUrl, cwd);
    for (const name of screenshotNames) {
      if (!(await Bun.file(join(cwd, "dist", name)).exists())) {
        throw new Error(`screenshot was not written: dist/${name}`);
      }
    }
  } finally {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTermination);
    await cleanup();
  }
}

await main();
