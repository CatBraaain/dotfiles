import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const readinessTimeoutMs = 60_000;
const playwrightSession = `dsh-web-smoke-${process.pid}`;
const tokenUrlPattern = /http:\/\/127\.0\.0\.1:[0-9]+\/\?token=[A-Za-z0-9_-]+/;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(command: readonly string[], cwd: string): Promise<CommandResult> {
  const process = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode: await process.exited, stdout, stderr };
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
    const log = await Bun.file(logPath)
      .text()
      .catch(() => "");
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
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
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

interface BrowserErrors {
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
}

async function assertNoBrowserErrors(cwd: string, tokenUrl: string): Promise<BrowserErrors> {
  const output = await runPlaywright(
    [
      "run-code",
      `async page => { const consoleErrors = []; const pageErrors = []; page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); }); page.on("pageerror", error => pageErrors.push(error.stack ?? error.message)); await page.goto(${JSON.stringify(tokenUrl)}); await page.waitForTimeout(1000); await page.reload(); await page.waitForTimeout(1000); return { consoleErrors, pageErrors }; }`,
    ],
    cwd,
  );
  let browserErrors: unknown;
  try {
    browserErrors = JSON.parse(output);
  } catch {
    throw new Error(`could not read browser errors:\n${redactToken(output)}`);
  }
  if (!browserErrors || typeof browserErrors !== "object") {
    throw new Error(`could not read browser errors:\n${redactToken(output)}`);
  }
  const { consoleErrors, pageErrors } = browserErrors as Partial<BrowserErrors>;
  if (!Array.isArray(consoleErrors) || !Array.isArray(pageErrors)) {
    throw new Error(`could not read browser errors:\n${redactToken(output)}`);
  }
  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(
      `browser errors detected:\n${redactToken([...consoleErrors, ...pageErrors].join("\n"))}`,
    );
  }
  return { consoleErrors, pageErrors };
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "dsh-web-smoke-"));
  const logPath = join(tempDir, "dsh-web.log");
  let server: Bun.Subprocess | undefined;
  let browserStarted = false;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (browserStarted) await runPlaywright(["close"], tempDir).catch(() => {});
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
    await runPlaywright(["open", "--browser=chromium", "about:blank"], tempDir);
    await Bun.sleep(1_000);
    const browserErrors = await assertNoBrowserErrors(tempDir, tokenUrl);
    console.log(
      `dsh web smoke test passed: console errors ${browserErrors.consoleErrors.length}, page errors ${browserErrors.pageErrors.length}`,
    );
  } finally {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTermination);
    await cleanup();
  }
}

await main();
