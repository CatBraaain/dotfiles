import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type RunEnv } from "./main";
import type { summarizeProviderUsageJson } from "./summary";
import type { UsageProviderAdapter } from "./types";

type UsageSummary = ReturnType<typeof summarizeProviderUsageJson>;

interface Fixture {
  env: RunEnv;
  calls: string[];
  stdout: string[];
  stderr: string[];
  agentDir: string;
}

async function withCli(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "usage-main-"));
  const agentDir = join(homeDir, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      first: { type: "api_key", key: "first-secret" },
      current: {
        type: "oauth",
        access: "current-secret",
        refresh: "refresh-secret",
        expires: 2_000,
      },
      expired: {
        type: "oauth",
        access: "expired-secret",
        refresh: "expired-refresh",
        expires: 999,
      },
    }),
  );
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "current" }));
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const adapters = ["first", "missing", "current", "expired"].map((id): UsageProviderAdapter => ({
    id,
    displayName: `Provider ${id}`,
    semantics: { kind: "api-key", label: "API balance" },
    async query() {
      calls.push(id);
      return {
        providerId: id,
        providerName: `Provider ${id}`,
        capturedAt: 1_000,
        source: "fixture",
        semantics: { kind: "api-key", label: "API balance" },
        buckets: [],
        metrics: [],
      };
    },
  }));
  const env: RunEnv = {
    homeDir,
    variables: {},
    now: () => 1_000,
    adapters,
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    renderProviderState: (state) => `${state.providerId}: ${state.status}`,
  };
  try {
    await action({ env, calls, stdout, stderr, agentDir });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe("run", () => {
  it("queries configured providers and reports expired credentials with current first", async () => {
    await withCli(async ({ env, calls, stdout, stderr }) => {
      assert.equal(await run([], env), 0);
      assert.deepEqual(calls, ["first", "current"]);
      assert.deepEqual(stdout, [
        "                  short  shortResetsAt   long  longResetsAt\ncurrent: ready\nfirst: ready\nexpired: auth-unavailable",
      ]);
      assert.deepEqual(stderr, []);
    });
  });

  it("prints missing cells and returns 1 when the normal display query fails", async () => {
    await withCli(async ({ env, stdout, stderr }) => {
      env.renderProviderState = undefined;
      env.adapters = env.adapters!.map((adapter) => ({
        ...adapter,
        async query() {
          throw new Error("first-secret 50% remaining");
        },
      }));
      assert.equal(await run(["first"], env), 1);
      const expected = [
        `${"".padEnd("Provider first".length)}  short  shortResetsAt   long  longResetsAt`,
        "Provider first      —              —      —             —",
      ].join("\n");
      assert.deepEqual(stdout, [expected]);
      assert.deepEqual(stderr, []);
    });
  });

  it("prints provider, nullable remaining percentages and reset times instead of invoking the renderer", async () => {
    await withCli(async ({ env, stdout }) => {
      env.renderProviderState = () => {
        throw new Error("JSON must not render human blocks");
      };
      assert.equal(await run(["--json"], env), 0);
      const states = JSON.parse(stdout[0]!) as UsageSummary[];
      assert.deepEqual(states, [
        {
          provider: "current",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
        {
          provider: "first",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
        {
          provider: "expired",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
      ]);
      assert.equal(stdout[0], JSON.stringify(states, null, 2));
      assert.doesNotMatch(stdout[0]!, /first-secret|current-secret|refresh-secret/);
    });
  });

  it("attempts only explicitly requested providers even when authentication is missing", async () => {
    await withCli(async ({ env, calls, stdout }) => {
      assert.equal(await run(["missing", "--json"], env), 1);
      assert.deepEqual(calls, []);
      const states = JSON.parse(stdout[0]!) as UsageSummary[];
      assert.deepEqual(states, [
        {
          provider: "missing",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
      ]);
    });
  });

  it("preserves registry order after current and queries repeated IDs only once", async () => {
    await withCli(async ({ env, calls, stdout }) => {
      assert.equal(await run(["current", "missing", "first", "first", "--json"], env), 0);
      assert.deepEqual(calls, ["first", "current"]);
      const states = JSON.parse(stdout[0]!) as UsageSummary[];
      assert.deepEqual(
        states.map((state) => state.provider),
        ["current", "first", "missing"],
      );
    });
  });

  it("returns null percentages for forced expired OAuth without extra JSON fields", async () => {
    await withCli(async ({ env, calls, stdout }) => {
      assert.equal(await run(["expired", "--json"], env), 1);
      assert.deepEqual(calls, []);
      const states = JSON.parse(stdout[0]!) as UsageSummary[];
      assert.deepEqual(states, [
        {
          provider: "expired",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
      ]);
    });
  });

  it("returns 1 when all attempted queries fail and redacts their errors", async () => {
    await withCli(async ({ env, stdout, stderr }) => {
      env.adapters = env.adapters!.map((adapter) => ({
        ...adapter,
        async query() {
          throw new Error("first-secret current-secret refresh-secret");
        },
      }));
      assert.equal(await run(["first", "--json"], env), 1);
      const states = JSON.parse(stdout[0]!) as UsageSummary[];
      assert.deepEqual(states, [
        {
          provider: "first",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
      ]);
      assert.doesNotMatch(stdout[0]!, /first-secret/);
      assert.deepEqual(stderr, []);
    });
  });

  it("returns 0 for partial success", async () => {
    await withCli(async ({ env, stdout }) => {
      env.adapters = env.adapters!.map((adapter) =>
        adapter.id === "first"
          ? {
              ...adapter,
              async query() {
                throw new Error("failed");
              },
            }
          : adapter,
      );
      assert.equal(await run(["--json"], env), 0);
      const states = JSON.parse(stdout[0]!) as UsageSummary[];
      assert.deepEqual(states, [
        {
          provider: "current",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
        {
          provider: "first",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
        {
          provider: "expired",
          short: null,
          shortResetsAt: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
      ]);
    });
  });

  it("lists metadata and authentication type without querying or disclosing credentials", async () => {
    await withCli(async ({ env, calls, stdout, stderr }) => {
      assert.equal(await run(["list", "--json"], env), 0);
      assert.deepEqual(calls, []);
      assert.deepEqual(JSON.parse(stdout[0]!), [
        {
          id: "first",
          displayName: "Provider first",
          semantics: "api-key",
          authenticated: true,
          authType: "api_key",
        },
        {
          id: "missing",
          displayName: "Provider missing",
          semantics: "api-key",
          authenticated: false,
          authType: null,
        },
        {
          id: "current",
          displayName: "Provider current",
          semantics: "api-key",
          authenticated: true,
          authType: "oauth",
        },
        {
          id: "expired",
          displayName: "Provider expired",
          semantics: "api-key",
          authenticated: false,
          authType: null,
        },
      ]);
      assert.doesNotMatch(stdout[0]!, /secret|refresh|Bearer/);
      assert.deepEqual(stderr, []);
    });
  });

  it("prints tab-separated human list rows", async () => {
    await withCli(async ({ env, calls, stdout }) => {
      assert.equal(await run(["--json", "list"], env), 0);
      stdout.length = 0;
      assert.equal(await run(["list"], env), 0);
      assert.match(
        stdout[0]!,
        /^first\tProvider first\tapi-key\tapi_key\nmissing\tProvider missing\tapi-key\tunavailable\ncurrent\tProvider current\tapi-key\toauth/,
      );
      assert.deepEqual(calls, []);
    });
  });

  for (const argv of [
    ["--help"],
    ["--unknown"],
    ["unknown"],
    ["first", "unknown"],
    ["list", "first"],
    ["first", "list"],
  ]) {
    it(`returns usage error 2 without querying for ${argv.join(" ")}`, async () => {
      await withCli(async ({ env, calls, stdout, stderr }) => {
        assert.equal(await run(argv, env), 2);
        assert.deepEqual(calls, []);
        assert.deepEqual(stdout, []);
        assert.match(stderr[0]!, /^usage: /);
        assert.equal(
          stderr[1],
          "usage: usage [<provider> ...] [--json]\n       usage list [--json]",
        );
      });
    });
  }

  it("returns success with an empty array when no provider is authenticated", async () => {
    await withCli(async ({ env, agentDir, calls, stdout }) => {
      await writeFile(join(agentDir, "auth.json"), "{}");
      assert.equal(await run(["--json"], env), 0);
      assert.deepEqual(calls, []);
      assert.deepEqual(stdout, ["[]"]);
    });
  });

  it("produces no human blocks when no provider is authenticated", async () => {
    await withCli(async ({ env, agentDir, stdout }) => {
      await writeFile(join(agentDir, "auth.json"), "{}");
      assert.equal(await run([], env), 0);
      assert.deepEqual(stdout, []);
    });
  });

  it("reports malformed auth storage on stderr with exit 1", async () => {
    await withCli(async ({ env, agentDir, calls, stdout, stderr }) => {
      await writeFile(join(agentDir, "auth.json"), "secret-credential-json-fragment");
      assert.equal(await run([], env), 1);
      assert.deepEqual(calls, []);
      assert.deepEqual(stdout, []);
      assert.deepEqual(stderr, ["usage: Invalid auth.json: expected a JSON object."]);
    });
  });

  it("uses Z.AI environment auth with the current provider", async () => {
    await withCli(async ({ env, agentDir, stdout }) => {
      await writeFile(join(agentDir, "auth.json"), "{}");
      await writeFile(join(agentDir, "settings.json"), '{"defaultProvider":"zai"}');
      env.variables = { ZAI_API_KEY: "environment-secret" };
      env.adapters = undefined;
      const originalFetch = globalThis.fetch;
      async function fakeFetch(): Promise<Response> {
        return Response.json({
          data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 20 }] },
        });
      }
      globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
      try {
        assert.equal(await run(["--json"], env), 0);
        const states = JSON.parse(stdout[0]!) as UsageSummary[];
        assert.deepEqual(states, [
          {
            provider: "zai",
            short: null,
            shortResetsAt: null,
            long: 80,
            longResetsAt: null,
            longWindowMinutes: 300,
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("stored auth to fixed endpoint integration", () => {
  const shortResetsAt = new Date(2026, 0, 2, 3, 4).getTime() / 1000;
  const longResetsAt = new Date(2026, 11, 31, 23, 59).getTime() / 1000;
  const oauth = {
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: 2_000,
  };
  const cases = [
    {
      id: "openai-codex",
      credential: { ...oauth, accountId: "fixture-account" },
      urls: ["https://chatgpt.com/backend-api/wham/usage"],
      authorization: "Bearer fixture-access",
      short: 80,
      long: 70,
      humanRow: "Codex      80%    01/02 03:04    70%   12/31 23:59",
      payloads: [
        {
          rate_limit: {
            primary_window: {
              used_percent: 20,
              limit_window_seconds: 18000,
              reset_at: shortResetsAt,
            },
            secondary_window: {
              used_percent: 30,
              limit_window_seconds: 604800,
              reset_at: longResetsAt,
            },
          },
          plan_type: "fixture-access",
        },
      ],
    },
    {
      id: "zai",
      credential: { type: "api_key", key: "fixture-access" },
      urls: [
        "https://api.z.ai/api/monitor/usage/quota/limit",
        "https://api.z.ai/api/biz/subscription/list",
      ],
      authorization: "fixture-access",
      short: 80,
      long: 70,
      humanRow: "Z.AI       80%    01/02 03:04    70%   12/31 23:59",
      payloads: [
        {
          data: {
            limits: [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                percentage: 20,
                nextResetTime: shortResetsAt * 1000,
              },
              { type: "TOKENS_LIMIT", unit: 6, percentage: 30, nextResetTime: longResetsAt * 1000 },
              { type: "TIME_LIMIT", currentValue: 2, usage: 100 },
            ],
          },
        },
        { data: [] },
      ],
    },
    {
      id: "command-code",
      credential: { type: "api_key", key: "fixture-access" },
      urls: [
        "https://api.commandcode.ai/alpha/whoami",
        "https://api.commandcode.ai/alpha/billing/credits",
        "https://api.commandcode.ai/alpha/billing/subscriptions",
        "https://api.commandcode.ai/alpha/usage/summary",
      ],
      authorization: "Bearer fixture-access",
      short: 90,
      long: 83,
      humanRow: "Command    90%    01/02 03:04    83%   12/31 23:59",
      payloads: [
        { user: { userName: "tester" } },
        {
          credits: { monthlyCredits: 10 },
          windowLimits: {
            fiveHour: { used: 1, cap: 10, resetAt: shortResetsAt * 1000 },
            weekly: { used: 2, cap: 100, resetAt: longResetsAt * 1000 },
          },
        },
        { data: { currentPeriodEnd: new Date(longResetsAt * 1000).toISOString() } },
        { totalCost: 2 },
      ],
    },
  ];

  for (const fixture of cases) {
    it("projects saved " + fixture.id + " auth into adapter request headers", async () => {
      await withCli(async ({ env, agentDir, stdout }) => {
        await writeFile(
          join(agentDir, "auth.json"),
          JSON.stringify({ [fixture.id]: fixture.credential }),
        );
        env.adapters = undefined;
        env.renderProviderState = undefined;
        const originalFetch = globalThis.fetch;
        const requests: Array<{ url: string; headers: Headers }> = [];
        async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          assert.equal(init?.redirect, "error");
          requests.push({ url: String(input), headers: new Headers(init?.headers) });
          return Response.json(fixture.payloads[requests.length - 1]);
        }
        globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
        try {
          assert.equal(await run(["--json"], env), 0);
          assert.deepEqual(
            requests.map((request) => request.url),
            fixture.urls,
          );
          for (const request of requests)
            assert.equal(request.headers.get("Authorization"), fixture.authorization);
          if (fixture.id === "openai-codex")
            assert.equal(requests[0]?.headers.get("ChatGPT-Account-Id"), "fixture-account");
          const states = JSON.parse(stdout[0]!) as UsageSummary[];
          assert.deepEqual(states, [
            {
              provider: fixture.id,
              short: fixture.short,
              shortResetsAt: states[0]?.shortResetsAt,
              long: fixture.long,
              longWindowMinutes: fixture.id === "command-code" ? 43200 : 10080,
              longResetsAt: states[0]?.longResetsAt,
            },
          ]);
          assert.equal(Date.parse(states[0]!.shortResetsAt!), shortResetsAt * 1000);
          assert.equal(Date.parse(states[0]!.longResetsAt!), longResetsAt * 1000);
          assert.match(states[0]!.shortResetsAt!, /^2026-01-02T03:04:00[+-][0-9]{2}:[0-9]{2}$/u);
          assert.match(states[0]!.longResetsAt!, /^2026-12-31T23:59:00[+-][0-9]{2}:[0-9]{2}$/u);
          assert.doesNotMatch(stdout[0]!, /fixture-access|fixture-refresh|fixture-account/);
          stdout.length = 0;
          requests.length = 0;
          assert.equal(await run([fixture.id], env), 0);
          assert.equal(
            stdout[0],
            `         short  shortResetsAt   long  longResetsAt\n${fixture.humanRow}`,
          );
          assert.doesNotMatch(stdout[0]!, /fixture-access|fixture-refresh|fixture-account/);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });
  }

  for (const fixture of [
    { id: "openai-codex", credential: oauth, message: /accountId/ },
    { id: "openai-codex", credential: { ...oauth, expires: 999 }, message: /expired/ },
    { id: "openai-codex", credential: null, message: /Invalid/ },
  ]) {
    it(
      "reports configured but unavailable " +
        fixture.id +
        " auth without a request: " +
        fixture.message,
      async () => {
        await withCli(async ({ env, agentDir, stdout }) => {
          await writeFile(
            join(agentDir, "auth.json"),
            JSON.stringify({ [fixture.id]: fixture.credential }),
          );
          env.adapters = undefined;
          const originalFetch = globalThis.fetch;
          let calls = 0;
          async function fakeFetch(): Promise<Response> {
            calls += 1;
            throw new Error("Network is forbidden");
          }
          globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
          try {
            assert.equal(await run(["--json"], env), 1);
            assert.equal(calls, 0);
            const states = JSON.parse(stdout[0]!) as UsageSummary[];
            assert.deepEqual(states, [
              {
                provider: fixture.id,
                short: null,
                shortResetsAt: null,
                long: null,
                longResetsAt: null,
                longWindowMinutes: null,
              },
            ]);
          } finally {
            globalThis.fetch = originalFetch;
          }
        });
      },
    );
  }

  it("keeps canonical report IDs while preserving explicitly selected alias authentication", async () => {
    await withCli(async ({ env, agentDir, stdout }) => {
      await writeFile(
        join(agentDir, "auth.json"),
        JSON.stringify({
          commandcode: { type: "api_key", key: "alias-secret" },
          "command-code": { type: "api_key", key: "canonical-secret" },
        }),
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "commandcode" }),
      );
      env.adapters = undefined;
      const originalFetch = globalThis.fetch;
      const authorizations: Array<string | null> = [];
      async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://api.commandcode.ai");
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        if (url.pathname.endsWith("/whoami"))
          return Response.json({ user: { userName: "fixture-user" } });
        if (url.pathname.endsWith("/usage/summary")) return Response.json({ totalCost: 2 });
        return new Response("", { status: 500 });
      }
      globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
      try {
        for (const [argv, key] of [
          [[], "canonical-secret"],
          [["commandcode"], "alias-secret"],
          [["command-code"], "canonical-secret"],
          [["commandcode", "command-code"], "canonical-secret"],
          [["command-code", "commandcode"], "canonical-secret"],
        ] as const) {
          stdout.length = 0;
          authorizations.length = 0;
          assert.equal(await run([...argv, "--json"], env), 0);
          assert.ok(authorizations.length > 0);
          assert.ok(authorizations.every((value) => value === "Bearer " + key));
          const states = JSON.parse(stdout[0]!) as UsageSummary[];
          assert.equal(states.length, 1);
          assert.deepEqual(states[0], {
            provider: "command-code",
            short: null,
            shortResetsAt: null,
            long: null,
            longResetsAt: null,
            longWindowMinutes: null,
          });
        }
        await writeFile(
          join(agentDir, "auth.json"),
          JSON.stringify({
            commandcode: { type: "api_key", key: "alias-secret" },
          }),
        );
        stdout.length = 0;
        authorizations.length = 0;
        assert.equal(await run(["--json"], env), 0);
        assert.ok(authorizations.every((value) => value === "Bearer alias-secret"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("supported provider boundary", () => {
  it("lists exactly three providers in both output formats without requests", async () => {
    await withCli(async ({ env, agentDir, stdout }) => {
      await writeFile(join(agentDir, "auth.json"), "{}");
      env.adapters = undefined;
      assert.equal(await run(["list", "--json"], env), 0);
      const rows = JSON.parse(stdout[0]!) as Array<{ id: string }>;
      assert.deepEqual(
        rows.map((row) => row.id),
        ["openai-codex", "command-code", "zai"],
      );
      stdout.length = 0;
      assert.equal(await run(["list"], env), 0);
      assert.deepEqual(
        stdout[0]!.split("\n").map((line) => line.split("\t")[0]),
        ["openai-codex", "command-code", "zai"],
      );
    });
  });
  for (const providerId of [
    "baseten",
    "openai",
    "deepseek",
    "github-copilot",
    "openrouter",
    "vercel-ai-gateway",
    "fireworks",
    "opencode-go",
    "kimi-coding",
    "minimax",
    "minimax-cn",
    "moonshotai",
    "moonshotai-cn",
    "zai-coding-cn",
    "xai",
  ]) {
    it("rejects removed provider " + providerId + " before reading auth", async () => {
      const stderr: string[] = [];
      assert.equal(
        await run([providerId], {
          homeDir: "/nonexistent-usage-test-home",
          variables: {},
          stderr: (text) => {
            stderr.push(text);
          },
          stdout: () => {
            assert.fail("No output expected");
          },
        }),
        2,
      );
      assert.match(stderr[0]!, /unknown provider/);
    });
  }
});
