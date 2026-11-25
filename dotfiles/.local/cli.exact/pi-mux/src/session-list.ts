import { existsSync } from "node:fs";
import { prepareDirectory, type TmuxConfig } from "./configuration";
import { type LastRun, parseLastRun } from "./history-summary";
import { withLock } from "./locks";
import { livePanes, readTemporarySession, temporarySessionQuery } from "./pane-inventory";
import {
  isSessionState,
  parsePublishPending,
  parseSessionOption,
  type PublishPending,
  type SessionState,
} from "./pane-state";
import { platform } from "./platform";
import { readSnapshot, registerWorkspaces } from "./restore-state";
import { resolveSessionTitle } from "./saved-sessions";
import type { Pane } from "./session-model";
import { tmux, tmuxQueries } from "./tmux";

export type ListedSession = {
  id: string;
  file: string;
  state: SessionState | null;
  title: string | null;
  publishPending: PublishPending | null;
  lastRun?: LastRun;
  temporary?: true;
};

export type EmptySession = { id: string; file: string; temporary?: true };

export type ListedWorkspace = { cwd: string; sessions: ListedSession[]; empty: EmptySession[] };

export async function listWorkspaces(config: TmuxConfig): Promise<ListedWorkspace[]> {
  const panes = await livePanes(config, "list");
  const current = readSnapshot(config);
  if (panes.some(({ cwd }) => !current?.cwds.includes(cwd))) {
    prepareDirectory(config.stateDirectory);
    return await withLock(config, async () =>
      collectWorkspaceList(config, await livePanes(config, "list"), "register"),
    );
  }
  return await collectWorkspaceList(config, panes);
}

async function collectWorkspaceList(
  config: TmuxConfig,
  panes: Pane[],
  registration: "read" | "register" = "read",
): Promise<ListedWorkspace[]> {
  const saved = panes.filter((pane) => existsSync(pane.file));
  const unsaved = panes.filter((pane) => !existsSync(pane.file));
  const savedQueries = saved.flatMap(({ name, pane, session }) => {
    const target = platform.windows ? `=${name}:.${pane}` : pane;
    return [
      ["show-options", "-pqv", "-t", target, "@pi_session_state"],
      ["show-options", "-pqv", "-t", target, "@pi_session_state_pending"],
      temporarySessionQuery(session),
    ];
  });
  const commands = [
    ...savedQueries,
    ...unsaved.map(({ session }) => temporarySessionQuery(session)),
  ];
  const results = await listTmuxQueries(config, commands);
  const sessions = saved.map(({ id, cwd, file, session }, index) => {
    const queryIndex = index * 3;
    const metadata = results[queryIndex]!;
    const pending = results[queryIndex + 1]!;
    for (const result of [metadata, pending]) {
      if (result.exitCode !== 0)
        throw new Error(`tmux show-options failed: ${result.stderr.trim()}`);
    }
    const temporary = readTemporarySession(
      config,
      session,
      id,
      results[queryIndex + 2]!,
      "allow-missing",
    );
    return {
      cwd,
      session: {
        id,
        file,
        ...parseSessionMetadata(metadata.stdout, id, file),
        publishPending: parsePublishPending(pending.stdout, id),
        ...(temporary ? { temporary: true as const } : {}),
      } satisfies ListedSession,
    };
  });
  const empty = unsaved.map(({ id, cwd, file, session }, index) => {
    const result = results[savedQueries.length + index]!;
    const temporary = readTemporarySession(config, session, id, result, "allow-missing");
    return {
      cwd,
      session: {
        id,
        file,
        ...(temporary ? { temporary: true as const } : {}),
      } satisfies EmptySession,
    };
  });
  if (registration === "register")
    registerWorkspaces(
      config,
      panes.map(({ cwd }) => cwd),
    );
  const workspaces = new Map<string, ListedWorkspace>(
    (readSnapshot(config)?.cwds ?? []).map((cwd) => [cwd, { cwd, sessions: [], empty: [] }]),
  );
  for (const { cwd, session } of sessions) workspaces.get(cwd)?.sessions.push(session);
  for (const { cwd, session } of empty) workspaces.get(cwd)?.empty.push(session);
  return [...workspaces.values()];
}

async function listTmuxQueries(config: TmuxConfig, commands: string[][]) {
  const batch = platform.windows
    ? undefined
    : await tmuxQueries(config, commands).catch(() => undefined);
  if (batch !== undefined) return batch;
  return Promise.all(commands.map((command) => tmux(config, command, true)));
}

function parseSessionMetadata(
  encoded: string | undefined,
  id: string,
  file: string,
): Pick<ListedSession, "state" | "title" | "lastRun"> {
  const published = parseSessionOption(encoded, id);
  const state = isSessionState(published?.state) ? published.state : null;
  const title = typeof published?.title === "string" ? published.title : resolveSessionTitle(file);
  const lastRun = parseLastRun(published?.lastRun);
  return { state, title, ...(lastRun ? { lastRun } : {}) };
}
