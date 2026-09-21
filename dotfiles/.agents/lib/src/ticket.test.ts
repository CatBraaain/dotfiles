import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { TicketCliError, ticketCliArgs } from "./ticket";

describe("ticket helpers", () => {
  it("places --json before an edit option terminator", () => {
    assert.deepEqual(ticketCliArgs(["edit", "--", "-old", "-new"]), [
      "edit",
      "--json",
      "--",
      "-old",
      "-new",
    ]);
  });

  it("keeps non-JSON failures distinguishable by their message", () => {
    const error = new TicketCliError("", "ticket CLI returned non-JSON output: diagnostic");
    assert.match(error.message, /^ticket CLI returned non-JSON output:/);
  });
});
