import { expect, test } from "playwright/test";
import type { ElectronApplication, TestInfo } from "playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provideVSCodeFixture, VSCodeFixture } from "./vscode";

for (const failure of ["attachment", "manifest", "snapshot"] as const) {
  test(`fixture cleanup survives ${failure} failure after real Pi startup`, async ({
    playwright,
  }, testInfo) => {
    const originalLaunch = VSCodeFixture.prototype.launch;
    let host: VSCodeFixture | undefined;
    let ownedPids: number[] = [];
    const preparationError = new Error("Injected preparation failure");
    VSCodeFixture.prototype.launch = async function launchWithPreparationFailure() {
      host = this;
      ownedPids = startOwnedPi(this);
      if (failure === "manifest")
        writeFileSync(join(this.directory, "pi-mux-fixture.json"), "invalid JSON");
      if (failure === "snapshot")
        writeFileSync(join(this.directory, "snapshot.json"), "invalid JSON");
      throw preparationError;
    };
    const info = Object.create(testInfo) as TestInfo;
    if (failure === "attachment")
      info.attach = async function failAttachment() {
        throw new Error("Injected attachment failure");
      };
    try {
      await test.step("Inject diagnostic failure into the actual host fixture", async () => {
        await expect(
          provideVSCodeFixture({ playwright, fixedResponse: false }, async () => {}, info),
        ).rejects.toBe(preparationError);
      });
      await test.step("Confirm the owned server and real Pi stopped", async () => {
        expect(host).toBeDefined();
        await recordOwner(host!, ownedPids, testInfo);
        await expectOwnedStopped(host!, ownedPids);
      });
    } finally {
      VSCodeFixture.prototype.launch = originalLaunch;
      if (host !== undefined) await safetyCleanup(host, ownedPids, testInfo);
    }
  });
}

test("fixture cleanup preserves an actual preparation failure before manifest creation", async ({
  playwright,
}, testInfo) => {
  const originalPrepare = VSCodeFixture.prototype.prepare;
  let host: VSCodeFixture | undefined;
  let preparationError: unknown;
  VSCodeFixture.prototype.prepare = function prepareWithBlockedBinDirectory() {
    host = this;
    writeFileSync(join(this.directory, "bin"), "Blocks fixture bin directory creation");
    try {
      originalPrepare.call(this);
    } catch (error) {
      preparationError = error;
      throw error;
    }
  };
  try {
    await test.step("Fail the real Pi-mux preparation before its manifest is written", async () => {
      const failure = await provideVSCodeFixture(
        { playwright, fixedResponse: false },
        async () => {},
        testInfo,
      ).catch((error: unknown) => error);
      expect(preparationError).toBeInstanceOf(Error);
      expect(failure).toBe(preparationError);
      expect((failure as Error).message).toContain("EEXIST");
      expect((failure as Error).stack).toContain("preparePiMux");
    });
    await test.step("Confirm incomplete preparation still ran cleanup without the manifest", async () => {
      expect(host).toBeDefined();
      expect(existsSync(join(host!.directory, "pi-mux-fixture.json"))).toBe(false);
      expect(existsSync(join(host!.directory, "runtime/closed"))).toBe(true);
      await recordOwner(host!, [], testInfo);
      await expectOwnedStopped(host!, []);
    });
  } finally {
    VSCodeFixture.prototype.prepare = originalPrepare;
    if (host !== undefined) await safetyCleanup(host, [], testInfo);
  }
});

for (const failure of ["preparation", "output-path"] as const) {
  test(`fixture cleanup covers ${failure} failure before launch`, async ({
    playwright,
  }, testInfo) => {
    const originalPrepare = VSCodeFixture.prototype.prepare;
    let host: VSCodeFixture | undefined;
    let ownedPids: number[] = [];
    VSCodeFixture.prototype.prepare = function prepareWithFailure() {
      host = this;
      originalPrepare.call(this);
      ownedPids = startOwnedPi(this);
      if (failure === "preparation") throw new Error("Injected preparation failure");
    };
    const info = Object.create(testInfo) as TestInfo;
    if (failure === "output-path")
      info.outputPath = function failOutputPath() {
        throw new Error("Injected output path failure");
      };
    try {
      await test.step("Fail preparation inside the cleanup scope", async () => {
        await expect(
          provideVSCodeFixture({ playwright, fixedResponse: false }, async () => {}, info),
        ).rejects.toThrow("Injected");
      });
      await test.step("Confirm partial preparation did not leave owned processes", async () => {
        expect(host).toBeDefined();
        await recordOwner(host!, ownedPids, testInfo);
        await expectOwnedStopped(host!, ownedPids);
      });
    } finally {
      VSCodeFixture.prototype.prepare = originalPrepare;
      if (host !== undefined) await safetyCleanup(host, ownedPids, testInfo);
    }
  });
}

for (const failure of ["trace", "application"] as const) {
  test(`fixture cleanup stops real Pi when ${failure} shutdown fails`, async ({}, testInfo) => {
    const host = new VSCodeFixture();
    let ownedPids: number[] = [];
    try {
      host.prepare();
      ownedPids = startOwnedPi(host);
      Object.assign(host, {
        traceStarted: true,
        app: {
          context: () => ({
            tracing: {
              stop: async () => {
                if (failure === "trace") throw new Error("Injected trace failure");
              },
            },
          }),
          close: async () => {
            if (failure === "application") throw new Error("Injected application failure");
          },
        } as unknown as ElectronApplication,
      });
      await test.step("Fail one shutdown operation and retain the tmux cleanup", async () => {
        await expect(host.close(testInfo.outputPath("injected-trace.zip"))).rejects.toThrow(
          "Injected",
        );
        await recordOwner(host, ownedPids, testInfo);
        await expectOwnedStopped(host, ownedPids);
      });
    } finally {
      Object.assign(host, { app: undefined });
      await safetyCleanup(host, ownedPids, testInfo);
    }
  });
}

for (const outcome of ["success", "failure", "diagnostics"] as const) {
  const scenario =
    outcome === "diagnostics" ? "successful body with diagnostic failure" : `test body ${outcome}`;
  test(`fixture cleanup follows ${scenario} and closes the response provider`, async ({
    playwright,
  }, testInfo) => {
    let host: VSCodeFixture | undefined;
    let ownedPids: number[] = [];
    const bodyError = new Error("Injected test body failure");
    const diagnosticError = new Error("Injected diagnostic failure after the test body");
    const info = Object.create(testInfo) as TestInfo;
    if (outcome !== "success")
      info.attach = async function failBodyDiagnostics() {
        throw diagnosticError;
      };
    try {
      await test.step("Run the real Electron fixture through the test body", async () => {
        const execution = provideVSCodeFixture(
          { playwright, fixedResponse: true },
          async (ready) => {
            host = ready;
            await expect.poll(() => ready.piProcesses().length).toBeGreaterThan(0);
            ownedPids = ready.piProcesses().map(({ pid }) => pid);
            expect(ownedPids.length).toBeGreaterThan(0);
            if (outcome === "failure") throw bodyError;
          },
          info,
        );
        if (outcome === "failure") await expect(execution).rejects.toBe(bodyError);
        else if (outcome === "diagnostics") await expect(execution).rejects.toBe(diagnosticError);
        else await execution;
      });
      await test.step("Confirm processes and the local provider stopped", async () => {
        expect(host).toBeDefined();
        await recordOwner(host!, ownedPids, testInfo);
        await expectOwnedStopped(host!, ownedPids);
        await expect(fetch(host!.responseProvider!.baseUrl)).rejects.toThrow();
      });
    } finally {
      if (host !== undefined) {
        await safetyCleanup(host, ownedPids, testInfo);
        const reachable = await fetch(host.responseProvider!.baseUrl).catch(() => undefined);
        if (reachable !== undefined) await host.responseProvider!.close();
      }
    }
  });
}

test("fixture cleanup rejects a delayed real startup without stopping another fixture", async ({}, testInfo) => {
  const host = new VSCodeFixture();
  const other = new VSCodeFixture();
  let ownedPids: number[] = [];
  let otherPids: number[] = [];
  const ready = join(host.directory, "late-ready");
  const release = join(host.directory, "late-release");
  let complete: Promise<unknown> | undefined;
  try {
    host.prepare();
    other.prepare();
    ownedPids = startOwnedPi(host);
    otherPids = startOwnedPi(other);
    const original = readFileSync(host.sessions.A.session, "utf8");
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done; shift 2; exec "$@"',
        "sh",
        ready,
        release,
        join(host.directory, "bin/pi-mux"),
        "new",
        "--detached",
      ],
      {
        cwd: host.sessions.B.cwd,
        env: host.env,
        timeout: 15_000,
      },
    );
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    complete = once(child, "close");
    await test.step("Close the owner while a startup request is delayed", async () => {
      await expect.poll(() => existsSync(ready)).toBe(true);
      await host.close(testInfo.outputPath("late-trace.zip"));
      await expectOwnedStopped(host, ownedPids);
    });
    await test.step("Release the startup and confirm it cannot recreate the server", async () => {
      writeFileSync(release, "release");
      await complete;
      expect(child.exitCode).not.toBe(0);
      expect(stderr).toContain("Fixture tmux environment is closed");
      expect(existsSync(`/proc/${child.pid}`)).toBe(false);
      await recordOwner(host, ownedPids, testInfo);
      await recordOwner(other, otherPids, testInfo);
      await expectOwnedStopped(host, ownedPids);
      expect(other.piProcesses().map(({ pid }) => pid)).toEqual(otherPids);
      expect(readFileSync(host.sessions.A.session, "utf8")).toBe(original);
    });
  } finally {
    try {
      writeFileSync(release, "release");
      await complete;
      if (existsSync(join(host.directory, "bin/tmux")))
        ownedPids.push(...host.piProcesses().map(({ pid }) => pid));
    } finally {
      try {
        await safetyCleanup(host, ownedPids, testInfo);
      } finally {
        await safetyCleanup(other, otherPids, testInfo);
      }
    }
  }
});

test("fixture cleanup waits for a native server creation already inside the startup lock", async ({
  playwright,
}, testInfo) => {
  void playwright;
  const host = new VSCodeFixture();
  const ready = join(host.directory, "native-ready");
  const release = join(host.directory, "native-release");
  let ownedPids: number[] = [];
  let startup: Promise<unknown> | undefined;
  let releaser: Promise<unknown> | undefined;
  try {
    host.prepare();
    ownedPids = startOwnedPi(host);
    const { realTmux } = JSON.parse(
      readFileSync(join(host.directory, "pi-mux-fixture.json"), "utf8"),
    ) as { realTmux: string };
    const delayed = join(host.directory, "delayed-tmux");
    writeFileSync(
      delayed,
      `#!/bin/sh
if [ "$1" != -N ]; then
  touch '${ready}'
  while [ ! -e '${release}' ]; do sleep 0.02; done
fi
exec '${realTmux}' "$@"
`,
    );
    chmodSync(delayed, 0o700);
    const wrapper = join(host.directory, "bin/tmux");
    writeFileSync(wrapper, readFileSync(wrapper, "utf8").replaceAll(realTmux, delayed));
    const child = spawn(wrapper, ["-S", host.tmuxSocket, "-f", "/dev/null", "start-server"], {
      env: host.env,
      timeout: 15_000,
    });
    child.stdout.resume();
    child.stderr.resume();
    startup = once(child, "close");
    await test.step("Hold a native creation after its closed-marker check", async () => {
      await expect.poll(() => existsSync(ready)).toBe(true);
    });
    const releaseChild = spawn(
      "/bin/sh",
      [
        "-c",
        'while [ ! -e "$1" ]; do sleep 0.02; done; sleep 0.1; touch "$2"',
        "sh",
        join(host.directory, "runtime/closed"),
        release,
      ],
      { timeout: 15_000 },
    );
    releaseChild.stdout.resume();
    releaseChild.stderr.resume();
    releaser = once(releaseChild, "close");
    await test.step("Close the owner before releasing the native creation", async () => {
      await host.close(testInfo.outputPath("native-trace.zip"));
      await Promise.all([startup, releaser]);
      expect(child.exitCode).toBe(0);
      expect(releaseChild.exitCode).toBe(0);
      expect(existsSync(`/proc/${child.pid}`)).toBe(false);
      expect(existsSync(`/proc/${releaseChild.pid}`)).toBe(false);
      await recordOwner(host, ownedPids, testInfo);
      await expectOwnedStopped(host, ownedPids);
    });
  } finally {
    writeFileSync(release, "release");
    try {
      await Promise.all([startup, releaser]);
    } finally {
      await safetyCleanup(host, ownedPids, testInfo);
    }
  }
});

function startOwnedPi(host: VSCodeFixture): number[] {
  execFileSync(join(host.directory, "bin/pi-mux"), ["new", "--detached"], {
    cwd: host.sessions.A.cwd,
    env: host.env,
    encoding: "utf8",
  });
  const pids = host.piProcesses().map(({ pid }) => pid);
  expect(pids.length).toBeGreaterThan(0);
  return pids;
}

async function expectOwnedStopped(host: VSCodeFixture, pids: number[]): Promise<void> {
  const server = spawnSync("tmux", ["-N", "-S", host.tmuxSocket, "has-session"]);
  expect(server.error).toBeUndefined();
  expect(server.status, `Owned tmux server at ${host.tmuxSocket}`).not.toBe(0);
  expect(existsSync(host.tmuxSocket)).toBe(false);
  await expect.poll(() => pids.filter((pid) => existsSync(`/proc/${pid}`))).toEqual([]);
}

async function safetyCleanup(
  host: VSCodeFixture,
  pids: number[],
  testInfo: TestInfo,
): Promise<void> {
  await host.close(testInfo.outputPath("safety-trace.zip"));
  await expectOwnedStopped(host, pids);
}

async function recordOwner(host: VSCodeFixture, pids: number[], testInfo: TestInfo): Promise<void> {
  await testInfo.attach("cleanup ownership", {
    body: JSON.stringify({ directory: host.directory, socket: host.tmuxSocket, pids }, null, 2),
    contentType: "application/json",
  });
}
