import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHeadless } from "./display";

function runDisplay(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "browse-display-contract-"));
  try {
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "fixtures/display-lifecycle.ts"), scenario],
      {
        env: { ...process.env, XDG_CACHE_HOME: root },
        timeout: 5000,
      },
    );
    assert.equal(child.exitCode, 0, child.stderr.toString());
    return {
      ...JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!),
      stderr: child.stderr.toString(),
    } as {
      events: any[][];
      error?: string;
      now: number;
      stderr: string;
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("server display mode", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    for (const value of [undefined, "invalid", "0", "1"]) {
      it(`resolves CAMOUFOX_HEADLESS=${value} on ${platform}`, () => {
        assert.equal(
          resolveHeadless({ CAMOUFOX_HEADLESS: value }, platform),
          value === "1" || (value !== "0" && platform === "win32"),
        );
      });
    }
  }
});

describe("headed helper processes", () => {
  it("starts detached Xvfb, waits for its socket, then starts denied-by-default localhost VNC", () => {
    const report = runDisplay("start");
    assert.equal(report.error, undefined);
    const launches = report.events.filter(([name]) => name === "spawn");
    assert.deepEqual(
      launches.map((event) => event[1]),
      ["Xvfb", "x11vnc"],
    );
    assert.deepEqual(launches[0]?.[2], [":99", "-screen", "0", "1920x1080x24"]);
    assert.deepEqual(launches[1]?.[2], [
      "-display",
      ":99",
      "-localhost",
      "-rfbport",
      "5900",
      "-forever",
      "-nopw",
      "-deny_all",
    ]);
    for (const launch of launches) {
      assert.equal(launch[3].detached, true);
      assert.equal(launch[3].stdio[0], "ignore");
      assert.equal(launch[3].stdio[1], launch[3].stdio[2]);
    }
    assert.equal(report.events.filter(([name]) => name === "unref").length, 2);
    assert.ok(
      report.events.findIndex(([name]) => name === "wait") <
        report.events.findIndex(([name, command]) => name === "spawn" && command === "x11vnc"),
    );
  });

  it("reuses an existing display and VNC listener", () => {
    const report = runDisplay("existing");
    assert.equal(report.error, undefined);
    assert.deepEqual(
      report.events.filter(([name]) => name === "spawn"),
      [],
    );
  });

  it.skipIf(process.platform !== "linux")(
    "recognizes a Linux abstract X11 socket without a filesystem socket",
    () => {
      const report = runDisplay("abstract");
      assert.equal(
        report.events.filter(([name, command]) => name === "spawn" && command === "Xvfb").length,
        0,
      );
    },
  );

  it("warns and continues when x11vnc is unavailable", () => {
    const report = runDisplay("missing-vnc");
    assert.equal(report.error, undefined);
    assert.match(report.stderr, /x11vnc not on PATH/);
    assert.equal(
      report.events.filter(([name, command]) => name === "spawn" && command === "x11vnc").length,
      0,
    );
  });

  it("abandons Xvfb startup when its socket does not appear within ten seconds", () => {
    const report = runDisplay("timeout");
    assert.match(report.error!, /did not appear within 10s/);
    assert.ok(report.now >= 10000 && report.now <= 10100);
    assert.equal(
      report.events.filter(([name, command]) => name === "spawn" && command === "x11vnc").length,
      0,
    );
  });
});
