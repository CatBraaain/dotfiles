import { afterEach, describe, expect, it, vi } from "vitest";
import { PiMux } from "../src/piMux";
import { TmuxRuntimeStore } from "../src/tmux";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const processMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: processMock });
  return { execFile };
});

async function withPiMuxProcess(
  program: string,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const parent = "/tmp/work/vscode-pi-sessions";
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "pi-mux-process-"));
  writeFileSync(join(directory, "pi-mux"), `#!/usr/bin/env node\n${program}\n`, { mode: 0o700 });
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  processMock.mockImplementation(promisify(actual.execFile));
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
  processMock.mockReset();
});

describe("external command environment", () => {
  it("calls pi-mux with argv, cwd, and no inherited tmux context", async () => {
    vi.stubEnv("TMUX", "/unrelated/socket,1,0");
    vi.stubEnv("TMUX_PANE", "%9");
    processMock.mockResolvedValue({ stdout: "Pi session A\nAttach with: pi-mux open A\n" });
    expect(await new PiMux().newSession("/project with spaces")).toBe("A");
    expect(processMock).toHaveBeenCalledExactlyOnceWith("pi-mux", ["new", "--detached"], {
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
      processMock.mockResolvedValue({ stdout: "Pi session A\n" });

      await new PiMux().newSession("/project");

      expect(processMock).toHaveBeenCalledExactlyOnceWith("pi-mux", ["new", "--detached"], {
        cwd: "/project",
        timeout: 0,
        env: expect.objectContaining({ COLORTERM: expected, PI_TRUE_COLOR: "0" }),
      });
      expect(process.env).toEqual(parentEnv);
    },
  );

  it("keeps list queries bounded without applying their timeout to lifecycle operations", async () => {
    processMock.mockResolvedValue({ stdout: "[]\n" });
    expect(await new PiMux().list()).toEqual([]);
    expect(processMock).toHaveBeenCalledExactlyOnceWith("pi-mux", ["list"], {
      cwd: undefined,
      timeout: 10_000,
      env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
    });
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
        expect(processMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("uses the exact socket without -f and removes tmux context for direct commands", async () => {
    vi.stubEnv("TMUX", "/unrelated/socket,1,0");
    vi.stubEnv("TMUX_PANE", "%9");
    processMock.mockResolvedValue({ stdout: "" });
    expect(await new TmuxRuntimeStore("/dedicated/server.sock").clients()).toEqual([]);
    expect(processMock).toHaveBeenCalledExactlyOnceWith(
      "tmux",
      [
        "-S",
        "/dedicated/server.sock",
        "list-clients",
        "-F",
        "#{client_pid}\t#{client_name}\t#{session_name}",
      ],
      {
        timeout: 10_000,
        env: expect.objectContaining({ TMUX: undefined, TMUX_PANE: undefined }),
      },
    );
  });
});
