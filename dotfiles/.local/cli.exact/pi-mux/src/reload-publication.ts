import type { ReleaseLock } from "./locks";
import { matchesLaunch } from "./pane-inventory";
import type { ReloadWaiting, ReloadWaitingTarget } from "./reload-waiting";
import type { Pane } from "./session-model";

export type ReloadPublication = {
  pane: Pane;
  launchToken: string;
  preserveWarm: boolean;
  deadlineMs: number;
};

type InFlightReload = ReloadPublication & { release: ReleaseLock };

export type ReloadProgress = {
  reloaded: Set<string>;
  failed: Set<string>;
  inFlight: Map<string, InFlightReload>;
  waiting: ReloadWaiting;
};

export function publishWaitingTargets(
  {
    waiting,
    inFlight,
  }: { waiting: ReloadWaiting; inFlight: ReadonlyMap<string, ReloadPublication> },
  queued: readonly ReloadWaitingTarget[] = [],
): void {
  waiting.replace([...queued, ...[...inFlight.values()].map(({ pane }) => pane)]);
}

export function reportReloadFailure(
  progress: Pick<ReloadProgress, "failed" | "waiting">,
  id: string,
  reason: string,
): void {
  if (progress.failed.has(id)) return;
  progress.failed.add(id);
  progress.waiting.settle(id);
  console.error(`pi-mux: reload ${id}: ${reason}`);
}

export function formatReloadProcess(pid: number, name?: string): string {
  if (!name?.trim()) return `PID ${pid}, process unknown`;
  const label = JSON.stringify(name).replace(
    /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu,
    (character) => {
      const hex = character.charCodeAt(0).toString(16).padStart(4, "0");
      return "\\u" + hex;
    },
  );
  return `PID ${pid}, process ${label}`;
}

function conversationPanePids(
  panes: readonly Pick<Pane, "session" | "id" | "panePid">[],
  session: string,
  id: string,
): number[] {
  return panes
    .filter((pane) => pane.session === session && pane.id === id)
    .map((pane) => pane.panePid);
}

export function wasReplacedByPeer(
  initialPanes: readonly Pick<Pane, "session" | "id" | "panePid">[],
  livePanes: readonly Pick<Pane, "session" | "id" | "panePid">[],
  session: string,
  id: string,
): boolean {
  const initialPanePids = conversationPanePids(initialPanes, session, id);
  const livePanePids = conversationPanePids(livePanes, session, id);
  return (
    initialPanePids.length > 0 &&
    livePanePids.length > 0 &&
    livePanePids.every((panePid) => !initialPanePids.includes(panePid))
  );
}

export function announceReloaded(
  progress: Pick<ReloadProgress, "reloaded" | "waiting">,
  id: string,
): void {
  progress.reloaded.add(id);
  progress.waiting.settle(id);
  console.log(`reloaded ${id}`);
}

export function matchesReloadPublication(
  original: Pane,
  panePid: number,
  token: string,
  preserveWarm: boolean,
  encodedMetadata?: string,
  launch?: string,
): boolean {
  if (
    !Number.isSafeInteger(panePid) ||
    panePid <= 0 ||
    panePid === original.panePid ||
    !encodedMetadata ||
    !launch ||
    !matchesLaunch(launch, original.id, panePid, token)
  )
    return false;

  try {
    const metadata = JSON.parse(Buffer.from(encodedMetadata, "base64").toString("utf8"));
    return (
      metadata?.id === original.id &&
      metadata.pid === panePid &&
      metadata.token === token &&
      (!preserveWarm || (metadata.startup === "ready" && metadata.warm === true))
    );
  } catch {
    return false;
  }
}
