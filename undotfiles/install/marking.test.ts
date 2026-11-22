import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { readInstallProfile } from "./marking.ts";

describe("install profile", () => {
  for (const profile of ["dev", "work", "personal"]) {
    it(`accepts INSTALL_PROFILE=${profile}`, async () => {
      assert.equal(await readInstallProfile(async () => `INSTALL_PROFILE=${profile}\r\n`), profile);
    });
  }

  it("rejects an unknown profile with the accepted values", async () => {
    await assert.rejects(
      readInstallProfile(async () => "INSTALL_PROFILE=development"),
      /expected one of: dev, work, personal/,
    );
  });

  it("rejects a missing profile", async () => {
    await assert.rejects(
      readInstallProfile(async () => ""),
      /INSTALL_PROFILE is not defined/,
    );
  });
});
