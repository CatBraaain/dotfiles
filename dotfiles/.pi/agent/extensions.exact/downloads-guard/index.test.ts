import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "bun:test";
import downloadsGuard, {
  ancestorDirectories,
  downloadsAncestors,
  findContextPaths,
  isWithinDirectory,
  resolveDownloadsRoot,
} from "./index";

const temporaryDirectories: string[] = [];
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const require = createRequire(import.meta.url);
const jitiPath = require.resolve("jiti", {
  paths: [dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))],
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "downloads-guard-"));
  temporaryDirectories.push(home);
  const root = join(home, "Downloads");
  const cwd = join(root, "archive", "project");
  await mkdir(cwd, { recursive: true });
  return { home, root, cwd };
}

describe("Downloads path boundaries", () => {
  for (const [root, cwd, platform, expected] of [
    ["/home/user/Downloads", "/home/user/Downloads", "linux", true],
    ["/home/user/Downloads", "/home/user/Downloads/archive", "linux", true],
    ["/home/user/Downloads", "/home/user/Downloads-old", "linux", false],
    ["/home/user/Downloads", "/tmp/Downloads", "linux", false],
    ["/home/user/Downloads", "/home/user/downloads", "linux", false],
    ["/home/user/Downloads", "/home/user/Downloads/../project", "linux", false],
    ["C:\\Users\\user\\Downloads", "c:\\users\\USER\\downloads\\archive", "win32", true],
    ["C:\\Users\\user\\Downloads", "C:/Users/user/Downloads/archive", "win32", true],
    ["C:\\Users\\user\\Downloads", "C:\\Users\\user\\Downloads-old", "win32", false],
    ["C:\\Users\\user\\Downloads", "D:\\Users\\user\\Downloads", "win32", false],
    ["\\\\server\\share\\Downloads", "\\\\server\\share\\Downloads\\archive", "win32", true],
    ["\\\\server\\share\\Downloads", "\\\\server\\other\\Downloads", "win32", false],
  ] as const) {
    it(`classifies ${platform} cwd ${cwd}`, () => {
      assert.equal(isWithinDirectory(root, cwd, platform), expected);
    });
  }

  it("stops the Windows ancestor walk despite different path casing", () => {
    assert.deepEqual(
      ancestorDirectories(
        "C:\\Users\\user\\Downloads",
        "c:\\users\\USER\\downloads\\archive",
        "win32",
      ),
      ["c:\\users\\USER\\downloads", "c:\\users\\USER\\downloads\\archive"],
    );
  });

  it("resolves the standard Windows location without treating arbitrary names as roots", async () => {
    assert.equal(
      await resolveDownloadsRoot({ home: "C:\\Users\\user", platform: "win32", env: {} }),
      "C:\\Users\\user\\Downloads",
    );
  });

  it("uses the Linux default when XDG configuration is absent", async () => {
    const { home, root } = await fixture();
    assert.equal(await resolveDownloadsRoot({ home, platform: "linux", env: {} }), root);
  });

  it("keeps the standard root when the XDG file is unreadable", async () => {
    const { home, root } = await fixture();
    const config = join(home, ".config");
    await mkdir(config);
    const configuration = join(config, "user-dirs.dirs");
    await writeFile(configuration, 'XDG_DOWNLOAD_DIR="$HOME/Incoming"\n', { mode: 0 });
    assert.equal(await resolveDownloadsRoot({ home, platform: "linux", env: {} }), root);
  });

  it("resolves an XDG Downloads location with HOME expansion", async () => {
    const { home } = await fixture();
    const config = join(home, "config");
    await mkdir(config);
    await writeFile(join(config, "user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/Incoming files"\n');
    assert.equal(
      await resolveDownloadsRoot({ home, platform: "linux", env: { XDG_CONFIG_HOME: config } }),
      join(home, "Incoming files"),
    );
  });

  it("does not execute shell syntax in XDG configuration", async () => {
    const { home, root } = await fixture();
    await mkdir(join(home, ".config"));
    await writeFile(
      join(home, ".config", "user-dirs.dirs"),
      'XDG_DOWNLOAD_DIR="$(touch /tmp/downloads-guard-unwanted)"\n',
    );
    assert.equal(await resolveDownloadsRoot({ home, platform: "linux", env: {} }), root);
  });

  it("includes only ancestors from Downloads to cwd", async () => {
    const { root, cwd } = await fixture();
    assert.deepEqual(await downloadsAncestors(cwd, root), [root, dirname(cwd), cwd]);
  });

  it("resolves a symlink alias pointing into Downloads", async () => {
    const { home, root, cwd } = await fixture();
    const alias = join(home, "alias");
    await symlink(cwd, alias, "dir");
    assert.deepEqual(await downloadsAncestors(alias, root), [root, dirname(cwd), cwd]);
  });

  it("keeps the lexical Downloads ancestors when a child symlink points outside", async () => {
    const { home, root } = await fixture();
    const outside = join(home, "outside");
    const alias = join(root, "alias");
    await mkdir(outside);
    await symlink(outside, alias, "dir");
    assert.deepEqual(await downloadsAncestors(alias, root), [root, alias]);
  });
});

describe("agent context names", () => {
  for (const name of [
    ".pi",
    ".agents",
    ".claude",
    ".cursor",
    ".codex",
    ".gemini",
    ".opencode",
    ".PI",
  ]) {
    it(`detects the ${name} directory without entering it`, async () => {
      const { root } = await fixture();
      const target = join(root, name);
      await mkdir(target, { mode: 0 });
      try {
        assert.deepEqual(await findContextPaths([root, target]), [target]);
      } finally {
        await chmod(target, 0o700);
      }
    });
  }

  for (const name of [
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "agents.md",
    "SKILL.md",
    "CLAUDE.md",
    "CLAUDE.MD",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
  ]) {
    it(`detects ${name} without needing its contents`, async () => {
      const { root } = await fixture();
      const target = join(root, name);
      await writeFile(target, "PRIVATE BODY MUST NOT BE READ", { mode: 0 });
      assert.deepEqual(await findContextPaths([root]), [target]);
    });
  }

  it("ignores ordinary files, backup names, wrong entry types, and unrelated descendants", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "SKILL.md.bak"), "ordinary file");
    await writeFile(join(root, "AGENTS.extra.md"), "ordinary file");
    await writeFile(join(root, ".pi"), "not a directory");
    await mkdir(join(root, "SKILL.md"));
    await mkdir(join(root, "unrelated"));
    await writeFile(join(root, "unrelated", "AGENTS.md"), "not an ancestor");
    assert.deepEqual(await findContextPaths([root]), []);
  });

  it("detects inherited context and stops before scanning deeper ancestors", async () => {
    const { root, cwd } = await fixture();
    const target = join(root, "CLAUDE.md");
    await writeFile(target, "private");
    assert.deepEqual(await findContextPaths([root, dirname(cwd), cwd, join(cwd, "missing")]), [
      target,
    ]);
  });

  it("ignores context above Downloads", async () => {
    const { home, root, cwd } = await fixture();
    await writeFile(join(home, "AGENTS.md"), "normal home context");
    assert.deepEqual(await findContextPaths(await downloadsAncestors(cwd, root)), []);
  });

  it("detects a symlink to a context file", async () => {
    const { home, root } = await fixture();
    const source = join(home, "instructions");
    const target = join(root, "AGENTS.md");
    await writeFile(source, "private");
    await symlink(source, target);
    assert.deepEqual(await findContextPaths([root]), [target]);
  });
});

describe("startup behavior", () => {
  it("does not warn or request shutdown outside Downloads", async () => {
    const { home, root } = await fixture();
    const notifications: unknown[] = [];
    let handler!: (event: unknown, context: unknown) => Promise<void>;
    downloadsGuard(
      {
        on(_event: string, callback: typeof handler) {
          handler = callback;
        },
      } as never,
      async () => root,
    );
    await handler(
      {},
      {
        cwd: home,
        mode: "tui",
        ui: { notify: (...args: unknown[]) => notifications.push(args) },
        shutdown() {
          throw new Error("unexpected shutdown");
        },
      },
    );
    assert.deepEqual(notifications, []);
  });

  it("warns and continues when Downloads contains no context", async () => {
    const { root, cwd } = await fixture();
    const notifications: unknown[][] = [];
    let handler!: (event: unknown, context: unknown) => Promise<void>;
    downloadsGuard(
      {
        on(_event: string, callback: typeof handler) {
          handler = callback;
        },
      } as never,
      async () => root,
    );
    await handler(
      {},
      {
        cwd,
        mode: "tui",
        ui: { notify: (...args: unknown[]) => notifications.push(args) },
        shutdown() {
          throw new Error("unexpected shutdown");
        },
      },
    );
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.[1], "warning");
    assert.match(String(notifications[0]?.[0]), /Downloads guard/);
  });

  for (const mode of ["tui", "print", "json", "rpc"] as const) {
    it(`exits nonzero before input in ${mode} mode`, async () => {
      const { root, cwd } = await fixture();
      await writeFile(join(root, "AGENTS.md"), "PRIVATE BODY MUST NOT BE READ");
      const script = `
        const { createJiti } = require(${JSON.stringify(jitiPath)});
        const fs = require("node:fs/promises");
        const originalReadFile = fs.readFile;
        fs.readFile = async function(file, ...args) {
          if (String(file).startsWith(${JSON.stringify(root)})) throw new Error("CONTEXT BODY READ");
          return originalReadFile(file, ...args);
        };
        async function main() {
          const extension = await createJiti(${JSON.stringify(extensionPath)}).import(${JSON.stringify(extensionPath)}, { default: true });
          let handler;
          extension({ on(event, callback) { handler = callback; } }, async () => ${JSON.stringify(root)});
          await handler({ reason: "startup" }, {
            cwd: ${JSON.stringify(cwd)}, mode: ${JSON.stringify(mode)},
            ui: { notify() {} },
            shutdown() { setImmediate(() => { process.stderr.write("TUI_CLEANUP\\n"); process.exit(0); }); }
          });
          process.stdout.write("INPUT_STARTED\\n");
        }
        main().catch(error => { console.error(error); process.exit(9); });
      `;
      const result = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 10_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /agent context found:/);
      assert.match(result.stderr, /AGENTS\.md/);
      assert.doesNotMatch(result.stderr, /CONTEXT BODY READ|PRIVATE BODY/);
      if (mode === "tui") assert.match(result.stderr, /TUI_CLEANUP/);
    });
  }
});
