import { afterEach, describe, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { run } from "./main";
import { preserveMtime } from "./preserve";

const TEMP_ROOT = join(tmpdir(), "work", "dotfiles", "project-move");
const FINEST_MTIME_NS =
  process.platform === "win32" ? 1_700_000_000_123_456_700n : 1_700_000_000_123_456_789n;
const EXECUTE = ["--execute", "--pi-stopped"];
const fixtures: string[] = [];
interface Fixture {
  root: string;
  home: string;
  agent: string;
  oldCwd: string;
  newCwd: string;
  stdout: string[];
  stderr: string[];
}

afterEach(() => {
  mock.restore();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): Fixture {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const root = fs.mkdtempSync(join(TEMP_ROOT, "case-"));
  fixtures.push(root);
  const home = join(root, "home");
  const newCwd = join(root, "projects", "new");
  fs.mkdirSync(newCwd, { recursive: true });
  return {
    root,
    home,
    agent: join(home, "pi-data"),
    oldCwd: join(root, "projects", "old"),
    newCwd,
    stdout: [],
    stderr: [],
  };
}

function write(path: string, bytes: string | Uint8Array): void {
  assert.ok(path.startsWith(TEMP_ROOT + sep));
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, bytes);
}

function sessionDir(f: Fixture, cwd = f.oldCwd): string {
  return join(f.agent, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function session(
  f: Fixture,
  id = "session-a",
  archive = false,
  extra: Record<string, unknown> = {},
): string {
  const path = join(sessionDir(f), archive ? "archive" : "", `${id}.jsonl`);
  write(
    path,
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2025-01-01T00:00:00Z",
      cwd: f.oldCwd,
      ...extra,
    }) + "\n",
  );
  fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
  return path;
}

function workDir(f: Fixture, cwd = f.oldCwd): string {
  return join(f.home, ".agents", "work", basename(cwd));
}

function ticketsDir(f: Fixture, cwd = f.oldCwd): string {
  return join(f.home, ".agents", "tickets", basename(cwd));
}

function invoke(f: Fixture, execute = true, onLine?: (line: string) => void): number {
  return run([...(execute ? EXECUTE : []), f.oldCwd, f.newCwd], {
    cwd: f.root,
    home: f.home,
    processEnv: { HOME: f.home, PI_CODING_AGENT_DIR: f.agent },
    stdout(line) {
      f.stdout.push(line);
      onLine?.(line);
    },
    stderr(line) {
      f.stderr.push(line);
    },
  });
}

function record(f: Fixture, prefix: string): Record<string, any> {
  const line = f.stdout.find((item) => item.startsWith(prefix + ": "));
  assert.ok(line, `missing ${prefix}: ${f.stdout.join("\n")} ${f.stderr.join("\n")}`);
  return JSON.parse(line.slice(prefix.length + 2));
}

function destination(f: Fixture, source: string): string {
  return join(sessionDir(f, f.newCwd), source.slice(sessionDir(f).length + 1));
}

function targets(f: Fixture): Record<string, any>[] {
  return f.stdout
    .filter((line) => line.startsWith("target: "))
    .map((line) => JSON.parse(line.slice(8)));
}

describe("arguments and preview", () => {
  for (const args of [
    [],
    ["a"],
    ["a", "b", "c"],
    ["--execute", "a", "b"],
    ["--pi-stopped", "a", "b"],
    ["--execute", "--execute", "--pi-stopped", "a", "b"],
    ["--help", "a"],
    ["--unknown"],
    ["", "b"],
  ]) {
    it(`returns argument error without filesystem changes for ${JSON.stringify(args)}`, () => {
      const f = fixture();
      const exit = run(args, { home: f.home, stdout: () => {}, stderr: () => {} });
      assert.equal(exit, 2);
      assert.equal(fs.existsSync(f.home), false);
    });
  }

  it("shows help without validating paths or configuration", () => {
    const output: string[] = [];
    const exit = run(["--help"], {
      processEnv: { PI_CODING_AGENT_DIR: "" },
      stdout: (line) => output.push(line),
    });
    assert.equal(exit, 0);
    assert.match(output.join("\n"), /Preview is the default/);
    assert.match(output.join("\n"), /sessions, work files, tickets and their paths/);
  });

  it("previews sessions and complete work trees and tickets without writing", () => {
    const f = fixture();
    const source = session(f);
    write(join(workDir(f), ".hidden", "plan.bin"), Buffer.from([0, 255, 1]));
    fs.mkdirSync(join(workDir(f), "empty"));
    write(join(ticketsDir(f), "TICKET-001.md"), "---\nstatus: open\n---\n\n# todo\n");
    const original = fs.readFileSync(source);
    const mtime = fs.statSync(source, { bigint: true }).mtimeNs;
    assert.equal(invoke(f, false), 0);
    assert.deepEqual(fs.readFileSync(source), original);
    assert.equal(fs.statSync(source, { bigint: true }).mtimeNs, mtime);
    assert.equal(fs.existsSync(sessionDir(f, f.newCwd)), false);
    assert.equal(fs.existsSync(join(f.agent, "project-move-backups")), false);
    assert.equal(fs.existsSync(workDir(f, f.newCwd)), false);
    assert.equal(fs.existsSync(ticketsDir(f, f.newCwd)), false);
    assert.equal(record(f, "work").files, 1);
    assert.equal(record(f, "work").directories, 2);
    assert.equal(record(f, "tickets").files, 1);
    assert.equal(record(f, "tickets").status, "move");
    assert.equal(record(f, "plan").mode, "preview");
    assert.match(record(f, "plan").precondition, /sessions, work files, tickets and their paths/);
  });

  it("returns target zero without creating backup or destination directories", () => {
    const f = fixture();
    assert.equal(invoke(f), 0);
    assert.equal(record(f, "result").targets, 0);
    assert.equal(record(f, "result").work, "absent");
    assert.equal(record(f, "result").tickets, "absent");
    assert.equal(fs.existsSync(f.home), false);
  });

  it("resolves relative cwd paths and accepts a missing old project", () => {
    const f = fixture();
    session(f);
    const exit = run(["projects/old/../old", "projects/new/."], {
      cwd: f.root,
      home: f.home,
      processEnv: { PI_CODING_AGENT_DIR: f.agent },
      stdout: (line) => f.stdout.push(line),
      stderr: (line) => f.stderr.push(line),
    });
    assert.equal(exit, 0);
    assert.equal(record(f, "plan").oldCwd, f.oldCwd);
    assert.equal(record(f, "plan").newCwd, f.newCwd);
  });

  it("supports the option terminator for project names starting with a dash", () => {
    const f = fixture();
    fs.mkdirSync(join(f.root, "-new"));
    const exit = run(["--", "-old", "-new"], {
      cwd: f.root,
      home: f.home,
      processEnv: { PI_CODING_AGENT_DIR: f.agent },
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(exit, 0);
  });
});

describe("migration and preservation", () => {
  it("moves normal/archive sessions and a complete work tree while preserving exact session bytes and nanosecond mtime", () => {
    const f = fixture();
    const parent = session(f, "parent");
    const child = session(f, "child", true, { parentSession: parent });
    const tail = Buffer.from([13, 10, 0, 255, 10, 13, 10]);
    const header = `{"type":"session","version":3,"id":"parent","timestamp":"t","cwd":${JSON.stringify(f.oldCwd)},"large":900719925474099312345,"nested":{"x":1e999,"negative":-0}}`;
    write(parent, Buffer.concat([Buffer.from(header), tail]));
    const expectedNs = FINEST_MTIME_NS;
    const fd = fs.openSync(parent, "r+");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      preserveMtime(fd, { ...stat, mtimeNs: expectedNs } as fs.BigIntStats, parent);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.statSync(parent, { bigint: true }).mtimeNs, expectedNs);
    const originals = new Map(
      [parent, child].map((path) => [
        path,
        { bytes: fs.readFileSync(path), mtime: fs.statSync(path, { bigint: true }).mtimeNs },
      ]),
    );
    const ignored = join(sessionDir(f), "subagents", "ignored.jsonl");
    write(ignored, "not a session");
    const workBytes = Buffer.from([0, 255, 42]);
    write(join(workDir(f), ".hidden", "notes.bin"), workBytes);
    write(join(workDir(f), "plan.md"), `old path ${f.oldCwd}`);
    fs.mkdirSync(join(workDir(f), "empty"));
    const ticketText = `---\nstatus: open\n---\n\n# ticket\n\nrefs ${f.oldCwd}\n`;
    write(join(ticketsDir(f), "TICKET-001.md"), ticketText);
    assert.equal(invoke(f), 0, f.stderr.join("\n"));
    for (const target of targets(f).filter((item) => item.kind === "session")) {
      const original = originals.get(target.source)!;
      assert.deepEqual(fs.readFileSync(target.backup), original.bytes);
      assert.equal(fs.statSync(target.backup, { bigint: true }).mtimeNs, original.mtime);
      assert.equal(fs.statSync(target.destination, { bigint: true }).mtimeNs, original.mtime);
      assert.equal(fs.existsSync(target.source), false);
      assert.equal(target.backupState, "verified");
      assert.equal(target.destinationState, "verified");
    }
    const migrated = fs.readFileSync(destination(f, parent));
    assert.deepEqual(migrated.subarray(migrated.indexOf(13)), tail);
    assert.match(migrated.toString("utf8"), /"large":900719925474099312345,/);
    assert.match(migrated.toString("utf8"), /"x":1e999,"negative":-0/);
    const parentHeader = JSON.parse(migrated.subarray(0, migrated.indexOf(13)).toString("utf8"));
    const expectedParentHeader = {
      type: "session",
      version: 3,
      id: "parent",
      timestamp: "t",
      cwd: f.newCwd,
      large: Number("900719925474099312345"),
      nested: { x: Infinity, negative: -0 },
    };
    assert.deepEqual(parentHeader, expectedParentHeader);
    const childHeader = JSON.parse(fs.readFileSync(destination(f, child), "utf8"));
    const expectedChildHeader = {
      type: "session",
      version: 3,
      id: "child",
      timestamp: "2025-01-01T00:00:00Z",
      cwd: f.newCwd,
      parentSession: join(sessionDir(f, f.newCwd), "parent.jsonl"),
    };
    assert.deepEqual(childHeader, expectedChildHeader);
    const work = targets(f).find((item) => item.kind === "work")!;
    assert.deepEqual(fs.readFileSync(join(work.destination, ".hidden", "notes.bin")), workBytes);
    assert.equal(
      fs.readFileSync(join(work.destination, "plan.md"), "utf8"),
      `old path ${f.oldCwd}`,
    );
    assert.ok(fs.statSync(join(work.destination, "empty")).isDirectory());
    assert.equal(fs.existsSync(work.source), false);
    assert.deepEqual(fs.readFileSync(join(work.backup, ".hidden", "notes.bin")), workBytes);
    const tickets = targets(f).find((item) => item.kind === "tickets")!;
    assert.equal(fs.readFileSync(join(tickets.destination, "TICKET-001.md"), "utf8"), ticketText);
    assert.equal(fs.readFileSync(join(tickets.backup, "TICKET-001.md"), "utf8"), ticketText);
    assert.equal(fs.existsSync(tickets.source), false);
    assert.equal(fs.readFileSync(ignored, "utf8"), "not a session");
    assert.ok(fs.statSync(join(sessionDir(f), "archive")).isDirectory());
    if (process.platform !== "win32")
      assert.equal(Number(fs.statSync(dirname(dirname(work.backup))).mode) & 0o077, 0);
    assert.deepEqual(record(f, "result"), {
      sessionsCompleted: 2,
      sessionsPending: 0,
      work: "complete",
      tickets: "complete",
      targets: 4,
    });
  });

  for (const version of [undefined, 1, 2, 3]) {
    it(`preserves legacy version ${version ?? "absent"} and opaque subsequent data without migration`, () => {
      const f = fixture();
      const source = session(f, "legacy", false, {
        version,
        parentSession: join(f.root, "outside.jsonl"),
      });
      const headerText = fs.readFileSync(source);
      const body = Buffer.from("{legacy body is not interpreted}\r\n");
      fs.appendFileSync(source, body);
      assert.equal(invoke(f), 0, f.stderr.join("\n"));
      const moved = fs.readFileSync(destination(f, source));
      assert.deepEqual(moved.subarray(moved.indexOf(10) + 1), body);
      const actual = JSON.parse(moved.subarray(0, moved.indexOf(10)).toString());
      const original = JSON.parse(headerText.toString());
      assert.equal(Object.hasOwn(actual, "version"), Object.hasOwn(original, "version"));
      assert.equal(actual.version, original.version);
      assert.equal(actual.parentSession, original.parentSession);
    });
  }

  it("preserves header-only files without adding a newline", () => {
    const f = fixture();
    const source = session(f);
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(source, bytes.subarray(0, bytes.length - 1));
    assert.equal(invoke(f), 0);
    assert.equal(fs.readFileSync(destination(f, source)).includes(10), false);
  });

  it("keeps a read-only session file read-only with its finest representable mtime", () => {
    const f = fixture();
    const source = session(f);
    const fd = fs.openSync(source, "r+");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      preserveMtime(fd, { ...stat, mtimeNs: FINEST_MTIME_NS } as fs.BigIntStats, source);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(source, 0o444);
    const mtime = fs.statSync(source, { bigint: true }).mtimeNs;
    assert.equal(mtime, FINEST_MTIME_NS);
    assert.equal(invoke(f), 0, f.stderr.join("\n"));
    const target = targets(f)[0]!;
    for (const path of [target.backup, target.destination]) {
      assert.equal(Number(fs.statSync(path).mode) & 0o777, 0o444);
      assert.equal(fs.statSync(path, { bigint: true }).mtimeNs, mtime);
    }
    assert.equal(fs.existsSync(source), false);
  });

  it("moves an empty work directory even with no sessions", () => {
    const f = fixture();
    fs.mkdirSync(workDir(f), { recursive: true });
    assert.equal(invoke(f), 0);
    assert.ok(fs.statSync(workDir(f, f.newCwd)).isDirectory());
    assert.equal(fs.existsSync(workDir(f)), false);
    assert.equal(record(f, "result").targets, 1);
  });

  it("moves an empty tickets directory even with no sessions", () => {
    const f = fixture();
    fs.mkdirSync(ticketsDir(f), { recursive: true });
    assert.equal(invoke(f), 0);
    assert.ok(fs.statSync(ticketsDir(f, f.newCwd)).isDirectory());
    assert.equal(fs.existsSync(ticketsDir(f)), false);
    assert.equal(record(f, "result").targets, 1);
  });

  it("does not inspect same-basename work storage while still moving sessions", () => {
    const f = fixture();
    f.oldCwd = join(f.root, "before", "project");
    f.newCwd = join(f.root, "after", "project");
    fs.mkdirSync(f.newCwd, { recursive: true });
    const source = session(f);
    const untouched = join(f.root, "untouched");
    write(untouched, "unchanged");
    fs.mkdirSync(dirname(workDir(f)), { recursive: true });
    fs.symlinkSync(untouched, workDir(f));
    fs.mkdirSync(dirname(ticketsDir(f)), { recursive: true });
    fs.symlinkSync(untouched, ticketsDir(f));
    assert.equal(invoke(f), 0, f.stderr.join("\n"));
    assert.equal(record(f, "work").scanned, false);
    assert.equal(record(f, "work").status, "unchanged");
    assert.equal(record(f, "tickets").scanned, false);
    assert.equal(record(f, "tickets").status, "unchanged");
    assert.equal(record(f, "result").work, "unchanged");
    assert.equal(record(f, "result").tickets, "unchanged");
    assert.equal(fs.readlinkSync(workDir(f)), untouched);
    assert.equal(fs.readlinkSync(ticketsDir(f)), untouched);
    assert.ok(fs.existsSync(destination(f, source)));
  });

  it("leaves existing destination work data untouched when the old work folder is absent", () => {
    const f = fixture();
    session(f);
    const keep = join(workDir(f, f.newCwd), "keep");
    write(keep, "existing");
    assert.equal(invoke(f), 0);
    assert.equal(fs.readFileSync(keep, "utf8"), "existing");
    assert.equal(record(f, "result").work, "absent");
  });

  it("accepts existing destination sessions with future versions and unrelated parent formats", () => {
    const f = fixture();
    session(f);
    const existing = join(sessionDir(f, f.newCwd), "future.jsonl");
    const bytes =
      JSON.stringify({
        type: "session",
        id: "future",
        cwd: f.newCwd,
        version: 4,
        timestamp: null,
        parentSession: { future: true },
      }) + "\nopaque";
    write(existing, bytes);
    assert.equal(invoke(f), 0, f.stderr.join("\n"));
    assert.equal(fs.readFileSync(existing, "utf8"), bytes);
  });

  it("rewrites an escaped header key without changing other header strings", () => {
    const f = fixture();
    const source = session(f, "escaped", false, {
      custom: { text: 'quote\\" and {} [], :', cwd: f.oldCwd },
    });
    const text = fs.readFileSync(source, "utf8").replace('"cwd":', '"\\u0063wd":');
    fs.writeFileSync(source, text);
    assert.equal(invoke(f), 0, f.stderr.join("\n"));
    const header = JSON.parse(fs.readFileSync(destination(f, source), "utf8"));
    assert.equal(header.cwd, f.newCwd);
    assert.equal(header.custom.cwd, f.oldCwd);
    assert.equal(header.custom.text, 'quote\\" and {} [], :');
  });

  it.skipIf(process.platform === "win32")("handles quotes or newlines in project paths", () => {
    const f = fixture();
    f.oldCwd = join(f.root, 'old"project\nname');
    f.newCwd = join(f.root, 'new"project\nname');
    fs.mkdirSync(f.newCwd);
    const source = session(f, "quoted", false, {
      custom: { text: 'quote\\" and {} [], :', cwd: f.oldCwd },
    });
    assert.equal(invoke(f), 0, f.stderr.join("\n"));
    const header = JSON.parse(fs.readFileSync(destination(f, source), "utf8"));
    assert.equal(header.cwd, f.newCwd);
    assert.equal(header.custom.cwd, f.oldCwd);
    assert.equal(header.custom.text, 'quote\\" and {} [], :');
    assert.ok(f.stdout.every((line) => !line.includes("\n")));
  });

  it("ignores custom session directory environment settings", () => {
    const f = fixture();
    const custom = join(f.root, "custom");
    write(join(custom, "opaque.jsonl"), "keep");
    const exit = run([f.oldCwd, f.newCwd], {
      cwd: f.root,
      home: f.home,
      processEnv: { PI_CODING_AGENT_DIR: f.agent, PI_CODING_AGENT_SESSION_DIR: custom },
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(exit, 0);
    assert.equal(fs.readFileSync(join(custom, "opaque.jsonl"), "utf8"), "keep");
  });
});

describe("preflight safety", () => {
  for (const collision of [
    "filename",
    "id",
    "work-directory",
    "work-file",
    "work-symlink",
    "tickets-directory",
  ]) {
    it(`stops before any writes on ${collision} collision`, () => {
      const f = fixture();
      const source = session(f);
      const original = fs.readFileSync(source);
      if (collision === "filename") write(destination(f, source), original);
      if (collision === "id")
        write(
          join(sessionDir(f, f.newCwd), "other.jsonl"),
          JSON.stringify({ type: "session", id: "session-a", cwd: f.newCwd }),
        );
      if (collision.startsWith("work-")) {
        write(join(workDir(f), "source.txt"), "source");
        if (collision === "work-directory") fs.mkdirSync(workDir(f, f.newCwd));
        if (collision === "work-file") write(workDir(f, f.newCwd), "existing");
        if (collision === "work-symlink")
          fs.symlinkSync(join(f.root, "missing"), workDir(f, f.newCwd));
      }
      if (collision === "tickets-directory") {
        write(join(ticketsDir(f), "TICKET-001.md"), "ticket");
        fs.mkdirSync(ticketsDir(f, f.newCwd));
      }
      assert.equal(invoke(f), 1);
      assert.deepEqual(fs.readFileSync(source), original);
      assert.equal(fs.existsSync(join(f.agent, "project-move-backups")), false);
    });
  }

  for (const problem of [
    "cwd",
    "version",
    "timestamp",
    "parent",
    "duplicate",
    "nested-duplicate",
    "bom",
    "utf8",
    "json",
  ]) {
    it(`rejects source header ${problem} without modifying originals`, () => {
      const f = fixture();
      const source = session(f);
      let text = fs.readFileSync(source, "utf8");
      if (problem === "cwd")
        text = text.replace(JSON.stringify(f.oldCwd), JSON.stringify(f.newCwd));
      if (problem === "version") text = text.replace('"version":3', '"version":4');
      if (problem === "timestamp")
        text = text.replace('"timestamp":"2025-01-01T00:00:00Z"', '"timestamp":null');
      if (problem === "parent")
        text = text.trimEnd().slice(0, -1) + ',"parentSession":"relative"}\n';
      if (problem === "duplicate")
        text = text.replace('"type":"session"', '"type":"session","type":"session"');
      if (problem === "nested-duplicate")
        text = text.trimEnd().slice(0, -1) + ',"custom":{"x":1,"x":2}}\n';
      if (problem === "bom") text = "\uFEFF" + text;
      if (problem === "json") text = "not JSON\n";
      fs.writeFileSync(source, problem === "utf8" ? Buffer.from([255, 10]) : text);
      const before = fs.readFileSync(source);
      assert.equal(invoke(f), 1);
      assert.deepEqual(fs.readFileSync(source), before);
      assert.equal(fs.existsSync(join(f.agent, "project-move-backups")), false);
    });
  }

  it("rejects duplicate IDs across normal and archive", () => {
    const f = fixture();
    session(f, "duplicate");
    session(f, "duplicate", true);
    assert.equal(invoke(f), 1);
    assert.match(f.stderr.join("\n"), /Duplicate source session id/);
  });

  it("rejects cwd encoding collisions", () => {
    const f = fixture();
    f.oldCwd = join(f.root, "a-b");
    f.newCwd = join(f.root, "a", "b");
    fs.mkdirSync(f.newCwd, { recursive: true });
    assert.equal(invoke(f), 1);
    assert.match(f.stderr.join("\n"), /encoding collision/);
  });

  it("rejects an empty basename before writing", () => {
    const f = fixture();
    f.oldCwd = "/";
    assert.equal(invoke(f), 1);
    assert.match(f.stderr.join("\n"), /basename is empty/);
    assert.equal(fs.existsSync(f.home), false);
  });

  for (const kind of [
    "session-file",
    "session-parent",
    "work-file",
    "work-root",
    "tickets-file",
    "tickets-root",
  ]) {
    it(`rejects symlink ${kind} without following it`, () => {
      const f = fixture();
      const outside = join(f.root, "outside");
      write(join(outside, "keep"), "unchanged");
      if (kind === "session-file") {
        const source = join(sessionDir(f), "link.jsonl");
        fs.mkdirSync(dirname(source), { recursive: true });
        fs.symlinkSync(join(outside, "keep"), source);
      } else if (kind === "session-parent") {
        fs.mkdirSync(dirname(sessionDir(f)), { recursive: true });
        fs.symlinkSync(outside, sessionDir(f));
      } else {
        session(f);
        const root = kind.startsWith("work-") ? workDir(f) : ticketsDir(f);
        fs.mkdirSync(dirname(root), { recursive: true });
        if (kind.endsWith("-root")) fs.symlinkSync(outside, root);
        else {
          fs.mkdirSync(root);
          fs.symlinkSync(join(outside, "keep"), join(root, "link"));
        }
      }
      assert.equal(invoke(f), 1);
      assert.equal(fs.readFileSync(join(outside, "keep"), "utf8"), "unchanged");
      assert.equal(fs.existsSync(join(f.agent, "project-move-backups")), false);
    });
  }

  for (const overlap of ["work", "tickets"]) {
    it(`rejects overlap between the ${overlap} folder and session storage`, () => {
      const f = fixture();
      f.agent = join(
        overlap === "work" ? workDir(f) : ticketsDir(f),
        "pi-data",
      );
      session(f);
      assert.equal(invoke(f), 1);
      assert.match(f.stderr.join("\n"), /Overlapping migration paths/);
      assert.equal(fs.existsSync(join(f.agent, "project-move-backups")), false);
    });
  }
});

describe("changes and partial failures", () => {
  for (const change of ["content", "identity", "session-set", "work-set"]) {
    it(`stops safely when original ${change} changes after preflight`, () => {
      const f = fixture();
      const source = session(f);
      const original = fs.readFileSync(source);
      if (change === "work-set") write(join(workDir(f), "plan"), "plan");
      let changed = false;
      const exit = invoke(f, true, (line) => {
        if (!line.startsWith("backup: ") || changed) return;
        changed = true;
        if (change === "content") fs.appendFileSync(source, "changed");
        if (change === "identity") {
          fs.unlinkSync(source);
          fs.writeFileSync(source, original);
        }
        if (change === "session-set") session(f, "added");
        if (change === "work-set") write(join(workDir(f), "added"), "added");
      });
      assert.equal(exit, 1);
      assert.ok(fs.existsSync(source));
      assert.equal(record(f, "result").sessionsCompleted, 0);
      assert.match(f.stderr.join("\n"), /changed/i);
    });
  }

  it("does not overwrite a destination created after preflight", () => {
    const f = fixture();
    const source = session(f);
    const target = destination(f, source);
    const exit = invoke(f, true, (line) => {
      if (line.startsWith("backup: ")) write(target, "external");
    });
    assert.equal(exit, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "external");
    assert.ok(fs.existsSync(source));
    assert.equal(targets(f)[0]!.backupState, "verified");
  });

  it("retains the current original when it changes while destinations are being created", () => {
    const f = fixture();
    const source = session(f);
    const originalMkdir = fs.mkdirSync;
    spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options: any) => {
      if (String(path) === sessionDir(f, f.newCwd)) fs.appendFileSync(source, "external change");
      return originalMkdir(path, options);
    }) as typeof fs.mkdirSync);
    assert.equal(invoke(f), 1);
    assert.match(fs.readFileSync(source, "utf8"), /external change/);
    assert.equal(targets(f)[0]!.destinationState, "verified");
    assert.match(f.stderr.join("\n"), /Original changed/);
  });

  it("keeps originals when a verified backup is corrupted before deletion", () => {
    const f = fixture();
    const source = session(f);
    let backupRoot = "";
    const originalMkdir = fs.mkdirSync;
    spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options: any) => {
      if (String(path) === sessionDir(f, f.newCwd)) {
        const backup = join(backupRoot, source.slice(join(f.agent, "sessions").length + 1));
        fs.writeFileSync(backup, "corrupted");
      }
      return originalMkdir(path, options);
    }) as typeof fs.mkdirSync);
    const exit = invoke(f, true, (line) => {
      if (line.startsWith("backup: ")) backupRoot = JSON.parse(line.slice(8));
    });
    assert.equal(exit, 1);
    assert.ok(fs.existsSync(source));
    assert.equal(targets(f)[0]!.backupState, "unknown");
  });

  for (const location of ["backup", "destination"] as const) {
    it(`retains originals and reports partial ${location} writes as unverified`, () => {
      const f = fixture();
      const source = session(f);
      const before = fs.readFileSync(source);
      const openFiles = new Map<number, string>();
      const originalOpen = fs.openSync;
      const originalWrite = fs.writeFileSync;
      spyOn(fs, "openSync").mockImplementation((...args) => {
        const fd = originalOpen(...args);
        openFiles.set(fd, String(args[0]));
        return fd;
      });
      spyOn(fs, "writeFileSync").mockImplementation((...args) => {
        const path = typeof args[0] === "number" ? openFiles.get(args[0]) : undefined;
        const shouldFail =
          path !== undefined &&
          (location === "backup"
            ? path.includes("project-move-backups")
            : path === destination(f, source));
        if (shouldFail) {
          originalWrite(args[0], Buffer.from("partial"));
          throw new Error(`injected write failure: ${path}`);
        }
        return originalWrite(...args);
      });
      assert.equal(invoke(f), 1);
      assert.deepEqual(fs.readFileSync(source), before);
      const target = targets(f)[0]!;
      assert.equal(target.status, "pending");
      assert.equal(target[location + "State"], "created-unverified");
      if (location === "destination") assert.equal(target.backupState, "verified");
      assert.match(f.stderr.join("\n"), /injected write failure/);
    });
  }

  it("retains the original when setting the backup mtime fails", () => {
    const f = fixture();
    const source = session(f);
    const before = fs.readFileSync(source);
    spyOn(fs, "futimesSync").mockImplementation(() => {
      throw new Error("injected timestamp failure");
    });
    assert.equal(invoke(f), 1);
    assert.deepEqual(fs.readFileSync(source), before);
    assert.equal(targets(f)[0]!.backupState, "created-unverified");
    assert.equal(targets(f)[0]!.destinationState, "not-created");
  });

  it("detects source path replacement with a symlink after preflight", () => {
    const f = fixture();
    const source = session(f);
    const moved = join(f.root, "moved-session-folder");
    const exit = invoke(f, true, (line) => {
      if (!line.startsWith("backup: ")) return;
      fs.renameSync(sessionDir(f), moved);
      fs.symlinkSync(moved, sessionDir(f));
    });
    assert.equal(exit, 1);
    assert.ok(fs.existsSync(join(moved, basename(source))));
    assert.equal(record(f, "result").sessionsCompleted, 0);
    assert.match(f.stderr.join("\n"), /Unsafe directory path/);
  });

  it("reports completed sessions and partially deleted work originals separately", () => {
    const f = fixture();
    const source = session(f);
    const a = join(workDir(f), "a");
    const b = join(workDir(f), "b");
    write(a, "a");
    write(b, "b");
    const originalUnlink = fs.unlinkSync;
    spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path) === b) throw new Error(`injected unlink failure: ${b}`);
      return originalUnlink(path);
    });
    assert.equal(invoke(f), 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.readFileSync(b, "utf8"), "b");
    assert.equal(record(f, "result").sessionsCompleted, 1);
    assert.equal(record(f, "result").work, "partially-deleted");
    const work = targets(f).find((target) => target.kind === "work")!;
    assert.ok(work.remaining.includes(b));
    assert.equal(work.backupState, "verified");
    assert.equal(work.destinationState, "verified");
    assert.equal(fs.readFileSync(join(work.backup, "a"), "utf8"), "a");
    assert.equal(fs.readFileSync(join(work.destination, "b"), "utf8"), "b");
  });
});

describe.skipIf(process.platform !== "win32")("Windows timestamps and attributes", () => {
  it("preserves an exact 100-nanosecond mtime and atime", () => {
    const f = fixture();
    const path = join(f.root, "times.txt");
    write(path, "x");
    const fd = fs.openSync(path, "r+");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      const times = {
        ...stat,
        atimeNs: FINEST_MTIME_NS,
        mtimeNs: FINEST_MTIME_NS,
      } as fs.BigIntStats;
      preserveMtime(fd, times, path);
      const applied = fs.fstatSync(fd, { bigint: true });
      assert.equal(applied.mtimeNs, FINEST_MTIME_NS);
      assert.equal(applied.atimeNs, FINEST_MTIME_NS);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.statSync(path, { bigint: true }).mtimeNs, FINEST_MTIME_NS);
  });

  it("stops when the mtime is finer than the 100-nanosecond filesystem tick", () => {
    const f = fixture();
    const path = join(f.root, "times.txt");
    write(path, "x");
    const fd = fs.openSync(path, "r+");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      assert.throws(
        () =>
          preserveMtime(fd, { ...stat, mtimeNs: FINEST_MTIME_NS + 89n } as fs.BigIntStats, path),
        /Cannot preserve mtime precision/,
      );
    } finally {
      fs.closeSync(fd);
    }
  });

  it("keeps the read-only directory attribute in the backup and destination", () => {
    const f = fixture();
    session(f);
    const locked = join(workDir(f), "locked");
    write(join(locked, "plan.md"), "plan");
    fs.chmodSync(locked, 0o444);
    assert.equal(invoke(f), 0, f.stderr.join("\n"));
    const work = targets(f).find((item) => item.kind === "work")!;
    for (const location of [work.backup, work.destination]) {
      assert.equal(Number(fs.statSync(join(location, "locked")).mode) & 0o777, 0o444);
      assert.equal(fs.readFileSync(join(location, "locked", "plan.md"), "utf8"), "plan");
    }
    assert.equal(fs.existsSync(work.source), false);
  });
});
