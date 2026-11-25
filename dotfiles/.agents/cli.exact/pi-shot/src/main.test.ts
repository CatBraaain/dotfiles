import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { npmPiEntry, piCommand, run } from "./main";

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

function knownPaths(paths: Record<string, string>): (name: string) => string | undefined {
  return (name) => paths[name];
}

async function shot(
  args: string[],
  environment: Record<string, string>,
  stdin = "",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: dirname(MAIN),
    env: environment,
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

describe("piCommand", () => {
  it("starts pi from PATH outside Windows", () => {
    const which = knownPaths({ pi: "/tools/pi" });

    assert.deepEqual(piCommand("linux", which), ["/tools/pi"]);
  });

  it("prefers pi.exe from PATH on Windows", () => {
    const which = knownPaths({
      "pi.exe": "C:\\bin\\pi.exe",
      "pi.cmd": "C:\\npm\\pi.cmd",
      "node.exe": "C:\\node\\node.exe",
    });

    assert.deepEqual(piCommand("win32", which), ["C:\\bin\\pi.exe"]);
  });

  it("starts the npm-installed pi through node on Windows", () => {
    const npmDirectory = join(temporaryDirectory("pi-shot-npm-"), "npm");
    const packageDirectory = join(
      npmDirectory,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    mkdirSync(join(packageDirectory, "dist", "bundle"), { recursive: true });
    writeFileSync(
      join(packageDirectory, "package.json"),
      JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } }),
    );
    const shim = join(npmDirectory, "pi.cmd");
    writeFileSync(shim, "");
    const which = knownPaths({ "pi.cmd": shim, "node.exe": "C:\\node\\node.exe" });

    assert.deepEqual(piCommand("win32", which), [
      "C:\\node\\node.exe",
      join(packageDirectory, "dist", "bundle", "cli.js"),
    ]);
  });

  it("rejects an npm package whose manifest has no bin.pi", () => {
    const npmDirectory = temporaryDirectory("pi-shot-npm-");
    const packageDirectory = join(
      npmDirectory,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ bin: {} }));

    assert.throws(() => npmPiEntry(join(npmDirectory, "pi.cmd")), /has no bin\.pi/);
  });
});

describe("run", () => {
  it("returns 127 when PATH has neither pi.exe nor the npm shim on Windows", async () => {
    const stderr: string[] = [];

    const exitCode = await run(["prompt"], {
      platform: "win32",
      which: () => undefined,
      stderr: (text) => stderr.push(text),
    });

    assert.equal(exitCode, 127);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0] ?? "", /pi is not on PATH/);
  });
});

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
