import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function getStartupCommand(args: string[]): string[] {
  if (process.env.STARTUP_BIN) return [process.env.STARTUP_BIN, ...args];
  return [process.execPath, join(import.meta.dir, "main.ts"), ...args];
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
  test(label, async () => {
    const home = mkdtempSync(join(tmpdir(), "startup-health-"));
    const bin = join(home, "bin");
    const spawnLog = join(home, "spawn.log");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "openserp");
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$PROBE_LOG"\n');
    chmodSync(stub, 0o755);

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
      const child = Bun.spawn(getStartupCommand([]), {
        cwd: home,
        env: {
          HOME: home,
          PATH: bin,
          TMPDIR: home,
          XDG_CACHE_HOME: home,
          OPENSERP_BASE_URL: `http://127.0.0.1:${server.port}`,
          PROBE_LOG: spawnLog,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(exitCode, 0);
      assert.equal(stdout, "");
      assert.equal(stderr, "");

      if (launches) {
        await waitForFile(spawnLog, 2000);
      } else {
        await Bun.sleep(150);
      }

      assert.deepEqual(requests, ["/ready"]);
      assert.equal(existsSync(spawnLog), launches);
      if (launches) {
        const stubArgs = readFileSync(spawnLog, "utf8").trim().split("\n");
        assert.deepEqual(stubArgs, [
          "serve",
          "-a",
          "127.0.0.1",
          "-p",
          String(server.port),
          "--quiet",
        ]);
      }
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });
}

function writeBrowseStub(home: string): void {
  const cliDir = join(home, ".agents", "cli");
  mkdirSync(cliDir, { recursive: true });
  const stub = join(cliDir, "browse");
  writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$PROBE_LOG"\n');
  chmodSync(stub, 0o755);
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
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("launches browse server start when the camoufox port is closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "startup-camoufox-"));
  const spawnLog = join(home, "spawn.log");
  writeBrowseStub(home);

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const camoufoxPort = probe.port;
  probe.stop(true);

  try {
    const { exitCode, stdout, stderr } = await runScript({
      HOME: home,
      PATH: home,
      TMPDIR: home,
      XDG_CACHE_HOME: home,
      CAMOUFOX_BASE_URL: `ws://127.0.0.1:${camoufoxPort}/camoufox`,
      PROBE_LOG: spawnLog,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");

    await waitForFile(spawnLog, 2000);
    const stubArgs = readFileSync(spawnLog, "utf8").trim().split("\n");
    assert.deepEqual(stubArgs, ["server", "start"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skips browse server start when the camoufox port is open", async () => {
  const home = mkdtempSync(join(tmpdir(), "startup-camoufox-"));
  const spawnLog = join(home, "spawn.log");
  writeBrowseStub(home);

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });

  try {
    const { exitCode, stdout, stderr } = await runScript({
      HOME: home,
      PATH: home,
      TMPDIR: home,
      XDG_CACHE_HOME: home,
      CAMOUFOX_BASE_URL: `ws://127.0.0.1:${server.port}/camoufox`,
      PROBE_LOG: spawnLog,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");

    await Bun.sleep(150);
    assert.equal(existsSync(spawnLog), false);
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

const isWindows = process.platform === "win32";
const posixTest = test.skipIf(isWindows);
const windowsTest = test.skipIf(!isWindows);
const CLEAN_EXIT = { exitCode: 0, stdout: "", stderr: "" };
const UPDATE_TASK_ARG = "update";
const UPDATE_LOCK_PIPE = "\\\\.\\pipe\\pi-update";
const LOG_ARGS = 'printf "%s\\n" "$@" >> "$PROBE_LOG"\n';
const CONCURRENT_HOLDER_SETTLE_MS = 1500;
const STUB_MAX_WAIT_SECONDS = 30;
const WINDOWS_TEST_TIMEOUT_MS = 20_000;

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
  "runs pi update --all once when pi starts concurrently without flock",
  async () => {
    const fixture = createPiUpdateFixture();
    try {
      await waitForUpdateLockReleased();
      const results = await Promise.all([
        runScript(fixture.env),
        runScript(fixture.env),
        runScript(fixture.env),
      ]);
      for (const result of results) {
        assert.deepEqual(result, CLEAN_EXIT);
      }

      await waitForLogLines(fixture.spawnLog, 1);
      await Bun.sleep(CONCURRENT_HOLDER_SETTLE_MS);
      assert.equal(await tryListen(UPDATE_LOCK_PIPE), false, "the first update is still running");
      assert.deepEqual(readLogLines(fixture.spawnLog), ["update --all"]);
    } finally {
      writeFileSync(fixture.releaseFile, "");
      await waitForUpdateLockReleased();
      rmSync(fixture.home, { recursive: true, force: true });
    }
  },
  WINDOWS_TEST_TIMEOUT_MS,
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
      await waitForUpdateLockReleased();
      rmSync(fixture.home, { recursive: true, force: true });
    }
  },
  WINDOWS_TEST_TIMEOUT_MS,
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

function createPiUpdateFixture(): {
  home: string;
  env: Record<string, string>;
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

  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  return {
    home,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      PATH: bin,
      PROBE_LOG: spawnLog,
      PROBE_RELEASE: releaseFile,
    },
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

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  await waitFor(
    () => existsSync(path),
    timeoutMs,
    `file not created within ${timeoutMs}ms: ${path}`,
  );
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
