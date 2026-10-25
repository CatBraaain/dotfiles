import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { fetchProviderJson } from "./http";
import type { ResolvedAuth } from "./types";

const auth: ResolvedAuth = {
  headers: { Authorization: "Bearer synthetic-key" },
  secrets: ["synthetic-key"],
};

describe("provider HTTP transport", () => {
  it("rejects redirects before sending another authenticated request", async () => {
    const original = globalThis.fetch;
    let redirect: RequestRedirect | undefined;
    globalThis.fetch = (async (_input, init) => {
      redirect = init?.redirect;
      return Response.json({});
    }) as typeof fetch;
    try {
      await fetchProviderJson(
        "https://example.invalid/usage",
        auth,
        new AbortController().signal,
        1000,
        "Fixture",
      );
      assert.equal(redirect, "error");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("redacts response strings before normalizers can shorten them", async () => {
    const original = globalThis.fetch;
    const secret = "long-prefix-" + "x".repeat(900);
    globalThis.fetch = (async (_input, _init) =>
      Response.json({
        plan_type: secret,
        nested: [{ label: secret, used: 7 }],
        [secret]: "field",
      })) as typeof fetch;
    try {
      const payload = await fetchProviderJson(
        "https://example.invalid/usage",
        { ...auth, secrets: [secret] },
        new AbortController().signal,
        1000,
        "Fixture",
      );
      assert.deepEqual(payload, {
        plan_type: "<redacted>",
        nested: [{ label: "<redacted>", used: 7 }],
        "<redacted>": "field",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not expose truncated secrets from HTTP error bodies", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      new Response("synthetic-key".repeat(1000), { status: 401 })) as typeof fetch;
    try {
      await assert.rejects(
        fetchProviderJson(
          "https://example.invalid/usage",
          auth,
          new AbortController().signal,
          1000,
          "Fixture",
        ),
        { message: "Fixture returned HTTP 401." },
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not expose parser snippets from malformed JSON", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      new Response("not-json-synthetic-key")) as typeof fetch;
    try {
      await assert.rejects(
        fetchProviderJson(
          "https://example.invalid/usage",
          auth,
          new AbortController().signal,
          1000,
          "Fixture",
        ),
        { message: "Fixture returned invalid JSON." },
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects oversized success bodies", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) => new Response("x".repeat(65537))) as typeof fetch;
    try {
      await assert.rejects(
        fetchProviderJson(
          "https://example.invalid/usage",
          auth,
          new AbortController().signal,
          1000,
          "Fixture",
        ),
        /exceeded 65536 bytes/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects non-object JSON", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) => Response.json([])) as typeof fetch;
    try {
      await assert.rejects(
        fetchProviderJson(
          "https://example.invalid/usage",
          auth,
          new AbortController().signal,
          1000,
          "Fixture",
        ),
        /response was not an object/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects an exhausted deadline without fetching", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async (_input, _init) => {
      called = true;
      return Response.json({});
    }) as typeof fetch;
    try {
      await assert.rejects(
        fetchProviderJson(
          "https://example.invalid/usage",
          auth,
          new AbortController().signal,
          0,
          "Fixture",
        ),
        /deadline expired/,
      );
      assert.equal(called, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects an already aborted caller without fetching", async () => {
    const original = globalThis.fetch;
    let called = false;
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async (_input, _init) => {
      called = true;
      return Response.json({});
    }) as typeof fetch;
    try {
      await assert.rejects(
        fetchProviderJson(
          "https://example.invalid/usage",
          auth,
          controller.signal,
          1000,
          "Fixture",
        ),
        { name: "AbortError" },
      );
      assert.equal(called, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("aborts a request when its deadline expires", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch;
    try {
      await assert.rejects(
        fetchProviderJson(
          "https://example.invalid/usage",
          auth,
          new AbortController().signal,
          10,
          "Fixture",
        ),
        /Timed out/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
