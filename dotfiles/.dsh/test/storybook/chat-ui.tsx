import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

export type Session = {
  id: string;
  name: string;
  time: string;
  active: boolean;
};

export type Workspace = {
  cwd: string;
  label: string;
  sessions: Session[];
};

export type Message = {
  type: "assistant" | "user";
  copy: string;
  code?: string;
  time: string;
};

type SessionMode = "active" | "all";
type IconName =
  | "archive"
  | "check"
  | "chevron"
  | "copy"
  | "modeCollapse"
  | "modeExpand"
  | "more"
  | "plus"
  | "refresh"
  | "send"
  | "unarchive";

type SessionRowProps = {
  session: Session;
  isSelected?: boolean;
  isCopied?: boolean;
  onOpen?: (session: Session) => void;
  onCopy?: (id: string) => void;
  onArchive?: (id: string, active: boolean) => void;
};

type WorkspaceCardProps = {
  workspace: Workspace;
  sessions: Session[];
  mode: SessionMode;
  isCollapsible: boolean;
  isCollapsed: boolean;
  selectedId?: string | null;
  copiedId?: string | null;
  onToggleCollapse?: (cwd: string) => void;
  onToggleMode?: (cwd: string, mode: SessionMode) => void;
  onNewSession?: (cwd: string) => void;
  onRefresh?: (label: string) => void;
  onOpenSession?: (session: Session) => void;
  onCopySession?: (id: string) => void;
  onArchiveSession?: (id: string, active: boolean) => void;
};

type WorkspaceListProps = {
  groups: Workspace[];
  modes?: Record<string, SessionMode>;
  selectedId?: string | null;
  copiedId?: string | null;
  collapsedWorkspaces?: Set<string>;
  onToggleCollapse?: (cwd: string) => void;
  onToggleMode?: (cwd: string, mode: SessionMode) => void;
  onNewSession?: (cwd: string) => void;
  onRefresh?: (label: string) => void;
  onOpenSession?: (session: Session) => void;
  onCopySession?: (id: string) => void;
  onArchiveSession?: (id: string, active: boolean) => void;
};

type ChatHeaderProps = {
  title: string;
  context: string;
};

type MessageThreadProps = {
  messages: Message[];
};

type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

type SessionListPaneProps = {
  groups: Workspace[];
  modes: Record<string, SessionMode>;
  selectedId: string | null;
  copiedId: string | null;
  collapsedWorkspaces: Set<string>;
  status: string;
  statusError: boolean;
  onNewWorkspace: () => void;
  onToggleCollapse: (cwd: string) => void;
  onToggleMode: (cwd: string, mode: SessionMode) => void;
  onNewSession: (cwd: string) => void;
  onRefresh: (label: string) => void;
  onOpenSession: (session: Session) => void;
  onCopySession: (id: string) => void;
  onArchiveSession: (id: string, active: boolean) => void;
};

type ChatPaneProps = {
  title: string;
  context: string;
  messages: Message[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export const initialGroups: Workspace[] = [
  {
    cwd: "/Users/aya/Projects/atlas-dashboard",
    label: "atlas-dashboard",
    sessions: [
      {
        id: "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
        name: "Polish the session list",
        time: "2026/09/19 18:42",
        active: true,
      },
      {
        id: "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61",
        name: "Check keyboard navigation",
        time: "2026/09/19 17:16",
        active: false,
      },
    ],
  },
  {
    cwd: "/Users/aya/Projects/website-redesign",
    label: "website-redesign",
    sessions: [
      {
        id: "3d8e2f6a-7b1c-4a9d-8e5f-2c6b1a4d7f90",
        name: "Review landing page copy",
        time: "2026/09/18 16:08",
        active: true,
      },
      {
        id: "4a7c1e9b-2d5f-4b8a-9c3e-6f1a2d5b8e70",
        name: "Archive old experiments",
        time: "2026/09/17 11:34",
        active: false,
      },
    ],
  },
];

export const initialMessages: Message[] = [
  {
    type: "assistant",
    copy: "The session list is ready for a visual pass. I kept the workspace compact and made the active state easier to scan.",
    code: "designs/chat-ui.html",
    time: "2026/09/21 10:42",
  },
  {
    type: "user",
    copy: "Place the chat beside the session list so I can move between context and conversation.",
    time: "2026/09/21 10:44",
  },
  {
    type: "assistant",
    copy: "Done. The split view keeps the list available while giving the active session room for a full conversation.",
    time: "2026/09/21 10:45",
  },
];

export function SessionRow({
  session,
  isSelected = false,
  isCopied = false,
  onOpen,
  onCopy,
  onArchive,
}: SessionRowProps): ReactNode {
  return (
    <div className={`session-row${isSelected ? " is-selected" : ""}`}>
      <button className="session-main" type="button" onClick={() => onOpen?.(session)}>
        <span className={`status-dot${session.active ? " is-active" : ""}`} aria-hidden="true" />
        <span className="session-copy">
          <span className="session-name">{session.name}</span>
        </span>
      </button>
      <div className="session-meta">
        <time className="session-time">{session.time}</time>
        <div className="row-actions">
          <button
            className={`row-action${isCopied ? " is-copied" : ""}`}
            type="button"
            onClick={() => onCopy?.(session.id)}
            aria-label={isCopied ? "Copied" : "Copy session ID"}
            title={isCopied ? "Copied" : "Copy session ID"}
          >
            <Icon name={isCopied ? "check" : "copy"} />
          </button>
          <button
            className={`row-action${session.active ? " archive" : " unarchive"}`}
            type="button"
            onClick={() => onArchive?.(session.id, !session.active)}
            aria-label={session.active ? "Archive" : "Unarchive"}
            title={session.active ? "Archive" : "Unarchive"}
          >
            <Icon name={session.active ? "archive" : "unarchive"} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceCard({
  workspace,
  sessions,
  mode,
  isCollapsible,
  isCollapsed,
  selectedId = null,
  copiedId = null,
  onToggleCollapse,
  onToggleMode,
  onNewSession,
  onRefresh,
  onOpenSession,
  onCopySession,
  onArchiveSession,
}: WorkspaceCardProps): ReactNode {
  const nextMode: SessionMode = mode === "all" ? "active" : "all";
  const modeLabel = mode === "all" ? "All" : "Active";
  const modeActionLabel = nextMode === "all" ? "Show all sessions" : "Show active sessions";
  const sessionLabel = sessions.length === 1 ? "session" : "sessions";

  return (
    <section className={`workspace${isCollapsed ? " is-collapsed" : ""}`}>
      <header className="workspace-header" data-action={isCollapsible ? "collapse" : undefined}>
        {isCollapsible ? (
          <button
            className="workspace-name workspace-collapse-trigger"
            type="button"
            onClick={() => onToggleCollapse?.(workspace.cwd)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${workspace.label}`}
            title={`~/projects/${workspace.label}`}
          >
            <span className="workspace-collapse-icon">
              <Icon name="chevron" />
            </span>
            <span>{workspace.label}</span>
          </button>
        ) : (
          <div className="workspace-name" title={workspace.cwd}>
            {workspace.label}
          </div>
        )}
        <div className="workspace-header-actions">
          {isCollapsed ? (
            <span
              className="workspace-summary"
              aria-label={`${modeLabel}, ${sessions.length} ${sessionLabel}`}
            >
              {modeLabel} · {sessions.length} {sessionLabel}
            </span>
          ) : (
            <button
              className="button button-icon workspace-mode-toggle"
              type="button"
              onClick={() => onToggleMode?.(workspace.cwd, nextMode)}
              aria-pressed={mode === "all"}
              aria-label={`${modeLabel} sessions. ${modeActionLabel}`}
              title={`${modeLabel} sessions · ${modeActionLabel}`}
            >
              <Icon name={nextMode === "all" ? "modeExpand" : "modeCollapse"} />
            </button>
          )}
          <button
            className="button button-icon workspace-new-session"
            type="button"
            onClick={() => onNewSession?.(workspace.cwd)}
            aria-label={`New session in ${workspace.label}`}
            title="New session"
          >
            <Icon name="plus" />
          </button>
          <button
            className="button button-icon workspace-refresh"
            type="button"
            onClick={() => onRefresh?.(workspace.label)}
            aria-label={`Refresh ${workspace.label}`}
            title="Refresh"
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      {!isCollapsed &&
        sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            isSelected={selectedId === session.id}
            isCopied={copiedId === session.id}
            onOpen={onOpenSession}
            onCopy={onCopySession}
            onArchive={onArchiveSession}
          />
        ))}
    </section>
  );
}

export function WorkspaceList({
  groups,
  modes = {},
  selectedId = null,
  copiedId = null,
  collapsedWorkspaces = new Set(),
  onToggleCollapse,
  onToggleMode,
  onNewSession,
  onRefresh,
  onOpenSession,
  onCopySession,
  onArchiveSession,
}: WorkspaceListProps): ReactNode {
  const visibleGroups = groups
    .map((group) => ({ group, sessions: visibleSessions(group, modes) }))
    .filter(({ sessions }) => sessions.length > 0);

  if (visibleGroups.length === 0) {
    return (
      <section className="workspace-list" aria-live="polite">
        <div className="empty-state">
          <strong>No active sessions</strong>
          <span>Create a new session to see it here</span>
        </div>
      </section>
    );
  }

  return (
    <section className="workspace-list" aria-live="polite">
      {visibleGroups.map(({ group, sessions }, groupIndex) => (
        <WorkspaceCard
          key={group.cwd}
          workspace={group}
          sessions={sessions}
          mode={modes[group.cwd] ?? "active"}
          isCollapsible={groupIndex === 0 || groupIndex === 1}
          isCollapsed={collapsedWorkspaces.has(group.cwd)}
          selectedId={selectedId}
          copiedId={copiedId}
          onToggleCollapse={onToggleCollapse}
          onToggleMode={onToggleMode}
          onNewSession={onNewSession}
          onRefresh={onRefresh}
          onOpenSession={onOpenSession}
          onCopySession={onCopySession}
          onArchiveSession={onArchiveSession}
        />
      ))}
    </section>
  );
}

export function ChatHeader({ title, context }: ChatHeaderProps): ReactNode {
  return (
    <header className="chat-header">
      <div>
        <h2 className="chat-title">{title}</h2>
        <p className="chat-context">{context}</p>
      </div>
      <button
        className="button button-icon chat-header-action"
        type="button"
        aria-label="More session actions"
        title="More session actions"
      >
        <Icon name="more" />
      </button>
    </header>
  );
}

export function ChatMessage({ message }: { readonly message: Message }): ReactNode {
  return (
    <article className={`message${message.type === "user" ? " is-user" : ""}`}>
      <div className="message-body">
        <p className="message-copy">{message.copy}</p>
        {message.code ? (
          <pre className="message-code">
            <code>{message.code}</code>
          </pre>
        ) : null}
        <time className="message-time">{message.time}</time>
      </div>
    </article>
  );
}

export function MessageThread({ messages }: MessageThreadProps): ReactNode {
  return (
    <div className="chat-thread" aria-live="polite">
      {messages.map((message, index) => (
        <ChatMessage key={`${message.time}-${index}`} message={message} />
      ))}
    </div>
  );
}

export function ChatComposer({ value, onChange, onSubmit }: ChatComposerProps): ReactNode {
  return (
    <form className="chat-composer" onSubmit={onSubmit}>
      <textarea
        className="chat-input"
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Message this session…"
        aria-label="Message this session"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-footer">
        <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
        <button
          className="send-button"
          type="submit"
          aria-label="Send message"
          title="Send message"
        >
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}

export function SessionListPane({
  groups,
  modes,
  selectedId,
  copiedId,
  collapsedWorkspaces,
  status,
  statusError,
  onNewWorkspace,
  onToggleCollapse,
  onToggleMode,
  onNewSession,
  onRefresh,
  onOpenSession,
  onCopySession,
  onArchiveSession,
}: SessionListPaneProps): ReactNode {
  return (
    <section className="session-pane">
      <header className="workspace-list-header">
        <h1 className="workspace-list-title">Workspaces</h1>
        <button
          className="button new-workspace-button"
          type="button"
          onClick={onNewWorkspace}
          aria-label="New Workspace"
          title="New Workspace"
          data-od-id="new-workspace"
        >
          <Icon name="plus" />
          <span>New Workspace</span>
        </button>
      </header>
      <WorkspaceList
        groups={groups}
        modes={modes}
        selectedId={selectedId}
        copiedId={copiedId}
        collapsedWorkspaces={collapsedWorkspaces}
        onToggleCollapse={onToggleCollapse}
        onToggleMode={onToggleMode}
        onNewSession={onNewSession}
        onRefresh={onRefresh}
        onOpenSession={onOpenSession}
        onCopySession={onCopySession}
        onArchiveSession={onArchiveSession}
      />
      <p
        className={`status-message${statusError ? " is-error" : ""}`}
        role="status"
        aria-live="polite"
      >
        {status}
      </p>
    </section>
  );
}

export function ChatPane({
  title,
  context,
  messages,
  draft,
  onDraftChange,
  onSubmit,
}: ChatPaneProps): ReactNode {
  return (
    <section className="chat-pane" aria-labelledby="chat-title">
      <ChatHeader title={title} context={context} />
      <MessageThread messages={messages} />
      <ChatComposer value={draft} onChange={onDraftChange} onSubmit={onSubmit} />
    </section>
  );
}

export function SessionChat(): ReactNode {
  const [groups, setGroups] = useState(() => cloneGroups(initialGroups));
  const [modes, setModes] = useState<Record<string, SessionMode>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [statusError, setStatusError] = useState(false);
  const statusTimer = useRef<number | undefined>(undefined);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current);
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const showStatus = (message: string, isError = false): void => {
    if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current);
    setStatus(message);
    setStatusError(isError);
    statusTimer.current = window.setTimeout(() => {
      setStatus("");
      setStatusError(false);
    }, 2600);
  };

  const selectedSession = findSession(groups, selectedId);
  const selectedWorkspace = findWorkspace(groups, selectedId);

  const toggleMode = (cwd: string, mode: SessionMode): void =>
    setModes((current) => ({ ...current, [cwd]: mode }));
  const toggleWorkspace = (cwd: string): void =>
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  const openSession = (session: Session): void => {
    setSelectedId(session.id);
    showStatus(`Opened “${session.name}”`);
  };
  const addSession = (cwd: string): void => {
    const group = groups.find((item) => item.cwd === cwd);
    if (!group) return;
    const session = {
      id: crypto.randomUUID(),
      name: "New Pi session",
      time: "Just now",
      active: true,
    };
    setGroups((current) =>
      current.map((item) =>
        item.cwd === cwd ? { ...item, sessions: [session, ...item.sessions] } : item,
      ),
    );
    setModes((current) => ({ ...current, [cwd]: "active" }));
    setSelectedId(session.id);
    showStatus(`New session added to ${group.label}`);
  };
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
    showStatus(`New workspace added to ${label}`);
  };
  const archiveSession = (id: string, active: boolean): void => {
    setGroups((current) =>
      current.map((group) => ({
        ...group,
        sessions: group.sessions.map((session) =>
          session.id === id ? { ...session, active } : session,
        ),
      })),
    );
    if (!active && selectedId === id) setSelectedId(null);
    showStatus(active ? "Session unarchived" : "Session archived");
  };
  const copySessionId = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      showStatus("Copy failed", true);
    }
    setCopiedId(id);
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1000);
  };
  const submitMessage = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const copy = draft.trim();
    if (!copy) return;
    const time = new Intl.DateTimeFormat([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    setMessages((current) => [...current, { type: "user", copy, time }]);
    setDraft("");
    window.setTimeout(
      () =>
        setMessages((current) => [
          ...current,
          { type: "assistant", copy: "Message queued for this session.", time },
        ]),
      360,
    );
  };

  return (
    <main className="chat-ui-design app" data-od-id="session-list">
      <div className="app-grid">
        <SessionListPane
          groups={groups}
          modes={modes}
          selectedId={selectedId}
          copiedId={copiedId}
          collapsedWorkspaces={collapsedWorkspaces}
          status={status}
          statusError={statusError}
          onNewWorkspace={addWorkspace}
          onToggleCollapse={toggleWorkspace}
          onToggleMode={toggleMode}
          onNewSession={addSession}
          onRefresh={(label) => showStatus(`List refreshed: ${label}`)}
          onOpenSession={openSession}
          onCopySession={(id) => void copySessionId(id)}
          onArchiveSession={archiveSession}
        />
        <ChatPane
          title={selectedSession?.name ?? "Polish the session list"}
          context={
            selectedWorkspace
              ? `${selectedWorkspace.label} · ${selectedWorkspace.cwd}`
              : "atlas-dashboard · /Users/aya/Projects/atlas-dashboard"
          }
          messages={messages}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submitMessage}
        />
      </div>
    </main>
  );
}

function visibleSessions(group: Workspace, modes: Record<string, SessionMode>): Session[] {
  return (modes[group.cwd] ?? "active") === "all"
    ? group.sessions
    : group.sessions.filter((session) => session.active);
}

function findSession(groups: Workspace[], id: string | null): Session | null {
  if (!id) return null;
  for (const group of groups) {
    const session = group.sessions.find((item) => item.id === id);
    if (session) return session;
  }
  return null;
}

function findWorkspace(groups: Workspace[], id: string | null): Workspace | null {
  if (!id) return null;
  return groups.find((group) => group.sessions.some((session) => session.id === id)) ?? null;
}

function cloneGroups(groups: Workspace[]): Workspace[] {
  return groups.map((group) => ({
    ...group,
    sessions: group.sessions.map((session) => ({ ...session })),
  }));
}

function Icon({ name }: { readonly name: IconName }): ReactNode {
  const isModeIcon = name === "modeCollapse" || name === "modeExpand";
  const paths: Record<IconName, ReactNode> = {
    copy: (
      <>
        <rect x="5" y="5" width="7" height="8" rx="1" />
        <path d="M3.5 10V4.5A1.5 1.5 0 0 1 5 3h4.5" />
      </>
    ),
    check: <path d="m3.3 8.2 3 3 6.4-6.4" />,
    plus: <path d="M8 3v10M3 8h10" />,
    refresh: (
      <>
        <path d="M13.5 5.2A5.5 5.5 0 1 0 14 8" />
        <path d="M10.8 2.6h3v3" />
      </>
    ),
    archive: (
      <>
        <path d="M3 5.5h10M4 5.5v6.2A1.3 1.3 0 0 0 5.3 13h5.4a1.3 1.3 0 0 0 1.3-1.3V5.5M5.3 3h5.4l.8 2.5H4.5L5.3 3Z" />
        <path d="M6.5 8.5h3" />
      </>
    ),
    unarchive: (
      <>
        <path d="M3 5.5h10M4 5.5v6.2A1.3 1.3 0 0 0 5.3 13h5.4a1.3 1.3 0 0 0 1.3-1.3V5.5M5.3 3h5.4l.8 2.5H4.5L5.3 3Z" />
        <path d="m6 9 2-2 2 2M8 7v4" />
      </>
    ),
    modeCollapse: <path d="M3 5h8m-8 7h8m-8 7h8m4-14 3 3 3-3m-6 14 3-3 3 3" />,
    modeExpand: <path d="M3 5h8m-8 7h8m-8 7h8m4-11 3-3 3 3m-6 8 3 3 3-3" />,
    chevron: <path d="m4.5 6 3.5 3.5L11.5 6" />,
    more: (
      <>
        <circle cx="4" cy="8" r=".7" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r=".7" fill="currentColor" stroke="none" />
        <circle cx="12" cy="8" r=".7" fill="currentColor" stroke="none" />
      </>
    ),
    send: (
      <>
        <path d="m3 8 10-5-2.5 10-2.4-4.2L3 8Z" />
        <path d="m8.1 8.8 2.1-1.5" />
      </>
    ),
  };
  return (
    <svg
      viewBox={isModeIcon ? "0 0 24 24" : "0 0 16 16"}
      fill="none"
      stroke="currentColor"
      strokeWidth={isModeIcon ? "1.5" : "1.25"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
