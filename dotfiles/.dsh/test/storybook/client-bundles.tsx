import * as React from "react";
import * as primitives from "./primitives-stub";

type PluginName = "agents" | "concurrency-retry" | "custom-ui" | "quota-line" | "session-list" | "skill-status";

type BundleRegistration = {
  readonly id: string;
  readonly factory: (require: (name: string) => unknown) => Record<string, unknown>;
};

type SlotEntry = {
  readonly spec: { readonly id?: string; readonly name?: string };
  readonly component: React.ComponentType<Record<string, unknown>>;
};

type PluginExports = { readonly apply: (context: Record<string, unknown>) => void };

type ModuleLoaderHost = typeof globalThis & {
  __ModuleLoader__?: { load(registration: BundleRegistration): void };
};

const pluginIds: Record<PluginName, string> = {
  agents: "dotfiles-dsh-agents",
  "concurrency-retry": "dotfiles-dsh-concurrency-retry",
  "custom-ui": "dotfiles-dsh-custom-ui",
  "quota-line": "dotfiles-dsh-quota-line",
  "session-list": "dotfiles-dsh-session-list",
  "skill-status": "dotfiles-dsh-skill-status",
};

const importers: Record<PluginName, () => Promise<unknown>> = {
  // @ts-expect-error client bundles are generated JavaScript without declarations.
  agents: () => import("../../plugins.exact/agents/lib/client.js"),
  // @ts-expect-error client bundles are generated JavaScript without declarations.
  "concurrency-retry": () => import("../../plugins.exact/concurrency-retry/lib/client.js"),
  // @ts-expect-error client bundles are generated JavaScript without declarations.
  "custom-ui": () => import("../../plugins.exact/custom-ui/lib/client.js"),
  // @ts-expect-error client bundles are generated JavaScript without declarations.
  "quota-line": () => import("../../plugins.exact/quota-line/lib/client.js"),
  // @ts-expect-error client bundles are generated JavaScript without declarations.
  "session-list": () => import("../../plugins.exact/session-list/lib/client.js"),
  // @ts-expect-error client bundles are generated JavaScript without declarations.
  "skill-status": () => import("../../plugins.exact/skill-status/lib/client.js"),
};

const registrations = new Map<string, BundleRegistration>();
const bundles = new Map<PluginName, Promise<PluginExports>>();

function installModuleLoader(): void {
  const host = globalThis as ModuleLoaderHost;
  host.__ModuleLoader__ = {
    load: (registration) => registrations.set(registration.id, registration),
  };
}

async function loadBundle(plugin: PluginName): Promise<PluginExports> {
  const cached = bundles.get(plugin);
  if (cached !== undefined) return cached;

  installModuleLoader();
  const bundle = importers[plugin]().then(() => {
    const registration = registrations.get(pluginIds[plugin]);
    if (registration === undefined) throw new Error(`bundle not registered: ${plugin}`);
    return registration.factory((name) => {
      if (name === "react") return React;
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
      throw new Error(`Storybook does not provide ${name}`);
    }) as PluginExports;
  });
  bundles.set(plugin, bundle);
  return bundle;
}

type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function hostFetch(originalFetch: BrowserFetch): BrowserFetch {
  return async (input, init) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl, window.location.origin);
    if (url.pathname === "/plugins/quota-line/quota.json") {
      return new Response(
        JSON.stringify({
          ok: true,
          providers: [{ id: "zai", rolling: { percent: 42 }, weekly: { percent: 78 } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/api/dsh-agents/state") {
      return new Response(
        JSON.stringify({
          managed: true,
          agent: "main",
          className: "middle",
          manual: false,
          model: "glm-5.3-flash",
          agents: ["main", "senior", "junior", "vision"],
          classes: ["high", "middle", "low", "vision"],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  };
}

function fakeContext(entries: SlotEntry[], cleanups: (() => void)[]): Record<string, unknown> {
  const context: Record<string, unknown> = {
    inject: (_services: unknown, callback: (scope: Record<string, unknown>) => void) => callback(context),
    slots: {
      inject: (_name: unknown, callback: (scope: Record<string, unknown>) => void) => callback(context),
      register: (spec: SlotEntry["spec"], component: SlotEntry["component"]) => entries.push({ spec, component }),
      entries: () => [],
      subscribe: () => () => {},
    },
    effect: (setup: () => void | (() => void)) => {
      const cleanup = setup();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    sessions: {
      list: { getSnapshot: () => ({ current: "storybook-session" }), subscribe: () => () => {} },
      open: () => {},
    },
    modelDirectories: {
      directoryFor: () => ({
        store: { getSnapshot: () => ({ current: { provider: "zai" } }), subscribe: () => () => {} },
      }),
    },
    workspaces: { archiveSession: async () => {}, create: async () => ({ workspaceId: "storybook" }) },
    uiWorkspace: { startSession: () => {} },
    layout: { selectPanel: () => {} },
    locale: { register: () => () => {} },
    uiConversation: { events: { register: () => {} }, views: { register: () => {} } },
  };
  return context;
}

export function useClientBundle(plugin: PluginName, options: { readonly fakeHostFetch?: boolean } = {}): SlotEntry[] | undefined {
  const [entries, setEntries] = React.useState<SlotEntry[]>();

  React.useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const originalFetch = globalThis.fetch as BrowserFetch;
    if (options.fakeHostFetch) globalThis.fetch = hostFetch(originalFetch) as typeof fetch;

    void loadBundle(plugin).then((bundle) => {
      if (disposed) return;
      const nextEntries: SlotEntry[] = [];
      bundle.apply(fakeContext(nextEntries, cleanups));
      setEntries(nextEntries);
    });

    return () => {
      disposed = true;
      if (options.fakeHostFetch) globalThis.fetch = originalFetch as typeof fetch;
      cleanups.reverse().forEach((cleanup) => cleanup());
    };
  }, [options.fakeHostFetch, plugin]);

  return entries;
}

export function entry(entries: SlotEntry[] | undefined, id: string): React.ComponentType<Record<string, unknown>> | undefined {
  return entries?.find((candidate) => candidate.spec.id === id || candidate.spec.name === id)?.component;
}
