import { afterEach, describe, expect, it, vi } from "vitest";
import { PiMux } from "../src/piMux";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

function fakeChildWith(stdout: string) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", 0, null);
  });
  return child;
}

function succeedWithStdout(stdout: string): void {
  spawnMock.mockImplementation(() => fakeChildWith(stdout));
}

async function withPiMuxProcess(
  program: string,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const parent = "/tmp/work/vscode-agent-kit";
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "pi-mux-process-"));
  writeFileSync(join(directory, "pi-mux"), `#!/usr/bin/env node\n${program}\n`, { mode: 0o700 });
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.mockImplementation(actual.spawn);
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("HOME", directory);
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  spawnMock.mockReset();
});

describe("external command environment", () => {
  it.each([
    [2, "target-missing"],
    [3, "client-missing"],
  ] as const)("reports switch exit %i as %s", async (exitCode, result) => {
    await withPiMuxProcess(`process.exit(${exitCode});`, async () => {
      expect(await new PiMux().switch("A")).toBe(result);
    });
  });

  it("propagates other switch failures with the command diagnostics", async () => {
    await withPiMuxProcess('console.error("switch failed"); process.exit(1);', async () => {
      await expect(new PiMux().switch("A")).rejects.toThrow("switch failed (pi-mux exited with 1)");
    });
  });

  it("calls pi-mux with argv, cwd, and no inherited tmux context", async () => {
    vi.stubEnv("TMUX", "/unrelated/socket,1,0");
    vi.stubEnv("TMUX_PANE", "%9");
    succeedWithStdout("Pi session A\nAttach with: pi-mux open A\n");
    expect(await new PiMux().newSession("/project with spaces")).toBe("A");
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("pi-mux", ["new", "--detached"], {
      cwd: "/project with spaces",
      timeout: 0,
      env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
    });
    expect(process.env.TMUX).toBe("/unrelated/socket,1,0");
  });

  it.each([
    { inherited: undefined, expected: "truecolor" },
    { inherited: "", expected: "" },
    { inherited: "24bit", expected: "24bit" },
    { inherited: "truecolor", expected: "truecolor" },
    { inherited: "custom", expected: "custom" },
  ])(
    "passes COLORTERM=$expected to detached startup for $inherited",
    async ({ inherited, expected }) => {
      vi.stubEnv("COLORTERM", inherited);
      vi.stubEnv("PI_TRUE_COLOR", "0");
      const parentEnv = { ...process.env };
      succeedWithStdout("Pi session A\n");

      await new PiMux().newSession("/project");

      expect(spawnMock).toHaveBeenCalledExactlyOnceWith("pi-mux", ["new", "--detached"], {
        cwd: "/project",
        timeout: 0,
        env: expect.objectContaining({ COLORTERM: expected, PI_TRUE_COLOR: "0" }),
      });
      expect(process.env).toEqual(parentEnv);
    },
  );

  it("keeps query commands bounded without applying their timeout to lifecycle operations", async () => {
    succeedWithStdout("[]\n");
    expect(await new PiMux().list()).toEqual([]);
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("pi-mux", ["list", "--json"], {
      cwd: undefined,
      timeout: 10_000,
      env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
    });
    succeedWithStdout(JSON.stringify({ id: "A", cwd: "/p", file: "/f", target: "t" }) + "\n");
    await new PiMux().current();
    expect(spawnMock).toHaveBeenLastCalledWith("pi-mux", ["current", "--json"], {
      cwd: undefined,
      timeout: 10_000,
      env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
    });
    succeedWithStdout("");
    await new PiMux().switch("A");
    expect(spawnMock).toHaveBeenLastCalledWith("pi-mux", ["switch", "A"], {
      cwd: undefined,
      timeout: 10_000,
      env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
    });
    spawnMock.mockClear();
    succeedWithStdout("[]\n");
    await new PiMux().history();
    expect(spawnMock).toHaveBeenLastCalledWith("pi-mux", ["history", "--json"], {
      cwd: undefined,
      timeout: 10_000,
      env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
    });
  });

  it("collects a history response larger than the old one-MiB execFile stdout cap", async () => {
    await withPiMuxProcess(
      "const entry = { id: '', cwd: '/p', file: '/p/x.jsonl', title: 'x'.repeat(200), btime: 1, mtime: null, size: 1 };" +
        " const entries = Array.from({ length: 5000 }, (_, i) => Object.assign({}, entry, { id: 'x' + i }));" +
        " process.stdout.write(JSON.stringify(entries));",
      async () => {
        expect(await new PiMux().history()).toHaveLength(5000);
      },
    );
  });

  it("lets a real detached startup finish beyond the old ten-second limit", async () => {
    await withPiMuxProcess(
      'setTimeout(() => process.stdout.write("Pi session A\\n"), 11_000);',
      async (cwd) => {
        expect(await new PiMux().newSession(cwd)).toBe("A");
      },
    );
  }, 15_000);

  it("reports lifecycle CLI exit failure without retrying", async () => {
    await withPiMuxProcess(
      'process.stderr.write("startup failed\\n"); process.exit(7);',
      async (cwd) => {
        await expect(new PiMux().newSession(cwd)).rejects.toThrow("startup failed");
        expect(spawnMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("executes close with an unchanged ID and accepts an empty successful response", async () => {
    await withPiMuxProcess(
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["close", "custom-ID"])) process.exit(2);',
      async () => {
        await expect(new PiMux().closeSession("custom-ID")).resolves.toBeUndefined();
        expect(spawnMock).toHaveBeenCalledExactlyOnceWith("pi-mux", ["close", "custom-ID"], {
          cwd: undefined,
          timeout: 0,
          env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
        });
      },
    );
  });

  it("passes the conditional close flag and complete ID to an isolated contract fixture", async () => {
    await withPiMuxProcess(
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["close", "--if-temporary", "custom-ID"])) process.exit(2);',
      async () => {
        await expect(new PiMux().closeTemporarySession("custom-ID")).resolves.toBeUndefined();
        expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
          "pi-mux",
          ["close", "--if-temporary", "custom-ID"],
          {
            cwd: undefined,
            timeout: 0,
            env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
          },
        );
      },
    );
  });

  it("reports a nonzero close exit without retry or fallback", async () => {
    await withPiMuxProcess(
      'process.stderr.write("restore candidate removal failed\\n"); process.exit(1);',
      async () => {
        await expect(new PiMux().closeSession("custom-ID")).rejects.toThrow(
          /pi-mux close custom-ID: .*restore candidate removal failed/s,
        );
        expect(spawnMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("reports an unavailable close CLI without invoking tmux", async () => {
    await withPiMuxProcess("", async (cwd) => {
      vi.stubEnv("PATH", join(cwd, "missing"));
      await expect(new PiMux().closeSession("custom-ID")).rejects.toThrow(
        "pi-mux close custom-ID: spawn pi-mux ENOENT",
      );
      expect(spawnMock).toHaveBeenCalledOnce();
    });
  });
});
