import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_HANDOFF_EVENT = "agents:max-handoff";

type MaxHandoffResult = "ready" | "stopped" | "unavailable";

interface MaxHandoffOptions {
  context: ExtensionContext;
  class: string | undefined;
  approve: (changesMode: boolean) => Promise<boolean>;
  isCurrent: () => boolean;
  isOnRequestBranch: () => boolean;
}

export interface MaxHandoffRequest extends MaxHandoffOptions {
  respond: (completion: Promise<MaxHandoffResult>) => void;
}

export function requestMaxHandoff(
  events: ExtensionAPI["events"],
  options: MaxHandoffOptions,
): Promise<MaxHandoffResult> {
  return new Promise((resolve, reject) => {
    let handled = false;
    events.emit(MAX_HANDOFF_EVENT, {
      ...options,
      respond(completion: Promise<MaxHandoffResult>) {
        handled = true;
        completion.then(resolve, reject);
      },
    } satisfies MaxHandoffRequest);
    if (!handled) resolve("unavailable");
  });
}
