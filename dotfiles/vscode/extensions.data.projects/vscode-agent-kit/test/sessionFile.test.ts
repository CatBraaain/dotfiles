import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeSessionFile, parseSessionHeader, displayNameFromScan, createNameScan, foldSessionEntryLine } from "../src/sessionFile";
import { cleanup, header, messageEntry, sessionInfoEntry, tempDir, writeJsonl } from "./fixtures";

let dir: string;

beforeEach(async () => {
  dir = await tempDir("pi-session-file-test-");
});

afterEach(async () => {
  await cleanup(dir);
});

describe("parseSessionHeader", () => {
  it("extracts id and cwd from the session header", () => {
    const parsed = parseSessionHeader(
      JSON.stringify(header({ id: "uuid-1", cwd: "/home/user/project", timestamp: "2024-12-03T14:00:00.000Z" })),
    );
    expect(parsed).toEqual({ id: "uuid-1", cwd: "/home/user/project", timestamp: "2024-12-03T14:00:00.000Z" });
  });

  it("rejects non-session first lines", () => {
    expect(parseSessionHeader(JSON.stringify(messageEntry("user", "hi")))).toBeNull();
    expect(parseSessionHeader("not json")).toBeNull();
  });

  it("rejects headers without id or cwd", () => {
    expect(parseSessionHeader(JSON.stringify(header({ id: undefined })))).toBeNull();
    expect(parseSessionHeader(JSON.stringify(header({ cwd: undefined })))).toBeNull();
  });
});

describe("summarizeSessionFile", () => {
  it("returns null for an empty file", async () => {
    const filePath = await writeJsonl(dir, "empty.jsonl", []);
    expect(await summarizeSessionFile(filePath)).toBeNull();
  });

  it("returns null when the first line is not a session header", async () => {
    const filePath = await writeJsonl(dir, "bad.jsonl", [messageEntry("user", "hi"), header()]);
    expect(await summarizeSessionFile(filePath)).toBeNull();
  });

  it("uses the latest session_info name as the display name", async () => {
    const filePath = await writeJsonl(dir, "named.jsonl", [
      header(),
      messageEntry("user", "hello"),
      sessionInfoEntry("First name"),
      sessionInfoEntry("  Latest name  "),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("Latest name");
  });

  it("falls back to the first user message when the latest session_info clears the name", async () => {
    // pi semantics: an empty name on the latest session_info clears the title
    const filePath = await writeJsonl(dir, "cleared.jsonl", [
      header(),
      messageEntry("user", "Fix the login bug"),
      sessionInfoEntry("Old name"),
      sessionInfoEntry(""),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("Fix the login bug");
  });

  it("uses the first line of the first user message, capped at 80 chars", async () => {
    const long = "x".repeat(120);
    const filePath = await writeJsonl(dir, "long.jsonl", [
      header(),
      messageEntry("user", `${long}\nsecond line`),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("x".repeat(80));
  });

  it("trims surrounding whitespace before taking the first line", async () => {
    const filePath = await writeJsonl(dir, "multiline.jsonl", [
      header(),
      messageEntry("user", "\n\n  first line  \nsecond line"),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("first line");
  });

  it("joins text blocks of array content", async () => {
    const filePath = await writeJsonl(dir, "blocks.jsonl", [
      header(),
      messageEntry("user", [{ type: "text", text: "Part one" }, { type: "image", data: "..." }, { type: "text", text: "Part two" }]),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("Part one Part two");
  });

  it("skips user messages without text and uses the next one that has text", async () => {
    const filePath = await writeJsonl(dir, "image-first.jsonl", [
      header(),
      messageEntry("user", [{ type: "image", data: "..." }]),
      messageEntry("user", "textual message"),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("textual message");
  });

  it("ignores non-user messages and yields Untitled when there is no name and no user text", async () => {
    const filePath = await writeJsonl(dir, "assistant-only.jsonl", [
      header(),
      messageEntry("assistant", [{ type: "text", text: "Hello!" }]),
      messageEntry("toolResult", [{ type: "text", text: "output" }]),
      { type: "message", id: "e9", parentId: null, timestamp: "2024-12-03T14:00:01.000Z", message: { role: "bashExecution", command: "ls" } },
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("Untitled");
  });

  it("skips unparseable mid-file lines and still reads later entries", async () => {
    const filePath = await writeJsonl(dir, "broken.jsonl", [header(), "{broken json", sessionInfoEntry("Named after break")]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("Named after break");
  });

  it("keeps unicode display names intact", async () => {
    const filePath = await writeJsonl(dir, "unicode.jsonl", [header(), sessionInfoEntry("日本語セッション名")]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("日本語セッション名");
  });
});

describe("multi-chunk scanning (files larger than the 4 MiB scan chunk)", () => {
  const chunkBytes = 4 * 1024 * 1024;

  it("finds the latest session_info beyond chunk boundaries", async () => {
    const bigAssistantLine = {
      type: "message",
      id: "pad",
      parentId: null,
      timestamp: "2024-12-03T14:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(600_000) }],
      },
    };
    const padding = Array.from({ length: 10 }, () => bigAssistantLine); // ~6 MB total
    const filePath = await writeJsonl(dir, "big-named.jsonl", [
      header({ id: "big-1", cwd: "/b" }),
      messageEntry("user", "first user"),
      ...padding,
      sessionInfoEntry("Final name"),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("Final name");
    expect(info?.header.id).toBe("big-1");
  });

  it("extracts a session_info line larger than one chunk", async () => {
    const giant = sessionInfoEntry("Big line name", { details: "x".repeat(5_000_000) });
    const filePath = await writeJsonl(dir, "giant-line.jsonl", [header({ id: "big-2", cwd: "/b" }), giant]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("Big line name");
  });

  it("skips false-positive needles inside assistant content and uses the real first user message", async () => {
    const falseHit = messageEntry("assistant", [
      { type: "text", text: `quoted payload {"role":"user"} inside a string ${"y".repeat(chunkBytes)}` },
    ]);
    const filePath = await writeJsonl(dir, "false-hit.jsonl", [
      header({ id: "big-3", cwd: "/b" }),
      falseHit,
      messageEntry("user", "real first"),
    ]);
    const info = await summarizeSessionFile(filePath);
    expect(info?.displayName).toBe("real first");
  });
});

describe("foldSessionEntryLine / displayNameFromScan (pure helpers)", () => {
  it("session_info set after the first user message wins", () => {
    const scan = createNameScan();
    foldSessionEntryLine(scan, JSON.stringify(messageEntry("user", "first message")));
    foldSessionEntryLine(scan, JSON.stringify(sessionInfoEntry("Late name")));
    expect(displayNameFromScan(scan)).toBe("Late name");
  });

  it("clearing the name falls back to the first user message", () => {
    const scan = createNameScan();
    foldSessionEntryLine(scan, JSON.stringify(sessionInfoEntry("name")));
    foldSessionEntryLine(scan, JSON.stringify(sessionInfoEntry(undefined)));
    foldSessionEntryLine(scan, JSON.stringify(messageEntry("user", "fallback text")));
    expect(displayNameFromScan(scan)).toBe("fallback text");
  });

  it("handles the first line of user content with CRLF", () => {
    const scan = createNameScan();
    foldSessionEntryLine(scan, JSON.stringify(messageEntry("user", "line one\r\nline two")));
    expect(displayNameFromScan(scan)).toBe("line one");
  });
});
