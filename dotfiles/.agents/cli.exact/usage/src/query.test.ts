import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { AuthResolution } from "./auth";
import { queryProviders } from "./query";
import type { UsageProviderAdapter, UsageReport } from "./types";

const RESOLVED: AuthResolution = {
  status: "resolved",
  type: "api_key",
  auth: {
    apiKey: "private-api-key",
    headers: { Authorization: "Bearer private-api-key" },
    secrets: ["private-api-key", "private-refresh-token"],
  },
};

function adapter(id: string, query?: UsageProviderAdapter["query"]): UsageProviderAdapter {
  return {
    id,
    displayName: `Provider ${id}`,
    semantics: { kind: "api-key", label: "API balance" },
    query: query ?? (async () => report(id)),
  };
}

function report(providerId: string): UsageReport {
  return {
    providerId,
    providerName: `Provider ${providerId}`,
    capturedAt: 0,
    source: "fixture",
    semantics: { kind: "api-key", label: "API balance" },
    buckets: [],
    metrics: [],
  };
}

describe("queryProviders", () => {
  it("passes resolved authentication, a signal, the fixed timeout, and a no-op guard", async () => {
    let calls = 0;
    const fixture = adapter("ready", async (auth, signal, timeoutMs, guard) => {
      calls += 1;
      assert.equal(auth, RESOLVED.status === "resolved" ? RESOLVED.auth : undefined);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      assert.equal(timeoutMs, 15_000);
      assert.equal(await guard(), undefined);
      return report("ready");
    });
    const states = await queryProviders([fixture], {
      resolveAuth: async () => RESOLVED,
      displayState: () => "current",
    });
    assert.equal(calls, 1);
    assert.deepEqual(states, [
      {
        providerId: "ready",
        providerName: "Provider ready",
        displayState: "current",
        status: "ready",
        report: report("ready"),
      },
    ]);
  });

  it("returns auth-unavailable without calling the adapter", async () => {
    let calls = 0;
    const states = await queryProviders(
      [
        adapter("missing", async () => {
          calls += 1;
          return report("missing");
        }),
      ],
      {
        resolveAuth: () => ({ status: "unavailable", message: "OAuth credential has expired." }),
        displayState: () => "configured",
      },
    );
    assert.equal(calls, 0);
    assert.deepEqual(states, [
      {
        providerId: "missing",
        providerName: "Provider missing",
        displayState: "configured",
        status: "auth-unavailable",
        message: "OAuth credential has expired.",
      },
    ]);
  });

  it("redacts query errors while retaining successful results", async () => {
    const states = await queryProviders(
      [
        adapter("broken", async () => {
          throw new Error("private-api-key private-refresh-token Bearer other-token\nfailed");
        }),
        adapter("ready"),
      ],
      { resolveAuth: () => RESOLVED, displayState: () => "configured" },
    );
    assert.equal(states[0]?.status, "query-failed");
    if (states[0]?.status === "query-failed") {
      assert.equal(states[0].message, "<redacted> <redacted> Bearer <redacted> failed");
    }
    assert.equal(states[1]?.status, "ready");
  });

  it("isolates authentication resolution exceptions per provider", async () => {
    const states = await queryProviders([adapter("broken"), adapter("ready")], {
      resolveAuth: (providerId) => {
        if (providerId === "broken") throw new Error("Bearer private-auth-token unavailable");
        return RESOLVED;
      },
      displayState: () => "configured",
    });
    assert.equal(states[0]?.status, "query-failed");
    if (states[0]?.status === "query-failed")
      assert.equal(states[0].message, "Bearer <redacted> unavailable");
    assert.equal(states[1]?.status, "ready");
  });

  it("handles non-Error query exceptions", async () => {
    const states = await queryProviders(
      [
        adapter("broken", async () => {
          throw "private-api-key";
        }),
      ],
      {
        resolveAuth: () => RESOLVED,
        displayState: () => "configured",
      },
    );
    assert.equal(states[0]?.status, "query-failed");
    if (states[0]?.status === "query-failed") assert.equal(states[0].message, "<redacted>");
  });

  it("places current first while preserving adapter order for other results", async () => {
    const states = await queryProviders(
      [adapter("first"), adapter("second"), adapter("current"), adapter("last")],
      {
        resolveAuth: () => RESOLVED,
        displayState: (providerId) => (providerId === "current" ? "current" : "configured"),
      },
    );
    assert.deepEqual(
      states.map((state) => state.providerId),
      ["current", "first", "second", "last"],
    );
  });

  it("limits concurrent queries to two without imposing completion order", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const fixtures = ["first", "second", "third", "fourth", "fifth"].map((id) =>
      adapter(id, async () => {
        calls.push(id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls.length === 2) started.resolve();
        await release.promise;
        active -= 1;
        return report(id);
      }),
    );
    const pending = queryProviders(fixtures, {
      resolveAuth: () => RESOLVED,
      displayState: () => "configured",
    });
    await started.promise;
    assert.deepEqual(calls, ["first", "second"]);
    release.resolve();
    const states = await pending;
    assert.equal(maxActive, 2);
    assert.equal(active, 0);
    assert.deepEqual(
      states.map((state) => state.providerId),
      fixtures.map((fixture) => fixture.id),
    );
    assert.ok(states.every((state) => state.status === "ready"));
  });

  it("returns an empty array without resolving authentication for empty input", async () => {
    const states = await queryProviders([], {
      resolveAuth: () => {
        throw new Error("must not be called");
      },
      displayState: () => "configured",
    });
    assert.deepEqual(states, []);
  });
});

describe("query output secrecy", () => {
  it("redacts every string field of an injected successful report before truncation", async () => {
    const secret = "report-secret-" + "x".repeat(800);
    const reflected = "field " + secret + "\nend";
    const fixtureReport: UsageReport = {
      providerId: reflected,
      providerName: reflected,
      source: reflected,
      capturedAt: 123,
      accountLabel: reflected,
      semantics: { kind: "api-key", label: reflected },
      buckets: [
        {
          id: reflected,
          label: reflected,
          groupId: reflected,
          groupLabel: reflected,
          modelKeys: [reflected],
          unit: "count",
          period: reflected,
          used: 4,
        },
      ],
      metrics: [{ id: reflected, label: reflected, value: reflected, currency: reflected }],
      notes: [reflected],
    };
    const states = await queryProviders([adapter("fixture", async () => fixtureReport)], {
      resolveAuth: () => ({
        status: "resolved",
        type: "api_key",
        auth: { headers: {}, secrets: [secret] },
      }),
      displayState: () => "configured",
    });
    const serialized = JSON.stringify(states);
    assert.doesNotMatch(serialized, /report-secret/);
    assert.equal(states[0]?.status, "ready");
    if (states[0]?.status !== "ready") assert.fail("Expected a ready report");
    const safe = states[0].report;
    assert.equal(safe.accountLabel, "field <redacted> end");
    assert.equal(safe.buckets[0]?.modelKeys?.[0], "field <redacted> end");
    assert.equal(safe.metrics[0]?.value, "field <redacted> end");
    assert.equal(safe.capturedAt, 123);
    assert.equal(safe.buckets[0]?.used, 4);
    assert.equal(fixtureReport.accountLabel, reflected);
  });

  for (const asError of [false, true]) {
    it("redacts long exceptions before shortening: Error=" + asError, async () => {
      const secret = "exception-secret-" + "z".repeat(800);
      const states = await queryProviders(
        [
          adapter("broken", async () => {
            if (asError) throw new Error(secret);
            throw secret;
          }),
        ],
        {
          resolveAuth: () => ({
            status: "resolved",
            type: "oauth",
            auth: { headers: {}, secrets: [secret] },
          }),
          displayState: () => "configured",
        },
      );
      assert.equal(states[0]?.status, "query-failed");
      if (states[0]?.status !== "query-failed") assert.fail("Expected query failure");
      assert.equal(states[0].message, "<redacted>");
    });
  }
});
