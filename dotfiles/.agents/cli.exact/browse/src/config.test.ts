import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import {
  CAMOUFOX_HEALTH_SESSION_KEY,
  camoufoxSessionKey,
  currentSlotNumber,
  SLOT_COUNT,
  slotLockFile,
  SLOT_ENV,
} from "./config";

function withSlotEnv(value: string | undefined, run: () => void): void {
  const saved = process.env[SLOT_ENV];
  try {
    if (value === undefined) delete process.env[SLOT_ENV];
    else process.env[SLOT_ENV] = value;
    run();
  } finally {
    if (saved === undefined) delete process.env[SLOT_ENV];
    else process.env[SLOT_ENV] = saved;
  }
}

describe("camoufoxSessionKey", () => {
  it("names the session after the acquired render slot", () => {
    withSlotEnv("1", () => {
      assert.equal(camoufoxSessionKey("web-search"), "web-search-1");
      assert.equal(camoufoxSessionKey("web-fetch"), "web-fetch-1");
      assert.equal(camoufoxSessionKey(CAMOUFOX_HEALTH_SESSION_KEY), "web-health-1");
    });
  });

  it("falls back to the pid so concurrent runs never share a session without flock(1)", () => {
    withSlotEnv(undefined, () => {
      assert.equal(camoufoxSessionKey("web-fetch"), `web-fetch-${process.pid}`);
      assert.equal(camoufoxSessionKey(CAMOUFOX_HEALTH_SESSION_KEY), `web-health-${process.pid}`);
    });
  });

  it("falls back to the pid for out-of-range slot values", () => {
    withSlotEnv(String(SLOT_COUNT), () => {
      assert.equal(camoufoxSessionKey("web-search"), `web-search-${process.pid}`);
    });
  });
});

describe("currentSlotNumber", () => {
  it("parses the slot from the environment", () => {
    withSlotEnv("0", () => assert.equal(currentSlotNumber(), 0));
    withSlotEnv(String(SLOT_COUNT - 1), () => assert.equal(currentSlotNumber(), SLOT_COUNT - 1));
  });

  it("rejects missing, non-numeric, and out-of-range values", () => {
    withSlotEnv(undefined, () => assert.equal(currentSlotNumber(), undefined));
    withSlotEnv("abc", () => assert.equal(currentSlotNumber(), undefined));
    withSlotEnv("-1", () => assert.equal(currentSlotNumber(), undefined));
    withSlotEnv(String(SLOT_COUNT), () => assert.equal(currentSlotNumber(), undefined));
  });
});

describe("slotLockFile", () => {
  it("names a distinct lock file per slot", () => {
    const names = [...Array(SLOT_COUNT).keys()].map(slotLockFile);
    assert.equal(new Set(names).size, SLOT_COUNT);
    assert.deepEqual(
      names.sort(),
      [
        "browse-slot-0.lock",
        "browse-slot-1.lock",
      ],
    );
  });
});
