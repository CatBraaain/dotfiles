import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { findExecutable } from "./shared.ts";

const directories: string[] = [];

function fixture() {
  mkdirSync("/tmp/work/dotfiles", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/handoff-launch-");
  directories.push(directory);
  const node = findExecutable("node");
  const output = join(directory, "observed.json");
  const backend = join(directory, "backend.mjs");
  writeFileSync(
    backend,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify({pid:process.pid,cwd:process.cwd(),env:process.env,execArgv:process.execArgv}));`,
  );
  const manifest = {
    version: 1,
    execPath: node,
    execArgv: ["--no-warnings"],
    argv: [backend],
    cwd: directory,
    env: {
      PATH: process.env.PATH!,
      SECRET: "Launch-only value",
      PI_SESSION_ID: "parent",
      TMUX: "old",
      TERM: "old",
    },
    startup: {
      version: 1,
      instanceId: randomUUID(),
      sessionId: "resolved-session",
      socketPath: join(directory, "server.sock"),
      editorText: "Unsent text",
    },
  };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { directory, node, output, manifest };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Node backend launcher", () => {
  it("executes the original runtime with its environment and the new terminal values", () => {
    const { directory, node, output } = fixture();
    const child = spawnSync(
      node,
      [fileURLToPath(new URL("./launch.mjs", import.meta.url)), directory],
      {
        env: {
          PATH: process.env.PATH,
          TERM: "tmux-256color",
          TMUX: "/new.sock,42,0",
          TMUX_PANE: "%3",
        },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(observed.pid, child.pid);
    assert.equal(observed.cwd, directory);
    assert.deepEqual(observed.execArgv, ["--no-warnings"]);
    assert.equal(observed.env.SECRET, "Launch-only value");
    assert.equal(observed.env.TMUX, "/new.sock,42,0");
    assert.equal(observed.env.TMUX_PANE, "%3");
    assert.equal(observed.env.TERM, "tmux-256color");
    assert.equal(observed.env.PI_SESSION_ID, undefined);
    assert.equal(existsSync(join(directory, "manifest.json")), false);
    assert.equal(
      readFileSync(join(directory, "startup.json"), "utf8").includes("Launch-only value"),
      false,
    );
  });

  it("removes environment data and reports a sanitized error when backend exec fails", () => {
    const { directory, node, manifest } = fixture();
    manifest.execPath = join(directory, "missing-node");
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const child = spawnSync(
      node,
      [fileURLToPath(new URL("./launch.mjs", import.meta.url)), directory],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 1);
    assert.equal(existsSync(join(directory, "manifest.json")), false);
    assert.equal(child.stderr.includes("Launch-only value"), false);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "error.json"), "utf8")), {
      error: "Backend launch failed",
    });
  });
});
