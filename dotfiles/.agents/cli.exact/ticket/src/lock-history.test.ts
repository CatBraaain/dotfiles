import { afterEach, beforeEach, describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LockHistory } from "./lock-history";

const PROJECT = "app";
const TICKET_ID = "20260704.090000";
const LOCK_AT = "2026-07-04T09:15:03.000Z";
const RELEASE_AT = "2026-07-04T09:45:03.000Z";
const CREATED_AT = "2026-07-04T09:00:00.000Z";
const FORKED_AT = "2026-07-04T10:00:00.000Z";
const KEY = `${PROJECT}/${TICKET_ID}`;

let home: string;
let agent: string;
let cwd: string;
let group: string;
let originalEnv: Pick<NodeJS.ProcessEnv, "PI_CODING_AGENT_DIR" | "PI_CODING_AGENT_SESSION_DIR">;

beforeEach(async () => {
  originalEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
  };
  home = await mkdtemp(join(tmpdir(), "ticket-lock-history-"));
  agent = join(home, "fixture-agent");
  cwd = join(home, "projects", PROJECT);
  group = join(agent, "sessions", "--unrelated-working-directory--");
  process.env.PI_CODING_AGENT_DIR = "~/fixture-agent";
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

function target(project = PROJECT) {
  return {
    project,
    ticketId: TICKET_ID,
    cwd: project === PROJECT ? cwd : join(home, "projects", project),
  };
}

function transcript(
  file: string,
  ownerId: string,
  records: readonly object[],
  options: { createdAt?: string; parentSession?: string } = {},
) {
  const header = {
    type: "session",
    version: 3,
    id: ownerId,
    timestamp: options.createdAt ?? CREATED_AT,
    cwd: join(home, "somewhere-else"),
    parentSession: options.parentSession,
  };
  return writeTranscript(file, header, records);
}

async function writeTranscript(file: string, header: object, records: readonly object[]) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jsonl([header, ...records]));
  return file;
}

function jsonl(records: readonly object[]) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function event(
  options: {
    prefix?: string;
    project?: string;
    path?: string;
    status?: string;
    args?: object;
    timestamp?: string;
    isError?: boolean;
  } = {},
) {
  const { prefix = "000000", project = PROJECT, status = "locked", timestamp = LOCK_AT } = options;
  const path = options.path ?? join(home, ".agents", "tickets", project, `${TICKET_ID}.md`);
  const messageTime = Date.parse(timestamp);
  const callTime = new Date(messageTime - 1).toISOString();
  const assistant = {
    type: "message",
    id: `${prefix}01`,
    parentId: null,
    timestamp: callTime,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `call_${prefix}`,
          name: "ticket_set",
          arguments: options.args ?? { selector: "next", status },
        },
      ],
      stopReason: "toolUse",
      timestamp: messageTime - 1,
    },
  };
  const result = {
    type: "message",
    id: `${prefix}02`,
    parentId: assistant.id,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: `call_${prefix}`,
      toolName: "ticket_set",
      content: [
        {
          type: "text",
          text: `updated ${TICKET_ID}\nstatus: ${status}\nafter: -\npath: ${path}\n`,
        },
      ],
      isError: options.isError ?? false,
      timestamp: messageTime,
    },
  };
  return [assistant, result] as const;
}

describe("LockHistory", () => {
  it("finds direct lock results in archives regardless of session cwd or escaped selector", async () => {
    const lock = event({
      args: { status: "locked", selector: 'prefix "quoted"\\ segment', project: PROJECT },
    });
    const file = await transcript(join(group, "archive", "old.jsonl"), "original-owner", lock);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.deepEqual([...owners], [[KEY, { ownerId: "original-owner", file }]]);
  });

  it("uses the verified store path to distinguish a same-ID ticket in another project", async () => {
    const lock = event({
      project: "other",
      args: { status: "locked", selector: TICKET_ID, project: "other" },
    });
    const file = await transcript(join(group, "other.jsonl"), "owner", lock);
    const { owners } = await new LockHistory(home).findOwners([target(), target("other")]);
    assert.deepEqual([...owners], [[`other/${TICKET_ID}`, { ownerId: "owner", file }]]);
  });

  it("rejects a result path outside the canonical ticket store and a conflicting explicit project", async () => {
    await transcript(
      join(group, "outside.jsonl"),
      "outsider",
      event({ path: join(home, PROJECT, `${TICKET_ID}.md`) }),
    );
    await transcript(
      join(group, "conflicting.jsonl"),
      "conflicting",
      event({ args: { status: "locked", project: "other" } }),
    );
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.equal(owners.size, 0);
  });

  it("ignores missing and failed results, non-explicit locks, and lookalike results from other tools", async () => {
    const [call, result] = event({ prefix: "000003" });
    await transcript(join(group, "other-tool.jsonl"), "other-tool", [
      call,
      { ...result, message: { ...result.message, toolName: "bash" } },
    ]);
    await transcript(join(group, "failed.jsonl"), "failed", event({ isError: true }));
    await transcript(join(group, "implicit.jsonl"), "implicit", event({ args: { after: null } }));
    await transcript(join(group, "unfinished.jsonl"), "unfinished", [call]);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.equal(owners.size, 0);
  });

  it("requires the assistant call to be an ancestor of the result", async () => {
    const [call, result] = event();
    await transcript(join(group, "siblings.jsonl"), "owner", [call, { ...result, parentId: null }]);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.equal(owners.size, 0);
  });

  it("matches a result through intervening tool results, even on a superseded branch", async () => {
    const [call, result] = event();
    const intervening = {
      ...result,
      id: "00000003",
      message: { ...result.message, toolName: "ticket_show" },
    };
    const alternate = {
      type: "message",
      id: "00000004",
      parentId: call.id,
      timestamp: RELEASE_AT,
      message: { role: "user", content: "Alternate branch", timestamp: Date.parse(RELEASE_AT) },
    };
    const file = await transcript(join(group, "branches.jsonl"), "branches", [
      call,
      intervening,
      { ...result, parentId: intervening.id },
      alternate,
    ]);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.deepEqual(owners.get(KEY), { ownerId: "branches", file });
  });

  it("a later successful direct nonlocked result invalidates the older lock even without a status argument", async () => {
    const lock = event();
    const release = event({
      prefix: "000001",
      status: "blocked",
      timestamp: RELEASE_AT,
      args: { after: "dependency" },
    });
    await transcript(join(group, "lock.jsonl"), "locker", lock);
    await transcript(join(group, "release.jsonl"), "releaser", release);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.equal(owners.size, 0);
  });

  it("uses result append order to break same-session ties across branches", async () => {
    const lock = event();
    const release = event({ prefix: "000001", status: "open" });
    await transcript(join(group, "same-session.jsonl"), "owner", [...lock, ...release]);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.equal(owners.size, 0);
  });

  it("does not prefer a newer fork header over the original event or another newer lock", async () => {
    const lock = event();
    const original = join(group, "source.jsonl");
    const archived = await transcript(join(group, "archive", "source.jsonl"), "source", lock);
    await transcript(join(group, "fork.jsonl"), "fork", lock, {
      createdAt: FORKED_AT,
      parentSession: original,
    });
    const scanner = new LockHistory(home);
    assert.deepEqual((await scanner.findOwners([target()])).owners.get(KEY), {
      ownerId: "source",
      file: archived,
    });

    const newerLock = event({ prefix: "000001", timestamp: RELEASE_AT });
    const newer = await transcript(join(group, "latest.jsonl"), "latest", newerLock);
    assert.deepEqual((await scanner.findOwners([target()])).owners.get(KEY), {
      ownerId: "latest",
      file: newer,
    });
  });

  it("deduplicates an archived copy of the same event by its original IDs and timestamps", async () => {
    const file = await transcript(join(group, "source.jsonl"), "source", event());
    const archiveFile = join(group, "archive", "source.jsonl");
    await mkdir(dirname(archiveFile));
    await copyFile(file, archiveFile);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.deepEqual(owners.get(KEY), { ownerId: "source", file });
  });

  it("fails closed when the newest lock is copied but its source cannot be found", async () => {
    const earlierAt = "2026-07-04T09:10:03.000Z";
    await transcript(
      join(group, "earlier.jsonl"),
      "earlier",
      event({ prefix: "000001", timestamp: earlierAt }),
    );
    await transcript(join(group, "orphan.jsonl"), "orphan", event(), {
      createdAt: FORKED_AT,
      parentSession: join(home, "missing.jsonl"),
    });
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.equal(owners.size, 0);
  });

  it("allows work performed after a fork even when the parent session is missing", async () => {
    const newLock = event({ timestamp: "2026-07-04T11:00:03.000Z" });
    const file = await transcript(join(group, "fork.jsonl"), "fork", newLock, {
      createdAt: FORKED_AT,
      parentSession: join(home, "missing.jsonl"),
    });
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.deepEqual(owners.get(KEY), { ownerId: "fork", file });
  });

  it("fails closed on independent cross-session equal-time results", async () => {
    await transcript(join(group, "first.jsonl"), "first", event());
    const file = await transcript(
      join(group, "second.jsonl"),
      "second",
      event({ prefix: "000001" }),
    );
    await utimes(file, 1_000, 1_000);
    const { owners } = await new LockHistory(home).findOwners([target()]);
    assert.equal(owners.size, 0);
  });

  it("scans normal groups and each target's effective custom root with relative and JSONC settings", async () => {
    const another = target("other");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(another.cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      '{\n// project sessions\n"sessionDir":"./custom",\n}',
    );
    await writeFile(join(another.cwd, ".pi", "settings.json"), '{"sessionDir":"./custom"}');
    const archive = await transcript(
      join(cwd, "custom", "archive", "owner.jsonl"),
      "custom-owner",
      event(),
    );
    const normal = await transcript(
      join(group, "owner.jsonl"),
      "normal-owner",
      event({ project: "other" }),
    );
    const { owners } = await new LockHistory(home).findOwners([target(), another]);
    assert.deepEqual(owners.get(KEY), { ownerId: "custom-owner", file: archive });
    assert.deepEqual(owners.get(`other/${TICKET_ID}`), { ownerId: "normal-owner", file: normal });
  });

  it("uses the agent settings fallback and honors the environment override", async () => {
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "settings.json"), '{"sessionDir":"~/global"}');
    const globalFile = await transcript(
      join(home, "global", "owner.jsonl"),
      "global-owner",
      event(),
    );
    const scanner = new LockHistory(home);
    assert.deepEqual((await scanner.findOwners([target()])).owners.get(KEY), {
      ownerId: "global-owner",
      file: globalFile,
    });

    process.env.PI_CODING_AGENT_SESSION_DIR = "./override";
    const overrideFile = await transcript(
      join(cwd, "override", "owner.jsonl"),
      "override-owner",
      event(),
    );
    assert.deepEqual((await scanner.findOwners([target()])).owners.get(KEY), {
      ownerId: "override-owner",
      file: overrideFile,
    });
  });

  it("refreshes a cached transcript after appending a release", async () => {
    const file = await transcript(join(group, "owner.jsonl"), "owner", event());
    const scanner = new LockHistory(home);
    assert.deepEqual((await scanner.findOwners([target()])).owners.get(KEY), {
      ownerId: "owner",
      file,
    });
    await appendFile(
      file,
      jsonl(event({ prefix: "000001", status: "open", timestamp: RELEASE_AT })),
    );
    assert.equal((await scanner.findOwners([target()])).owners.size, 0);
  });

  it("distinguishes an unreadable history inventory from a resolved search without an owner", async () => {
    const archive = join(group, "archive");
    await mkdir(group, { recursive: true });
    await writeFile(archive, "");
    const scanner = new LockHistory(home);
    await assert.rejects(scanner.findOwners([target()]), /Invalid session archive/);

    await rm(archive);
    const empty = await scanner.findOwners([target()]);
    assert.equal(empty.owners.size, 0);
    const file = await transcript(join(archive, "owner.jsonl"), "owner", event());
    const recovered = await scanner.findOwners([target()]);
    assert.deepEqual(recovered.owners.get(KEY), { ownerId: "owner", file });
  });

  it.each([false, true])(
    "retries a file changed before reading once (still changing: %s)",
    async (keepsChanging) => {
      const file = await transcript(join(group, "owner.jsonl"), "owner", event());
      const originalOpen = fs.open;
      let attempts = 0;
      const open = spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === file && (++attempts === 1 || keepsChanging)) {
          await appendFile(file, "\n");
        }
        return originalOpen(...args);
      });
      try {
        const scanner = new LockHistory(home);
        if (keepsChanging) {
          await assert.rejects(scanner.findOwners([target()]), /Session changed before reading/);
        } else {
          const { owners } = await scanner.findOwners([target()]);
          assert.deepEqual(owners.get(KEY), { ownerId: "owner", file });
        }
        assert.equal(attempts, 2);
      } finally {
        open.mockRestore();
      }
    },
  );

  it("validates the selected file revision observed by the lookup, not the current cache", async () => {
    const file = await transcript(join(group, "owner.jsonl"), "owner", event());
    const scanner = new LockHistory(home);
    const lookup = await scanner.findOwners([target()]);
    const owner = lookup.owners.get(KEY);
    assert.ok(owner);
    assert.equal(await lookup.isOwnerFileCurrent(owner), true);

    await appendFile(file, jsonl(event({ prefix: "000001", timestamp: RELEASE_AT })));
    const refreshed = await scanner.findOwners([target()]);
    assert.deepEqual(refreshed.owners.get(KEY), owner);
    assert.equal(await refreshed.isOwnerFileCurrent(owner), true);
    assert.equal(await lookup.isOwnerFileCurrent(owner), false);
  });

  it("invalidates equal-size, equal-mtime replacements by inode", async () => {
    const file = await transcript(join(group, "owner.jsonl"), "first", event());
    const scanner = new LockHistory(home);
    const replacement = await transcript(join(group, "replacement.tmp"), "other", event());
    await utimes(file, 1_000, 1_000);
    await utimes(replacement, 1_000, 1_000);
    assert.equal((await stat(file)).size, (await stat(replacement)).size);
    assert.deepEqual((await scanner.findOwners([target()])).owners.get(KEY), {
      ownerId: "first",
      file,
    });

    await rename(replacement, file);
    assert.deepEqual((await scanner.findOwners([target()])).owners.get(KEY), {
      ownerId: "other",
      file,
    });
  });
});
