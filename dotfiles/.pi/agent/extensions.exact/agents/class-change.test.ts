import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CLASS_CHANGE_EVENT,
  requestClassChange,
  type ClassChangeRequest,
  type ClassChangeResult,
} from "./class-change.ts";

const context = {} as ExtensionContext;

describe("class change event contract", () => {
  it("returns unavailable without a receiver instead of waiting forever", async () => {
    const events = createEventBus();
    assert.equal(await requestClassChange(events, { class: "high", context }), "unavailable");
  });

  it("waits for the receiver's completion on the real event bus", async () => {
    const events = createEventBus();
    const completion = Promise.withResolvers<ClassChangeResult>();
    events.on(CLASS_CHANGE_EVENT, (data) => {
      const request = data as ClassChangeRequest;
      assert.equal(request.class, "high");
      assert.equal(request.context, context);
      request.respond(completion.promise);
    });
    let finished = false;
    const change = requestClassChange(events, { class: "high", context }).then((result) => {
      finished = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(finished, false);
    completion.resolve("applied");
    assert.equal(await change, "applied");
  });

  it("propagates receiver errors to the caller", async () => {
    const events = createEventBus();
    events.on(CLASS_CHANGE_EVENT, (data) => {
      (data as ClassChangeRequest).respond(Promise.reject(new Error("model failed")));
    });
    await assert.rejects(requestClassChange(events, { class: "high", context }), /model failed/);
  });

  it("keeps concurrent request results separate", async () => {
    const events = createEventBus();
    const high = Promise.withResolvers<ClassChangeResult>();
    const low = Promise.withResolvers<ClassChangeResult>();
    events.on(CLASS_CHANGE_EVENT, (data) => {
      const request = data as ClassChangeRequest;
      request.respond(request.class === "high" ? high.promise : low.promise);
    });
    const first = requestClassChange(events, { class: "high", context });
    const second = requestClassChange(events, { class: "low", context });
    low.resolve("ignored");
    high.resolve("applied");
    assert.deepEqual(await Promise.all([first, second]), ["applied", "ignored"]);
  });
});
