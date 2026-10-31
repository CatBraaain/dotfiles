import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";

export const PROVIDER_UPDATE_EVENT = "replace-context:provider-update";

export interface ProviderUpdate {
  registry: ExtensionContext["modelRegistry"];
  providerId: string;
  register(): void;
  handled: boolean;
  error?: unknown;
}

export function registerProviderUpdate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  providerId: string,
  config: ProviderConfig,
): void {
  const update: ProviderUpdate = {
    registry: ctx.modelRegistry,
    providerId,
    register() {
      pi.registerProvider(providerId, config);
    },
    handled: false,
  };
  pi.events.emit(PROVIDER_UPDATE_EVENT, update);
  if (!update.handled) update.register();
  if (update.error !== undefined) throw update.error;
}
