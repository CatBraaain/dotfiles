import type { Meta, StoryObj } from "@storybook/react";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  ChatPane as ChatPaneComponent,
  initialGroups,
  initialMessages,
  SessionChat as SessionChatComponent,
  SessionListPane as SessionListPaneComponent,
  type Message,
  type Session,
  type Workspace,
} from "./chat-ui";
import "./chat-ui.css";

const meta = {
  title: "design / Session chat",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const SessionChat: Story = {
  name: "composition / session chat",
  render: () => <SessionChatComponent />,
};

export const SessionListPane: Story = {
  name: "pane / session list",
  render: () => <SessionListPaneStory />,
};

export const ChatPane: Story = {
  name: "pane / chat",
  render: () => <ChatPaneStory />,
};

function SessionListPaneStory(): JSX.Element {
  const [groups, setGroups] = useState(() => cloneGroups(initialGroups));
  const [modes, setModes] = useState<Record<string, "active" | "all">>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState("");

  const addWorkspace = (): void => {
    const label = `new-workspace-${groups.length + 1}`;
    const cwd = `/Users/aya/Projects/${label}`;
    const session = {
      id: crypto.randomUUID(),
      name: "New Pi session",
      time: "Just now",
      active: true,
    };
    setGroups((current) => [...current, { cwd, label, sessions: [session] }]);
    setModes((current) => ({ ...current, [cwd]: "active" }));
    setSelectedId(session.id);
    setStatus(`New workspace added to ${label}`);
  };

  const toggleCollapse = (cwd: string): void =>
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  const openSession = (session: Session): void => {
    setSelectedId(session.id);
    setStatus(`Opened “${session.name}”`);
  };

  return (
    <ComponentPreview>
      <SessionListPaneComponent
        groups={groups}
        modes={modes}
        selectedId={selectedId}
        copiedId={null}
        collapsedWorkspaces={collapsedWorkspaces}
        status={status}
        statusError={false}
        onNewWorkspace={addWorkspace}
        onToggleCollapse={toggleCollapse}
        onToggleMode={(cwd, mode) => setModes((current) => ({ ...current, [cwd]: mode }))}
        onNewSession={(cwd) => setStatus(`New session added to ${cwd}`)}
        onRefresh={(label) => setStatus(`List refreshed: ${label}`)}
        onOpenSession={openSession}
        onCopySession={() => setStatus("Session ID copied")}
        onArchiveSession={(id, active) =>
          setStatus(`${active ? "Session unarchived" : "Session archived"}: ${id}`)
        }
      />
    </ComponentPreview>
  );
}

function ChatPaneStory(): JSX.Element {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>(initialMessages);

  const submitMessage = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const copy = draft.trim();
    if (!copy) return;
    setMessages((current) => [...current, { type: "user", copy, time: "Just now" }]);
    setDraft("");
  };

  return (
    <ComponentPreview>
      <ChatPaneComponent
        title="Polish the session list"
        context="atlas-dashboard · /Users/aya/Projects/atlas-dashboard"
        messages={messages}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submitMessage}
      />
    </ComponentPreview>
  );
}

function ComponentPreview({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="chat-ui-design component-preview">{children}</div>;
}

function cloneGroups(groups: Workspace[]): Workspace[] {
  return groups.map((group) => ({
    ...group,
    sessions: group.sessions.map((session) => ({ ...session })),
  }));
}
