import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";
const posixTest = test.skipIf(isWindows);
const windowsTest = test.skipIf(!isWindows);
const CLEAN_EXIT = { exitCode: 0, stdout: "", stderr: "" };
const UPDATE_TASK_ARG = "update";
const UPDATE_LOCK_PIPE = "\\\\.\\pipe\\pi-update";
const LOG_ARGS = 'printf "%s\\n" "$@" >> "$PROBE_LOG"\n';
const STUB_MAX_WAIT_SECONDS = 30;
const STARTUP_PROCESS_TIMEOUT_MS = 5000;
const STARTUP_TEST_TIMEOUT_MS = 10_000;
const WINDOWS_UPDATE_TEST_TIMEOUT_MS = 30_000;

let windowsStubDir: string | undefined;

if (isWindows) {
  beforeAll(async () => {
    windowsStubDir = mkdtempSync(join(tmpdir(), "startup-windows-stubs-"));
    const source = join(windowsStubDir, "log-args.ts");
    mkdirSync(join(windowsStubDir, "dist"));
    writeFileSync(
      source,
      'import { appendFileSync } from "node:fs";\n' +
        'appendFileSync(process.env.PROBE_LOG!, process.argv.slice(2).join("\\n") + "\\n");\n',
    );
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        source,
        "--outfile",
        windowsStubPath(windowsStubDir),
      ],
      { cwd: windowsStubDir, stdout: "ignore", stderr: "pipe", timeout: 20_000 },
    );
    const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    assert.equal(exitCode, 0, stderr);
  }, 25_000);

  afterAll(() => {
    if (windowsStubDir) removeTestDirectory(windowsStubDir);
  });
}

const cases = [
  { status: 200, launches: false, label: "skips openserp when /ready returns 200" },
  { status: 299, launches: false, label: "skips openserp when /ready returns 299" },
  { status: 300, launches: true, label: "launches openserp when /ready returns 300" },
  {
    status: 302,
    launches: true,
    label: "launches openserp when /ready returns 302 without following the redirect",
  },
  { status: 404, launches: true, label: "launches openserp when /ready returns 404" },
  { status: 503, launches: true, label: "launches openserp when /ready returns 503" },
];

for (const { status, launches, label } of cases) {
  test(
    label,
    async () => {
      const home = mkdtempSync(join(tmpdir(), "startup-health-"));
      const bin = join(home, "bin");
      const spawnLog = join(home, "spawn.log");
      mkdirSync(bin, { recursive: true });
      installArgvStub(join(bin, "openserp"));

      const requests: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const pathname = new URL(request.url).pathname;
          requests.push(pathname);
          return new Response(null, {
            status: pathname === "/ready" ? status : 200,
            headers: { Location: "/ready-target" },
          });
        },
      });

      try {
        const result = await runScript({
          HOME: home,
          PATH: bin,
          TMPDIR: home,
          OPENSERP_BASE_URL: `http://127.0.0.1:${server.port}`,
          PROBE_LOG: spawnLog,
        });
        assert.deepEqual(result, CLEAN_EXIT);
        assert.deepEqual(requests, ["/ready"]);

        if (!launches) {
          await assertNothingLogged(spawnLog);
          return;
        }

        const expectedArgs = ["serve", "-a", "127.0.0.1", "-p", String(server.port), "--quiet"];
        const stubArgs = await waitForLogLines(spawnLog, expectedArgs.length);
        assert.deepEqual(stubArgs, expectedArgs);
      } finally {
        server.stop(true);
        removeTestDirectory(home);
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );
}

function getStartupCommand(args: string[]): string[] {
  if (process.env.STARTUP_BIN) return [process.env.STARTUP_BIN, ...args];
  return [process.execPath, join(import.meta.dir, "main.ts"), ...args];
}

function writeBrowseStub(home: string): void {
  const cliDir = join(home, ".agents", "cli");
  mkdirSync(cliDir, { recursive: true });
  installArgvStub(join(cliDir, "browse"));
}

async function runScript(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(getStartupCommand(args), {
    cwd: env.HOME,
    env: {
      ...(isWindows ? { SystemRoot: process.env.SystemRoot, USERPROFILE: env.HOME } : {}),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: STARTUP_PROCESS_TIMEOUT_MS,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test(
  "launches browse server start when the camoufox port is closed",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "startup-camoufox-"));
    const spawnLog = join(home, "spawn.log");
    writeBrowseStub(home);

    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const camoufoxPort = probe.port;
    probe.stop(true);

    try {
      const result = await runScript({
        HOME: home,
        PATH: home,
        TMPDIR: home,
        XDG_CACHE_HOME: home,
        CAMOUFOX_BASE_URL: `ws://127.0.0.1:${camoufoxPort}/camoufox`,
        PROBE_LOG: spawnLog,
      });
      assert.deepEqual(result, CLEAN_EXIT);
      assert.deepEqual(await waitForLogLines(spawnLog, 2), ["server", "start"]);
    } finally {
      removeTestDirectory(home);
    }
  },
  STARTUP_TEST_TIMEOUT_MS,
);

test(
  "skips browse server start when the camoufox port is open",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "startup-camoufox-"));
    const spawnLog = join(home, "spawn.log");
    writeBrowseStub(home);

    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });

    try {
      const result = await runScript({
        HOME: home,
        PATH: home,
        TMPDIR: home,
        XDG_CACHE_HOME: home,
        CAMOUFOX_BASE_URL: `ws://127.0.0.1:${server.port}/camoufox`,
        PROBE_LOG: spawnLog,
      });
      assert.deepEqual(result, CLEAN_EXIT);
      await assertNothingLogged(spawnLog);
    } finally {
      server.stop(true);
      removeTestDirectory(home);
    }
  },
  STARTUP_TEST_TIMEOUT_MS,
);

posixTest("runs flock -n <lock> pi update --all when flock is available", async () => {
  const fixture = createShStubHome({ pi: LOG_ARGS, flock: LOG_ARGS });
  try {
    assert.deepEqual(await runScript(fixture.env), CLEAN_EXIT);

    const [lockOption, lockPath, piPath, ...updateArgs] = await waitForLogLines(
      fixture.spawnLog,
      5,
    );
    assert.ok(lockPath, "flock receives a lock path");
    assert.deepEqual(
      [lockOption, piPath, ...updateArgs],
      ["-n", join(fixture.bin, "pi"), "update", "--all"],
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

posixTest("skips pi update when flock is unavailable", async () => {
  const fixture = createShStubHome({ pi: LOG_ARGS });
  try {
    assert.deepEqual(await runScript(fixture.env), CLEAN_EXIT);
    await assertNothingLogged(fixture.spawnLog);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

posixTest("skips pi update when pi is unavailable", async () => {
  const fixture = createShStubHome({ flock: LOG_ARGS });
  try {
    assert.deepEqual(await runScript(fixture.env), CLEAN_EXIT);
    await assertNothingLogged(fixture.spawnLog);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

posixTest("does not run pi update for the update argument outside windows", async () => {
  const fixture = createShStubHome({ pi: LOG_ARGS, flock: LOG_ARGS });
  try {
    assert.deepEqual(await runScript(fixture.env, [UPDATE_TASK_ARG]), CLEAN_EXIT);
    await assertNothingLogged(fixture.spawnLog);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

windowsTest(
  "runs only one pi update while the pipe is held even with flock.exe on PATH",
  async () => {
    const fixture = createPiUpdateFixture();
    try {
      const flockPath = installArgvStub(join(fixture.env.PATH, "flock"));
      assert.equal(Bun.which("flock", { PATH: fixture.env.PATH }), flockPath);
      await waitForUpdateLockReleased();

      assert.deepEqual(await runScript(fixture.env), CLEAN_EXIT);
      assert.deepEqual(await waitForLogLines(fixture.spawnLog, 1), ["update --all"]);

      const contenders = await Promise.all([
        runScript(fixture.env, [UPDATE_TASK_ARG]),
        runScript(fixture.env, [UPDATE_TASK_ARG]),
      ]);
      assert.deepEqual(contenders, [CLEAN_EXIT, CLEAN_EXIT]);
      assert.equal(await tryListen(UPDATE_LOCK_PIPE), false, "the first update is still running");
      assert.deepEqual(readLogLines(fixture.spawnLog), ["update --all"]);
    } finally {
      writeFileSync(fixture.releaseFile, "");
      await waitForUpdateLockReleased();
      removeTestDirectory(fixture.home);
    }
  },
  WINDOWS_UPDATE_TEST_TIMEOUT_MS,
);

windowsTest(
  "runs pi update --all again after the previous update exited",
  async () => {
    const fixture = createPiUpdateFixture();
    try {
      await waitForUpdateLockReleased();
      assert.deepEqual(await runScript(fixture.env), CLEAN_EXIT);
      await waitForLogLines(fixture.spawnLog, 1);
      writeFileSync(fixture.releaseFile, "");
      await waitForUpdateLockReleased();

      assert.deepEqual(await runScript(fixture.env), CLEAN_EXIT);
      assert.deepEqual(await waitForLogLines(fixture.spawnLog, 2), [
        "update --all",
        "update --all",
      ]);
    } finally {
      writeFileSync(fixture.releaseFile, "");
      await waitForUpdateLockReleased();
      removeTestDirectory(fixture.home);
    }
  },
  WINDOWS_UPDATE_TEST_TIMEOUT_MS,
);

function createShStubHome(stubs: Record<string, string>): {
  home: string;
  bin: string;
  env: Record<string, string>;
  spawnLog: string;
} {
  const home = mkdtempSync(join(tmpdir(), "startup-update-"));
  const bin = join(home, "bin");
  const spawnLog = join(home, "spawn.log");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(stubs)) {
    writeShStub(join(bin, name), body);
  }
  return {
    home,
    bin,
    env: { HOME: home, PATH: bin, TMPDIR: home, PROBE_LOG: spawnLog },
    spawnLog,
  };
}

function writeShStub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

function installArgvStub(path: string): string {
  if (!isWindows) {
    writeShStub(path, LOG_ARGS);
    return path;
  }

  assert.ok(windowsStubDir);
  const exePath = `${path}.exe`;
  linkSync(windowsStubPath(windowsStubDir), exePath);
  return exePath;
}

function windowsStubPath(dir: string): string {
  return join(dir, "dist", "log-args.exe");
}

function removeTestDirectory(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

function createPiUpdateFixture(): {
  home: string;
  env: { HOME: string; PATH: string; PROBE_LOG: string; PROBE_RELEASE: string };
  spawnLog: string;
  releaseFile: string;
} {
  const home = mkdtempSync(join(tmpdir(), "startup-update-"));
  const bin = join(home, "bin");
  const spawnLog = join(home, "spawn.log");
  const releaseFile = join(home, "release");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "pi.cmd"),
    [
      "@echo off",
      '>>"%PROBE_LOG%" echo %*',
      "set /a waitedSeconds=0",
      ":waiting",
      'if exist "%PROBE_RELEASE%" goto released',
      `if %waitedSeconds% GEQ ${STUB_MAX_WAIT_SECONDS} goto released`,
      '"%SystemRoot%\\System32\\ping.exe" -n 2 127.0.0.1 >nul',
      "set /a waitedSeconds+=1",
      "goto waiting",
      ":released",
      "",
    ].join("\r\n"),
  );

  return {
    home,
    env: { HOME: home, PATH: bin, PROBE_LOG: spawnLog, PROBE_RELEASE: releaseFile },
    spawnLog,
    releaseFile,
  };
}

async function assertNothingLogged(spawnLog: string): Promise<void> {
  await Bun.sleep(150);
  assert.equal(existsSync(spawnLog), false);
}

function readLogLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean) : [];
}

async function waitForLogLines(path: string, count: number): Promise<string[]> {
  await waitFor(
    () => readLogLines(path).length >= count,
    5000,
    `expected at least ${count} lines in ${path}`,
  );
  return readLogLines(path);
}

async function waitForUpdateLockReleased(): Promise<void> {
  const deadline = Date.now() + 10000;
  let isReleased = false;
  while (!isReleased && Date.now() < deadline) {
    isReleased = await tryListen(UPDATE_LOCK_PIPE);
    if (!isReleased) await Bun.sleep(50);
  }
  assert.ok(isReleased, "update lock was not released");
}

function tryListen(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer((socket) => socket.destroy());
    probe.once("error", () => resolve(false));
    probe.listen(address, () => probe.close(() => resolve(true)));
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  assert.ok(condition(), message);
}
