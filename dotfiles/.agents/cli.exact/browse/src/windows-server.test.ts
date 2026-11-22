import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopWindowsServer } from "./windows-server";

async function withProcess(
  scriptName: string,
  args: string[],
  check: (child: Bun.Subprocess, serverScript: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "browse windows process-"));
  const script = join(root, scriptName);
  writeFileSync(script, "await Bun.sleep(30000);\n");
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await check(child, join(root, "browse.ts"));
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32")("Windows server process identity", () => {
  it("stops the matching server invocation with a spaced script path", async () => {
    await withProcess("browse.ts", ["__server"], async (child, script) => {
      stopWindowsServer(child.pid, [process.execPath, script, "__server"]);
      assert.equal(
        await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)]),
        true,
      );
    });
  }, 25_000);

  it("does not stop a different script running in the same runtime", async () => {
    await withProcess("other.ts", ["__server"], async (child, script) => {
      stopWindowsServer(child.pid, [process.execPath, script, "__server"]);
      assert.ok(process.kill(child.pid, 0));
    });
  }, 25_000);

  it("does not stop an invocation whose script path differs only by letter case", async () => {
    await withProcess("Browse.ts", ["__server"], async (child, script) => {
      stopWindowsServer(child.pid, [process.execPath, script, "__server"]);
      assert.ok(process.kill(child.pid, 0));
    });
  }, 25_000);

  it("does not stop the same script when __server is not the subcommand", async () => {
    await withProcess("browse.ts", ["search", "__server"], async (child, script) => {
      stopWindowsServer(child.pid, [process.execPath, script, "__server"]);
      assert.ok(process.kill(child.pid, 0));
    });
  }, 25_000);
});
