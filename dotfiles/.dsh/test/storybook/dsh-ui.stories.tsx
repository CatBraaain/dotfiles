import type { Meta, StoryObj } from "@storybook/react";
import { createElement, type ReactNode } from "react";
import { entry, useClientBundle } from "./client-bundles";
import { ComposerDock } from "./fake-host";
import "./stories.css";

const meta = {
  title: "dsh client UI",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Agents: Story = {
  name: "agents / automatic selection",
  render: () => createElement(AgentsStory),
};

export const ConcurrencyRetry: Story = {
  name: "concurrency-retry / wait row",
  render: () => createElement(ConcurrencyRetryStory),
};

export const CustomUi: Story = {
  name: "custom-ui / one-line composer",
  render: () => createElement(CustomUiStory),
};

export const QuotaLine: Story = {
  name: "quota-line / available quota",
  render: () => createElement(QuotaLineStory),
};

export const SessionList: Story = {
  name: "session-list / workspace sessions",
  render: () => createElement(SessionListStory),
};

export const SkillStatus: Story = {
  name: "skill-status / used skills",
  render: () => createElement(SkillStatusStory),
};

function AgentsStory(): ReactNode {
  const component = entry(useClientBundle("agents", { fakeHostFetch: true }), "agent-class");
  return createElement(
    ComposerDock,
    null,
    component === undefined
      ? null
      : createElement(component, {
          sessionId: "storybook-session",
          initialState: {
            managed: true,
            agent: "main",
            className: "middle",
            manual: false,
            model: "glm-5.3-flash",
            agents: ["main", "senior", "junior", "vision"],
            classes: ["high", "middle", "low", "vision"],
          },
        }),
  );
}

function ConcurrencyRetryStory(): ReactNode {
  const component = entry(useClientBundle("concurrency-retry"), "conversation.chat.node");
  return createElement(
    ComposerDock,
    null,
    component === undefined
      ? null
      : createElement(component, {
          node: {
            kind: "concurrency-retry/wait",
            data: { provider: "zai", attempt: 2, waitMs: 5_000 },
          },
        }),
  );
}

function CustomUiStory(): ReactNode {
  useClientBundle("custom-ui");
  return createElement(
    ComposerDock,
    null,
    createElement(
      "div",
      { className: "composer-card", "data-composer-card": true },
      createElement("div", { className: "uV2eYG_scroll" }, "Review the composer layout…"),
      createElement(
        "div",
        { className: "uV2eYG_row" },
        createElement("span", null, "34k"),
        createElement("button", { type: "button", className: "uV2eYG_primary" }, "Send"),
      ),
    ),
  );
}

function QuotaLineStory(): ReactNode {
  const component = entry(useClientBundle("quota-line", { fakeHostFetch: true }), "quota-line");
  return createElement(ComposerDock, null, component === undefined ? null : createElement(component));
}

function SessionListStory(): ReactNode {
  const component = entry(useClientBundle("session-list"), "sidebar.workspaces");
  const now = Date.now();
  const sessions = [
    session("s1", "refit the dock alignment", { running: true, updatedAt: now - 90_000 }),
    session("s2", "review session-list", { completed: true, updatedAt: now - 3 * 3_600_000 }),
    session("s3", "refactor quota-line", { updatedAt: now - 2 * 86_400_000 }),
  ];
  const props = {
    wide: true,
    expandSidebar: () => {},
    useSessions: (selector: (snapshot: unknown) => unknown) =>
      selector({ ids: sessions.map(({ id }) => id), byId: Object.fromEntries(sessions.map(({ id, summary }) => [id, summary])), current: "s1" }),
    useSessionPendingInteraction: (selector: (snapshot: unknown) => unknown) => selector(new Map()),
    useWorkspaces: (selector: (snapshot: unknown) => unknown) =>
      selector({
        archivedSessionIds: [],
        items: [{ workspaceId: "w1", title: "dotfiles", path: "/home/user/dotfiles", sessionIds: sessions.map(({ id }) => id), createdAt: new Date(now - 86_400_000).toISOString(), updatedAt: new Date(now).toISOString() }],
      }),
    useDirectoryFlow: (selector: (snapshot: unknown) => unknown) => selector(false),
    t: translate,
  };
  return createElement(
    "aside",
    { className: "storybook-session-list" },
    component === undefined ? null : createElement(component, props),
  );
}

function SkillStatusStory(): ReactNode {
  const component = entry(useClientBundle("skill-status"), "skill-status");
  return createElement(
    ComposerDock,
    null,
    component === undefined
      ? null
      : createElement(component, {
          useProjection: (key: string) => (key === "skillStatus" ? ["commit", "review", "write-docs"] : undefined),
        }),
  );
}

function session(id: string, title: string, overrides: Record<string, unknown> = {}): { id: string; summary: Record<string, unknown> } {
  return {
    id,
    summary: { id, title, displayTitle: title, blank: false, running: false, completed: false, updatedAt: Date.now(), ...overrides },
  };
}

const messages: Record<string, string> = {
  "section.workspaces": "Workspaces",
  "workspace.add": "Add workspace",
  "session.new": "New Session",
  "time.now": "now",
  "time.minutes": "{n}min",
  "time.hours": "{n}h",
  "time.days": "{n}d",
  "time.months": "{n}mo",
  "time.years": "{n}y",
  "actions.archive": "Archive session",
  "actions.copyId": "Copy session ID",
  "actions.newSession.aria": "New session in {name}",
  "group.ungrouped": "Ungrouped",
  "sessions.expand": "Show {n} more sessions",
  "sessions.collapse": "Show less",
  close: "Close",
  cancel: "Cancel",
  "folderError.title": "Couldn’t open folder",
  "folderError.retry": "Choose again",
};

function translate(key: string, params?: Record<string, unknown>): string {
  return (messages[key] ?? key)
    .replace("{n}", String(params?.n ?? ""))
    .replace("{name}", String(params?.name ?? ""));
}
