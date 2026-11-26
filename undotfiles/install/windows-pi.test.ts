import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PI_PACKAGE } from "./windows-pi.ts";

describe.skipIf(process.platform !== "win32")("Windows Pi launcher", () => {
  let root: string;
  let prefix: string;
  let node: string;
  let binary: string;

  beforeAll(() => {
    const installedNode = Bun.which("node.exe");
    assert.ok(installedNode, "Node.js is required for Windows launch tests");
    node = installedNode;
    root = mkdtempSync(join(tmpdir(), "windows-pi-"));
    prefix = join(root, "npm global prefix");
    mkdirSync(prefix);
    binary = join(prefix, "pi.exe");
    const supplied = process.env.WINDOWS_PI_BIN;
    if (supplied) {
      copyFileSync(supplied, binary);
      return;
    }
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        join(import.meta.dir, "windows-pi.ts"),
        "--outfile",
        binary,
      ],
      { stdout: "ignore", stderr: "pipe", timeout: 20_000 },
    );
    assert.equal(build.exitCode, 0, build.stderr.toString());
  }, 25_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function writePackage(entry: string): string {
    const directory = join(prefix, "node_modules", PI_PACKAGE);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: PI_PACKAGE, bin: { pi: entry } }),
    );
    return join(directory, entry);
  }

  function launch(args: string[] = []) {
    return Bun.spawnSync([binary, ...args], {
      cwd: root,
      env: { SystemRoot: process.env.SystemRoot, PATH: dirname(node), PROBE_VALUE: "inherited" },
      stdin: Buffer.from("stdin data"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
  }

  it("reports a missing npm package and does not run a shim", () => {
    rmSync(join(prefix, "node_modules", PI_PACKAGE, "package.json"), { force: true });
    writeFileSync(join(prefix, "pi.cmd"), "@exit /b 23\r\n");
    writeFileSync(join(prefix, "pi.ps1"), "exit 23\r\n");
    const result = launch();
    assert.equal(result.exitCode, 127);
    assert.match(result.stderr.toString(), /Cannot find .*package\.json/);
  });

  it("uses the current bin.pi and preserves args, working directory, env, stdio and exit code", () => {
    const original = writePackage("old.js");
    writeFileSync(original, "process.stdout.write('old');");
    assert.equal(launch().stdout.toString(), "old");

    const updated = writePackage("next version/entry.js");
    mkdirSync(dirname(updated), { recursive: true });
    writeFileSync(
      updated,
      `const { readFileSync } = require('node:fs');
process.stdout.write(JSON.stringify([process.argv.slice(2), process.cwd(), process.env.PROBE_VALUE, readFileSync(0, 'utf8')]));
process.stderr.write('diagnostic');
process.exitCode = 37;
`,
    );
    const args = [
      "two words",
      'a"b',
      "",
      "C:\\path with space\\",
      "日本語",
      "a & b %CD% | c",
      "line1\nline2",
    ];
    const result = launch(args);
    assert.equal(result.exitCode, 37, result.stderr.toString());
    assert.deepEqual(JSON.parse(result.stdout.toString()), [args, root, "inherited", "stdin data"]);
    assert.equal(result.stderr.toString(), "diagnostic");
  });

  it("does not run an entry outside the installed package", () => {
    const outside = writePackage("../outside.js");
    writeFileSync(outside, "process.exit(23);");
    const result = launch();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr.toString(), /Pi entry is outside its package/);
  });
});
