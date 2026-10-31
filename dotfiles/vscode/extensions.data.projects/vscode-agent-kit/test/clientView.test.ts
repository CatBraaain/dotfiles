import { describe, expect, it } from "vitest";
import {
  archiveTargetIds,
  nextSelectionFromClick,
  selectAllIds,
  sessionListView,
  visibleSessions,
  type ClientSession,
  type ClientState,
  type ElementDescriptor,
  type ViewMode,
} from "../src/webview/client";

const atlasUnarchived: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  displayName: "Atlas current",
  mtimeMs: 4_000,
  isArchived: false,
  isLocked: false,
};
const atlasArchived: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000002",
  displayName: "Atlas archived",
  mtimeMs: 3_000,
  isArchived: true,
  isLocked: false,
};
const betaLocked: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  displayName: "Beta locked",
  mtimeMs: 2_000,
  isArchived: false,
  isLocked: true,
};
const betaPlain: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000004",
  displayName: "Beta plain",
  mtimeMs: 1_000,
  isArchived: false,
  isLocked: false,
};

const groups = [
  { cwd: "/workspace/atlas", label: "atlas", sessions: [atlasUnarchived, atlasArchived] },
  { cwd: "/workspace/beta", label: "beta", sessions: [betaLocked, betaPlain] },
];

/** Both workspaces in All mode: every session is visible. */
const allModes = modesOf({ "/workspace/atlas": "all", "/workspace/beta": "all" });

function modesOf(entries: Record<string, ViewMode> = {}): Map<string, ViewMode> {
  return new Map(Object.entries(entries));
}

function viewFor(
  modes: Map<string, ViewMode>,
  stateGroups = groups,
  copiedIds: ReadonlySet<string> = new Set(),
  selectedIds: ReadonlySet<string> = new Set(),
) {
  return sessionListView({ groups: stateGroups } as ClientState, modes, copiedIds, selectedIds);
}

function collectElements(node: ElementDescriptor | string): ElementDescriptor[] {
  if (typeof node === "string") return [];
  return [node, ...(node.children ?? []).flatMap(collectElements)];
}

function elementsIn(view: ReturnType<typeof viewFor>): ElementDescriptor[] {
  return view.sessions.flatMap(collectElements);
}

function sectionsIn(view: ReturnType<typeof viewFor>): ElementDescriptor[] {
  return view.sessions.filter((section) => section.tag === "section");
}

/** Text content of an element, concatenated depth-first. */
function text(node: ElementDescriptor): string {
  return (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
}

function byClass(elements: ElementDescriptor[], className: string): ElementDescriptor[] {
  return elements.filter((element) =>
    (element.attrs?.class ?? "").split(/\s+/).includes(className),
  );
}

describe("sessionListView", () => {
  it("renders the empty state when no workspace is visible", () => {
    const empty = viewFor(modesOf(), []);
    const allArchived = viewFor(modesOf(), [
      { cwd: "/workspace/beta", label: "beta", sessions: [atlasArchived] },
    ]);

    expect(empty.sessions).toHaveLength(1);
    expect(empty.sessions[0].tag).toBe("p");
    expect(text(empty.sessions[0])).toBe("No saved sessions");
    expect(sectionsIn(allArchived)).toHaveLength(1);
    expect(text(allArchived.sessions[0])).toContain("Select All to browse saved sessions.");
  });

  it("renders group headers with the basename, the cwd hint, and per-workspace mode buttons", () => {
    const view = viewFor(allModes);

    expect(sectionsIn(view).map((section) => section.tag)).toEqual(["section", "section"]);
    const titles = byClass(elementsIn(view), "group-title");
    expect(titles.map(text)).toEqual(["atlas", "beta"]);
    expect(titles.map((title) => title.attrs?.title)).toEqual([
      "/workspace/atlas",
      "/workspace/beta",
    ]);
    expect(byClass(elementsIn(view), "group-path").map(text)).toEqual([
      "/workspace/atlas",
      "/workspace/beta",
    ]);

    const toggles = byClass(elementsIn(view), "mode-button");
    expect(toggles.map((toggle) => toggle.attrs?.["data-mode"])).toEqual([
      "unarchived",
      "all",
      "unarchived",
      "all",
    ]);
    expect(toggles.map(text)).toEqual(["Unarchived", "All", "Unarchived", "All"]);
    expect(toggles.map((toggle) => toggle.attrs?.["data-cwd"])).toEqual([
      "/workspace/atlas",
      "/workspace/atlas",
      "/workspace/beta",
      "/workspace/beta",
    ]);
  });

  it("distinguishes same-named project and worktree groups by visible full paths", () => {
    const paths = ["/workspace/atlas", "/worktrees/atlas"];
    const view = viewFor(
      modesOf(),
      paths.map((cwd) => ({ cwd, label: "atlas", sessions: [atlasUnarchived] })),
    );

    expect(byClass(elementsIn(view), "group-title").map(text)).toEqual(["atlas", "atlas"]);
    expect(byClass(elementsIn(view), "group-path").map(text)).toEqual(paths);
  });

  it("marks the pressed mode per workspace from the modes map", () => {
    const defaultToggles = byClass(elementsIn(viewFor(modesOf())), "mode-button");
    expect(
      defaultToggles.map((toggle) => [toggle.attrs?.["data-cwd"], toggle.attrs?.["aria-pressed"]]),
    ).toEqual([
      ["/workspace/atlas", "true"],
      ["/workspace/atlas", "false"],
      ["/workspace/beta", "true"],
      ["/workspace/beta", "false"],
    ]);

    const atlasAllToggles = byClass(
      elementsIn(viewFor(modesOf({ "/workspace/atlas": "all" }))),
      "mode-button",
    );
    expect(
      atlasAllToggles.map((toggle) => [toggle.attrs?.["data-cwd"], toggle.attrs?.["aria-pressed"]]),
    ).toEqual([
      ["/workspace/atlas", "false"],
      ["/workspace/atlas", "true"],
      ["/workspace/beta", "true"],
      ["/workspace/beta", "false"],
    ]);
  });

  it("shows unarchived sessions by default and archived ones only in All mode", () => {
    expect(sectionsIn(viewFor(modesOf()))).toHaveLength(2);
    expect(byClass(elementsIn(viewFor(modesOf())), "session-name").map(text)).toEqual([
      "Atlas current",
      "Beta locked",
      "Beta plain",
    ]);

    const allAtlas = viewFor(modesOf({ "/workspace/atlas": "all" }));
    expect(byClass(elementsIn(allAtlas), "session-name").map(text)).toEqual([
      "Atlas current",
      "Atlas archived",
      "Beta locked",
      "Beta plain",
    ]);
  });

  it("renders sessions in given order and keeps the id off the row text", () => {
    const elements = elementsIn(viewFor(allModes));
    const rows = byClass(elements, "session-row");
    expect(rows).toHaveLength(4);

    const buttons = byClass(elements, "session-button");
    const timestamps = byClass(elements, "session-timestamp").map(text);
    for (const [index, session] of [
      atlasUnarchived,
      atlasArchived,
      betaLocked,
      betaPlain,
    ].entries()) {
      expect(buttons[index].attrs?.title).toContain(session.sessionId);
      expect(timestamps[index]).toBe(new Date(session.mtimeMs).toLocaleString());
    }
  });

  it("orders each row as button, timestamp, copy, lock, and the archive overlay last", () => {
    const rowClasses = (row: ElementDescriptor): (string | undefined)[] =>
      (row.children ?? [])
        .filter((child): child is ElementDescriptor => typeof child !== "string")
        .map((child) => child.attrs?.class ?? "");

    const rows = byClass(elementsIn(viewFor(allModes)), "session-row");
    expect(rowClasses(rows[0])).toEqual([
      "session-button",
      "session-timestamp",
      "copy",
      "lock",
      "archive",
    ]);
    expect(rowClasses(rows[1])).toEqual(["session-button", "session-timestamp", "copy", "lock"]);
  });

  it("renders the Copy overlay on every row with the Copy session ID hint", () => {
    const copies = byClass(elementsIn(viewFor(allModes)), "copy");

    expect(copies.map((copy) => copy.attrs?.["data-copy"])).toEqual([
      atlasUnarchived.sessionId,
      atlasArchived.sessionId,
      betaLocked.sessionId,
      betaPlain.sessionId,
    ]);
    for (const copy of copies) {
      expect(copy.attrs?.title).toBe("Copy session ID");
      expect(copy.attrs?.["aria-label"]).toBe("Copy session ID");
      expect(copy.attrs?.type).toBe("button");
    }
  });

  it("shows the check mark on the copy button of the copied session ID", () => {
    const copies = byClass(
      elementsIn(viewFor(allModes, groups, new Set([atlasUnarchived.sessionId]))),
      "copy",
    );

    expect(copies[0].attrs?.class).toBe("copy copied");
    expect(copies[0].attrs?.title).toBe("Copied");
    expect(copies[0].attrs?.["aria-label"]).toBe("Copied");
    const icon = (copies[0].children ?? []).filter(
      (child): child is ElementDescriptor => typeof child !== "string",
    );
    expect(icon[0].tag).toBe("svg");
    expect(copies[1].attrs?.class).toBe("copy");
    expect(copies[1].attrs?.title).toBe("Copy session ID");
  });

  it("renders the Lock overlay on every row with pressed state and hint per lock state", () => {
    const locks = byClass(elementsIn(viewFor(allModes)), "lock");

    expect(locks.map((lock) => lock.attrs?.["data-lock"])).toEqual([
      atlasUnarchived.sessionId,
      atlasArchived.sessionId,
      betaLocked.sessionId,
      betaPlain.sessionId,
    ]);
    expect(locks.map((lock) => [lock.attrs?.["aria-pressed"], lock.attrs?.title])).toEqual([
      ["false", "Lock"],
      ["false", "Lock"],
      ["true", "Unlock"],
      ["false", "Lock"],
    ]);
  });

  it("renders the Archive overlay on unarchived rows, disabled while locked", () => {
    const elements = elementsIn(viewFor(allModes));
    const archives = byClass(elements, "archive");

    expect(archives.map((archive) => archive.attrs?.["data-archive"])).toEqual([
      atlasUnarchived.sessionId,
      betaLocked.sessionId,
      betaPlain.sessionId,
    ]);
    expect(archives.map((archive) => [archive.attrs?.disabled, archive.attrs?.title])).toEqual([
      [undefined, "Archive"],
      ["disabled", "Archive (locked)"],
      [undefined, "Archive"],
    ]);
  });

  it("marks selected and archived rows with row classes", () => {
    const rows = byClass(
      elementsIn(viewFor(allModes, groups, new Set(), new Set([betaPlain.sessionId]))),
      "session-row",
    );

    expect(rows.map((row) => row.attrs?.class)).toEqual([
      "session-row",
      "session-row archived",
      "session-row",
      "session-row selected",
    ]);
  });

  it("uses native buttons for every interactive element", () => {
    const interactive = elementsIn(viewFor(allModes)).filter((element) =>
      ["data-action", "data-mode", "data-session", "data-archive", "data-lock", "data-copy"].some(
        (name) => element.attrs?.[name] !== undefined,
      ),
    );
    expect(interactive.length).toBeGreaterThan(0);
    for (const element of interactive) {
      expect(element.tag).toBe("button");
      expect(element.attrs?.type).toBe("button");
    }
  });
});

describe("visibleSessions", () => {
  it("flattens the display order across groups with the mode filter applied", () => {
    const state = { groups } as ClientState;

    expect(visibleSessions(state, modesOf()).map((session) => session.sessionId)).toEqual([
      atlasUnarchived.sessionId,
      betaLocked.sessionId,
      betaPlain.sessionId,
    ]);
    expect(visibleSessions(state, allModes).map((session) => session.sessionId)).toEqual([
      atlasUnarchived.sessionId,
      atlasArchived.sessionId,
      betaLocked.sessionId,
      betaPlain.sessionId,
    ]);
  });
});

describe("nextSelectionFromClick", () => {
  const visibleIds = [atlasUnarchived.sessionId, betaLocked.sessionId, betaPlain.sessionId];
  const emptySelection = new Set<string>();

  it("replaces the selection with the clicked row and opens it on a plain click", () => {
    const update = nextSelectionFromClick(
      { sessionId: betaPlain.sessionId, shiftKey: false, ctrlKey: false, metaKey: false },
      emptySelection,
      visibleIds,
      undefined,
    );

    expect(update.selection).toEqual(new Set([betaPlain.sessionId]));
    expect(update.anchor).toBe(betaPlain.sessionId);
    expect(update.opensSession).toBe(true);
  });

  it("toggles one row without opening on a Ctrl click", () => {
    const selected = new Set([atlasUnarchived.sessionId]);

    const added = nextSelectionFromClick(
      { sessionId: betaPlain.sessionId, shiftKey: false, ctrlKey: true, metaKey: false },
      selected,
      visibleIds,
      atlasUnarchived.sessionId,
    );
    expect(added.selection).toEqual(new Set([atlasUnarchived.sessionId, betaPlain.sessionId]));
    expect(added.opensSession).toBe(false);

    const removed = nextSelectionFromClick(
      { sessionId: atlasUnarchived.sessionId, shiftKey: false, ctrlKey: false, metaKey: true },
      added.selection,
      visibleIds,
      atlasUnarchived.sessionId,
    );
    expect(removed.selection).toEqual(new Set([betaPlain.sessionId]));
    expect(removed.opensSession).toBe(false);
  });

  it("selects the anchor-to-clicked range in display order across cwd groups on a Shift click", () => {
    const update = nextSelectionFromClick(
      { sessionId: betaPlain.sessionId, shiftKey: true, ctrlKey: false, metaKey: false },
      emptySelection,
      visibleIds,
      atlasUnarchived.sessionId,
    );

    expect(update.selection).toEqual(new Set(visibleIds));
    expect(update.anchor).toBe(atlasUnarchived.sessionId);
    expect(update.opensSession).toBe(false);
  });

  it("selects a backwards range up to the anchor", () => {
    const update = nextSelectionFromClick(
      { sessionId: atlasUnarchived.sessionId, shiftKey: true, ctrlKey: false, metaKey: false },
      emptySelection,
      visibleIds,
      betaPlain.sessionId,
    );

    expect(update.selection).toEqual(new Set(visibleIds));
    expect(update.anchor).toBe(betaPlain.sessionId);
  });

  it("falls back to the clicked row alone when the anchor is no longer visible", () => {
    const update = nextSelectionFromClick(
      { sessionId: betaPlain.sessionId, shiftKey: true, ctrlKey: false, metaKey: false },
      emptySelection,
      visibleIds,
      "00000000-0000-4000-8000-000000000009",
    );

    expect(update.selection).toEqual(new Set([betaPlain.sessionId]));
    expect(update.anchor).toBe(betaPlain.sessionId);
    expect(update.opensSession).toBe(false);
  });
});

describe("archiveTargetIds", () => {
  it("archives just the clicked row when it is not selected", () => {
    expect(
      archiveTargetIds(
        betaPlain.sessionId,
        new Set(),
        visibleSessions({ groups } as ClientState, allModes),
      ),
    ).toEqual([betaPlain.sessionId]);
  });

  it("archives the visible selected unarchived unlocked rows when the clicked row is selected", () => {
    const visible = visibleSessions({ groups } as ClientState, allModes);
    const selection = new Set([
      atlasUnarchived.sessionId,
      atlasArchived.sessionId,
      betaLocked.sessionId,
    ]);

    expect(archiveTargetIds(atlasUnarchived.sessionId, selection, visible)).toEqual([
      atlasUnarchived.sessionId,
    ]);
  });

  it("never archives rows hidden by the current display mode", () => {
    const visible = visibleSessions({ groups } as ClientState, modesOf());
    const selection = new Set([atlasUnarchived.sessionId, atlasArchived.sessionId]);

    expect(archiveTargetIds(atlasUnarchived.sessionId, selection, visible)).toEqual([
      atlasUnarchived.sessionId,
    ]);
  });

  it("returns no target when every selected visible row is locked or archived", () => {
    const visible = visibleSessions({ groups } as ClientState, allModes);
    const selection = new Set([betaLocked.sessionId, atlasArchived.sessionId]);

    expect(archiveTargetIds(betaLocked.sessionId, selection, visible)).toEqual([]);
  });
});

describe("selectAllIds", () => {
  it("selects the visible unarchived unlocked rows across cwd groups", () => {
    expect(selectAllIds(visibleSessions({ groups } as ClientState, allModes))).toEqual([
      atlasUnarchived.sessionId,
      betaPlain.sessionId,
    ]);
  });
});
