import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const sessionId = "session-a";
const firstTime = "2026-01-01T00:00:00.000Z";
const secondTime = "2026-01-01T00:00:01.000Z";
const thirdTime = "2026-01-01T00:00:02.000Z";
const tempRoot = "/tmp/work/dotfiles/pi-mux-session-metadata";
const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(custom = false) {
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, "case-"));
  fixtures.push(root);
  const group = join(root, "agent", "sessions", "--workspace--");
  const directory = custom ? join(root, "custom") : group;
  const file = join(directory, "log.jsonl");
  mkdirSync(directory, { recursive: true });
  const header = { type: "session", id: sessionId, version: 3, cwd: root, timestamp: firstTime };
  writeFileSync(file, lines(header));
  function run(args = ["metadata", sessionId]) {
    return spawnSync(process.execPath, [join(import.meta.dir, "main.ts"), ...args], {
      cwd: root,
      env: {
        PATH: "",
        HOME: root,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        XDG_CACHE_HOME: join(root, "cache"),
        ...(custom ? { PI_CODING_AGENT_SESSION_DIR: directory } : {}),
      },
      encoding: "utf8",
    });
  }
  function read(args?: string[]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { root, group, file, header, run, read };
}

function lines(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry) + "\n").join("");
}

function response(id: string, timestamp: string, text = id) {
  return {
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function customEntry(customType: string, data: object, id = "custom-entry") {
  return { type: "custom", customType, id, data };
}

function view(responseId: string | null, viewedAt: string) {
  return customEntry("pi-mux-viewed", { sessionId, responseId, viewedAt });
}

describe("metadata", () => {
  it("returns unknown fields for a saved full ID without a tmux executable", () => {
    const { read, run } = fixture(true);
    assert.deepEqual(read(), {
      id: sessionId,
      ticket: null,
      worktrees: [],
      updatedAt: null,
      viewedAt: null,
      unread: null,
    });
    assert.equal(run(["metadata", "session"]).stdout, "");
    assert.equal(run(["metadata", "session"]).status, 1);
    assert.equal(run(["metadata", sessionId, "--json"]).status, 1);
  });

  it("uses matching ticket and worktree entries in append order", () => {
    const { file, read } = fixture();
    const ticket = { project: "dotfiles", id: "20260101-000000-case" };
    appendFileSync(
      file,
      lines(
        customEntry("pi-mux-ticket", { sessionId, ticket }),
        customEntry("pi-mux-ticket", {
          sessionId: "parent",
          ticket: { ...ticket, project: "other" },
        }),
        customEntry("session-worktree-metadata", { sessionId, workspaces: ["/work/old"] }),
        customEntry("session-worktree-metadata", { sessionId, workspaces: ["/work/new"] }),
        customEntry("session-worktree-metadata", {
          sessionId: "parent",
          workspaces: ["/work/parent"],
        }),
      ),
    );
    const result = read();
    assert.deepEqual(result.ticket, ticket);
    assert.deepEqual(result.worktrees, ["/work/new"]);
  });

  it("fails for the last matching invalid worktree record without falling back", () => {
    const { file, read, run } = fixture();
    appendFileSync(
      file,
      lines(customEntry("session-worktree-metadata", { sessionId, workspaces: ["/work"] })),
    );
    assert.deepEqual(read().worktrees, ["/work"]);
    appendFileSync(
      file,
      lines(
        customEntry("session-worktree-metadata", { sessionId, workspaces: ["relative"] }, "bad"),
      ),
    );
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Invalid workspaces in custom entry bad/);
  });

  it("keeps a response appended after the view target unread even before receipt arrives", () => {
    const { file, read } = fixture();
    appendFileSync(file, lines(response("seen", secondTime)));
    const { responseId } = read(["metadata", "--view-target", sessionId, file]);
    assert.equal(responseId, "seen");
    appendFileSync(file, lines(response("unseen", firstTime), view(responseId, thirdTime)));
    const result = read();
    assert.equal(result.updatedAt, firstTime);
    assert.equal(result.viewedAt, thirdTime);
    assert.equal(result.unread, true);
  });

  it("uses the latest display time and ignores tool-only responses and copied receipts", () => {
    const { file, read } = fixture();
    const tool = {
      ...response("tool", thirdTime),
      message: { role: "assistant", content: [{ type: "toolCall" }] },
    };
    appendFileSync(
      file,
      lines(
        response("seen", firstTime),
        view("seen", thirdTime),
        tool,
        view(null, secondTime),
        customEntry("pi-mux-viewed", {
          sessionId: "parent",
          responseId: null,
          viewedAt: thirdTime,
        }),
      ),
    );
    const result = read();
    assert.equal(result.updatedAt, firstTime);
    assert.equal(result.viewedAt, thirdTime);
    assert.equal(result.unread, false);
  });

  it("leaves a multi-chunk unfinished line unprocessed until its newline arrives", () => {
    const { file, read } = fixture();
    appendFileSync(file, lines(view(null, firstTime)));
    assert.equal(read().unread, false);
    const bytes = Buffer.from(lines(response("large", secondTime, "日".repeat(400_000))));
    const splitAt = bytes.indexOf(Buffer.from("日")) + 1;
    appendFileSync(file, bytes.subarray(0, splitAt));
    assert.equal(read().updatedAt, null);
    appendFileSync(file, bytes.subarray(splitAt, -1));
    assert.equal(read().updatedAt, null);
    appendFileSync(file, bytes.subarray(-1));
    assert.equal(read().updatedAt, secondTime);
    assert.equal(read().unread, true);
  });

  it("rebuilds after replacement, truncation and a growing rewrite of the checkpoint boundary", () => {
    const { file, header, read } = fixture();
    appendFileSync(file, lines(response("old", firstTime)));
    assert.equal(read().updatedAt, firstTime);
    writeFileSync(file + ".new", lines(header, response("replaced", secondTime)));
    renameSync(file + ".new", file);
    assert.equal(read().updatedAt, secondTime);
    writeFileSync(file, lines(header, response("rewritten", thirdTime, "x".repeat(2000))));
    assert.equal(read().updatedAt, thirdTime);
    writeFileSync(file, lines(header));
    assert.equal(read().updatedAt, null);
  });

  it("rebuilds from corrupted cache data", () => {
    const { file, root, read } = fixture();
    appendFileSync(file, lines(response("saved", secondTime)));
    assert.equal(read().updatedAt, secondTime);
    const cache = join(root, "cache", "pi-mux", "session-metadata");
    const [entry] = readdirSync(cache);
    writeFileSync(join(cache, entry!), "broken");
    assert.equal(read().updatedAt, secondTime);
  });

  it("detects a duplicate whose header becomes readable without a directory change", () => {
    const { file, group, header, read, run } = fixture();
    appendFileSync(file, lines(response("saved", firstTime)));
    const pendingFile = join(group, "pending.jsonl");
    writeFileSync(pendingFile, "");
    assert.equal(read().updatedAt, firstTime);
    appendFileSync(pendingFile, lines(header));
    assert.match(run().stderr, /Ambiguous session ID/);
  });

  it("reads an explicit display target even when the normal layer holds a different file", () => {
    const { group, header, read } = fixture();
    const archive = join(group, "archive");
    mkdirSync(archive);
    const file = join(archive, "archive.jsonl");
    writeFileSync(file, lines(header, response("displayed", secondTime)));
    const stat = statSync(file, { bigint: true });
    assert.deepEqual(read(["metadata", "--view-target", sessionId, file]), {
      file,
      fileIdentity: [stat.dev, stat.ino, stat.birthtimeNs].join(":"),
      responseId: "displayed",
    });
    assert.equal(read().updatedAt, null);
  });

  it("re-resolves an archived path and detects a new duplicate in the preferred layer", () => {
    const { file, group, header, read, run } = fixture();
    const archived = join(group, "archive", "archived.jsonl");
    mkdirSync(dirname(archived), { recursive: true });
    appendFileSync(file, lines(response("archived", firstTime)));
    assert.equal(read().updatedAt, firstTime);
    renameSync(file, archived);
    assert.equal(read().updatedAt, firstTime);
    writeFileSync(file, lines(header, response("preferred", secondTime)));
    assert.equal(read().updatedAt, secondTime);
    writeFileSync(join(group, "duplicate.jsonl"), lines(header));
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Ambiguous session ID/);
  });
});
