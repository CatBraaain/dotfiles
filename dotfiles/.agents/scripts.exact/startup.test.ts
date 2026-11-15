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
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptDir = import.meta.dir;
const scriptPath = existsSync(join(scriptDir, "startup.executable"))
  ? join(scriptDir, "startup.executable")
  : join(scriptDir, "startup");

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
      const child = Bun.spawn([process.execPath, scriptPath], {
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

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  assert.ok(existsSync(path), `file not created within ${timeoutMs}ms: ${path}`);
}
