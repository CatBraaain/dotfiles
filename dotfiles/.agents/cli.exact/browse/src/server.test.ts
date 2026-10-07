import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { RESTART_COOLDOWN_MS } from "./config";
import { restartInCooldown } from "./server";

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
