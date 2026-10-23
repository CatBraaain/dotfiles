import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CLASS_CHANGE_EVENT = "agents:class-change";

export type ClassChangeResult = "applied" | "unchanged" | "ignored" | "unavailable";
export type SelectionSource = "manual" | "auto" | "agent";

export interface ClassChangeOptions {
  class: string | undefined;
  context: ExtensionContext;
  source?: SelectionSource;
  preserveManualSelection?: boolean;
  requiredAgent?: string;
}

export interface ClassChangeRequest extends ClassChangeOptions {
  respond: (completion: Promise<ClassChangeResult>) => void;
}

export function requestClassChange(
  events: ExtensionAPI["events"],
  options: ClassChangeOptions,
): Promise<ClassChangeResult> {
  return new Promise((resolve, reject) => {
    let handled = false;
    events.emit(CLASS_CHANGE_EVENT, {
      ...options,
      respond(completion: Promise<ClassChangeResult>) {
        handled = true;
        completion.then(resolve, reject);
      },
    } satisfies ClassChangeRequest);
    if (!handled) resolve("unavailable");
  });
}
