import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTwikitTweetMarkdown, renderTwitterTweets } from "./twitter-auth";

describe.skipIf(process.platform === "win32")("Twikit CLI script delivery", () => {
  const project = join(import.meta.dir, "..");
  let root = "";
  let executable = "";
  let pythonScript = "";
  let preload = "";

  beforeAll(() => {
    const tempParent = join(tmpdir(), "work", "dotfiles");
    mkdirSync(tempParent, { recursive: true });
    root = mkdtempSync(join(tempParent, "browse-twikit-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    pythonScript = readFileSync(join(project, "scripts/twikit_client.py"), "utf8");
    writeFileSync(
      join(bin, "uv"),
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TWIKIT_TRACE, JSON.stringify({
  args: process.argv.slice(2),
  script: await Bun.stdin.text(),
}));
if (process.env.TWIKIT_FAIL === "1") {
  console.error("fixture uv failure");
  process.exit(7);
}
console.log(JSON.stringify({
  userInfo: { name: "Alice", screenName: "alice" },
  tweets: [{ text: "fixture post", author: "Alice", screenName: "alice" }],
  tweet: { text: "fixture post", author: "Alice", screenName: "alice" },
  replies: [{ text: "fixture reply", author: "Bob", screenName: "bob" }],
}));
`,
      { mode: 0o755 },
    );
    preload = join(root, "fetch-preload.ts");
    writeFileSync(
      preload,
      `globalThis.fetch = async (input) => {
  if (String(input) !== "https://api.fxtwitter.com/status/123") {
    throw new Error("Unexpected network request: " + String(input));
  }
  return new Response(null, { status: 503, statusText: "Fixture unavailable" });
};
`,
    );
    const buildRoot = join(root, "dist");
    const copiedProject = join(buildRoot, "browse");
    mkdirSync(copiedProject, { recursive: true });
    for (const entry of ["src", "scripts", "package.json"]) {
      cpSync(join(project, entry), join(copiedProject, entry), { recursive: true });
    }
    const build = Bun.spawnSync([process.execPath, join(project, "../cli.build.ts")], {
      cwd: buildRoot,
      timeout: 30_000,
    });
    assert.equal(build.exitCode, 0, build.stderr.toString());
    assert.equal(existsSync(copiedProject), false);
    executable = join(buildRoot, "browse.executable");
    assert.ok(existsSync(executable));
  }, 30_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function runCli(
    mode: "source" | "compiled",
    url: string,
    options: { failUv?: boolean; cookies?: boolean; mockFxTwitter?: boolean } = {},
  ) {
    const cache = mkdtempSync(join(root, "cache-"));
    const cookieFile = join(cache, "pi/web-search/twitter-cookies.json");
    if (options.cookies !== false) {
      mkdirSync(join(cache, "pi/web-search"), { recursive: true });
      writeFileSync(cookieFile, "{}");
    }
    const tracePath = join(cache, "trace.json");
    const command =
      mode === "compiled"
        ? [executable]
        : [process.execPath, ...(options.mockFxTwitter ? ["--preload", preload] : []), project];
    const child = Bun.spawnSync([...command, "fetch", url, "--json"], {
      env: {
        ...process.env,
        BUN_OPTIONS: "",
        PATH: join(root, "bin"),
        XDG_CACHE_HOME: cache,
        TWIKIT_TRACE: tracePath,
        TWIKIT_FAIL: options.failUv ? "1" : "0",
      },
      timeout: 5000,
    });
    const trace = existsSync(tracePath)
      ? (JSON.parse(readFileSync(tracePath, "utf8")) as { args: string[]; script: string })
      : undefined;
    return {
      code: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      cookieFile,
      trace,
    };
  }

  const listCases = [
    {
      name: "user timeline",
      url: "https://x.com/alice",
      args: ["user", "alice", "--count", "40"],
      title: "Alice (@alice)",
      latest: false,
    },
    {
      name: "top search",
      url: "https://x.com/search?q=browse%20cli%20%E6%A4%9C%E7%B4%A2",
      args: ["search", "browse cli 検索", "--count", "20"],
      title: "Twitter search: browse cli 検索",
      latest: false,
    },
    {
      name: "latest search",
      url: "https://x.com/search?q=browse%20cli&f=live",
      args: ["search", "browse cli", "--count", "20"],
      title: "Twitter search: browse cli",
      latest: true,
    },
  ];

  for (const mode of ["source", "compiled"] as const) {
    for (const scenario of listCases) {
      it(`${mode}: delivers the full script and arguments for ${scenario.name}`, () => {
        const result = runCli(mode, scenario.url);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.ok(result.trace);
        assert.equal(result.trace.script, pythonScript);
        assert.deepEqual(result.trace.args, [
          "run",
          "--no-project",
          "--script",
          "-",
          ...scenario.args,
          "--cookie-file",
          result.cookieFile,
          ...(scenario.latest ? ["--latest"] : []),
        ]);
        const output = JSON.parse(result.stdout);
        assert.equal(output.backend, "Twitter-twikit");
        assert.equal(output.title, scenario.title);
        assert.match(output.body, /## Tweets \(1 retrieved\)/);
        assert.match(output.body, /fixture post/);
      });
    }

    it(`${mode}: propagates uv failures through the CLI error handler`, () => {
      const result = runCli(mode, "https://x.com/alice", { failUv: true });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /^All web fetch backends failed: Twitter-twikit: twifork wrapper failed \(uv\):/,
      );
      assert.match(result.stderr, /fixture uv failure/);
      assert.equal(result.trace?.script, pythonScript);
    });

    it(`${mode}: rejects missing cookies before starting uv`, () => {
      const result = runCli(mode, "https://x.com/alice", { cookies: false });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /No Twitter cookies found\. Run: browse login twitter/);
      assert.equal(result.trace, undefined);
    });
  }

  it("source: falls back from fxtwitter without network and keeps tweet replies", () => {
    const result = runCli("source", "https://x.com/alice/status/123", { mockFxTwitter: true });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.trace);
    assert.equal(result.trace.script, pythonScript);
    assert.deepEqual(result.trace.args, [
      "run",
      "--no-project",
      "--script",
      "-",
      "tweet",
      "123",
      "--cookie-file",
      result.cookieFile,
    ]);
    const output = JSON.parse(result.stdout);
    assert.equal(output.backend, "Twitter-twikit");
    assert.deepEqual(output.fallbacks, [
      { backend: "Twitter", error: "fxtwitter 503 Fixture unavailable" },
    ]);
    assert.match(output.body, /## Replies \(1 retrieved\)/);
    assert.match(output.body, /fixture reply/);
  });
});

describe("renderTwikitTweetMarkdown", () => {
  it("renders the tweet and replies", () => {
    const markdown = renderTwikitTweetMarkdown(
      {
        text: "main text",
        author: "Alice",
        screenName: "alice",
        createdAt: "Sat Aug 01 00:00:00 +0000 2026",
        likes: 3,
        retweets: 2,
        replies: 1,
        mediaUrls: ["https://pbs.twimg.com/x.jpg"],
      },
      [{ text: "a reply", author: "Bob", screenName: "bob" }],
      "https://x.com/alice/status/123",
    );
    assert.match(markdown, /^# Alice \(@alice\)/);
    assert.match(markdown, /- URL: https:\/\/x\.com\/alice\/status\/123/);
    assert.match(markdown, /- Stats: 3 likes, 2 retweets, 1 replies/);
    assert.match(markdown, /## Replies \(1 retrieved\)/);
    assert.match(markdown, /### 1\. Bob \(@bob\)/);
  });
});

describe("renderTwitterTweets", () => {
  it("renders a user header when user info is present", () => {
    const markdown = renderTwitterTweets({ title: "Alice (@alice)", url: "https://x.com/alice" }, [
      { text: "tweet", author: "Alice", screenName: "alice" },
    ]);
    assert.match(markdown, /^# Alice \(@alice\)/);
    assert.match(markdown, /## Tweets \(1 retrieved\)/);
    assert.match(markdown, /### 1\. Alice \(@alice\)/);
  });

  it("renders a search header", () => {
    const markdown = renderTwitterTweets(
      { title: "Twitter search: browse cli", url: "https://x.com/search?q=browse+cli" },
      [],
    );
    assert.match(markdown, /^# Twitter search: browse cli/);
    assert.match(markdown, /## Tweets \(0 retrieved\)/);
  });
});
