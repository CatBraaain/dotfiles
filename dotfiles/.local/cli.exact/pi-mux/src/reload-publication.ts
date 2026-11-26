import type { ReleaseLock } from "./locks";
import { matchesLaunch } from "./pane-inventory";
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
};

export function reportReloadFailure(
  progress: Pick<ReloadProgress, "failed">,
  id: string,
  reason: string,
): void {
  if (progress.failed.has(id)) return;
  progress.failed.add(id);
  console.error(`pi-mux: reload ${id}: ${reason}`);
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

export function announceReloaded(progress: Pick<ReloadProgress, "reloaded">, id: string): void {
  progress.reloaded.add(id);
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
