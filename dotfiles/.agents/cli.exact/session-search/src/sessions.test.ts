import { afterAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cwdToProjectDir,
  isWithinDateRange,
  listSessionFiles,
  parseSessionFileName,
  readSessionTitle,
  resolveSessionById,
} from "./sessions";

const tempRoots: string[] = [];

function createSessionTree(): string {
  const root = mkdtempSync(join(tmpdir(), "session-search-test-"));
  tempRoots.push(root);
  return root;
}

function writeSession(root: string, project: string, fileName: string, lines: string[]): string {
  const projectDir = join(root, project);
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, fileName);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("parseSessionFileName", () => {
  it("parses the timestamp and session id from a session file name", () => {
    const fileName = "2026-10-21T02-36-37-448Z_01a15c51-58c7-701d-9567-a445a2f76fa7.jsonl";
    assert.deepEqual(parseSessionFileName(fileName), {
      startedAt: "2026-10-21T02:36:37.448Z",
      sessionId: "01a15c51-58c7-701d-9567-a445a2f76fa7",
    });
  });

  it("rejects names that are not session files", () => {
    assert.equal(parseSessionFileName("subagents"), null);
    assert.equal(parseSessionFileName("notes.txt"), null);
    assert.equal(parseSessionFileName("2026-10-21T02-36-37-448Z_not-a-uuid.jsonl"), null);
  });
});

describe("cwdToProjectDir", () => {
  it("maps a project cwd to its session directory name", () => {
    assert.equal(
      cwdToProjectDir("/home/username/projects/browser-youtube-play-all"),
      "--home-username-projects-browser-youtube-play-all--",
    );
  });
});

describe("isWithinDateRange", () => {
  it("accepts days within the range including both edges", () => {
    assert.equal(isWithinDateRange("2026-10-21", "2026-10-21", "2026-10-21"), true);
    assert.equal(isWithinDateRange("2026-10-21", "2026-10-01", "2026-10-31"), true);
  });

  it("rejects days outside the range", () => {
    assert.equal(isWithinDateRange("2026-09-30", "2026-10-01", undefined), false);
    assert.equal(isWithinDateRange("2026-11-01", undefined, "2026-10-31"), false);
  });

  it("accepts any day when both edges are omitted", () => {
    assert.equal(isWithinDateRange("2026-10-21", undefined, undefined), true);
  });
});

describe("listSessionFiles", () => {
  it("lists only session files directly under project directories, newest first", () => {
    const root = createSessionTree();
    writeSession(
      root,
      "--proj-a--",
      "2026-10-01T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
      [],
    );
    writeSession(
      root,
      "--proj-a--",
      "2026-10-21T00-00-00-000Z_00000000-0000-0000-0000-000000000002.jsonl",
      [],
    );
    const subagentsDir = join(root, "--proj-a--", "subagents");
    mkdirSync(subagentsDir);
    writeFileSync(
      join(subagentsDir, "2026-10-21T00-00-00-000Z_00000000-0000-0000-0000-000000000003.jsonl"),
      "\n",
    );
    writeSession(
      root,
      "--proj-b--",
      "2026-10-10T00-00-00-000Z_00000000-0000-0000-0000-000000000004.jsonl",
      [],
    );

    const files = listSessionFiles(root);
    assert.deepEqual(
      files.map((file) => `${file.project}/${file.sessionId.slice(-1)}`),
      ["--proj-a--/2", "--proj-b--/4", "--proj-a--/1"],
    );
  });

  it("filters projects by partial name match", () => {
    const root = createSessionTree();
    writeSession(
      root,
      "--home-username-projects-dotfiles--",
      "2026-10-01T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
      [],
    );
    writeSession(
      root,
      "--home-username-projects-playground--",
      "2026-10-01T00-00-00-000Z_00000000-0000-0000-0000-000000000002.jsonl",
      [],
    );

    const files = listSessionFiles(root, { project: "dotfiles" });
    assert.equal(files.length, 1);
    assert.equal(files[0].project, "--home-username-projects-dotfiles--");
  });

  it("filters sessions by filename date range", () => {
    const root = createSessionTree();
    writeSession(
      root,
      "--proj--",
      "2026-10-01T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
      [],
    );
    writeSession(
      root,
      "--proj--",
      "2026-10-21T00-00-00-000Z_00000000-0000-0000-0000-000000000002.jsonl",
      [],
    );

    const files = listSessionFiles(root, { since: "2026-10-10" });
    assert.equal(files.length, 1);
    assert.equal(files[0].sessionId.slice(-1), "2");
  });
});

describe("resolveSessionById", () => {
  const files = [
    {
      project: "p",
      sessionId: "01a15c51-58c7-701d-9567-a445a2f76fa7",
      startedAt: "2026-10-21T02:36:37.448Z",
      path: "/a",
    },
    {
      project: "p",
      sessionId: "01a15ca4-78c1-725d-958d-0b8eae80973d",
      startedAt: "2026-10-21T04:07:25.123Z",
      path: "/b",
    },
  ];

  it("resolves a unique id prefix", () => {
    const resolution = resolveSessionById(files, "01a15c51");
    assert.equal(resolution.status, "unique");
    assert.equal(resolution.status === "unique" && resolution.file.path, "/a");
  });

  it("reports ambiguity with the candidates", () => {
    const resolution = resolveSessionById(files, "01a15c");
    assert.equal(resolution.status, "ambiguous");
    assert.equal(resolution.status === "ambiguous" && resolution.candidates.length, 2);
  });

  it("reports not found for an unknown prefix", () => {
    assert.equal(resolveSessionById(files, "ffffffff").status, "notFound");
  });
});

describe("readSessionTitle", () => {
  it("returns the first user message text as a single line", async () => {
    const root = createSessionTree();
    const path = writeSession(
      root,
      "--proj--",
      "2026-10-21T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
      [
        '{"type":"session","id":"00000000-0000-0000-0000-000000000001","timestamp":"2026-10-21T00:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","message":{"role":"system","content":""}}',
        userLineMultiblock(),
      ],
    );
    assert.equal(await readSessionTitle(path), "first line second line");
  });

  it("returns an empty string when no user message exists", async () => {
    const root = createSessionTree();
    const path = writeSession(
      root,
      "--proj--",
      "2026-10-21T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
      [
        '{"type":"session","id":"00000000-0000-0000-0000-000000000001"}',
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
      ],
    );
    assert.equal(await readSessionTitle(path), "");
  });
});

function userLineMultiblock(): string {
  return JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "first line\nsecond line" }] },
  });
}
