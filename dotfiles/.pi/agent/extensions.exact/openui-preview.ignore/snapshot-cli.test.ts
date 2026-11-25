import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, it, mock, spyOn } from "bun:test";
import { chromium } from "playwright-core";
import { displayLibrary } from "./library.data";
import {
  buildBrowserBundle,
  captureSnapshot,
  resolveChromiumExecutable,
  runSnapshot,
  SnapshotCleanupError,
} from "./snapshot-cli";
import type { SnapshotInput } from "./snapshot";

let workDir: string;
beforeAll(() => {
  mkdirSync("/tmp/work/dotfiles/openui-preview-tests", { recursive: true });
  workDir = mkdtempSync("/tmp/work/dotfiles/openui-preview-tests/cli-");
  writeFileSync(join(workDir, "spec.json"), JSON.stringify(displayLibrary.toSpec()));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});
afterEach(() => mock.restore());
function input(source = 'root = Stack([TextContent("hello")])'): SnapshotInput {
  return {
    source,
    generatedDir: workDir,
    pngPath: join(workDir, "snapshot.png"),
    deadline: Date.now() + 15_000,
  };
}

describe("snapshot CLI", () => {
  function controlledInput(): { directory: string; path: string } {
    const directory = mkdtempSync(join(workDir, "control-"));
    const path = join(directory, "input.json");
    writeFileSync(path, JSON.stringify(input()));
    mkdirSync(join(directory, "pending"));
    return { directory, path };
  }

  it("does not recreate a revoked startup directory", async () => {
    const { directory, path } = controlledInput();
    renameSync(join(directory, "pending"), join(directory, "cancelled"));
    rmSync(directory, { recursive: true });
    let calls = 0;
    await assert.rejects(
      runSnapshot(path, async () => {
        calls += 1;
      }),
      /ENOENT/,
    );
    assert.equal(calls, 0);
    assert.equal(existsSync(directory), false);
  });

  it("writes completion only after capture cleanup finishes", async () => {
    const { directory, path } = controlledInput();
    await runSnapshot(path, async () => {
      assert.equal(existsSync(join(directory, "finished.json")), false);
    });
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "finished.json"), "utf8")), {
      ok: true,
    });
  });

  it("honors cancellation before capture begins", async () => {
    const { directory, path } = controlledInput();
    writeFileSync(join(directory, "cancel"), "");
    let calls = 0;
    await assert.rejects(
      runSnapshot(path, async () => {
        calls += 1;
      }),
      /interrupted/,
    );
    assert.equal(calls, 0);
    assert.equal(JSON.parse(readFileSync(join(directory, "finished.json"), "utf8")).ok, false);
  });

  it("does not acknowledge cleanup when browser cleanup fails", async () => {
    const { directory, path } = controlledInput();
    await assert.rejects(
      runSnapshot(path, async () => {
        throw new SnapshotCleanupError("close failed");
      }),
      /close failed/,
    );
    assert.equal(existsSync(join(directory, "finished.json")), false);
  });

  for (const mode of ["reject", "hang"] as const) {
    it(`kills the owned server before deleting temporary data when graceful close ${mode}s`, async () => {
      let browserTemp = "";
      let killed = false;
      spyOn(chromium, "launchServer").mockImplementation(async () => {
        browserTemp = process.env.TMPDIR!;
        return {
          wsEndpoint() {
            return "ws://127.0.0.1/fixture";
          },
          async close() {
            if (mode === "reject") throw new Error("close rejected");
            await new Promise(() => {});
          },
          async kill() {
            assert.equal(existsSync(browserTemp), true);
            killed = true;
          },
        } as never;
      });
      spyOn(chromium, "connect").mockImplementation(
        async () =>
          ({
            async newPage() {
              throw new Error("page failed");
            },
          }) as never,
      );
      await assert.rejects(
        captureSnapshot(input()),
        /browser close failed|before forced termination/,
      );
      assert.equal(killed, true);
      assert.equal(existsSync(browserTemp), false);
    });
  }

  it("stops an interrupted bundler before removing its directory", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("bundle interrupted")), 50);
    const before = new Set(readdirSync(tmpdir()));
    try {
      await assert.rejects(buildBrowserBundle(controller.signal), /bundle interrupted/);
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(
      readdirSync(tmpdir()).filter((name) => name.startsWith("bu-") && !before.has(name)),
      [],
    );
  });

  it("bundles local React components and upstream CSS without additional assets", async () => {
    const bundle = await buildBrowserBundle();
    assert.ok(bundle.javascript.length > 1_000);
    assert.match(bundle.css, /--openui-background/);
    assert.match(bundle.css, /openui-bar-chart/);
    assert.doesNotMatch(bundle.javascript, /import\s+.*\sfrom\s+["']/);
  });
  it("rejects unsupported DSL before launching a browser", async () => {
    await assert.rejects(
      captureSnapshot(input('root = Stack([Button("Go")])')),
      /display-only library/,
    );
  });
  it("honors the deadline before bundle generation", async () => {
    await assert.rejects(
      captureSnapshot({ ...input(), deadline: Date.now() - 1 }),
      /15-second deadline/,
    );
  });
  it("honors an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("test interruption"));
    await assert.rejects(captureSnapshot(input(), controller.signal), /test interruption/);
  });
  it("reports a missing standard-cache browser without fetching a substitute", async () => {
    spyOn(chromium, "executablePath").mockReturnValue(
      join(workDir, "empty-cache/chromium-0/chrome-linux64/chrome"),
    );
    const root = tmpdir();
    const before = new Set(readdirSync(root));
    const previousTemp = {
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
    };
    await assert.rejects(captureSnapshot(input()), /No existing Chromium executable/);
    const leaked = readdirSync(root).filter(
      (name) =>
        /^(playwright-artifacts-|playwright_chromiumdev_profile-|ob-)/.test(name) &&
        !before.has(name),
    );
    assert.deepEqual(leaked, []);
    assert.deepEqual(
      { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP },
      previousTemp,
    );
    assert.equal(existsSync(join(workDir, "snapshot.png")), false);
  });

  it("finds the newest executable in the same cache when the default revision is absent", async () => {
    const cache = join(workDir, "browser-cache");
    for (const revision of [9, 10, 11]) {
      const directory = join(cache, `chromium-${revision}`, "chrome-linux64");
      mkdirSync(directory, { recursive: true });
      const executable = join(directory, "chrome");
      writeFileSync(executable, "fixture");
      chmodSync(executable, revision === 11 ? 0o644 : 0o755);
    }
    mkdirSync(join(cache, "chromium-12", "chrome-linux64"), { recursive: true });
    const resolved = await resolveChromiumExecutable(
      join(cache, "chromium-1/chrome-linux64/chrome"),
    );
    assert.equal(resolved, join(cache, "chromium-10/chrome-linux64/chrome"));
  });
});
