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

const atlasActive: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  displayName: "Atlas current",
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 4).getTime(),
  isInactive: false,
};
const atlasInactive: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000002",
  displayName: "Atlas inactive",
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 3).getTime(),
  isInactive: true,
};
const betaOther: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  displayName: "Beta other",
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 2).getTime(),
  isInactive: false,
};
const betaPlain: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000004",
  displayName: "Beta plain",
  updatedAtMs: new Date(1970, 0, 1, 0, 0, 1).getTime(),
  isInactive: false,
};

const groups = [
  {
    cwd: "/workspace/atlas",
    label: "atlas",
    sessions: [atlasActive, atlasInactive],
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
    new Map(stateGroups.map((group) => [group.cwd, mode])),
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
    const empty = viewFor("active", []);
    const allInactive = viewFor("active", [
      {
        cwd: "/workspace/beta",
        label: "beta",
        sessions: [atlasInactive],
      },
    ]);

    expect(empty.sessions).toHaveLength(1);
    expect(empty.sessions[0].tag).toBe("p");
    expect(text(empty.sessions[0])).toBe("No sessions yet");
    expect(sectionsIn(allInactive)).toHaveLength(1);
    expect(allInactive.sessions[0].children).toHaveLength(1);
    expect(byClass(elementsIn(allInactive), "group-header")).toHaveLength(1);
    expect(byClass(elementsIn(allInactive), "group-mode-toggle")).toHaveLength(1);
    expect(byClass(elementsIn(allInactive), "session-row")).toHaveLength(0);
    expect(byClass(elementsIn(allInactive), "empty")).toHaveLength(0);
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
    expect(byClass(elementsIn(view), "group-mode-toggle")).toHaveLength(2);
  });

  it("renders one workspace disclosure button beside the independent workspace actions", () => {
    const headers = byClass(elementsIn(viewFor("all")), "group-header");

    for (const header of headers) {
      const children = (header.children ?? []).filter(
        (child): child is ElementDescriptor => typeof child !== "string",
      );
      expect(children.map((child) => child.attrs?.class)).toEqual([
        "group-toggle",
        "group-mode-toggle",
        "group-new-session",
      ]);
      const disclosure = children[0];
      expect(disclosure.tag).toBe("button");
      expect(disclosure.attrs).toMatchObject({
        type: "button",
        "data-toggle-group": header.attrs?.title,
        "aria-expanded": "true",
      });
      expect(collectElements(disclosure).filter((element) => element.tag === "button")).toEqual([
        disclosure,
      ]);
      expect(byClass(collectElements(disclosure), "group-chevron")[0].children?.[0]).toMatchObject({
        tag: "svg",
        attrs: { "aria-hidden": "true", focusable: "false" },
      });
      expect(text(disclosure)).toBe(header.attrs?.title?.split("/").at(-1));
    }
  });

  it("renders a mode button with its cwd and mode on empty, inactive, and collapsed groups", () => {
    const stateGroups = [
      { cwd: "/workspace/empty", label: "empty", sessions: [] },
      { cwd: "/workspace/inactive", label: "inactive", sessions: [atlasInactive] },
    ];
    const view = sessionListView(
      { groups: stateGroups },
      new Map([["/workspace/inactive", "all"]]),
      undefined,
      new Set(["/workspace/inactive"]),
    );
    const buttons = byClass(elementsIn(view), "group-mode-toggle");

    expect(buttons.map((button) => button.attrs)).toEqual([
      {
        class: "group-mode-toggle",
        type: "button",
        "data-mode-toggle": "/workspace/empty",
        "data-mode": "active",
        title: "Show all sessions",
        "aria-label": "Show all sessions",
      },
      {
        class: "group-mode-toggle",
        type: "button",
        "data-mode-toggle": "/workspace/inactive",
        "data-mode": "all",
        title: "Show active sessions",
        "aria-label": "Show active sessions",
      },
    ]);
    expect(buttons.map((button) => collectElements(button)[1].attrs)).toEqual([
      expect.objectContaining({
        width: "16",
        height: "16",
        fill: "currentColor",
        "data-mode-icon": "active",
      }),
      expect.objectContaining({
        width: "16",
        height: "16",
        fill: "currentColor",
        "data-mode-icon": "all",
      }),
    ]);
    expect(byClass(elementsIn(view), "session-row")).toHaveLength(0);
  });

  it("filters modes by cwd rather than the shared basename or group position", () => {
    const stateGroups = [
      { cwd: "/workspace/atlas", label: "atlas", sessions: [atlasInactive] },
      { cwd: "/worktrees/atlas", label: "atlas", sessions: [{ ...betaOther, isInactive: true }] },
    ];
    const modes = new Map<string, ViewMode>([["/worktrees/atlas", "all"]]);
    const initial = sessionListView({ groups: stateGroups });
    const view = sessionListView({ groups: stateGroups }, modes);
    const reordered = sessionListView({ groups: [...stateGroups].reverse() }, modes);

    expect(byClass(elementsIn(initial), "session-row")).toHaveLength(0);
    expect(byClass(elementsIn(view), "session-name").map(text)).toEqual(["Beta other"]);
    expect(byClass(elementsIn(reordered), "session-name").map(text)).toEqual(["Beta other"]);
    expect(
      byClass(elementsIn(view), "group-mode-toggle").map((button) => button.attrs?.["data-mode"]),
    ).toEqual(["active", "all"]);
  });

  it("keys same-named workspace groups by cwd across removal and reordering", () => {
    const groups = [
      { cwd: "/workspace/atlas", label: "atlas", sessions: [] },
      { cwd: "/worktrees/atlas", label: "atlas", sessions: [] },
    ];
    const initial = sessionListView({ groups });
    const reordered = sessionListView({ groups: [...groups].reverse() });
    const removed = sessionListView({ groups: groups.slice(1) });

    expect(initial.sessions.map((group) => group.key)).toEqual([
      "/workspace/atlas",
      "/worktrees/atlas",
    ]);
    expect(reordered.sessions.map((group) => group.key)).toEqual([
      "/worktrees/atlas",
      "/workspace/atlas",
    ]);
    expect(removed.sessions.map((group) => group.key)).toEqual(["/worktrees/atlas"]);
    expect(initial.sessions.every((group) => group.attrs?.key === undefined)).toBe(true);
  });

  it("offers the workspace menu on each header without a permanent Unregister button", () => {
    const view = viewFor("all");
    const headers = byClass(elementsIn(view), "group-header");

    expect(headers.map((header) => header.attrs?.["data-workspace-menu"])).toEqual([
      "/workspace/atlas",
      "/workspace/beta",
    ]);
    expect(byClass(elementsIn(view), "group-unregister")).toHaveLength(0);
    expect(byClass(elementsIn(view), "group-mode-toggle")).toHaveLength(2);
    expect(byClass(elementsIn(view), "group-new-session")).toHaveLength(2);
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

  it("keeps headings but omits rows in collapsed groups", () => {
    const view = viewFor("all", groups, undefined, new Set(["/workspace/atlas"]));
    const elements = elementsIn(view);

    expect(sectionsIn(view)).toHaveLength(2);
    expect(byClass(elements, "session-name").map(text)).toEqual(["Beta other", "Beta plain"]);
    const chevrons = byClass(elements, "group-chevron");
    expect(
      byClass(elements, "group-toggle").map((button) => button.attrs?.["aria-expanded"]),
    ).toEqual(["false", "true"]);
    expect(
      chevrons.map(
        (chevron) => collectElements(chevron).find((element) => element.tag === "path")?.attrs?.d,
      ),
    ).toEqual(["m9 18 6-6-6-6", "m6 9 6 6 6-6"]);
  });

  it("hides the displayed session's selected mark only while its group is collapsed", () => {
    const closed = viewFor("all", groups, atlasActive.sessionId, new Set(["/workspace/atlas"]));
    const opened = viewFor("all", groups, atlasActive.sessionId);

    expect(byClass(elementsIn(closed), "selected")).toHaveLength(0);
    const selectedRows = byClass(elementsIn(opened), "selected");
    expect(selectedRows).toHaveLength(1);
    expect(text(selectedRows[0])).toContain("Atlas current");
  });

  it("distinguishes same-named project and worktree groups by heading hints", () => {
    const paths = ["/workspace/atlas", "/worktrees/atlas"];
    const view = viewFor(
      "active",
      paths.map((cwd) => ({
        cwd,
        label: "atlas",
        registered: false,
        workspaceActive: true,
        sessions: [atlasActive],
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

  it("shows active sessions by default and inactive ones in All mode", () => {
    expect(sectionsIn(viewFor("active"))).toHaveLength(2);
    expect(byClass(elementsIn(viewFor("active")), "session-name").map(text)).toEqual([
      "Atlas current",
      "Beta other",
      "Beta plain",
    ]);

    expect(byClass(elementsIn(viewFor("all")), "session-name").map(text)).toEqual([
      "Atlas current",
      "Atlas inactive",
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
    for (const [index, session] of [atlasActive, atlasInactive, betaOther, betaPlain].entries()) {
      expect(buttons[index].attrs?.title).toContain(session.sessionId);
      expect(timestamps[index]).toBe("01/01");
    }
  });

  it("labels each session row with its id for the slide animation", () => {
    const elements = elementsIn(viewFor("all"));
    const rows = byClass(elements, "session-row");
    expect(rows.map((row) => row.attrs?.["data-row-session"])).toEqual([
      atlasActive.sessionId,
      atlasInactive.sessionId,
      betaOther.sessionId,
      betaPlain.sessionId,
    ]);
  });

  it("keeps an unknown-date session visible with a blank timestamp", () => {
    const view = viewFor("all", [
      {
        cwd: "/workspace/atlas",
        label: "atlas",
        sessions: [{ ...atlasActive, updatedAtMs: null }],
      },
    ]);
    const elements = elementsIn(view);

    expect(byClass(elements, "session-name").map(text)).toEqual(["Atlas current"]);
    expect(byClass(elements, "session-timestamp").map(text)).toEqual([""]);
  });

  it("keeps phase-absent status slots empty regardless of deactivate without changing row names", () => {
    const elements = elementsIn(viewFor("all"));
    const slots = byClass(elements, "session-status");

    expect(slots.map((slot) => slot.attrs?.["data-inactive"])).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    for (const slot of slots) {
      expect(slot.attrs?.["data-locked"]).toBeUndefined();
      expect(slot.attrs?.["aria-hidden"]).toBe("true");
      expect(slot.children).toEqual([]);
    }
    expect(byClass(elements, "session-button").map(text)).toEqual([
      "Atlas current",
      "Atlas inactive",
      "Beta other",
      "Beta plain",
    ]);
  });

  it.each([
    {
      state: "running",
      hasUnread: false,
      label: "Running",
      paths: ["M21 12a9 9 0 1 1-6.219-8.56"],
    },
    {
      state: "waiting-approval",
      hasUnread: false,
      label: "Waiting for approval",
      paths: ["M9 4v16", "M15 4v16"],
    },
    { state: "waiting-user", hasUnread: false, label: "Waiting for user", paths: [] },
    {
      state: "waiting-user",
      hasUnread: true,
      label: "Waiting for user",
      paths: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9", "M10 21a2 2 0 0 0 4 0"],
    },
  ] as const)(
    "maps $state with unread=$hasUnread to its icon and tooltip",
    ({ state, hasUnread, label, paths }) => {
      const elements = elementsIn(
        viewFor("all", [{ ...groups[0], sessions: [{ ...atlasActive, state, hasUnread }] }]),
      );
      const slot = byClass(elements, "session-status")[0];
      const statusElements = collectElements(slot);
      const statusPaths = statusElements.filter((element) => element.tag === "path");

      expect(slot.attrs?.["data-state"]).toBe(state);
      expect(slot.attrs?.["data-unread"]).toBe(String(hasUnread));
      expect(slot.attrs?.["aria-hidden"]).toBe("true");
      expect(statusPaths.map((path) => path.attrs?.d)).toEqual(paths);
      expect(slot.children).toHaveLength(paths.length === 0 ? 0 : 1);
      expect(byClass(elements, "session-button")[0].attrs?.title).toBe(
        `${atlasActive.displayName}\n${atlasActive.sessionId}\n${label}${hasUnread ? "\nUnread" : ""}`,
      );
      expect(byClass(elements, "deactivate")[0].attrs?.disabled).toBeUndefined();
      for (const icon of statusElements.filter((element) => element.tag === "svg")) {
        expect(icon.attrs).toMatchObject({
          width: "12",
          height: "12",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2",
        });
      }
      if (paths.length === 0) expect(slot.children).toEqual([]);
    },
  );

  it("hides unread icons and hints while the execution phase is unknown", () => {
    const elements = elementsIn(
      viewFor("all", [{ ...groups[0], sessions: [{ ...atlasActive, hasUnread: true }] }]),
    );
    expect(byClass(elements, "session-status")[0].children).toEqual([]);
    expect(byClass(elements, "session-button")[0].attrs?.title).toBe(
      `${atlasActive.displayName}\n${atlasActive.sessionId}`,
    );
  });

  it.each([undefined, "running", "waiting-approval", "waiting-user"] as const)(
    "keeps inactive status slots empty with phase %s",
    (state) => {
      const elements = elementsIn(
        viewFor("all", [
          { ...groups[0], sessions: [{ ...atlasInactive, state, hasUnread: true }] },
        ]),
      );
      expect(byClass(elements, "session-status")[0].children).toEqual([]);
      expect(byClass(elements, "activate")).toHaveLength(1);
    },
  );

  it("marks a delayed publication with a dot in the slot and a tooltip line", () => {
    const elements = elementsIn(
      viewFor("all", [{ ...groups[0], sessions: [{ ...atlasActive, publishDelayed: true }] }]),
    );
    const slot = byClass(elements, "session-status")[0];

    expect(slot.attrs?.["data-delayed"]).toBe("true");
    expect(slot.children).toEqual([
      expect.objectContaining({ attrs: { class: "session-delay-dot" } }),
    ]);
    expect(byClass(elements, "session-button")[0].attrs?.title).toBe(
      `${atlasActive.displayName}\n${atlasActive.sessionId}\nState update delayed`,
    );
  });

  it("keeps the phase icon beside the publish-delay dot when both apply", () => {
    const elements = elementsIn(
      viewFor("all", [
        {
          ...groups[0],
          sessions: [{ ...atlasActive, state: "running", publishDelayed: true }],
        },
      ]),
    );
    const slot = byClass(elements, "session-status")[0];

    expect(slot.attrs?.["data-state"]).toBe("running");
    expect(slot.attrs?.["data-delayed"]).toBe("true");
    expect(slot.children).toHaveLength(2);
    expect(byClass(elements, "session-delay-dot")).toHaveLength(1);
    expect(byClass(elements, "session-button")[0].attrs?.title).toBe(
      `${atlasActive.displayName}\n${atlasActive.sessionId}\nRunning\nState update delayed`,
    );
  });

  it("describes reload after the delay and before unread without replacing either icon", () => {
    const session = {
      ...atlasActive,
      state: "waiting-user" as const,
      hasUnread: true,
      publishDelayed: true,
      reloadPending: true,
    };
    const elements = elementsIn(viewFor("all", [{ ...groups[0], sessions: [session] }]));
    const slot = byClass(elements, "session-status")[0];

    expect(slot.children).toHaveLength(3);
    expect(byClass(elements, "session-reload-mark")[0].children).toEqual([
      expect.objectContaining({
        tag: "svg",
        attrs: expect.objectContaining({ focusable: "false" }),
      }),
    ]);
    expect(byClass(elements, "session-button")[0].attrs?.title).toBe(
      `${session.displayName}\n${session.sessionId}\nWaiting for user\nState update delayed\nReload pending\nUnread`,
    );
  });

  it("keeps delay and reload hints on inactive rows without the phase or unread hint", () => {
    const session = {
      ...atlasInactive,
      state: "waiting-user" as const,
      hasUnread: true,
      publishDelayed: true,
      reloadPending: true,
    };
    const elements = elementsIn(viewFor("all", [{ ...groups[0], sessions: [session] }]));

    expect(byClass(elements, "session-button")[0].attrs?.title).toBe(
      `${session.displayName}\n${session.sessionId}\nState update delayed\nReload pending`,
    );
  });

  it("omits the publish-delay mark for rows without a fresh delay", () => {
    const elements = elementsIn(
      viewFor("all", [
        { ...groups[0], sessions: [{ ...atlasActive, publishDelayed: false }] },
        { ...groups[0], sessions: [{ ...atlasInactive, publishDelayed: true }] },
      ]),
    );
    const [notDelayed, inactiveDelayed] = byClass(elements, "session-status");

    expect(notDelayed.attrs?.["data-delayed"]).toBeUndefined();
    expect(notDelayed.children).toEqual([]);
    expect(inactiveDelayed.attrs?.["data-delayed"]).toBe("true");
    expect(inactiveDelayed.children).toEqual([
      expect.objectContaining({ attrs: { class: "session-delay-dot" } }),
    ]);
    expect(
      byClass(elements, "session-button")[0].attrs?.title?.includes("State update delayed"),
    ).toBe(false);
  });

  it("uses 12px currentColor stroke icons for the row controls and chevrons", () => {
    const icons = elementsIn(viewFor("all")).filter(
      (element) => element.tag === "svg" && element.attrs?.["data-mode-icon"] === undefined,
    );

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

  it("orders each row as button, timestamp, and the deactivate or activate overlay last", () => {
    const rowClasses = (row: ElementDescriptor): (string | undefined)[] =>
      (row.children ?? [])
        .filter((child): child is ElementDescriptor => typeof child !== "string")
        .map((child) => child.attrs?.class ?? "");

    const rows = byClass(elementsIn(viewFor("all")), "session-row");
    expect(rowClasses(rows[0])).toEqual(["session-button", "session-timestamp", "deactivate"]);
    expect(rowClasses(rows[1])).toEqual(["session-button", "session-timestamp", "activate"]);
  });

  it("omits copy and lock controls from every row", () => {
    const elements = elementsIn(viewFor("all"));
    for (const className of ["copy", "lock"]) expect(byClass(elements, className)).toEqual([]);
    expect(elements.some((element) => element.attrs?.["data-copy"] !== undefined)).toBe(false);
    expect(elements.some((element) => element.attrs?.["data-lock"] !== undefined)).toBe(false);
  });

  it("renders an enabled Deactivate overlay on every active row", () => {
    const elements = elementsIn(viewFor("all"));
    const deactivateButtons = byClass(elements, "deactivate");

    expect(deactivateButtons.map((deactivate) => deactivate.attrs?.["data-deactivate"])).toEqual([
      atlasActive.sessionId,
      betaOther.sessionId,
      betaPlain.sessionId,
    ]);
    expect(
      deactivateButtons.map((deactivate) => [deactivate.attrs?.disabled, deactivate.attrs?.title]),
    ).toEqual([
      [undefined, "Deactivate"],
      [undefined, "Deactivate"],
      [undefined, "Deactivate"],
    ]);
  });

  it("renders the Activate overlay on inactive rows instead of Deactivate", () => {
    const elements = elementsIn(viewFor("all"));
    const activateButtons = byClass(elements, "activate");

    expect(activateButtons.map((activate) => activate.attrs?.["data-activate"])).toEqual([
      atlasInactive.sessionId,
    ]);
    expect(
      activateButtons.map((activate) => [activate.attrs?.disabled, activate.attrs?.title]),
    ).toEqual([[undefined, "Activate"]]);
  });

  it("marks the displayed session's row with the selected class", () => {
    const rows = byClass(elementsIn(viewFor("all", groups, betaPlain.sessionId)), "session-row");

    expect(rows.map((row) => row.attrs?.class)).toEqual([
      "session-row",
      "session-row inactive",
      "session-row",
      "session-row selected",
    ]);
  });

  it("marks no row when the terminal shows no session", () => {
    expect(byClass(elementsIn(viewFor("all")), "selected")).toHaveLength(0);
    expect(
      byClass(elementsIn(viewFor("active", groups, atlasInactive.sessionId)), "selected"),
    ).toHaveLength(0);
  });

  it("uses native buttons for every interactive element", () => {
    const interactive = elementsIn(viewFor("all")).filter((element) =>
      [
        "data-action",
        "data-mode",
        "data-toggle-group",
        "data-session",
        "data-deactivate",
        "data-activate",
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
  it("combines collapsed groups with the per-workspace mode filters", () => {
    expect(
      visibleSessions({ groups }, new Map(), new Set(["/workspace/atlas"])).map(
        (session) => session.sessionId,
      ),
    ).toEqual([betaOther.sessionId, betaPlain.sessionId]);
    expect(
      visibleSessions(
        { groups },
        new Map([["/workspace/atlas", "all"]]),
        new Set(["/workspace/beta"]),
      ).map((session) => session.sessionId),
    ).toEqual([atlasActive.sessionId, atlasInactive.sessionId]);
  });

  it("flattens the display order across groups with the mode filter applied", () => {
    const state = { groups } as ClientState;

    expect(visibleSessions(state).map((session) => session.sessionId)).toEqual([
      atlasActive.sessionId,
      betaOther.sessionId,
      betaPlain.sessionId,
    ]);
    expect(
      visibleSessions(state, new Map([["/workspace/atlas", "all"]])).map(
        (session) => session.sessionId,
      ),
    ).toEqual([
      atlasActive.sessionId,
      atlasInactive.sessionId,
      betaOther.sessionId,
      betaPlain.sessionId,
    ]);
  });
});
