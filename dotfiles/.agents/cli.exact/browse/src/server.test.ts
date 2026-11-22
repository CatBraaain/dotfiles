import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { RESTART_COOLDOWN_MS } from "./config";
import { camoufoxServerPort, openserpServeArgs, restartInCooldown } from "./server";

describe("camoufoxServerPort", () => {
  it("uses the port regardless of host and path", () => {
    assert.equal(camoufoxServerPort("ws://127.0.0.1:9378/camoufox"), "9378");
    assert.equal(camoufoxServerPort("ws://127.0.0.2:9378/another-path"), "9378");
  });

  it("uses the standard port when the URL omits it", () => {
    assert.equal(camoufoxServerPort("ws://localhost/camoufox"), "80");
    assert.equal(camoufoxServerPort("wss://localhost/camoufox"), "443");
  });

  it("rejects port zero because it does not identify a fixed listener", () => {
    assert.throws(() => camoufoxServerPort("ws://localhost:0/camoufox"), /nonzero port/);
  });
});

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
