import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthContext, PROVIDER_ENV_VARS, resolveAuth, type AuthContext } from "./auth";

const NOW_MS = 1_800_000_000_000;

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return { credentials: {}, variables: {}, now: () => NOW_MS, ...overrides };
}

async function withHome(
  action: (homeDir: string, agentDir: string) => Promise<void>,
): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "usage-auth-"));
  const agentDir = join(homeDir, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  try {
    await action(homeDir, agentDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe("loadAuthContext", () => {
  it("reads provider-keyed auth.json and the default provider from an injected home", async () => {
    await withHome(async (homeDir, agentDir) => {
      const credentials = { zai: { type: "api_key", key: "fixture-key" } };
      await writeFile(join(agentDir, "auth.json"), JSON.stringify(credentials));
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zai" }));
      const loaded = await loadAuthContext({ homeDir, variables: {}, now: () => NOW_MS });
      assert.deepEqual(loaded.credentials, credentials);
      assert.equal(loaded.defaultProvider, "zai");
      assert.equal(loaded.now(), NOW_MS);
    });
  });

  it("uses the injected HOME environment variable", async () => {
    await withHome(async (homeDir, agentDir) => {
      await writeFile(join(agentDir, "auth.json"), '{"zai":{"type":"api_key","key":"home-key"}}');
      const loaded = await loadAuthContext({ variables: { HOME: homeDir } });
      const result = resolveAuth("zai", loaded);
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") assert.equal(result.auth.apiKey, "home-key");
    });
  });

  it("treats absent files as empty without creating them", async () => {
    await withHome(async (homeDir) => {
      const loaded = await loadAuthContext({ homeDir, variables: {} });
      assert.deepEqual(loaded.credentials, {});
      assert.equal(loaded.defaultProvider, undefined);
      assert.equal(resolveAuth("zai", loaded).status, "unavailable");
    });
  });

  it("accepts a UTF-8 BOM", async () => {
    await withHome(async (homeDir, agentDir) => {
      await writeFile(
        join(agentDir, "auth.json"),
        '\uFEFF{"zai":{"type":"api_key","key":"bom-key"}}',
      );
      const loaded = await loadAuthContext({ homeDir, variables: {} });
      assert.equal(resolveAuth("zai", loaded).status, "resolved");
    });
  });

  it("reports invalid JSON without exposing credential content", async () => {
    await withHome(async (homeDir, agentDir) => {
      await writeFile(join(agentDir, "auth.json"), "private-secret-not-json");
      await assert.rejects(loadAuthContext({ homeDir, variables: {} }), {
        message: "Invalid auth.json: expected a JSON object.",
      });
    });
  });

  it("rejects a non-object auth store", async () => {
    await withHome(async (homeDir, agentDir) => {
      await writeFile(join(agentDir, "auth.json"), "[]");
      await assert.rejects(loadAuthContext({ homeDir, variables: {} }), /expected a JSON object/);
    });
  });

  it("reports settings read failures instead of guessing the default provider", async () => {
    await withHome(async (homeDir, agentDir) => {
      await mkdir(join(agentDir, "settings.json"));
      await assert.rejects(loadAuthContext({ homeDir, variables: {} }), {
        message: "Unable to read settings.json.",
      });
    });
  });
});

describe("resolveAuth", () => {
  it("uses a saved API key before its environment fallback", () => {
    const result = resolveAuth(
      "zai",
      context({
        credentials: { zai: { type: "api_key", key: "stored-key" } },
        variables: { ZAI_API_KEY: "environment-key" },
      }),
    );
    assert.deepEqual(result, {
      status: "resolved",
      type: "api_key",
      auth: {
        apiKey: "stored-key",
        headers: { Authorization: "Bearer stored-key" },
        secrets: ["stored-key", "Bearer stored-key"],
      },
    });
  });

  it("maps Codex OAuth access and account binding to headers", () => {
    const result = resolveAuth(
      "openai-codex",
      context({
        credentials: {
          "openai-codex": {
            type: "oauth",
            access: "access-token",
            refresh: "refresh-token",
            expires: NOW_MS + 1,
            accountId: "account",
          },
        },
      }),
    );
    assert.deepEqual(result, {
      status: "resolved",
      type: "oauth",
      auth: {
        headers: { Authorization: "Bearer access-token", "ChatGPT-Account-Id": "account" },
        secrets: ["access-token", "refresh-token", "Bearer access-token", "account"],
      },
    });
  });

  it("refuses expired OAuth instead of falling back or refreshing", () => {
    for (const expires of [NOW_MS - 1, NOW_MS]) {
      const result = resolveAuth(
        "zai",
        context({
          credentials: { zai: { type: "oauth", access: "access", refresh: "refresh", expires } },
          variables: { ZAI_API_KEY: "fallback" },
        }),
      );
      assert.equal(result.status, "unavailable");
      if (result.status === "unavailable") assert.match(result.message, /expired/);
    }
  });

  it("rejects malformed or unsupported stored credentials", () => {
    for (const credential of [
      null,
      [],
      "key",
      { type: "api_key", key: 42 },
      { type: "api_key", key: " " },
      { type: "oauth", access: "token", refresh: "refresh", expires: "future" },
      { type: "oauth", access: "token", expires: NOW_MS + 1 },
      { type: "other", key: "key" },
    ]) {
      assert.deepEqual(
        resolveAuth("zai", context({ credentials: { zai: credential } })),
        {
          status: "unavailable",
          message: "Invalid stored credential.",
        },
        `credential: ${JSON.stringify(credential)}`,
      );
    }
  });

  it("does not execute command-based stored API keys", () => {
    assert.deepEqual(
      resolveAuth(
        "zai",
        context({ credentials: { zai: { type: "api_key", key: "!echo secret" } } }),
      ),
      {
        status: "unavailable",
        message: "Command-based API keys are not supported.",
      },
    );
  });

  it("uses exactly the environment names declared by the installed providers", () => {
    const expected = { zai: "ZAI_API_KEY" };
    assert.deepEqual(PROVIDER_ENV_VARS, expected);
    for (const [providerId, variable] of Object.entries(expected)) {
      const result = resolveAuth(
        providerId,
        context({ variables: { [variable]: "env-key" }, defaultProvider: providerId }),
      );
      assert.equal(result.status, "resolved", providerId);
      if (result.status === "resolved") assert.equal(result.auth.apiKey, "env-key", providerId);
    }
  });

  it("does not invent environment fallbacks for OAuth-only or extension providers", () => {
    for (const providerId of ["openai-codex", "command-code", "unknown", "constructor"]) {
      assert.equal(
        resolveAuth(
          providerId,
          context({ variables: { ZAI_API_KEY: "key", COMMAND_CODE_API_KEY: "key" } }),
        ).status,
        "unavailable",
        providerId,
      );
    }
  });

  it("treats an empty environment value as unavailable", () => {
    assert.equal(
      resolveAuth("zai", context({ variables: { ZAI_API_KEY: " " } })).status,
      "unavailable",
    );
  });
});

describe("provider credential constraints", () => {
  it("requires an account binding for Codex OAuth", () => {
    for (const accountId of [
      undefined,
      "",
      " ",
      123,
      "bad\r\nheader",
      "account\u0085id",
      "account\u009fid",
    ]) {
      const result = resolveAuth(
        "openai-codex",
        context({
          credentials: {
            "openai-codex": {
              type: "oauth",
              access: "access",
              refresh: "refresh",
              expires: NOW_MS + 1,
              accountId,
            },
          },
        }),
      );
      assert.equal(result.status, "unavailable");
      if (result.status === "unavailable") assert.match(result.message, /accountId/);
    }
  });

  it("uses the requested alias credential and otherwise prefers canonical storage", () => {
    const loaded = context({
      credentials: {
        commandcode: { type: "api_key", key: "alias-key" },
        "command-code": { type: "api_key", key: "canonical-key" },
      },
    });
    for (const [id, key] of [
      ["commandcode", "alias-key"],
      ["command-code", "canonical-key"],
    ] as const) {
      const result = resolveAuth(id, loaded);
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") assert.equal(result.auth.apiKey, key);
    }
    delete loaded.credentials["command-code"];
    const fallback = resolveAuth("command-code", loaded);
    assert.equal(fallback.status, "resolved");
    if (fallback.status === "resolved") assert.equal(fallback.auth.apiKey, "alias-key");
  });
});
