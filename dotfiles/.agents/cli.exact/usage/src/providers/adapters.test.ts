import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { ADAPTERS, adapterForProvider } from "../adapters";
import type { ResolvedAuth } from "../types";

const auth: ResolvedAuth = {
  apiKey: "test-token",
  headers: { Authorization: "Bearer test-token" },
  secrets: ["test-token"],
};

describe("adapter registry", () => {
  it("contains exactly the three supported providers", () => {
    assert.deepEqual(
      ADAPTERS.map((adapter) => adapter.id),
      ["openai-codex", "commandcode", "zai"],
    );
    assert.equal(adapterForProvider("unsupported"), undefined);
  });
});

describe("fixed provider transports", () => {
  it("uses the fixed Z.AI origin and degrades optional failures without secret notes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), "test-token");
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/subscription/list"))
        return new Response("test-token private failure", { status: 500 });
      return Response.json({
        data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 20 }] },
      });
    }
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      for (const providerId of ["zai"]) {
        const report = await adapterForProvider(providerId)!.query(
          auth,
          new AbortController().signal,
          1000,
          async () => {},
        );
        assert.equal(report.buckets[0]?.remaining, 80);
        assert.equal(JSON.stringify(report).includes("test-token"), false);
      }
      assert.deepEqual(requests, [
        "https://api.z.ai/api/monitor/usage/quota/limit",
        "https://api.z.ai/api/biz/subscription/list",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not copy optional Command Code error bodies into notes", async () => {
    const originalFetch = globalThis.fetch;
    async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      assert.equal(init?.redirect, "error");
      assert.equal(new URL(String(input)).origin, "https://api.commandcode.ai");
      if (String(input).endsWith("/whoami")) return Response.json({ user: { userName: "tester" } });
      if (String(input).includes("/usage/summary")) return Response.json({ totalCost: 2 });
      return new Response("test-token private failure", { status: 500 });
    }
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      const report = await adapterForProvider("commandcode")!.query(
        auth,
        new AbortController().signal,
        1000,
        async () => {},
      );
      assert.equal(report.metrics[0]?.value, 2);
      assert.ok(report.notes?.includes("Command Code credits were unavailable."));
      assert.equal(JSON.stringify(report).includes("test-token"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
