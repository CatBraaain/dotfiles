import { describe, expect, it } from "vitest";
import {
  sessionListView,
  type ClientSession,
  type ClientState,
  type ElementDescriptor,
  type ViewMode,
} from "../src/webview/client";

const atlasActive: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  displayName: "Atlas active",
  mtimeMs: 2_000,
  isActive: true,
};
const atlasOld: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000002",
  displayName: "Atlas old",
  mtimeMs: 1_000,
  isActive: false,
};
const betaInactive: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  displayName: "Beta inactive",
  mtimeMs: 3_000,
  isActive: false,
};

const groups = [
  { cwd: "/workspace/atlas", label: "atlas", sessions: [atlasActive, atlasOld] },
  { cwd: "/workspace/beta", label: "beta", sessions: [betaInactive] },
];

/** Both workspaces in All mode: every session is visible. */
const allModes = modesOf({ "/workspace/atlas": "all", "/workspace/beta": "all" });

function modesOf(entries: Record<string, ViewMode> = {}): Map<string, ViewMode> {
  return new Map(Object.entries(entries));
}

function viewFor(modes: Map<string, ViewMode>, stateGroups = groups, copiedIds: ReadonlySet<string> = new Set()) {
  return sessionListView({ groups: stateGroups } as ClientState, modes, copiedIds);
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
  return elements.filter((element) => (element.attrs?.class ?? "").split(/\s+/).includes(className));
}

describe("sessionListView", () => {
  it("renders the empty state when no workspace is visible", () => {
    const empty = viewFor(modesOf(), []);
    const allInactive = viewFor(modesOf(), [{ cwd: "/workspace/beta", label: "beta", sessions: [betaInactive] }]);

    expect(empty.sessions).toHaveLength(1);
    expect(empty.sessions[0].tag).toBe("p");
    expect(text(empty.sessions[0])).toBe("No active sessions");
    expect(text(allInactive.sessions[0])).toBe("No active sessions");
  });

  it("renders group headers with the basename, the cwd hint, and per-workspace mode buttons", () => {
    const view = viewFor(allModes);

    expect(sectionsIn(view).map((section) => section.tag)).toEqual(["section", "section"]);
    const titles = byClass(elementsIn(view), "group-title");
    expect(titles.map(text)).toEqual(["atlas", "beta"]);
    expect(titles.map((title) => title.attrs?.title)).toEqual(["/workspace/atlas", "/workspace/beta"]);
    expect(byClass(elementsIn(view), "group-path")).toHaveLength(0);

    const toggles = byClass(elementsIn(view), "mode-button");
    expect(toggles.map((toggle) => toggle.attrs?.["data-mode"])).toEqual(["active", "all", "active", "all"]);
    expect(toggles.map((toggle) => toggle.attrs?.["data-cwd"])).toEqual([
      "/workspace/atlas",
      "/workspace/atlas",
      "/workspace/beta",
      "/workspace/beta",
    ]);
  });

  it("marks the pressed mode per workspace from the modes map", () => {
    const defaultToggles = byClass(elementsIn(viewFor(modesOf())), "mode-button");
    expect(defaultToggles.map((toggle) => [toggle.attrs?.["data-cwd"], toggle.attrs?.["aria-pressed"]])).toEqual([
      ["/workspace/atlas", "true"],
      ["/workspace/atlas", "false"],
    ]);

    const atlasAllToggles = byClass(elementsIn(viewFor(modesOf({ "/workspace/atlas": "all" }))), "mode-button");
    expect(atlasAllToggles.map((toggle) => [toggle.attrs?.["data-cwd"], toggle.attrs?.["aria-pressed"]])).toEqual([
      ["/workspace/atlas", "false"],
      ["/workspace/atlas", "true"],
    ]);
  });

  it("shows only active sessions per workspace and hides workspaces without active sessions", () => {
    expect(sectionsIn(viewFor(modesOf()))).toHaveLength(1);
    expect(byClass(elementsIn(viewFor(modesOf())), "session-name").map(text)).toEqual(["Atlas active"]);

    const allAtlas = viewFor(modesOf({ "/workspace/atlas": "all" }));
    expect(sectionsIn(allAtlas)).toHaveLength(1);
    expect(byClass(elementsIn(allAtlas), "session-name").map(text)).toEqual(["Atlas active", "Atlas old"]);

    expect(sectionsIn(viewFor(allModes))).toHaveLength(2);
    expect(byClass(elementsIn(viewFor(allModes)), "session-name").map(text)).toEqual([
      "Atlas active",
      "Atlas old",
      "Beta inactive",
    ]);
  });

  it("renders sessions in given order with active marks and keeps the id off the row text", () => {
    const elements = elementsIn(viewFor(allModes));
    const rows = byClass(elements, "session-row");
    expect(rows).toHaveLength(3);

    expect(byClass(elements, "indicator").map((indicator) => indicator.attrs?.class)).toEqual([
      "indicator active",
      "indicator",
      "indicator",
    ]);
    // The meta line is gone: the id lives in the button hint, the time at the row's right edge.
    expect(byClass(elements, "session-meta")).toHaveLength(0);
    const buttons = byClass(elements, "session-button");
    const timestamps = byClass(elements, "session-timestamp").map(text);
    for (const [index, session] of [atlasActive, atlasOld, betaInactive].entries()) {
      expect(buttons[index].attrs?.title).toContain(session.sessionId);
      expect(timestamps[index]).toBe(new Date(session.mtimeMs).toLocaleString());
    }
  });

  it("orders each row as button, timestamp, copy, and the archive overlay last", () => {
    const rowClasses = (row: ElementDescriptor): (string | undefined)[] =>
      (row.children ?? [])
        .filter((child): child is ElementDescriptor => typeof child !== "string")
        .map((child) => child.attrs?.class ?? "");

    const rows = byClass(elementsIn(viewFor(allModes)), "session-row");
    expect(rowClasses(rows[0])).toEqual(["session-button", "session-timestamp", "copy", "archive"]);
    expect(rowClasses(rows[1])).toEqual(["session-button", "session-timestamp", "copy"]);
  });

  it("renders the Copy overlay on every row with the Copy session ID hint", () => {
    const copies = byClass(elementsIn(viewFor(allModes)), "copy");

    expect(copies.map((copy) => copy.attrs?.["data-copy"])).toEqual([
      atlasActive.sessionId,
      atlasOld.sessionId,
      betaInactive.sessionId,
    ]);
    for (const copy of copies) {
      expect(copy.attrs?.title).toBe("Copy session ID");
      expect(copy.attrs?.["aria-label"]).toBe("Copy session ID");
      expect(copy.attrs?.type).toBe("button");
    }
  });

  it("shows the check mark on the copy button of the copied session ID", () => {
    const copies = byClass(elementsIn(viewFor(allModes, groups, new Set([atlasActive.sessionId]))), "copy");

    expect(copies[0].attrs?.class).toBe("copy copied");
    expect(copies[0].attrs?.title).toBe("Copied");
    expect(copies[0].attrs?.["aria-label"]).toBe("Copied");
    const icon = (copies[0].children ?? []).filter((child): child is ElementDescriptor => typeof child !== "string");
    expect(icon[0].tag).toBe("svg");
    expect(copies[1].attrs?.class).toBe("copy");
    expect(copies[1].attrs?.title).toBe("Copy session ID");
  });

  it("renders the Archive overlay only on active rows with an icon and the Archive hint", () => {
    const archives = byClass(elementsIn(viewFor(allModes)), "archive");

    expect(archives).toHaveLength(1);
    expect(archives[0].attrs?.["data-archive"]).toBe(atlasActive.sessionId);
    expect(archives[0].attrs?.title).toBe("Archive");
    expect(archives[0].attrs?.["aria-label"]).toBe("Archive");
    const icon = (archives[0].children ?? []).filter((child): child is ElementDescriptor => typeof child !== "string");
    expect(icon).toHaveLength(1);
    expect(icon[0].tag).toBe("svg");
    const paths = (icon[0].children ?? []).filter((child): child is ElementDescriptor => typeof child !== "string");
    expect(paths).toHaveLength(1);
    expect(paths[0].tag).toBe("path");
    expect(paths[0].attrs?.d).toContain("M6.5 8");
  });

  it("uses native buttons for every interactive element", () => {
    const interactive = elementsIn(viewFor(allModes)).filter((element) =>
      ["data-action", "data-mode", "data-session", "data-archive", "data-copy"].some(
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
