import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordDispatchTicket, recordViewReceipt } from "./session-metadata.ts";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
const sessionId = "owned-session";
const file = realpathSync(import.meta.path);
const sessionStat = statSync(file, { bigint: true });
const fileIdentity = [sessionStat.dev, sessionStat.ino, sessionStat.birthtimeNs].join(":");
const viewedAt = "2026-01-01T00:00:00.000Z";
const dispatch = {
  TICKET_DISPATCH_ROLE: "pi",
  TICKET_DISPATCH_PROJECT: "dotfiles",
  TICKET_DISPATCH_ID: "20260101-000000-test",
};

function history(branch: Entry[] = [], entries: Entry[] = branch) {
  const recorded: unknown[] = [];
  return {
    recorded,
    manager: {
      getSessionId: () => sessionId,
      getSessionFile: () => file,
      getBranch: () => branch,
      getEntries: () => entries,
    },
    pi: { appendEntry: (customType: string, data: unknown) => recorded.push({ customType, data }) },
  };
}

function assistantResponse(id: string): Entry {
  return {
    type: "message",
    id,
    message: { role: "assistant", content: [{ type: "text", text: id }] },
  } as Entry;
}

function dispatchEntry(owner: string): Entry {
  return { type: "custom", customType: "pi-mux-ticket", data: { sessionId: owner } } as Entry;
}

function encodeReceipt(overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      sessionId,
      processPid: process.pid,
      file,
      fileIdentity,
      viewedAt,
      responseId: "seen",
      ...overrides,
    }),
  ).toString("base64");
}

describe("dispatch ticket metadata", () => {
  it("records an assignment from ticket dispatch startup, independently of copied entries", () => {
    const { pi, manager, recorded } = history([], [dispatchEntry("parent-session")]);
    recordDispatchTicket(pi, manager, dispatch);
    assert.deepEqual(recorded, [
      {
        customType: "pi-mux-ticket",
        data: {
          sessionId,
          ticket: { project: "dotfiles", id: "20260101-000000-test" },
        },
      },
    ]);
  });

  it("does not add a new record on reload or infer a ticket without dispatch role", () => {
    const existing = history([], [dispatchEntry(sessionId)]);
    recordDispatchTicket(existing.pi, existing.manager, dispatch);
    assert.deepEqual(existing.recorded, []);
    const manual = history();
    recordDispatchTicket(manual.pi, manual.manager, {
      ...dispatch,
      TICKET_DISPATCH_ROLE: undefined,
    });
    assert.deepEqual(manual.recorded, []);
  });
});

describe("persisted view receipts", () => {
  it("appends the response named by the view even when a newer response exists", () => {
    const { pi, manager, recorded } = history([
      assistantResponse("seen"),
      assistantResponse("new"),
    ]);
    recordViewReceipt(pi, manager, encodeReceipt());
    assert.deepEqual(recorded, [
      { customType: "pi-mux-viewed", data: { sessionId, viewedAt, responseId: "seen" } },
    ]);
  });

  it("records a view made before the initial response without acknowledging it", () => {
    const { pi, manager, recorded } = history([assistantResponse("new")]);
    recordViewReceipt(pi, manager, encodeReceipt({ responseId: null }));
    assert.deepEqual(recorded, [
      { customType: "pi-mux-viewed", data: { sessionId, viewedAt, responseId: null } },
    ]);
  });

  it("ignores malformed receipts, another process or session, and responses outside the branch", () => {
    const { pi, manager, recorded } = history(
      [assistantResponse("seen")],
      [assistantResponse("alternate")],
    );
    for (const overrides of [
      { viewedAt: "invalid" },
      { processPid: process.pid + 1 },
      { sessionId: "other" },
      { responseId: "alternate" },
      { file: "/another-session.jsonl" },
      { fileIdentity: "1:1:1" },
    ])
      recordViewReceipt(pi, manager, encodeReceipt(overrides));
    assert.deepEqual(recorded, []);
  });
});
