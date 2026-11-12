import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const source = join(import.meta.dir, "main.ts");
const bunExecutable = process.execPath;
const temporaryRoot = "/tmp/work/dotfiles/speed-up-pi-mux-history-tests";
const cacheDirectoryName = "history-titles";
const cacheFileMode = 0o600;
const cacheDirectoryMode = 0o700;

type Header = {
  type: "session";
  version: number;
  id: string;
  cwd: string;
  timestamp: string;
};

class HistoryCacheFixture {
  readonly directory: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly otherCwd: string;
  readonly sessionsDirectory: string;
  readonly cacheDirectory: string;
  readonly membership: string;
  readonly env: Record<string, string>;

  constructor() {
    mkdirSync(temporaryRoot, { recursive: true });
    this.directory = join(temporaryRoot, randomUUID());
    this.agentDir = join(this.directory, "agent");
    this.cwd = join(this.directory, "workspace");
    this.otherCwd = join(this.directory, "other-workspace");
    this.sessionsDirectory = join(this.agentDir, "sessions");
    this.cacheDirectory = join(this.directory, "cache", "pi-mux", cacheDirectoryName);
    this.membership = join(this.agentDir, "session-state.json");
    this.env = {
      PATH: process.env.PATH ?? "",
      HOME: join(this.directory, "home"),
      XDG_RUNTIME_DIR: join(this.directory, "runtime"),
      PI_CODING_AGENT_DIR: this.agentDir,
      XDG_CACHE_HOME: join(this.directory, "cache"),
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    };
    mkdirSync(join(this.agentDir, "pi-tmux", "session-dirs"), { recursive: true, mode: 0o700 });
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.otherCwd, { recursive: true });
    writeFileSync(
      this.membership,
      JSON.stringify({
        "active-workspaces": {
          [this.cwd]: { "active-sessions": {} },
          [this.otherCwd]: { "active-sessions": {} },
        },
      }),
    );
  }

  sessionFile(cwd: string, id: string): string {
    return join(
      this.sessionsDirectory,
      `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`,
      `2026-01-01T00-00-00-000Z_${id}.jsonl`,
    );
  }

  writeSession(
    cwd: string,
    id: string,
    entries: unknown[],
    options: { trailingNewline?: boolean; file?: string } = {},
  ): string {
    const file = options.file ?? this.sessionFile(cwd, id);
    mkdirSync(dirname(file), { recursive: true });
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(file, lines + (options.trailingNewline === false ? "" : "\n"));
    return file;
  }

  header(id: string, cwd = this.cwd): Header {
    return {
      type: "session",
      version: 1,
      id,
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }

  sessionInfo(name?: unknown, options: { type?: unknown; includeName?: boolean } = {}) {
    return {
      type: options.type ?? "session_info",
      id: randomUUID(),
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      ...(options.includeName === false ? {} : { name }),
    };
  }

  history(cwd = this.cwd) {
    return spawnSync(bunExecutable, ["run", source, "history", "--cwd", cwd], {
      cwd: this.cwd,
      env: this.env,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  async historyAsync(cwd = this.cwd) {
    const child = Bun.spawn([bunExecutable, "run", source, "history", "--cwd", cwd], {
      cwd: this.cwd,
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { error: undefined, status, stdout, stderr };
  }

  expected(file: string, id: string, cwd: string, title: string | null) {
    const stat = statSync(file);
    return { id, cwd, file, title, mtime: Math.round(stat.mtimeMs), size: stat.size };
  }

  cacheFiles(): string[] {
    if (!existsSync(this.cacheDirectory)) return [];
    return readdirSync(this.cacheDirectory).map((name) => join(this.cacheDirectory, name));
  }

  cacheFileFor(file: string): string | undefined {
    return this.cacheFiles().find((cacheFile) => {
      try {
        return JSON.parse(readFileSync(cacheFile, "utf8")).file === file;
      } catch {
        return false;
      }
    });
  }

  cleanup(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

describe("history title cache", () => {
  it("creates a private per-file cache and preserves identical warm output without rewriting it", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.writeSession(fixture.cwd, id, [
        fixture.header(id),
        fixture.sessionInfo("Cached title"),
      ]);
      const sourceBefore = readFileSync(file, "utf8");
      const membershipBefore = readFileSync(fixture.membership, "utf8");
      const first = fixture.history();
      assert.equal(first.error, undefined);
      assert.equal(first.status, 0, first.stderr);
      const cacheFiles = fixture.cacheFiles();
      assert.equal(cacheFiles.length, 1);
      const cacheFile = cacheFiles[0]!;
      const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(cache.version, 1);
      assert.equal(cache.title, "Cached title");
      assert.equal(cache.file, file);
      assert.equal(typeof cache.fingerprint, "string");
      assert.equal(statSync(fixture.cacheDirectory).mode & 0o777, cacheDirectoryMode);
      assert.equal(statSync(cacheFile).mode & 0o777, cacheFileMode);
      const cacheMtime = statSync(cacheFile).mtimeMs;
      const warm = fixture.history();
      assert.equal(warm.error, undefined);
      assert.equal(warm.status, 0, warm.stderr);
      assert.equal(warm.stdout, first.stdout);
      assert.equal(statSync(cacheFile).mtimeMs, cacheMtime);
      assert.deepEqual(JSON.parse(first.stdout), [
        fixture.expected(file, id, fixture.cwd, "Cached title"),
      ]);
      assert.equal(readFileSync(file, "utf8"), sourceBefore);
      assert.equal(readFileSync(fixture.membership, "utf8"), membershipBefore);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads the latest session title and resolves blank, missing, null, and absent titles", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const cases = [
        {
          entries: [fixture.sessionInfo("older"), fixture.sessionInfo(" latest ")],
          title: "latest",
        },
        { entries: [fixture.sessionInfo("older"), fixture.sessionInfo("  ")], title: null },
        { entries: [fixture.sessionInfo("older"), fixture.sessionInfo("")], title: null },
        {
          entries: [
            fixture.sessionInfo("older"),
            fixture.sessionInfo(undefined, { includeName: false }),
          ],
          title: null,
        },
        { entries: [fixture.sessionInfo("older"), fixture.sessionInfo(null)], title: null },
        { entries: [], title: null },
        {
          entries: [fixture.sessionInfo("older"), { type: "message", name: "not a title" }],
          title: "older",
        },
      ];
      const expected = cases.map(({ entries, title }) => {
        const id = randomUUID();
        const file = fixture.writeSession(fixture.cwd, id, [fixture.header(id), ...entries]);
        return fixture.expected(file, id, fixture.cwd, title);
      });
      const result = fixture.history();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(result.stdout),
        expected.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file)),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("finds an early title across a multi-megabyte UTF-8 message line with and without a trailing newline", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const longUnicodeValue = "境界🙂".repeat(600_000);
      for (const trailingNewline of [true, false]) {
        const id = randomUUID();
        const file = fixture.writeSession(
          fixture.cwd,
          id,
          [
            fixture.header(id),
            fixture.sessionInfo("Title before giant message"),
            { type: "message", text: longUnicodeValue },
          ],
          { trailingNewline },
        );
        const result = fixture.history();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          JSON.parse(result.stdout).find((entry: { id: string }) => entry.id === id),
          fixture.expected(file, id, fixture.cwd, "Title before giant message"),
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("uses the latest Unicode-escaped session_info before an incomplete JSON tail on cold and warm reads", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.sessionFile(fixture.cwd, id);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          JSON.stringify(fixture.header(id)),
          JSON.stringify(fixture.sessionInfo("Older title")),
          '{"ty\\u0070e":"session_\\u0069nfo","na\\u006de":"\\u6700\\u7d42"}',
          '{"type":"session_info","name":',
        ].join("\n") + "\n",
      );
      const expectedStdout =
        JSON.stringify([fixture.expected(file, id, fixture.cwd, "最終")]) + "\n";
      const cold = fixture.history();
      assert.equal(cold.error, undefined);
      assert.equal(cold.status, 0, cold.stderr);
      assert.equal(cold.stdout, expectedStdout);
      const warm = fixture.history();
      assert.equal(warm.error, undefined);
      assert.equal(warm.status, 0, warm.stderr);
      assert.equal(warm.stdout, expectedStdout);
    } finally {
      fixture.cleanup();
    }
  });

  it("uses a complete final session_info entry without a trailing newline", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.writeSession(
        fixture.cwd,
        id,
        [fixture.header(id), fixture.sessionInfo("Complete final title")],
        { trailingNewline: false },
      );
      const result = fixture.history();
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        fixture.expected(file, id, fixture.cwd, "Complete final title"),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("refreshes appended titles and replaces a previously cached null title", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.writeSession(fixture.cwd, id, [fixture.header(id)]);
      const initial = fixture.history();
      assert.equal(initial.status, 0, initial.stderr);
      assert.deepEqual(JSON.parse(initial.stdout), [fixture.expected(file, id, fixture.cwd, null)]);
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}${JSON.stringify(fixture.sessionInfo("appended title"))}\n`,
      );
      const updated = fixture.history();
      assert.equal(updated.status, 0, updated.stderr);
      assert.deepEqual(JSON.parse(updated.stdout), [
        fixture.expected(file, id, fixture.cwd, "appended title"),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps history available when saving an updated title fails because the cache path is a directory", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.writeSession(fixture.cwd, id, [
        fixture.header(id),
        fixture.sessionInfo("Initial title"),
      ]);
      const membershipBefore = readFileSync(fixture.membership, "utf8");
      const initial = fixture.history();
      assert.equal(initial.error, undefined);
      assert.equal(initial.status, 0, initial.stderr);
      const cacheFile = fixture.cacheFileFor(file);
      assert.ok(cacheFile);
      unlinkSync(cacheFile);
      mkdirSync(cacheFile);
      const sourceBefore = readFileSync(file, "utf8");
      writeFileSync(
        file,
        `${sourceBefore}${JSON.stringify(fixture.sessionInfo("Updated title"))}\n`,
      );
      const sourceAfter = readFileSync(file, "utf8");
      const updated = fixture.history();
      assert.equal(updated.error, undefined);
      assert.equal(updated.status, 0, updated.stderr);
      assert.deepEqual(JSON.parse(updated.stdout), [
        fixture.expected(file, id, fixture.cwd, "Updated title"),
      ]);
      assert.equal(readFileSync(file, "utf8"), sourceAfter);
      assert.equal(readFileSync(fixture.membership, "utf8"), membershipBefore);
      assert.deepEqual(
        fixture.cacheFiles().filter((cachePath) => cachePath.endsWith(".tmp")),
        [],
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("detects a same-size overwrite even when the original modification time is restored", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.writeSession(fixture.cwd, id, [
        fixture.header(id),
        fixture.sessionInfo("First title"),
      ]);
      const fixedTime = new Date("2026-01-01T00:00:00.000Z");
      utimesSync(file, fixedTime, fixedTime);
      const originalStat = statSync(file);
      const originalIdentity = statSync(file, { bigint: true });
      const first = fixture.history();
      assert.equal(first.status, 0, first.stderr);
      const replacement = `${JSON.stringify(fixture.header(id))}\n${JSON.stringify(fixture.sessionInfo("Other title"))}\n`;
      assert.equal(Buffer.byteLength(replacement), originalStat.size);
      writeFileSync(file, replacement);
      utimesSync(file, originalStat.atime, originalStat.mtime);
      const updatedIdentity = statSync(file, { bigint: true });
      assert.equal(updatedIdentity.mtimeNs, originalIdentity.mtimeNs);
      assert.equal(updatedIdentity.size, originalIdentity.size);
      assert.equal(updatedIdentity.ino, originalIdentity.ino);
      assert.notEqual(updatedIdentity.ctimeNs, originalIdentity.ctimeNs);
      const updated = fixture.history();
      assert.equal(updated.status, 0, updated.stderr);
      assert.deepEqual(JSON.parse(updated.stdout), [
        fixture.expected(file, id, fixture.cwd, "Other title"),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("refreshes truncated files and removes deleted entries while discovering renamed and replaced files", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const truncatedId = randomUUID();
      const truncated = fixture.writeSession(fixture.cwd, truncatedId, [
        fixture.header(truncatedId),
        fixture.sessionInfo("Before truncate"),
      ]);
      const removedId = randomUUID();
      const removed = fixture.writeSession(fixture.cwd, removedId, [
        fixture.header(removedId),
        fixture.sessionInfo("Remove me"),
      ]);
      const renamedId = randomUUID();
      const renamedOriginal = fixture.writeSession(fixture.cwd, renamedId, [
        fixture.header(renamedId),
        fixture.sessionInfo("Rename me"),
      ]);
      const replacedId = randomUUID();
      const replaced = fixture.writeSession(fixture.cwd, replacedId, [
        fixture.header(replacedId),
        fixture.sessionInfo("Replace me"),
      ]);
      const initial = fixture.history();
      assert.equal(initial.status, 0, initial.stderr);
      writeFileSync(truncated, JSON.stringify(fixture.header(truncatedId)) + "\n");
      rmSync(removed);
      const renamed = fixture
        .sessionFile(fixture.cwd, renamedId)
        .replace(`${renamedId}.jsonl`, `renamed_${renamedId}.jsonl`);
      renameSync(renamedOriginal, renamed);
      const replacementId = randomUUID();
      const replacementCwd = fixture.otherCwd;
      const temporaryReplacement = `${replaced}.temporary`;
      writeFileSync(
        temporaryReplacement,
        `${JSON.stringify(fixture.header(replacementId, replacementCwd))}\n${JSON.stringify(fixture.sessionInfo("New identity"))}\n`,
      );
      renameSync(temporaryReplacement, replaced);
      const updated = fixture.history();
      assert.equal(updated.status, 0, updated.stderr);
      const history = JSON.parse(updated.stdout);
      assert.equal(
        history.some((entry: { id: string }) => entry.id === removedId),
        false,
      );
      assert.equal(
        history.some((entry: { file: string }) => entry.file === renamedOriginal),
        false,
      );
      assert.ok(
        history.some(
          (entry: { id: string; file: string; title: string | null }) =>
            entry.id === renamedId && entry.file === renamed && entry.title === "Rename me",
        ),
      );
      assert.deepEqual(
        history.find((entry: { id: string }) => entry.id === replacementId),
        fixture.expected(replaced, replacementId, replacementCwd, "New identity"),
      );
      assert.deepEqual(
        history.find((entry: { id: string }) => entry.id === truncatedId),
        fixture.expected(truncated, truncatedId, fixture.cwd, null),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rebuilds cache files containing malformed JSON or invalid versions and title values", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const cases = [
        { corrupt: "{broken", field: undefined },
        { corrupt: undefined, field: "version", invalid: 999 },
        { corrupt: undefined, field: "title", invalid: 42 },
        { corrupt: undefined, field: "fingerprint", invalid: "incorrect-fingerprint" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const id = randomUUID();
        const file = fixture.writeSession(fixture.cwd, id, [
          fixture.header(id),
          fixture.sessionInfo(`Source ${index}`),
        ]);
        fixture.history();
        const cacheFile = fixture.cacheFileFor(file);
        assert.ok(cacheFile);
        if (testCase.corrupt !== undefined) {
          writeFileSync(cacheFile, testCase.corrupt);
        } else {
          const validCache = JSON.parse(readFileSync(cacheFile, "utf8"));
          const invalidCache = { ...validCache, [testCase.field!]: testCase.invalid };
          writeFileSync(cacheFile, JSON.stringify(invalidCache));
        }
        const result = fixture.history();
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          JSON.parse(result.stdout).find((entry: { id: string }) => entry.id === id),
          fixture.expected(file, id, fixture.cwd, `Source ${index}`),
        );
        assert.doesNotThrow(() => JSON.parse(readFileSync(cacheFile, "utf8")));
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("returns correct history when the cache path is blocked, unsafe, or a symlink", () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.writeSession(fixture.cwd, id, [
        fixture.header(id),
        fixture.sessionInfo("Still available"),
      ]);
      const sourceBefore = readFileSync(file, "utf8");
      const membershipBefore = readFileSync(fixture.membership, "utf8");
      mkdirSync(join(fixture.directory, "cache", "pi-mux"), { recursive: true });
      writeFileSync(
        join(fixture.directory, "cache", "pi-mux", cacheDirectoryName),
        "not a directory",
      );
      const blocked = fixture.history();
      assert.equal(blocked.status, 0, blocked.stderr);
      assert.deepEqual(JSON.parse(blocked.stdout), [
        fixture.expected(file, id, fixture.cwd, "Still available"),
      ]);
      assert.equal(readFileSync(file, "utf8"), sourceBefore);
      assert.equal(readFileSync(fixture.membership, "utf8"), membershipBefore);
      rmSync(join(fixture.directory, "cache", "pi-mux", cacheDirectoryName));
      mkdirSync(fixture.cacheDirectory, { recursive: true, mode: 0o700 });
      chmodSync(fixture.cacheDirectory, 0o777);
      const unsafe = fixture.history();
      assert.equal(unsafe.status, 0, unsafe.stderr);
      assert.deepEqual(JSON.parse(unsafe.stdout), [
        fixture.expected(file, id, fixture.cwd, "Still available"),
      ]);
      chmodSync(fixture.cacheDirectory, 0o700);
      const baseline = fixture.history();
      assert.equal(baseline.status, 0, baseline.stderr);
      const target = join(fixture.directory, "cache-target.json");
      writeFileSync(target, "{}\n");
      const cacheFile = fixture.cacheFileFor(file);
      assert.ok(cacheFile);
      unlinkSync(cacheFile);
      symlinkSync(target, cacheFile);
      const linked = fixture.history();
      assert.equal(linked.status, 0, linked.stderr);
      assert.deepEqual(JSON.parse(linked.stdout), [
        fixture.expected(file, id, fixture.cwd, "Still available"),
      ]);
      assert.equal(readFileSync(target, "utf8"), "{}\n");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps headers and metadata current and returns consistent output across concurrent CLI processes", async () => {
    const fixture = new HistoryCacheFixture();
    try {
      const id = randomUUID();
      const file = fixture.writeSession(fixture.cwd, id, [
        fixture.header(id),
        fixture.sessionInfo("Initial"),
      ]);
      const initial = fixture.history();
      assert.equal(initial.status, 0, initial.stderr);
      const replacementId = randomUUID();
      const replacementCwd = fixture.otherCwd;
      const movedFile = fixture.sessionFile(replacementCwd, replacementId);
      const movedContents = `${JSON.stringify(fixture.header(replacementId, replacementCwd))}\n${JSON.stringify(fixture.sessionInfo("Moved header"))}\n`;
      mkdirSync(dirname(movedFile), { recursive: true });
      rmSync(file);
      writeFileSync(movedFile, movedContents);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => fixture.historyAsync(replacementCwd)),
      );
      for (const result of results) {
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [
          fixture.expected(movedFile, replacementId, replacementCwd, "Moved header"),
        ]);
      }
      const cache = fixture
        .cacheFiles()
        .map((cacheFile) => JSON.parse(readFileSync(cacheFile, "utf8")));
      assert.ok(
        cache.every((record) => record.version === 1 && typeof record.fingerprint === "string"),
      );
      assert.equal(readFileSync(movedFile, "utf8"), movedContents);
    } finally {
      fixture.cleanup();
    }
  });
});
