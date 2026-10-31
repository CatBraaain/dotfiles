import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  convertToLlm,
  InteractiveMode,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  applyProjectionEdits,
  createReplacement,
  isEditable,
  matchMessageSources,
  pendingProjection,
  projectPendingMessages,
  REPLACEMENT_STATE,
  replacementEdits,
  replaceRequestMessages,
  summaryContent,
} from "./projection.ts";
import { assistant, commitDrafts, seedConversation } from "./test-fixture.ts";

mkdirSync("/tmp/work/dotfiles/cache-preserving-compaction-qa", { recursive: true });

function replacement(manager: SessionManager, summary = "HANDOFF") {
  const entries = pendingProjection(manager).entries;
  const targets = new Set(
    entries
      .filter((entry) => entry.messages.some((message) => message.role !== "system"))
      .map((entry) => entry.sourceEntry.id),
  );
  return createReplacement(manager, entries, targets, summary);
}

function saveState(manager: SessionManager, summary = "HANDOFF") {
  const state = replacement(manager, summary);
  manager.appendCustomEntry(REPLACEMENT_STATE, state);
  return state;
}

describe("shared replacement projection", () => {
  it("uses the standard summary wrapper without rewriting the handoff", () => {
    const handoff = "Keep  double spaces\n\n- [x] Done\nUnchanged <tag> & punctuation.";
    const manager = SessionManager.inMemory();
    seedConversation(manager, 20);
    const state = replacement(manager, handoff);
    assert.ok(state.content.includes(handoff));
    assert.equal(state.content, summaryContent(handoff));
    commitDrafts(manager, replacementEdits(state));
    assert.equal(
      manager.buildSessionProjection().messages.filter((message) => message.role !== "system")
        .length,
      1,
    );
    assert.match(JSON.stringify(manager.getEntries()), /OLD |RECENT|PENDING/);
  });

  it("preserves stored system and summaries while suppressing replaced summaries only in model input", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "system", content: "system checkpoint", timestamp: 1 });
    manager.appendMessage({ role: "user", content: "old", timestamp: 2 });
    manager.appendCompaction("STANDARD SUMMARY", null, 1);
    const branchAt = manager.getLeafId();
    manager.branchWithSummary(branchAt, "BRANCH SUMMARY");
    const user = manager.appendMessage({ role: "user", content: "editable", timestamp: 3 });
    manager.appendMessage(assistant(undefined, "answer", "stop", 4));
    const state = saveState(manager);
    assert.equal(state.anchorId, user);
    for (const edit of replacementEdits(state))
      assert.equal(isEditable(manager.getEntry(edit.targetId)!), true);
    commitDrafts(manager, pendingProjection(manager).drafts);
    const context = JSON.stringify(
      convertToLlm(projectPendingMessages(manager.buildSessionProjection().messages, manager)),
    );
    assert.doesNotMatch(context, /STANDARD SUMMARY|BRANCH SUMMARY/);
    assert.match(JSON.stringify(manager.getEntries()), /STANDARD SUMMARY/);
    assert.match(JSON.stringify(manager.getEntries()), /BRANCH SUMMARY/);
    assert.match(context, /system checkpoint/);
    assert.match(context, /HANDOFF/);
    assert.doesNotMatch(context, /editable/);
  });

  it("keeps successful uncommitted state available to the next request and later boundary", () => {
    const manager = SessionManager.inMemory();
    seedConversation(manager, 20);
    saveState(manager);
    const rawProjection = manager.buildSessionProjection();
    const messages = projectPendingMessages(rawProjection.messages, manager);
    assert.doesNotMatch(JSON.stringify(messages), /OLD |RECENT|PENDING/);
    assert.match(JSON.stringify(messages), /HANDOFF/);
    const pending = pendingProjection(manager);
    commitDrafts(manager, pending.drafts);
    assert.deepEqual(pendingProjection(manager).drafts, []);
    assert.deepEqual(manager.buildSessionProjection().messages, messages);
  });

  it("rebuilds a pending projection from saved state on resume before a normal turn completed", () => {
    const directory = mkdtempSync(
      "/tmp/work/dotfiles/cache-preserving-compaction-qa/projection-resume-",
    );
    try {
      const manager = SessionManager.inMemory(directory);
      const ids = seedConversation(manager, 20);
      manager.appendCompaction("PENDING LEGACY", ids.old, 1);
      saveState(manager);
      const file = join(directory, "fixture.jsonl");
      writeFileSync(
        file,
        [manager.getHeader(), ...manager.getBranch()]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const resumed = SessionManager.open(file);
      const pending = pendingProjection(resumed);
      assert.match(JSON.stringify(pending.entries), /HANDOFF/);
      commitDrafts(resumed, pending.drafts);
      assert.doesNotMatch(
        JSON.stringify(
          convertToLlm(projectPendingMessages(resumed.buildSessionProjection().messages, resumed)),
        ),
        /OLD |RECENT|PENDING/,
      );
      assert.match(JSON.stringify(resumed.getEntries()), /OLD /);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("follows the selected branch and leaves queued or newly appended input outside the replacement", () => {
    const manager = SessionManager.inMemory();
    seedConversation(manager, 20);
    const before = manager.getLeafId()!;
    saveState(manager);
    const stateLeaf = manager.getLeafId()!;
    manager.appendMessage({ role: "user", content: "QUEUED", timestamp: 100 });
    const pending = pendingProjection(manager);
    assert.match(JSON.stringify(pending.entries.flatMap((entry) => entry.messages)), /QUEUED/);
    manager.branch(before);
    assert.deepEqual(pendingProjection(manager).drafts, []);
    assert.match(JSON.stringify(manager.buildSessionProjection().messages), /OLD /);
    manager.branch(stateLeaf);
    assert.ok(pendingProjection(manager).drafts.length > 0);
  });

  it("replaces its previous anchor again without resurrecting omitted originals", () => {
    const manager = SessionManager.inMemory();
    const ids = seedConversation(manager, 20);
    saveState(manager, "FIRST SUMMARY");
    commitDrafts(manager, pendingProjection(manager).drafts);
    manager.appendMessage({ role: "user", content: "later work", timestamp: 100 });
    const second = saveState(manager, "SECOND SUMMARY");
    assert.equal(second.anchorId, ids.old);
    commitDrafts(manager, pendingProjection(manager).drafts);
    const context = JSON.stringify(manager.buildSessionProjection().messages);
    assert.match(context, /SECOND SUMMARY/);
    assert.doesNotMatch(context, /FIRST SUMMARY|later work|OLD /);
    assert.match(JSON.stringify(manager.getEntries()), /FIRST SUMMARY|OLD /);
  });

  it("refuses a pending state if another edit changed its expected prefix", () => {
    const manager = SessionManager.inMemory();
    const ids = seedConversation(manager, 20);
    saveState(manager);
    manager.appendContextEdit(ids.old, { content: "OTHER OWNER EDIT" });
    assert.deepEqual(pendingProjection(manager).drafts, []);
    assert.match(JSON.stringify(manager.buildSessionProjection().messages), /OTHER OWNER EDIT/);
  });

  it("ignores malformed state and state invalidated by a later standard compaction", () => {
    const manager = SessionManager.inMemory();
    seedConversation(manager, 20);
    manager.appendCustomEntry(REPLACEMENT_STATE, { version: 999, targets: [] });
    assert.deepEqual(pendingProjection(manager).drafts, []);
    saveState(manager);
    manager.appendCompaction("MANUAL COMPACT", null, 1);
    assert.deepEqual(pendingProjection(manager).drafts, []);
    assert.match(JSON.stringify(manager.buildSessionProjection().messages), /MANUAL COMPACT/);
  });

  it("maps transformed content by unambiguous provenance without changing system or retained objects", () => {
    const manager = SessionManager.inMemory();
    const ids = seedConversation(manager, 20);
    const entries = manager.buildSessionProjection().entries;
    const original = convertToLlm(manager.buildSessionProjection().messages);
    const transformed = original.map((message) =>
      message.role === "user"
        ? { ...message, content: `TRANSFORMED ${message.timestamp}` }
        : message,
    );
    const state = createReplacement(manager, entries, new Set([ids.old]), "SUMMARY");
    const sources = matchMessageSources(transformed, entries);
    const compressed = replaceRequestMessages(transformed, sources, state);
    assert.strictEqual(compressed[0], transformed[0]);
    assert.strictEqual(compressed.at(-1), transformed.at(-1));
    assert.match(JSON.stringify(compressed), /SUMMARY/);
    assert.doesNotMatch(JSON.stringify(compressed), /TRANSFORMED 2/);
  });

  it("preserves earlier request transformations on retained messages while suppressing a committed immutable summary", () => {
    const manager = SessionManager.inMemory();
    const ids = seedConversation(manager, 20);
    const legacy = manager.appendCompaction("OLD LEGACY", ids.old, 1);
    const entries = manager.buildSessionProjection().entries;
    const state = createReplacement(manager, entries, new Set([legacy, ids.old]), "SUMMARY");
    manager.appendCustomEntry(REPLACEMENT_STATE, state);
    commitDrafts(manager, pendingProjection(manager).drafts);
    const incoming = manager
      .buildSessionProjection()
      .messages.map((message) =>
        message.role === "user" && message.timestamp === 4
          ? { ...message, content: "EARLIER TRANSFORM" }
          : message,
      );
    const final = JSON.stringify(convertToLlm(projectPendingMessages(incoming, manager)));
    assert.match(final, /EARLIER TRANSFORM/);
    assert.doesNotMatch(final, /OLD LEGACY/);
    assert.match(final, /SUMMARY/);
  });

  it("fails closed when a transformed message has no unambiguous source", () => {
    const manager = SessionManager.inMemory();
    seedConversation(manager, 20);
    assert.throws(
      () =>
        matchMessageSources(
          [{ role: "user", content: "synthetic", timestamp: 999 }],
          manager.buildSessionProjection().entries,
        ),
      /unambiguously/,
    );
  });

  it("applies omissions and replacements only to content while preserving roles and metadata", () => {
    const manager = SessionManager.inMemory();
    const ids = seedConversation(manager, 20);
    const entries = manager.buildSessionProjection().entries;
    const modified = applyProjectionEdits(entries, [
      { type: "context_edit", targetId: ids.old, replacement: { content: "MODEL ONLY" } },
    ]);
    const old = modified.find((entry) => entry.sourceEntry.id === ids.old)!;
    assert.deepEqual(old.messages[0], { role: "user", content: "MODEL ONLY", timestamp: 2 });
    assert.equal(manager.getEntry(ids.old)?.type, "message");
    assert.match(JSON.stringify(manager.getEntry(ids.old)), /OLD /);
  });
});

function label(message: { summary?: string; content?: unknown }): string {
  if (message.summary) return message.summary;
  if (typeof message.content === "string") return message.content;
  return JSON.stringify(message.content) ?? "";
}

function tuiHarness(manager: SessionManager) {
  const ui = {
    isInitialized: true,
    footer: { invalidate() {} },
    programStatus: { handleEvent() {} },
    settingsManager: {
      getShowTerminalProgress() {
        return false;
      },
    },
    session: {
      extensionRunner: {
        getEntryRenderer() {
          return undefined;
        },
      },
    },
    addCustomEntryToChat: Reflect.get(InteractiveMode.prototype, "addCustomEntryToChat"),
    ui: { requestRender() {} },
    sessionManager: manager,
    entriesRenderedByBoundaryCompaction: new Set(),
    messages: ["OLD", "old answer", "RECENT", "recent answer", "PENDING"],
    clears: 0,
    chatContainer: {
      clear() {
        ui.clears++;
        ui.messages = [];
      },
    },
    renderSessionItems(items: Array<{ summary?: string; content?: unknown }>) {
      ui.messages.push(
        ...items
          .filter((item) => item.content !== undefined || item.summary !== undefined)
          .map(label),
      );
    },
    addMessageToChat(message: { summary?: string; content?: unknown }) {
      ui.messages.push(label(message));
    },
    clearStatusIndicator() {},
    async flushCompactionQueue() {},
    renderProjectTrustWarningIfNeeded() {},
    showStatus() {},
    handleEvent: Reflect.get(InteractiveMode.prototype, "handleEvent"),
    renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
    rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
    renderInitialMessages: Reflect.get(InteractiveMode.prototype, "renderInitialMessages"),
  };
  return ui;
}

describe("raw and TUI history preservation", () => {
  it("keeps original transcript text in live events, rebuild, and resume", async () => {
    const directory = mkdtempSync("/tmp/work/dotfiles/cache-preserving-compaction-qa/tui-history-");
    try {
      const manager = SessionManager.inMemory(directory);
      seedConversation(manager, 20);
      const ui = tuiHarness(manager);
      const beforeIds = new Set(manager.getEntries().map((entry) => entry.id));
      saveState(manager);
      commitDrafts(manager, pendingProjection(manager).drafts);
      for (const entry of manager.getEntries().filter((entry) => !beforeIds.has(entry.id)))
        await ui.handleEvent({ type: "entry_appended", entry });
      assert.equal(ui.clears, 0);
      assert.ok(ui.messages.some((message) => message.includes("OLD")));
      ui.rebuildChatFromMessages();
      assert.ok(ui.messages.some((message) => message.includes("OLD")));
      assert.equal(
        ui.messages.some((message) => message.includes("HANDOFF")),
        false,
      );
      const file = join(directory, "tui-fixture.jsonl");
      writeFileSync(
        file,
        [manager.getHeader(), ...manager.getBranch()]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const resumedManager = SessionManager.open(file);
      const resumed = tuiHarness(resumedManager);
      resumed.messages = [];
      resumed.renderInitialMessages();
      assert.ok(resumed.messages.some((message) => message.includes("OLD")));
      assert.equal(
        resumed.messages.some((message) => message.includes("HANDOFF")),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(convertToLlm(resumedManager.buildSessionProjection().messages)),
        /OLD |old answer/,
      );
      assert.equal(
        resumedManager.getEntries().filter((entry: SessionEntry) => entry.type === "compaction")
          .length,
        0,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
