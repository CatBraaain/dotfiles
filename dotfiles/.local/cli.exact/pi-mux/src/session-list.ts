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

const STATE_OPTION = "@pi_session_state";
const PUBLISH_PENDING_OPTION = "@pi_session_state_pending";
const PANE_OPTIONS_COMPLETE = "pi-mux-pane-options-complete";

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
  const savedQueryCount = platform.windows ? 2 : 3;
  const savedQueries = saved.flatMap(({ name, pane, session }) => [
    ...paneOptionQueries(name, pane),
    temporarySessionQuery(session),
  ]);
  const commands = [
    ...savedQueries,
    ...unsaved.map(({ session }) => temporarySessionQuery(session)),
  ];
  const results = await listTmuxQueries(config, commands);
  const sessions = saved.map(({ id, cwd, file, session }, index) => {
    const queryIndex = index * savedQueryCount;
    const temporaryIndex = queryIndex + savedQueryCount - 1;
    const [metadata, pending] = results.slice(queryIndex, temporaryIndex).map((result) => {
      if (result.exitCode !== 0)
        throw new Error(`tmux show-options failed: ${result.stderr.trim()}`);
      if (platform.windows && !hasPaneOptionsCompletion(result.stdout))
        throw new Error(`tmux show-options failed: incomplete pane option response for ${id}`);
      return result.stdout;
    });
    const stateValue = platform.windows ? namedPaneOption(metadata!, STATE_OPTION) : metadata;
    const pendingValue = platform.windows
      ? namedPaneOption(metadata!, PUBLISH_PENDING_OPTION)
      : pending;
    const temporary = readTemporarySession(
      config,
      session,
      id,
      results[temporaryIndex]!,
      "allow-missing",
    );
    return {
      cwd,
      session: {
        id,
        file,
        ...parseSessionMetadata(stateValue, id, file),
        publishPending: parsePublishPending(pendingValue, id),
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

function paneOptionQueries(name: string, pane: string): string[][] {
  const target = platform.windows ? `=${name}:.${pane}` : pane;
  const flags = platform.windows ? "-pq" : "-pqv";
  const showOption = ["show-options", flags, "-t", target];
  const state = [...showOption, STATE_OPTION];
  const pending = [...showOption, PUBLISH_PENDING_OPTION];
  return platform.windows
    ? [
        [
          ...state,
          ";",
          ...pending,
          ";",
          "display-message",
          "-p",
          "-t",
          target,
          PANE_OPTIONS_COMPLETE,
        ],
      ]
    : [state, pending];
}

function hasPaneOptionsCompletion(stdout: string): boolean {
  const completionLine = `${PANE_OPTIONS_COMPLETE}\n`;
  return stdout === completionLine || stdout.endsWith(`\n${completionLine}`);
}

function namedPaneOption(stdout: string, option: string): string | undefined {
  const prefix = `${option} `;
  return stdout
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
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
