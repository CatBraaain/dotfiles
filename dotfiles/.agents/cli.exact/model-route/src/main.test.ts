import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { run, scoreCandidates } from "./main";
import type { CandidateInput, CandidateResult, UsageState } from "./score";
import { CACHE_TTL_MS, loadSnapshot, saveSnapshot } from "./cache";

const NOW = Date.parse("2026-06-17T12:00:00+09:00");
const HOUR_MS = 3_600_000;

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function usageState(remaining: number, resetsInHours: number): UsageState {
  return {
    remaining,
    windowMinutes: 600,
    resetsAt: new Date(NOW + resetsInHours * HOUR_MS).toISOString(),
  };
}

function tempCache(): string {
  tempDir = mkdtempSync(join(tmpdir(), "model-route-main-test-"));
  return join(tempDir, "usage.json");
}

const freshStates = new Map([
  ["zai", usageState(40, 4)],
  ["command-code", usageState(90, 24 * 7)],
]);

function envBase(cachePath: string) {
  return {
    now: () => NOW,
    queryUsage: async () => freshStates,
    loadSnapshot: () => null,
    saveSnapshot: () => {},
    stderr: (_text: string) => {},
    cachePath,
  };
}

describe("scoreCandidates", () => {
  it("returns all facts and urgency in input order", async () => {
    const candidates = [
      { provider: "command-code", model: "m2" },
      { provider: "unknown", model: "m3" },
      { provider: "zai", model: "m1" },
      { provider: "zai", model: "m1" },
    ];
    const result = await scoreCandidates(candidates, envBase(tempCache()));
    assert.deepEqual(
      result.map(({ provider, model }) => ({ provider, model })),
      candidates,
    );
    assert.equal(result[0]?.urgency, (0.9 * 600) / (168 * 60));
    assert.equal(result[1]?.urgency, null);
    assert.equal(result[2]?.urgency, 1);
    assert.deepEqual(result[2], result[3]);
    assert.equal(Object.hasOwn(result[0]!, "score"), false);
  });

  it("uses a valid snapshot without querying missing providers", async () => {
    const cachePath = tempCache();
    saveSnapshot(cachePath, {
      fetchedAt: NOW - 60_000,
      states: new Map([["zai", usageState(80, 10)]]),
    });
    let queries = 0;
    const scored = await scoreCandidates(
      [
        { provider: "zai", model: "m1" },
        { provider: "unknown", model: "m2" },
      ],
      {
        ...envBase(cachePath),
        loadSnapshot,
        queryUsage: async () => {
          queries++;
          return freshStates;
        },
      },
    );
    assert.equal(queries, 0);
    assert.equal(scored[0]?.usageState?.source, "cache");
    assert.equal(scored[0]?.usageState?.remaining, 80);
    assert.equal(scored[1]?.urgency, null);
  });

  it.each([false, true])(
    "caches successful unknown results across calls (empty=%s)",
    async (empty) => {
      const cachePath = tempCache();
      let now = NOW;
      let queries = 0;
      const deps = {
        ...envBase(cachePath),
        loadSnapshot,
        saveSnapshot,
        now: () => now,
        queryUsage: async () => {
          queries++;
          return empty ? new Map<string, UsageState>() : freshStates;
        },
      };
      const candidates = [
        { provider: "zai", model: "m1" },
        { provider: "unknown", model: "m2" },
      ];
      await scoreCandidates(candidates, deps);
      now += CACHE_TTL_MS;
      const cached = await scoreCandidates(
        [...candidates, { provider: "new-provider", model: "m3" }],
        deps,
      );
      assert.equal(queries, 1);
      assert.equal(cached.length, 3);
      assert.equal(cached.find((candidate) => candidate.provider === "unknown")?.urgency, null);
      if (!empty) assert.equal(cached[0]?.usageState?.source, "cache");
      now++;
      await scoreCandidates(candidates, deps);
      assert.equal(queries, 2);
    },
  );

  it("does not persist failed queries and keeps every candidate", async () => {
    const cachePath = tempCache();
    let queries = 0;
    let saves = 0;
    const deps = {
      ...envBase(cachePath),
      loadSnapshot,
      queryUsage: async () => {
        queries++;
        return null;
      },
      saveSnapshot: () => {
        saves++;
      },
    };
    const candidates = [
      { provider: "zai", model: "m1" },
      { provider: "command-code", model: "m2" },
    ];
    const scored = await scoreCandidates(candidates, deps);
    await scoreCandidates(candidates, deps);
    assert.equal(queries, 2);
    assert.equal(saves, 0);
    assert.deepEqual(
      scored.map(({ provider }) => provider),
      ["zai", "command-code"],
    );
    assert.ok(scored.every((candidate) => candidate.urgency === null));
  });

  it("uses the commandcode alias for usage lookup", async () => {
    const scored = await scoreCandidates(
      [{ provider: "commandcode", model: "m1" }],
      envBase(tempCache()),
    );
    assert.equal(scored[0]?.usageState?.remaining, 90);
  });

  it.each([-1, 0, 0.001])(
    "checks fresh resets against query completion time (offset=%s)",
    async (hours) => {
      const cachePath = tempCache();
      let now = NOW;
      const scored = await scoreCandidates([{ provider: "zai", model: "m1" }], {
        ...envBase(cachePath),
        loadSnapshot,
        saveSnapshot,
        now: () => now,
        queryUsage: async () => {
          now += 10_000;
          return new Map([["zai", usageState(80, hours)]]);
        },
      });
      assert.equal(scored.length, 1);
      assert.equal(scored[0]?.urgency, null);
      assert.equal(scored[0]?.usageState, null);
      assert.equal(loadSnapshot(cachePath, now)?.fetchedAt, now);
    },
  );

  it("calculates fresh urgency using the time after the query", async () => {
    let now = NOW;
    const scored = await scoreCandidates([{ provider: "zai", model: "m1" }], {
      ...envBase(tempCache()),
      now: () => now,
      queryUsage: async () => {
        now += HOUR_MS;
        return new Map([["zai", usageState(80, 3)]]);
      },
    });
    assert.equal(scored[0]?.urgency, 4);
  });

  it("treats reset cached windows as unknown without bypassing snapshot TTL", async () => {
    const cachePath = tempCache();
    saveSnapshot(cachePath, { fetchedAt: NOW, states: new Map([["zai", usageState(80, 0.001)]]) });
    let queries = 0;
    const scored = await scoreCandidates([{ provider: "zai", model: "m1" }], {
      ...envBase(cachePath),
      loadSnapshot,
      now: () => NOW + 10_000,
      queryUsage: async () => {
        queries++;
        return freshStates;
      },
    });
    assert.equal(queries, 0);
    assert.equal(scored[0]?.urgency, null);
    assert.equal(scored[0]?.usageState, null);
  });

  it("skips usage when there are no candidates", async () => {
    let queries = 0;
    const scored = await scoreCandidates([], {
      ...envBase(tempCache()),
      queryUsage: async () => {
        queries++;
        return freshStates;
      },
    });
    assert.equal(queries, 0);
    assert.deepEqual(scored, []);
  });
});

describe("cached urgency", () => {
  it("recalculates urgency from facts as time passes", async () => {
    const cachePath = tempCache();
    const states = new Map([["zai", usageState(50, 2)]]);
    saveSnapshot(cachePath, { fetchedAt: NOW, states });
    const candidates = [{ provider: "zai", model: "m" }];
    const first = await scoreCandidates(candidates, { ...envBase(cachePath), loadSnapshot });
    const later = await scoreCandidates(candidates, {
      ...envBase(cachePath),
      loadSnapshot,
      now: () => NOW + 4 * 60_000,
    });
    assert.equal(first[0]?.urgency, 2.5);
    assert.equal(later[0]?.urgency, (0.5 * 600) / 116);
    assert.equal(later[0]?.usageState?.source, "cache");
  });

  it("keeps duration-less cache facts with null urgency and no query", async () => {
    const cachePath = tempCache();
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 2,
        fetchedAt: NOW,
        entries: { zai: { remaining: 80, resetsAt: usageState(80, 10).resetsAt } },
      }),
    );
    const result = await scoreCandidates([{ provider: "zai", model: "m" }], {
      ...envBase(cachePath),
      loadSnapshot,
      queryUsage: async () => {
        assert.fail("A valid snapshot must not trigger a query");
      },
    });
    assert.equal(result[0]?.urgency, null);
    assert.equal(result[0]?.usageState?.windowMinutes, null);
    assert.equal(result[0]?.usageState?.remaining, 80);
  });
});

describe("CLI process", () => {
  it.each([false, true])(
    "keeps stdin JSON separate from cache warnings (blocked cache=%s)",
    (blocked) => {
      tempCache();
      const cacheRoot = join(tempDir!, "cache");
      if (blocked) writeFileSync(cacheRoot, "blocking parent");
      const queryLog = join(tempDir!, "queries.log");
      writeFileSync(
        join(tempDir!, "usage"),
        `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (JSON.stringify(process.argv.slice(2)) !== '["--json"]') process.exit(1);
appendFileSync(${JSON.stringify(queryLog)}, "query\\n");
console.log(JSON.stringify([
  { provider: "zai", long: 80, longWindowMinutes: 600, longResetsAt: new Date(Date.now() + 3_600_000).toISOString() },
  { provider: "unknown", long: null, longResetsAt: null }
]));
`,
        { mode: 0o755 },
      );
      const candidates = [
        { provider: "zai", model: "m1" },
        { provider: "unknown", model: "m2" },
      ];
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = Bun.spawnSync(
          [process.execPath, join(import.meta.dir, "main.ts"), "score"],
          {
            env: {
              ...process.env,
              PATH: `${tempDir}:${process.env.PATH}`,
              XDG_CACHE_HOME: cacheRoot,
            },
            stdin: Buffer.from(JSON.stringify({ candidates })),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        assert.equal(result.exitCode, 0, result.stderr.toString());
        const scored: CandidateResult[] = JSON.parse(result.stdout.toString());
        assert.equal(scored.length, candidates.length);
        assert.ok((scored[0]?.urgency ?? 0) >= 8);
        assert.equal(scored[0]?.usageState?.source, blocked || attempt === 0 ? "fresh" : "cache");
        assert.equal(scored[1]?.urgency, null);
        if (blocked) assert.match(result.stderr.toString(), /model-route: cache save failed/);
        else assert.equal(result.stderr.toString(), "");
      }
      assert.equal(readFileSync(queryLog, "utf8"), blocked ? "query\nquery\n" : "query\n");
    },
  );
});

describe("run", () => {
  it.each([
    { provider: "zai", usage: false, urgency: 1 },
    { provider: "zai", usage: "command-code", urgency: 1 },
    { provider: "zai", usage: true, urgency: 1 },
    { provider: "zai", usage: "", urgency: 1 },
    { provider: "unknown", usage: "zai", urgency: null },
    { provider: "commandcode", usage: false, urgency: (0.9 * 600) / (24 * 7 * 60) },
  ])("uses only provider and omits old usage fields: %j", async ({ provider, usage, urgency }) => {
    const cachePath = tempCache();
    const inputPath = join(tempDir!, "candidates.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        candidates: [
          {
            provider,
            model: "m1",
            usage,
            extra: true,
            weight: -1,
            adjust: "invalid",
            conditions: 42,
            score: 100,
          },
        ],
      }),
    );
    let output = "";
    const exitCode = await run(["score", inputPath], {
      ...envBase(cachePath),
      stdout: (text) => {
        output += text;
      },
    });
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(output) as CandidateResult[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.urgency, urgency);
    assert.equal(parsed[0]?.provider, provider);
    assert.equal(Object.hasOwn(parsed[0]!, "usage"), false);
    assert.equal(Object.hasOwn(parsed[0]!, "extra"), false);
    assert.deepEqual(Object.keys(parsed[0]!).sort(), [
      "model",
      "provider",
      "urgency",
      "usageState",
    ]);
  });

  it.each([
    { name: "empty input", candidates: [] },
    { name: "one candidate", candidates: [{ provider: "zai", model: "m1" }] },
    {
      name: "unknown usage",
      candidates: [
        { provider: "zai", model: "m1" },
        { provider: "command-code", model: "m2" },
      ],
    },
    {
      name: "exhausted, unknown, and duplicate candidates",
      candidates: [
        { provider: "zai", model: "m1" },
        { provider: "command-code", model: "m2" },
        { provider: "unknown", model: "m3" },
        { provider: "zai", model: "m1", weight: 2 },
      ],
    },
  ])("returns every candidate as an array for $name", async ({ name, candidates }) => {
    const cachePath = tempCache();
    const inputPath = join(tempDir!, "candidates.json");
    writeFileSync(inputPath, JSON.stringify({ candidates }));
    let output = "";
    let queryCalls = 0;
    const exitCode = await run(["score", inputPath], {
      ...envBase(cachePath),
      queryUsage: async () => {
        queryCalls++;
        if (name === "unknown usage") return null;
        return new Map([
          ["zai", usageState(0, 4)],
          ["command-code", usageState(90, 24)],
        ]);
      },
      stdout: (text) => {
        output += text;
      },
      stderr: () => {},
    });
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(output) as CandidateResult[];
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, candidates.length);
    assert.deepEqual(
      parsed.map(({ provider, model }) => JSON.stringify({ provider, model })).sort(),
      candidates
        .map(({ provider, model }: CandidateInput) => JSON.stringify({ provider, model }))
        .sort(),
    );
    if (candidates.length === 0) {
      assert.deepEqual(parsed, []);
      assert.equal(queryCalls, 0);
    }
    if (name === "unknown usage") {
      assert.ok(parsed.every((candidate) => candidate.urgency === null));
      assert.deepEqual(
        parsed.map(({ provider }) => provider),
        ["zai", "command-code"],
      );
    }
    if (name === "exhausted, unknown, and duplicate candidates") {
      assert.deepEqual(
        parsed.map(({ provider }) => provider),
        ["zai", "command-code", "unknown", "zai"],
      );
      assert.equal(parsed[0]?.urgency, 0);
      assert.equal(parsed[1]?.urgency, 0.375);
      assert.equal(parsed[2]?.urgency, null);
      assert.equal(parsed[3]?.urgency, 0);
    }
  });

  it("returns candidate JSON in input order", async () => {
    const cachePath = tempCache();
    const inputPath = join(tempDir!, "candidates.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      inputPath,
      JSON.stringify({
        candidates: [
          { provider: "zai", model: "m1" },
          { provider: "command-code", model: "m2" },
        ],
      }),
    );
    let output = "";
    const exitCode = await run(["score", inputPath], {
      ...envBase(cachePath),
      stdout: (text) => {
        output += text;
      },
      stderr: () => {},
    });
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(output) as CandidateResult[];
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(
      parsed.map((candidate) => candidate.provider),
      ["zai", "command-code"],
    );
  });

  it("reads candidates from an input file", async () => {
    const cachePath = tempCache();
    const inputPath = join(tempDir!, "candidates.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(inputPath, JSON.stringify({ candidates: [{ provider: "zai", model: "m1" }] }));
    let output = "";
    const exitCode = await run(["score", inputPath], {
      ...envBase(cachePath),
      stdout: (text) => {
        output += text;
      },
      stderr: () => {},
    });
    assert.equal(exitCode, 0);
    assert.match(output, /"zai"/);
  });

  it("rejects malformed input with exit code 2", async () => {
    const cachePath = tempCache();
    const inputPath = join(tempDir!, "bad.json");
    writeFileSync(inputPath, "not json");
    let output = "";
    const exitCode = await run(["score", inputPath], {
      ...envBase(cachePath),
      stdout: () => {},
      stderr: (text) => {
        output += text;
      },
    });
    assert.equal(exitCode, 2);
    assert.match(output, /model-route:/);
  });

  it("candidates が配列でない入力は exit 2", async () => {
    const cachePath = tempCache();
    const inputPath = join(tempDir!, "bad.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(inputPath, JSON.stringify({ candidates: "nope" }));
    const exitCode = await run(["score", inputPath], {
      ...envBase(cachePath),
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(exitCode, 2);
  });

  it.each([
    { argv: ["refresh"] },
    { argv: ["score", "--ttl-minutes", "1"] },
    { argv: ["score", "--usage-cli", "other"] },
    { argv: ["unknown"] },
    { argv: ["score", "--other"] },
    { argv: ["score", "one", "two"] },
  ])("rejects unsupported arguments without querying: $argv", async ({ argv }) => {
    let queries = 0;
    let output = "";
    let diagnostic = "";
    const exitCode = await run([...argv], {
      ...envBase(tempCache()),
      queryUsage: async () => {
        queries++;
        return freshStates;
      },
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        diagnostic += text;
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(queries, 0);
    assert.equal(output, "");
    assert.match(diagnostic, /usage: model-route score/);
  });

  it("keeps fresh JSON output and warns only on stderr when saving fails", async () => {
    const cachePath = tempCache();
    const inputPath = join(tempDir!, "input.json");
    writeFileSync(inputPath, JSON.stringify({ candidates: [{ provider: "zai", model: "m1" }] }));
    let output = "";
    let diagnostic = "";
    const exitCode = await run(["score", inputPath], {
      ...envBase(cachePath),
      saveSnapshot: () => {
        throw new Error("EACCES");
      },
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        diagnostic += text;
      },
    });
    assert.equal(exitCode, 0);
    const parsed: CandidateResult[] = JSON.parse(output);
    assert.equal(parsed[0]?.urgency, 1);
    assert.equal(parsed[0]?.usageState?.source, "fresh");
    assert.match(diagnostic, /model-route: cache save failed: EACCES/);
  });

  it("keeps fresh urgency when the real cache path is unwritable", async () => {
    const cachePath = tempCache();
    writeFileSync(cachePath, "blocking parent");
    const warnings: string[] = [];
    const scored = await scoreCandidates([{ provider: "zai", model: "m1" }], {
      ...envBase(join(cachePath, "usage.json")),
      loadSnapshot,
      saveSnapshot,
      stderr: (text) => {
        warnings.push(text);
      },
    });
    assert.equal(scored[0]?.urgency, 1);
    assert.equal(scored[0]?.usageState?.source, "fresh");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cache save failed/);
  });

  it("不明なコマンドは exit 2 で usage を出す", async () => {
    let output = "";
    const exitCode = await run([], {
      ...envBase(tempCache()),
      stdout: () => {},
      stderr: (text) => {
        output += text;
      },
    });
    assert.equal(exitCode, 2);
    assert.match(output, /usage: model-route/);
  });
});
