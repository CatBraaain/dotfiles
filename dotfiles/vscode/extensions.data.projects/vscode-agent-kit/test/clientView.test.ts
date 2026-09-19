import { describe, expect, it } from "vitest";
import { sessionListView, type ClientSession, type ElementDescriptor } from "../src/webview/client";

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
const betaActive: ClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  displayName: "Beta active",
  mtimeMs: 3_000,
  isActive: true,
};

const groups = [
  { cwd: "/workspace/atlas", label: "atlas", sessions: [atlasActive, atlasOld] },
  { cwd: "/workspace/beta", label: "beta", sessions: [betaActive] },
];

function collectElements(node: ElementDescriptor | string): ElementDescriptor[] {
  if (typeof node === "string") return [];
  return [node, ...(node.children ?? []).flatMap(collectElements)];
}

function allElements(): ElementDescriptor[] {
  const view = sessionListView({ mode: "all", groups });
  return [...view.modeButtons, ...view.sessions.flatMap(collectElements)];
}

/** Text content of an element, concatenated depth-first. */
function text(node: ElementDescriptor): string {
  return (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
}

function byClass(className: string): ElementDescriptor[] {
  return allElements().filter((element) => (element.attrs?.class ?? "").split(/\s+/).includes(className));
}

describe("sessionListView", () => {
  it("renders the empty state per mode", () => {
    const active = sessionListView({ mode: "active", groups: [] });
    const all = sessionListView({ mode: "all", groups: [] });

    expect(active.sessions).toHaveLength(1);
    expect(active.sessions[0].tag).toBe("p");
    expect(text(active.sessions[0])).toBe("No active sessions");
    expect(text(all.sessions[0])).toBe("No sessions");
  });

  it("renders groups in state order with label and full cwd", () => {
    const sections = sessionListView({ mode: "all", groups }).sessions;

    expect(sections.map((section) => section.tag)).toEqual(["section", "section"]);
    const titles = byClass("group-title");
    const paths = byClass("group-path");
    expect(titles.map(text)).toEqual(["atlas", "beta"]);
    expect(paths.map((path) => path.children)).toEqual([["/workspace/atlas"], ["/workspace/beta"]]);
    expect(paths[0].attrs?.title).toBe("/workspace/atlas");
  });

  it("renders sessions in given order with id in the meta line", () => {
    const rows = byClass("session-row");
    expect(rows).toHaveLength(3);

    const names = byClass("session-name").map(text);
    expect(names).toEqual(["Atlas active", "Atlas old", "Beta active"]);
    const metas = byClass("session-meta").map(text);
    for (const session of [atlasActive, atlasOld, betaActive]) {
      expect(metas.some((meta) => meta.includes(session.sessionId))).toBe(true);
    }
  });

  it("marks only the selected mode button as pressed", () => {
    const activeView = sessionListView({ mode: "active", groups: [] });
    const allView = sessionListView({ mode: "all", groups: [] });

    const pressedOf = (view: typeof activeView) =>
      Object.fromEntries(view.modeButtons.map((button) => [button.attrs?.["data-mode"], button.attrs?.["aria-pressed"]]));
    expect(pressedOf(activeView)).toEqual({ active: "true", all: "false" });
    expect(pressedOf(allView)).toEqual({ active: "false", all: "true" });
    expect(activeView.modeButtons.map((button) => text(button))).toEqual(["Active", "All"]);
  });

  it("gives every Deactivate button a unique accessible name with the display name", () => {
    const deactivates = allElements().filter((element) => element.attrs?.["data-deactivate"] !== undefined);
    const labels = deactivates.map((element) => element.attrs?.["aria-label"]);

    expect(labels).toEqual(["Deactivate Atlas active", "Deactivate Beta active"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("adds the active indicator class only to active session rows", () => {
    const indicators = byClass("indicator");
    const rows = byClass("session-row");

    expect(indicators).toHaveLength(3);
    indicators.forEach((indicator, index) => {
      const isActive = index === 0 || index === 2;
      expect(indicator.attrs?.class).toBe(`indicator${isActive ? " active" : ""}`);
    });
    expect(rows[1].children?.[0]).toBeDefined();
  });

  it("uses native buttons for every interactive element", () => {
    const interactive = allElements().filter((element) =>
      ["data-action", "data-mode", "data-session", "data-deactivate"].some((name) => element.attrs?.[name] !== undefined),
    );
    expect(interactive.length).toBeGreaterThan(0);
    for (const element of interactive) {
      expect(element.tag).toBe("button");
      expect(element.attrs?.type).toBe("button");
    }
  });
});
