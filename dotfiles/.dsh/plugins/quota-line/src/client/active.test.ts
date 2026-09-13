import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  quotaIdForRouteProvider,
  resolveActiveRouteProvider,
  subscribeActiveChange,
  type ActiveProviderServices,
} from "./active";

/** Build duck-typed services around snapshot values the test controls. */
function createServices(options: {
  sessionId?: string;
  provider?: string;
}): ActiveProviderServices & {
  emitSessionChange(): void;
  emitSelectionChange(): void;
  unsubscribed: string[];
} {
  const sessionListeners: Array<() => void> = [];
  const selectionListeners: Array<() => void> = [];
  const unsubscribed: string[] = [];
  return {
    sessions: {
      list: {
        getSnapshot: () => ({ current: options.sessionId }),
        subscribe: (fn) => {
          sessionListeners.push(fn);
          return () => unsubscribed.push("sessions");
        },
      },
    },
    modelDirectories: {
      directoryFor: (sessionId) => ({
        store: {
          getSnapshot: () => ({
            current: sessionId === options.sessionId ? { provider: options.provider } : null,
          }),
          subscribe: (fn) => {
            selectionListeners.push(fn);
            return () => unsubscribed.push("modelDirectories");
          },
        },
      }),
    },
    emitSessionChange: () => sessionListeners.forEach((fn) => fn()),
    emitSelectionChange: () => selectionListeners.forEach((fn) => fn()),
    unsubscribed,
  };
}

describe("quotaIdForRouteProvider", () => {
  it("maps dsh route provider ids onto their quota row ids", () => {
    assert.equal(quotaIdForRouteProvider("zai"), "zai");
    assert.equal(quotaIdForRouteProvider("zai-coding-cn"), "zai");
    assert.equal(quotaIdForRouteProvider("openai-codex"), "codex");
  });

  it("returns undefined for unmapped routes and empty input", () => {
    assert.equal(quotaIdForRouteProvider("openrouter"), undefined);
    assert.equal(quotaIdForRouteProvider(""), undefined);
    assert.equal(quotaIdForRouteProvider(undefined), undefined);
  });
});

describe("resolveActiveRouteProvider", () => {
  it("reads the focused session provider from the model directory snapshot", () => {
    const services = createServices({ sessionId: "s1", provider: "zai" });

    assert.equal(resolveActiveRouteProvider(services), "zai");
  });

  it("returns undefined when no session is focused, the state is not ready, or the provider is empty", () => {
    assert.equal(resolveActiveRouteProvider({}), undefined);
    assert.equal(resolveActiveRouteProvider(createServices({ sessionId: "s1" })), undefined);
    assert.equal(resolveActiveRouteProvider(createServices({ provider: "zai" })), undefined);
  });
});

describe("subscribeActiveChange", () => {
  it("re-runs onChange when the selection or the focused session changes", () => {
    const services = createServices({ sessionId: "s1", provider: "zai" });
    let changes = 0;
    const unsubscribe = subscribeActiveChange(services, () => {
      changes += 1;
    });

    services.emitSelectionChange();
    services.emitSessionChange();
    unsubscribe();

    assert.equal(changes, 2);
    // 'modelDirectories' twice: the session switch re-points the directory
    // subscription (unsubscribing the old one first), then cleanup releases
    // the rest.
    assert.deepEqual(services.unsubscribed, ["modelDirectories", "sessions", "modelDirectories"]);
  });

  it("re-points the directory subscription on a session switch so a late selection lands", () => {
    let sessionId = "s1";
    let sessionListener: (() => void) | undefined;
    const selectionListenersBySession: Record<string, Array<() => void>> = { s1: [], s2: [] };
    const services: ActiveProviderServices = {
      sessions: {
        list: {
          getSnapshot: () => ({ current: sessionId }),
          subscribe: (fn) => {
            sessionListener = fn;
            return () => {
              sessionListener = undefined;
            };
          },
        },
      },
      modelDirectories: {
        directoryFor: (id) => ({
          store: {
            getSnapshot: () => ({ current: sessionId === id ? { provider: "zai" } : null }),
            subscribe: (fn) => {
              selectionListenersBySession[id]?.push(fn);
              return () => {
                const list = selectionListenersBySession[id] ?? [];
                const index = list.indexOf(fn);
                if (index >= 0) list.splice(index, 1);
              };
            },
          },
        }),
      },
    };

    let changes = 0;
    const unsubscribe = subscribeActiveChange(services, () => {
      changes += 1;
    });

    // The initial follow points at the currently focused session only.
    assert.equal(selectionListenersBySession.s1?.length, 1);
    assert.equal(selectionListenersBySession.s2?.length, 0);

    // Switching sessions fires onChange and moves the directory subscription.
    sessionId = "s2";
    sessionListener?.();
    assert.equal(changes, 1);
    assert.equal(selectionListenersBySession.s1?.length, 0);
    assert.equal(selectionListenersBySession.s2?.length, 1);

    // After cleanup nothing is subscribed anymore.
    unsubscribe();
    assert.equal(selectionListenersBySession.s2?.length, 0);
    sessionListener?.();
    assert.equal(changes, 1);
  });

  it("is a no-op without a sessions service and unsubscribes everything on cleanup", () => {
    let changes = 0;
    const unsubscribe = subscribeActiveChange({}, () => {
      changes += 1;
    });

    unsubscribe();
    assert.equal(changes, 0);
  });
});
