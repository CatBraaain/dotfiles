import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { RESTART_COOLDOWN_MS } from "./config";
import { openserpServeArgs, restartInCooldown } from "./server";

describe("openserpServeArgs", () => {
  it("keeps --quiet and adds --log_level error to the serve arguments", () => {
    assert.deepEqual(openserpServeArgs("127.0.0.1", "7000"), [
      "serve",
      "-a",
      "127.0.0.1",
      "-p",
      "7000",
      "--quiet",
      "--log_level",
      "error",
    ]);
  });
});

describe("restartInCooldown", () => {
  const now = 1_000_000;

  it("is not in cooldown when the server start time is unknown", () => {
    assert.equal(restartInCooldown(undefined, now), false);
  });

  it("is in cooldown while the server started within the cooldown window", () => {
    assert.equal(restartInCooldown(now - RESTART_COOLDOWN_MS + 1, now), true);
  });

  it("is not in cooldown after the cooldown window has passed", () => {
    assert.equal(restartInCooldown(now - RESTART_COOLDOWN_MS, now), false);
  });
});
