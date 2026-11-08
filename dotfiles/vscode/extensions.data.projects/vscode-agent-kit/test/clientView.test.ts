import { describe, expect, it } from "vitest";
import {
  formatSessionTimestamp,
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
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 4).getTime(),
  isArchived: false,
};
const atlasArchived: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000002",
  displayName: "Atlas archived",
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 3).getTime(),
  isArchived: true,
};
const betaOther: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  displayName: "Beta other",
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 2).getTime(),
  isArchived: false,
};
const betaPlain: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000004",
  displayName: "Beta plain",
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 1).getTime(),
  isArchived: false,
};

const groups = [
  {
    cwd: "/workspace/atlas",
    label: "atlas",
    sessions: [atlasUnarchived, atlasArchived],
  },
  {
    cwd: "/workspace/beta",
    label: "beta",
    sessions: [betaOther, betaPlain],
  },
];

function viewFor(
  mode: ViewMode,
  stateGroups = groups,
  displayedSessionId: string | undefined = undefined,
  collapsedCwds: ReadonlySet<string> = new Set(),
) {
  return sessionListView(
    { groups: stateGroups } as ClientState,
    mode,
    displayedSessionId,
    collapsedCwds,
  );
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

describe("formatSessionTimestamp", () => {
  it("leaves unknown timestamps blank", () => {
    expect(formatSessionTimestamp(null)).toBe("");
  });

  it.each([
    {
      name: "zero-pads hours and minutes on the same local day",
      timestamp: new Date(2026, 0, 5, 9, 5),
      now: new Date(2026, 0, 5, 18, 30),
      expected: "09:05",
    },
    {
      name: "uses 24-hour time throughout the same local day",
      timestamp: new Date(2026, 0, 5, 23, 7),
      now: new Date(2026, 0, 5, 0, 1),
      expected: "23:07",
    },
    {
      name: "zero-pads the month and day of a past date",
      timestamp: new Date(2025, 0, 5, 9, 5),
      now: new Date(2026, 4, 7, 18, 30),
      expected: "01/05",
    },
    {
      name: "shows yesterday at 23:59 as a date after midnight",
      timestamp: new Date(2026, 0, 4, 23, 59),
      now: new Date(2026, 0, 5, 0, 0),
      expected: "01/04",
    },
    {
      name: "shows today's midnight as zero-padded time",
      timestamp: new Date(2026, 0, 5, 0, 0),
      now: new Date(2026, 0, 5, 0, 1),
      expected: "00:00",
    },
    {
      name: "distinguishes the same day number in another month",
      timestamp: new Date(2026, 0, 5, 9, 5),
      now: new Date(2026, 1, 5, 18, 30),
      expected: "01/05",
    },
    {
      name: "distinguishes the same month and day in another year",
      timestamp: new Date(2025, 0, 5, 9, 5),
      now: new Date(2026, 0, 5, 18, 30),
      expected: "01/05",
    },
  ])("$name", ({ timestamp, now, expected }) => {
    expect(formatSessionTimestamp(timestamp.getTime(), now)).toBe(expected);
  });
});

describe("sessionListView", () => {
  it("renders the empty state when no workspace is visible", () => {
    const empty = viewFor("unarchived", []);
    const allArchived = viewFor("unarchived", [
      {
        cwd: "/workspace/beta",
        label: "beta",
        sessions: [atlasArchived],
      },
    ]);

    expect(empty.sessions).toHaveLength(1);
    expect(empty.sessions[0].tag).toBe("p");
    expect(text(empty.sessions[0])).toBe("No saved sessions");
    expect(sectionsIn(allArchived)).toHaveLength(1);
    expect(allArchived.sessions[0].children).toHaveLength(1);
    expect(byClass(elementsIn(allArchived), "group-header")).toHaveLength(1);
    expect(byClass(elementsIn(allArchived), "mode-button")).toHaveLength(0);
    expect(byClass(elementsIn(allArchived), "session-row")).toHaveLength(0);
    expect(byClass(elementsIn(allArchived), "empty")).toHaveLength(0);
  });

  it("renders group headers with the basename and the cwd hint only", () => {
    const view = viewFor("all");

    expect(sectionsIn(view).map((section) => section.tag)).toEqual(["section", "section"]);
    const titles = byClass(elementsIn(view), "group-title");
    expect(titles.map(text)).toEqual(["atlas", "beta"]);
    const headers = byClass(elementsIn(view), "group-header");
    expect(headers.map((header) => header.attrs?.title)).toEqual([
      "/workspace/atlas",
      "/workspace/beta",
    ]);
    expect(byClass(elementsIn(view), "group-path")).toHaveLength(0);
    expect(byClass(elementsIn(view), "mode-button")).toHaveLength(0);
  });

  it("renders an Unregister button on every workspace group", () => {
    const view = viewFor("all");
    const buttons = byClass(elementsIn(view), "group-unregister");

    expect(buttons.map((button) => button.attrs?.["data-unregister"])).toEqual([
      "/workspace/atlas",
      "/workspace/beta",
    ]);
    expect(buttons[0].attrs).toMatchObject({
      type: "button",
      title: "Unregister workspace",
      "aria-label": "Unregister workspace atlas",
    });
    const path = collectElements(buttons[0]).find((element) => element.tag === "path");
    expect(path?.attrs?.d).toBe("M5 12h14");
  });

  it("renders a per-group New session button carrying its workspace cwd", () => {
    const view = viewFor("all");
    const buttons = byClass(elementsIn(view), "group-new-session");

    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.attrs?.type)).toEqual(["button", "button"]);
    expect(buttons.map((button) => button.attrs?.["data-new-session"])).toEqual([
      "/workspace/atlas",
      "/workspace/beta",
    ]);
    expect(buttons.map((button) => button.attrs?.title)).toEqual(["New session", "New session"]);
    expect(buttons.map((button) => button.attrs?.["aria-label"])).toEqual([
      "New session in atlas",
      "New session in beta",
    ]);
    for (const button of buttons) {
      const path = collectElements(button).find((element) => element.tag === "path");
      expect(path?.attrs?.d).toBe("M5 12h14");
    }
  });

  it("opens groups by default with keyboard-operable chevron and name buttons", () => {
    const elements = elementsIn(viewFor("all"));
    const paths = ["/workspace/atlas", "/workspace/beta"];
    for (const className of ["group-chevron", "group-title"]) {
      const controls = byClass(elements, className);
      expect(controls).toHaveLength(2);
      for (const [index, control] of controls.entries()) {
        expect(control.tag).toBe("button");
        expect(control.attrs).toMatchObject({
          type: "button",
          "data-toggle-group": paths[index],
          "aria-expanded": "true",
        });
        expect(control.attrs?.["aria-hidden"]).toBeUndefined();
      }
    }
  });

  it("keeps headings but omits rows in collapsed groups", () => {
    const view = viewFor("all", groups, undefined, new Set(["/workspace/atlas"]));
    const elements = elementsIn(view);

    expect(sectionsIn(view)).toHaveLength(2);
    expect(byClass(elements, "session-name").map(text)).toEqual(["Beta other", "Beta plain"]);
    const chevrons = byClass(elements, "group-chevron");
    expect(chevrons.map((chevron) => chevron.attrs?.["aria-expanded"])).toEqual(["false", "true"]);
    expect(
      chevrons.map(
        (chevron) => collectElements(chevron).find((element) => element.tag === "path")?.attrs?.d,
      ),
    ).toEqual(["m9 18 6-6-6-6", "m6 9 6 6 6-6"]);
  });

  it("hides the displayed session's selected mark only while its group is collapsed", () => {
    const closed = viewFor("all", groups, atlasUnarchived.sessionId, new Set(["/workspace/atlas"]));
    const opened = viewFor("all", groups, atlasUnarchived.sessionId);

    expect(byClass(elementsIn(closed), "selected")).toHaveLength(0);
    const selectedRows = byClass(elementsIn(opened), "selected");
    expect(selectedRows).toHaveLength(1);
    expect(text(selectedRows[0])).toContain("Atlas current");
  });

  it("distinguishes same-named project and worktree groups by heading hints", () => {
    const paths = ["/workspace/atlas", "/worktrees/atlas"];
    const view = viewFor(
      "unarchived",
      paths.map((cwd) => ({
        cwd,
        label: "atlas",
        registered: false,
        workspaceActive: true,
        sessions: [atlasUnarchived],
      })),
    );

    expect(byClass(elementsIn(view), "group-title").map(text)).toEqual(["atlas", "atlas"]);
    expect(byClass(elementsIn(view), "group-header").map((header) => header.attrs?.title)).toEqual(
      paths,
    );
    expect(byClass(elementsIn(view), "group-path")).toHaveLength(0);
    for (const [index, path] of paths.entries())
      expect(text(view.sessions[index])).not.toContain(path);
  });

  it("shows unarchived sessions by default and archived ones in All mode", () => {
    expect(sectionsIn(viewFor("unarchived"))).toHaveLength(2);
    expect(byClass(elementsIn(viewFor("unarchived")), "session-name").map(text)).toEqual([
      "Atlas current",
      "Beta other",
      "Beta plain",
    ]);

    expect(byClass(elementsIn(viewFor("all")), "session-name").map(text)).toEqual([
      "Atlas current",
      "Atlas archived",
      "Beta other",
      "Beta plain",
    ]);
  });

  it("renders sessions in given order and keeps the id off the row text", () => {
    const elements = elementsIn(viewFor("all"));
    const rows = byClass(elements, "session-row");
    expect(rows).toHaveLength(4);

    const buttons = byClass(elements, "session-button");
    const timestamps = byClass(elements, "session-timestamp").map(text);
    for (const [index, session] of [
      atlasUnarchived,
      atlasArchived,
      betaOther,
      betaPlain,
    ].entries()) {
      expect(buttons[index].attrs?.title).toContain(session.sessionId);
      expect(timestamps[index]).toBe("01/01");
    }
  });

  it("keeps an unknown-date session visible with a blank timestamp", () => {
    const view = viewFor("all", [
      {
        cwd: "/workspace/atlas",
        label: "atlas",
        sessions: [{ ...atlasUnarchived, updatedAtMs: null }],
      },
    ]);
    const elements = elementsIn(view);

    expect(byClass(elements, "session-name").map(text)).toEqual(["Atlas current"]);
    expect(byClass(elements, "session-timestamp").map(text)).toEqual([""]);
  });

  it("shows archive state in decorative dots without changing row names", () => {
    const elements = elementsIn(viewFor("all"));
    const dots = byClass(elements, "session-status");

    expect(dots.map((dot) => dot.attrs?.["data-archived"])).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    for (const dot of dots) expect(dot.attrs?.["data-locked"]).toBeUndefined();
    for (const dot of dots) expect(dot.attrs?.["aria-hidden"]).toBe("true");
    expect(byClass(elements, "session-button").map(text)).toEqual([
      "Atlas current",
      "Atlas archived",
      "Beta other",
      "Beta plain",
    ]);
  });

  it("uses 12px currentColor stroke icons for the row controls and chevrons", () => {
    const icons = elementsIn(viewFor("all")).filter((element) => element.tag === "svg");

    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.attrs).toMatchObject({
        width: "12",
        height: "12",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        "aria-hidden": "true",
        focusable: "false",
      });
    }
  });

  it("orders each row as button, timestamp, and the archive or unarchive overlay last", () => {
    const rowClasses = (row: ElementDescriptor): (string | undefined)[] =>
      (row.children ?? [])
        .filter((child): child is ElementDescriptor => typeof child !== "string")
        .map((child) => child.attrs?.class ?? "");

    const rows = byClass(elementsIn(viewFor("all")), "session-row");
    expect(rowClasses(rows[0])).toEqual(["session-button", "session-timestamp", "archive"]);
    expect(rowClasses(rows[1])).toEqual(["session-button", "session-timestamp", "unarchive"]);
  });

  it("omits copy and lock controls from every row", () => {
    const elements = elementsIn(viewFor("all"));
    for (const className of ["copy", "lock"]) expect(byClass(elements, className)).toEqual([]);
    expect(elements.some((element) => element.attrs?.["data-copy"] !== undefined)).toBe(false);
    expect(elements.some((element) => element.attrs?.["data-lock"] !== undefined)).toBe(false);
  });

  it("renders an enabled Archive overlay on every unarchived row", () => {
    const elements = elementsIn(viewFor("all"));
    const archives = byClass(elements, "archive");

    expect(archives.map((archive) => archive.attrs?.["data-archive"])).toEqual([
      atlasUnarchived.sessionId,
      betaOther.sessionId,
      betaPlain.sessionId,
    ]);
    expect(archives.map((archive) => [archive.attrs?.disabled, archive.attrs?.title])).toEqual([
      [undefined, "Archive"],
      [undefined, "Archive"],
      [undefined, "Archive"],
    ]);
  });

  it("renders the Unarchive overlay on archived rows instead of Archive", () => {
    const elements = elementsIn(viewFor("all"));
    const unarchives = byClass(elements, "unarchive");

    expect(unarchives.map((unarchive) => unarchive.attrs?.["data-unarchive"])).toEqual([
      atlasArchived.sessionId,
    ]);
    expect(
      unarchives.map((unarchive) => [unarchive.attrs?.disabled, unarchive.attrs?.title]),
    ).toEqual([[undefined, "Unarchive"]]);
  });

  it("marks the displayed session's row with the selected class", () => {
    const rows = byClass(elementsIn(viewFor("all", groups, betaPlain.sessionId)), "session-row");

    expect(rows.map((row) => row.attrs?.class)).toEqual([
      "session-row",
      "session-row archived",
      "session-row",
      "session-row selected",
    ]);
  });

  it("marks no row when the terminal shows no session", () => {
    expect(byClass(elementsIn(viewFor("all")), "selected")).toHaveLength(0);
    expect(
      byClass(elementsIn(viewFor("unarchived", groups, atlasArchived.sessionId)), "selected"),
    ).toHaveLength(0);
  });

  it("uses native buttons for every interactive element", () => {
    const interactive = elementsIn(viewFor("all")).filter((element) =>
      [
        "data-action",
        "data-mode",
        "data-toggle-group",
        "data-session",
        "data-archive",
        "data-unarchive",
      ].some((name) => element.attrs?.[name] !== undefined),
    );
    expect(interactive.length).toBeGreaterThan(0);
    for (const element of interactive) {
      expect(element.tag).toBe("button");
      expect(element.attrs?.type).toBe("button");
    }
  });
});

describe("visibleSessions", () => {
  it("combines collapsed groups with the shared mode filter", () => {
    expect(
      visibleSessions({ groups }, "unarchived", new Set(["/workspace/atlas"])).map(
        (session) => session.sessionId,
      ),
    ).toEqual([betaOther.sessionId, betaPlain.sessionId]);
    expect(
      visibleSessions({ groups }, "all", new Set(["/workspace/beta"])).map(
        (session) => session.sessionId,
      ),
    ).toEqual([atlasUnarchived.sessionId, atlasArchived.sessionId]);
  });

  it("flattens the display order across groups with the mode filter applied", () => {
    const state = { groups } as ClientState;

    expect(visibleSessions(state, "unarchived").map((session) => session.sessionId)).toEqual([
      atlasUnarchived.sessionId,
      betaOther.sessionId,
      betaPlain.sessionId,
    ]);
    expect(visibleSessions(state, "all").map((session) => session.sessionId)).toEqual([
      atlasUnarchived.sessionId,
      atlasArchived.sessionId,
      betaOther.sessionId,
      betaPlain.sessionId,
    ]);
  });
});
