// createStateFetcher / createSelectSender: transport and wire contract
// between the browser half and the host's exact /api routes.
import { strict as assert } from "node:assert/strict";
import { describe, it } from "bun:test";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { createSelectSender, createStateFetcher } from "./state.ts";

const sessionId = "session-1" as SessionId;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

const url = (): URL => new URL("/api/dsh-agents/state", "https://dsh.invalid");

describe("createStateFetcher", () => {
  it("POSTs the session id to the state route and returns the parsed state", async () => {
    let captured: Request | undefined;
    const fetcher = createStateFetcher(async (input, init) => {
      captured = new Request(url(), init);
      return json({ managed: true, agent: "main", className: "high", manual: false });
    });
    const state = await fetcher(sessionId);
    assert.equal(captured?.method, "POST");
    assert.equal(captured?.url, url().href);
    assert.equal(captured?.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(await captured.text()), { sessionId: "session-1" });
    assert.deepEqual(state, { managed: true, agent: "main", className: "high" });
  });

  it("drops the manual flag from the wire payload", async () => {
    const fetcher = createStateFetcher(async () =>
      json({ managed: true, agent: "main", className: "high", manual: true }),
    );
    assert.deepEqual(await fetcher(sessionId), {
      managed: true,
      agent: "main",
      className: "high",
      manual: true,
    });
  });

  it("reads a non-2xx response as unmanaged", async () => {
    const fetcher = createStateFetcher(async () => new Response("not found", { status: 404 }));
    assert.deepEqual(await fetcher(sessionId), { managed: false });
  });

  it("reads an unmanaged payload as unmanaged", async () => {
    const fetcher = createStateFetcher(async () => json({ managed: false }));
    assert.deepEqual(await fetcher(sessionId), { managed: false });
  });

  it("reads a malformed body as unmanaged", async () => {
    const fetcher = createStateFetcher(async () => json({ managed: "yes" }));
    assert.deepEqual(await fetcher(sessionId), { managed: false });
  });

  it("reads a transport failure as unmanaged", async () => {
    const fetcher = createStateFetcher(async () => {
      throw new TypeError("network down");
    });
    assert.deepEqual(await fetcher(sessionId), { managed: false });
  });
});

describe("createSelectSender", () => {
  it("POSTs the pick to the select route and reports acceptance", async () => {
    let captured: Request | undefined;
    const select = createSelectSender(async (_input, init) => {
      captured = new Request(new URL("/api/dsh-agents/select", "https://dsh.invalid"), init);
      return json({ ok: true, text: "class → low" });
    });
    const result = await select(sessionId, "class", "low");
    assert.equal(captured?.method, "POST");
    assert.equal(captured?.url, "https://dsh.invalid/api/dsh-agents/select");
    assert.equal(captured?.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(await captured!.text()), {
      sessionId: "session-1",
      kind: "class",
      name: "low",
    });
    assert.deepEqual(result, { ok: true });
  });

  it("reports a host rejection as not accepted", async () => {
    const select = createSelectSender(async () => json({ ok: false, text: "unknown agent" }));
    assert.deepEqual(await select(sessionId, "agent", "nope"), { ok: false });
  });

  it("reads a non-2xx response as not accepted", async () => {
    const select = createSelectSender(async () => new Response("not found", { status: 404 }));
    assert.deepEqual(await select(sessionId, "agent", "main"), { ok: false });
  });

  it("reads a malformed body as not accepted", async () => {
    const select = createSelectSender(async () => json({ ok: "yes" }));
    assert.deepEqual(await select(sessionId, "agent", "main"), { ok: false });
  });

  it("reads a transport failure as not accepted", async () => {
    const select = createSelectSender(async () => {
      throw new TypeError("network down");
    });
    assert.deepEqual(await select(sessionId, "agent", "main"), { ok: false });
  });
});
