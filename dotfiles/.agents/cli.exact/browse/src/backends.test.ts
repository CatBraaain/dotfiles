import { describe, it, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import {
  isCamoufoxServerCommand,
  prepareCamoufoxRetry,
  recoveryAttemptDuration,
  tryRecoveryBackends,
  type BackendEntry,
} from "./backends";

describe("isCamoufoxServerCommand", () => {
  const scriptPath = "/opt/cli/browse";
  const serverSubcommand = "__server";

  it("matches the compiled-binary command line [executable, __server]", () => {
    const args = [scriptPath, serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), true);
  });

  it("matches the source-run command line [bun, script, __server]", () => {
    const args = ["/usr/bin/bun", scriptPath, serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), true);
  });

  it("matches a compiled-binary command line with extra args", () => {
    const args = [scriptPath, serverSubcommand, "--flag"];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), true);
  });

  it("rejects a different subcommand", () => {
    const args = [scriptPath, "search"];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), false);
  });

  it("rejects a different script path", () => {
    const args = ["/elsewhere/browse", serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), false);
  });

  it("rejects the source form when the script path differs", () => {
    const args = ["/usr/bin/bun", "/elsewhere/browse", serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), false);
  });

  it("rejects an empty command line", () => {
    assert.equal(isCamoufoxServerCommand([], scriptPath, serverSubcommand), false);
  });
});

describe("backend retry flow", () => {
  for (const failure of ["render: aborted", "render: timeout", "render: connection closed"]) {
    for (const responsive of [true, false]) {
      it(`retries ${failure} after ${responsive ? "a healthy probe" : "a restart"}`, async () => {
        const events: string[] = [];
        let runs = 0;
        const outcome = await tryRecoveryBackends(
          "web search",
          [
            [
              "google",
              async () => {
                events.push("render");
                if (++runs === 1) throw new Error(failure);
                return "result";
              },
            ],
          ],
          (payload) => !payload,
          () => true,
          (error, budget) =>
            prepareCamoufoxRetry(error, budget, {
              isServerResponsive: async () => {
                events.push("health");
                return responsive;
              },
              restartServer: async () => {
                events.push("restart");
              },
            }),
        );
        assert.equal(outcome.payload, "result");
        assert.deepEqual(
          events,
          responsive ? ["render", "health", "render"] : ["render", "health", "restart", "render"],
        );
        assert.deepEqual(
          outcome.attempts.map((attempt) => attempt.ok),
          [false, true],
        );
      });
    }
  }

  it("advances to the next engine when the restart fails", async () => {
    const events: string[] = [];
    const outcome = await tryRecoveryBackends(
      "web search",
      [
        [
          "google",
          async () => {
            events.push("google");
            throw new Error("render: aborted");
          },
        ],
        [
          "duckduckgo",
          async () => {
            events.push("duckduckgo");
            return "ok";
          },
        ],
      ],
      () => false,
      () => true,
      (error, budget) =>
        prepareCamoufoxRetry(error, budget, {
          isServerResponsive: async () => false,
          restartServer: async () => {
            events.push("restart");
            throw new Error("restart failed");
          },
        }),
    );
    assert.deepEqual(events, ["google", "restart", "duckduckgo"]);
    assert.deepEqual(
      outcome.attempts.map((attempt) => attempt.backend),
      ["google", "google recovery", "duckduckgo"],
    );
    assert.equal(outcome.attempts[1]?.ok, false);
  });

  it("shares one server recovery budget across engines and stops a backend after its retry", async () => {
    const runs: string[] = [];
    let restarts = 0;
    const backends: BackendEntry[] = ["google", "duckduckgo", "bing"].map((engine) => [
      engine,
      async () => {
        runs.push(engine);
        throw new Error("render: aborted");
      },
    ]);
    await assert.rejects(
      () =>
        tryRecoveryBackends(
          "web search",
          backends,
          () => false,
          () => true,
          (error, budget) =>
            prepareCamoufoxRetry(error, budget, {
              isServerResponsive: async () => false,
              restartServer: async () => {
                restarts++;
              },
            }),
        ),
      /All web search backends failed: google: render: aborted; google: render: aborted; duckduckgo: render: aborted; bing: render: aborted\nHint: .*transient.*server restart/,
    );
    assert.deepEqual(runs, ["google", "google", "duckduckgo", "bing"]);
    assert.equal(restarts, 1);
  });

  for (const challenge of ["render: challenge detected", "parse: captcha detected"]) {
    it(`retries ${challenge} once per backend without consuming recovery budget`, async () => {
      const runs: string[] = [];
      const budgets: number[] = [];
      let healthChecks = 0;
      const backends: BackendEntry[] = ["google", "duckduckgo"].map((engine) => [
        engine,
        async () => {
          runs.push(engine);
          throw new Error(challenge);
        },
      ]);
      await assert.rejects(
        () =>
          tryRecoveryBackends(
            "web search",
            backends,
            () => false,
            () => true,
            (error, budget) => {
              budgets.push(budget);
              return prepareCamoufoxRetry(error, budget, {
                isServerResponsive: async () => {
                  healthChecks++;
                  return false;
                },
                restartServer: async () => {
                  throw new Error("unexpected restart");
                },
              });
            },
          ),
        /All web search backends failed/,
      );
      assert.deepEqual(runs, ["google", "google", "duckduckgo", "duckduckgo"]);
      assert.deepEqual(budgets, [0, 0]);
      assert.equal(healthChecks, 0);
    });
  }

  it("reports dedicated failures on one line without retries or a render hint", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        tryRecoveryBackends(
          "web fetch",
          [
            [
              "Reddit",
              async () => {
                calls++;
                throw new Error("RSS 403");
              },
            ],
          ],
          () => false,
        ),
      { message: "All web fetch backends failed: Reddit: RSS 403" },
    );
    assert.equal(calls, 1);
  });

  it("records only the final successful attempt's duration", async () => {
    const clock = spyOn(Date, "now");
    let now = 0;
    clock.mockImplementation(() => now);
    try {
      let runs = 0;
      const result = await tryRecoveryBackends(
        "web search",
        [
          [
            "google",
            async () => {
              now += 300;
              throw new Error("parse: empty response");
            },
          ],
          [
            "bing",
            async () => {
              now += ++runs === 1 ? 800 : 120;
              if (runs === 1) throw new Error("render: challenge detected");
              return "ok";
            },
          ],
        ],
        () => false,
        () => true,
      );
      assert.deepEqual(
        result.attempts.map((attempt) => attempt.durationMs),
        [300, 800, 120],
      );
      assert.equal(recoveryAttemptDuration(result.attempts), 120);
    } finally {
      clock.mockRestore();
    }
  });
});
