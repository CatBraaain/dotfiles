import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import recontextExtension from "./index.ts";
import { PROVIDER_UPDATE_EVENT, type ProviderUpdate } from "./provider-update.ts";
import { fakeProvider, memoryRuntime, seedConversation } from "./test-fixture.ts";

export async function preparationFixture(
  options: {
    extension?: typeof recontextExtension;
    mode?: ExtensionContext["mode"];
    second?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "recontext-preparation-"));
  mkdirSync(join(directory, ".git"));
  const manager = SessionManager.inMemory(directory);
  const seed = seedConversation(manager, 12_500);
  const runtime = await memoryRuntime();
  const fake = fakeProvider();
  runtime.registerNativeProvider(fake.provider);
  const second = fakeProvider("second-memory");
  if (options.second) runtime.registerNativeProvider(second.provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const providerIds = [
    ...new Set([
      ...registry.getAll().map((model) => model.provider),
      ...registry.getRegisteredProviderIds(),
    ]),
  ];
  const originals = new Map(
    providerIds.map((id) => [id, registry.getRegisteredNativeProvider(id)]),
  );
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1_000, reserveTokens: 512 },
    retry: { enabled: false },
    cacheWarming: "off",
    enableInstallTelemetry: false,
    defaultTools: [],
  });
  const notices: string[] = [];
  const errors: Array<{ event: string; error: string }> = [];
  const widgets = new Map<string, Component>();
  let api!: ExtensionAPI;
  let context!: ExtensionContext;
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Synthetic instructions.",
    extensionFactories: [
      options.extension ?? recontextExtension,
      (pi) => {
        api = pi;
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: registry.find(fake.provider.id, "physical")!,
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: loader,
    tools: [],
  });
  await session.bindExtensions({
    mode: options.mode ?? "rpc",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify(message) {
        notices.push(message);
      },
      setWidget(key, content) {
        if (typeof content === "function") {
          widgets.set(key, content({ requestRender() {} } as never, {} as never));
        } else if (content === undefined) widgets.delete(key);
      },
    },
    onError(error) {
      errors.push({ event: error.event, error: error.error });
    },
  });

  function wrappedProviderIds() {
    return registry.getRegisteredProviderIds().filter((id) => {
      const native = registry.getRegisteredNativeProvider(id);
      return native && native !== originals.get(id);
    });
  }
  function update(next = fakeProvider(fake.provider.id)) {
    const change: ProviderUpdate = {
      registry: context.modelRegistry,
      providerId: next.provider.id,
      handled: false,
      register() {
        registry.registerProvider(next.provider);
      },
    };
    api.events.emit(PROVIDER_UPDATE_EVENT, change);
    return { next, change };
  }
  function requestContext() {
    return { messages: convertToLlm(manager.buildSessionProjection().messages) };
  }
  function getContext() {
    return context;
  }
  async function dispose() {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    fake,
    second,
    runtime,
    registry,
    manager,
    session,
    api,
    seed,
    providerIds,
    originals,
    notices,
    errors,
    widgets,
    wrappedProviderIds,
    update,
    requestContext,
    getContext,
    dispose,
  };
}
