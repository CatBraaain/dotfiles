import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";

const MAIN = join(import.meta.dir, "main.ts");
const PI_PREFIX = ["-p", "--no-session", "--no-tools", "--agent", "junior", "--"];
const FAKE_PI = `#!/bin/bash
if [ -n "\${FAKE_PI_STDIN:-}" ]; then /bin/cat; fi
printf '%s\\0' "$@"
exit "\${FAKE_PI_EXIT:-0}"
`;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function fakePiDirectory(): string {
  const directory = temporaryDirectory("pi-shot-path-");
  const path = join(directory, "pi");
  writeFileSync(path, FAKE_PI);
  chmodSync(path, 0o755);
  return directory;
}

async function shot(
  args: string[],
  environment: Record<string, string>,
  stdin = "",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: dirname(MAIN),
    env:
      process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, ...environment }
        : environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(stdin);
  child.stdin.flush();
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(process.platform !== "win32")("run on Windows", () => {
  it("invokes pi.exe and passes the Pi exit code and original arguments", async () => {
    const node = Bun.which("node.exe");
    assert.ok(node, "Node.js is required for Windows launch tests");
    const home = temporaryDirectory("pi-shot-windows-");
    const bin = join(home, "npm install");
    mkdirSync(bin);
    installPiLauncher(bin);
    const packageDirectory = join(bin, "node_modules", "@earendil-works", "pi-coding-agent");
    const entry = join(packageDirectory, "nested", "pi entry.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        bin: { pi: "nested/pi entry.js" },
      }),
    );
    writeFileSync(
      entry,
      "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(37);",
    );
    const args = ["two words", "日本語", "-leading", 'a"b', "", "C:\\path with space\\"];

    const result = await shot(args, { PATH: `${bin};${dirname(node)}`, USERPROFILE: home });

    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 37);
    assert.deepEqual(JSON.parse(result.stdout), [...PI_PREFIX, ...args]);
  }, 30_000);

  it("returns 127 when only the npm shims are on PATH", async () => {
    const home = temporaryDirectory("pi-shot-no-exe-");
    writeFileSync(join(home, "pi.cmd"), "@exit /b 23\r\n");
    writeFileSync(join(home, "pi.ps1"), "exit 23\r\n");

    const result = await shot(["prompt"], { PATH: home, USERPROFILE: home });

    assert.equal(result.exitCode, 127);
    assert.match(result.stderr, /pi\.exe is not on PATH/);
  });
});

function installPiLauncher(bin: string): void {
  const target = join(bin, "pi.exe");
  const binary = process.env.WINDOWS_PI_BIN;
  if (binary) {
    copyFileSync(binary, target);
    return;
  }
  const source = join(import.meta.dir, "../../../../../undotfiles/install/windows-pi.ts");
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      source,
      "--outfile",
      target,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
      timeout: 20_000,
    },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
}

describe.skipIf(process.platform === "win32")("run on POSIX", () => {
  it("passes the pi arguments and the user arguments after --", async () => {
    const args = ["line1\nline2", 'He said "hi"', "--help", ""];

    const result = await shot(args, { PATH: fakePiDirectory() });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, [...PI_PREFIX, ...args].join("\0") + "\0");
  });

  it("returns the exit code of pi", async () => {
    const result = await shot(["prompt"], { PATH: fakePiDirectory(), FAKE_PI_EXIT: "7" });

    assert.equal(result.exitCode, 7);
  });

  it("returns 127 when pi is not on PATH", async () => {
    const result = await shot(["prompt"], { PATH: temporaryDirectory("pi-shot-empty-") });

    assert.equal(result.exitCode, 127);
    assert.match(result.stderr, /pi is not on PATH/);
  });

  it("hands stdin to pi", async () => {
    const result = await shot(
      ["prompt"],
      { PATH: fakePiDirectory(), FAKE_PI_STDIN: "1" },
      "stdin payload\n",
    );

    assert.equal(result.stdout, "stdin payload\n" + [...PI_PREFIX, "prompt"].join("\0") + "\0");
  });
});
