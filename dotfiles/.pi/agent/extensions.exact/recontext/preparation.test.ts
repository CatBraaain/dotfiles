import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import recontextExtension from "./index.ts";
import { preparationFixture } from "./preparation-fixture.ts";
import { installProviderGates } from "./provider-gate.ts";
import { PROVIDER_UPDATE_EVENT, type ProviderUpdate } from "./provider-update.ts";
import { fakeProvider, gateFixture, seedConversation } from "./test-fixture.ts";

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "preparation condition was not reached");
    await tick();
  }
}

function registrationFault() {
  let failing = false;
  let provider: ReturnType<typeof fakeProvider>["provider"];
  function register(ctx: ExtensionContext): void {
    const id = ctx.modelRegistry.getAll()[0]!.provider;
    const fake = fakeProvider(id);
    provider = fake.provider;
    const auth = provider.auth;
    Object.defineProperty(provider, "auth", {
      get() {
        if (failing) throw new Error("Synthetic provider auth getter registration failure");
        return auth;
      },
    });
    ctx.modelRegistry.registerProvider(provider);
    failing = true;
  }
  function repair(): void {
    failing = false;
  }
  function getProvider() {
    return provider;
  }
  return { register, repair, getProvider };
}

function faultExtension(fault: ReturnType<typeof registrationFault>, boundary = "session_start") {
  return function extension(pi: ExtensionAPI): void {
    if (boundary === "session_start") pi.on("session_start", (_event, ctx) => fault.register(ctx));
    recontextExtension(pi);
    if (boundary === "turn_start") pi.on("turn_start", (_event, ctx) => fault.register(ctx));
  };
}

describe("provider preparation lifecycle", () => {
  it("defers registration, shares one preparation, yields between providers, and keeps prepared wrappers", async () => {
    const h = await gateFixture({}, { deferPreparation: true });
    const catalog = h.registry.getAll().map((model) => [model.provider, model.id]);
    const providers = [...new Set(catalog.map(([provider]) => provider!))];
    const originals = new Map(
      providers.map((id) => [id, h.registry.getRegisteredNativeProvider(id)]),
    );
    function wrapped() {
      return providers.filter(
        (id) => h.registry.getRegisteredNativeProvider(id) !== originals.get(id),
      );
    }
    try {
      const first = h.gates.ensure();
      assert.strictEqual(h.gates.ensure(), first);
      assert.deepEqual(wrapped(), []);
      await until(() => wrapped().length > 0);
      assert.ok(wrapped().length < providers.length);
      await first;
      const prepared = providers.map((id) => h.registry.getRegisteredNativeProvider(id));
      await h.gates.ensure();
      assert.deepEqual(
        providers.map((id) => h.registry.getRegisteredNativeProvider(id)),
        prepared,
      );
      assert.equal(wrapped().length, providers.length);
      assert.deepEqual(
        h.registry.getAll().map((model) => [model.provider, model.id]),
        catalog,
      );
    } finally {
      h.gates.close();
    }
  });

  it("stops a scheduled preparation before its first provider and rejects shared waiters", async () => {
    const h = await gateFixture({}, { deferPreparation: true });
    const originals = h.registry.getRegisteredProviderIds();
    const preparation = h.gates.ensure();
    const stopped = assert.rejects(preparation, /owner is closed/);
    h.gates.close();
    await stopped;
    await tick();
    await tick();
    assert.deepEqual(h.registry.getRegisteredProviderIds(), originals);
    assert.strictEqual(h.registry.getRegisteredNativeProvider(h.provider.id), h.provider);
    await assert.rejects(h.gates.ensure(), /owner is closed/);
    h.gates.close();
  });

  it("stops a partial owner's timer without restoring over a foreign or replacement owner", async () => {
    const h = await gateFixture({}, { deferPreparation: true });
    const pending = h.gates.ensure();
    const stopped = assert.rejects(pending, /owner is closed/);
    await until(() => h.registry.getRegisteredProviderIds().length > 1);
    const wrappedId = h.registry.getRegisteredProviderIds().find((id) => id !== h.provider.id)!;
    const foreign = fakeProvider(wrappedId).provider;
    h.registry.registerProvider(foreign);
    h.gates.close();
    await stopped;
    assert.strictEqual(h.registry.getRegisteredNativeProvider(wrappedId), foreign);
    const next = installProviderGates(h.pi, () => h.ctx);
    try {
      await next.ensure();
      const providers = h.registry.getRegisteredProviderIds();
      const prepared = providers.map((id) => h.registry.getRegisteredNativeProvider(id));
      await tick();
      await tick();
      assert.deepEqual(
        providers.map((id) => h.registry.getRegisteredNativeProvider(id)),
        prepared,
      );
    } finally {
      next.close();
    }
    assert.strictEqual(h.registry.getRegisteredNativeProvider(wrappedId), foreign);
  });

  it("keeps a failed partial registration owned and does not retry it on each ensure", async () => {
    const h = await gateFixture({}, { deferPreparation: true });
    const fault = registrationFault();
    try {
      fault.register(h.ctx);
      await assert.rejects(h.gates.ensure(), /Synthetic provider auth getter/);
      const failedWrappers = h.registry
        .getRegisteredProviderIds()
        .map((id) => h.registry.getRegisteredNativeProvider(id));
      await assert.rejects(h.gates.ensure(), /Synthetic provider auth getter/);
      assert.deepEqual(
        h.registry
          .getRegisteredProviderIds()
          .map((id) => h.registry.getRegisteredNativeProvider(id)),
        failedWrappers,
      );
    } finally {
      fault.repair();
      h.gates.close();
    }
    assert.strictEqual(
      h.registry.getRegisteredNativeProvider(fault.getProvider().id),
      fault.getProvider(),
    );
  });

  it("publishes cold updates, protects active updates immediately, and includes a newly added provider", async () => {
    const h = await preparationFixture({ mode: "tui" });
    try {
      const cold = h.update();
      assert.equal(cold.change.error, undefined);
      assert.strictEqual(
        h.registry.getRegisteredNativeProvider(cold.next.provider.id),
        cold.next.provider,
      );
      h.widgets.get("recontext-preparation")!.render(80);
      await until(() => h.wrappedProviderIds().length > 0);
      const updated = h.update();
      assert.equal(updated.change.error, undefined);
      assert.notStrictEqual(
        h.registry.getRegisteredNativeProvider(updated.next.provider.id),
        updated.next.provider,
      );
      const added = h.update(fakeProvider("added-memory"));
      assert.equal(added.change.error, undefined);
      await until(() => h.widgets.size === 0);
      await h.session.setModel(h.registry.find(added.next.provider.id, "physical")!);
      await h.session.prompt("use newly registered model", { source: "extension" });
      assert.equal(h.wrappedProviderIds().length, h.providerIds.length + 1);
      assert.deepEqual(
        added.next.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.deepEqual(cold.next.state.requests, []);
      assert.deepEqual(updated.next.state.requests, []);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.dispose();
    }
  });

  it("retains current physical models and authentication published during preparation", async () => {
    const h = await preparationFixture();
    try {
      await until(() => h.wrappedProviderIds().length > 0);
      h.fake.state.pendingModels = [
        { ...h.fake.state.models[0]!, id: "physical-v2", contextWindow: 12_100 },
      ];
      h.fake.state.authRevision = "synthetic-v2";
      await h.runtime.setRuntimeApiKey(h.fake.provider.id, "synthetic-key-v2");
      await h.registry.refresh({ providers: [h.fake.provider.id], allowNetwork: false });
      await h.session.setModel(h.registry.find(h.fake.provider.id, "physical-v2")!);
      await h.session.prompt("updated model", { source: "extension" });
      assert.deepEqual(
        h.fake.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.ok(
        h.fake.state.requests.every(
          (request) =>
            request.model.id === "physical-v2" && request.options.apiKey === "synthetic-key-v2",
        ),
      );
      assert.deepEqual(h.errors, []);
    } finally {
      await h.dispose();
    }
  });

  it("preserves a draining summary's queue across a partial close and new owner", async () => {
    const h = await gateFixture({}, { deferPreparation: true });
    const pending = h.gates.ensure();
    const stopped = assert.rejects(pending, /owner is closed/);
    await until(() => h.registry.getRegisteredProviderIds().length > 1);
    const nextProvider = fakeProvider(h.provider.id);
    const change: ProviderUpdate = {
      registry: h.registry,
      providerId: h.provider.id,
      handled: false,
      register() {
        h.registry.registerProvider(nextProvider.provider);
      },
    };
    h.pi.events.emit(PROVIDER_UPDATE_EVENT, change);
    assert.equal(change.error, undefined);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    nextProvider.state.beforeReply = async (capture) => {
      if (capture.kind === "summary") {
        entered.resolve();
        await release.promise;
      }
    };
    seedConversation(h.manager, 12_500);
    function request() {
      return h.registry
        .streamSimple(
          h.model,
          { messages: convertToLlm(h.manager.buildSessionProjection().messages) },
          { sessionId: h.manager.getSessionId() },
        )
        .result();
    }
    const first = request();
    await entered.promise;
    h.gates.close();
    await stopped;
    const nextOwner = installProviderGates(h.pi, () => h.ctx);
    try {
      await nextOwner.ensure();
      assert.equal((await request()).stopReason, "aborted");
      assert.deepEqual(
        nextProvider.state.requests.map((capture) => capture.kind),
        ["summary"],
      );
      release.resolve();
      await first;
      await until(() => !nextOwner.isBusy());
      assert.equal((await request()).stopReason, "stop");
      assert.equal(nextProvider.state.maxActive, 1);
      assert.deepEqual(
        nextProvider.state.requests.map((capture) => capture.kind),
        ["summary", "summary", "normal"],
      );
    } finally {
      release.resolve();
      nextOwner.close();
      h.gates.close();
    }
  });
});

describe("AgentSession preparation boundaries", () => {
  it("registers only after the first empty widget render and removes it without visible rows", async () => {
    const h = await preparationFixture({ mode: "tui" });
    try {
      const catalog = h.registry.getAll().map((model) => [model.provider, model.id]);
      const widget = h.widgets.get("recontext-preparation")!;
      assert.ok(widget);
      await tick();
      await tick();
      assert.deepEqual(h.wrappedProviderIds(), []);
      for (let render = 0; render < 10; render++) assert.deepEqual(widget.render(80), []);
      assert.deepEqual(h.wrappedProviderIds(), []);
      await until(() => h.widgets.size === 0);
      assert.equal(h.wrappedProviderIds().length, h.providerIds.length);
      assert.deepEqual(
        h.registry.getAll().map((model) => [model.provider, model.id]),
        catalog,
      );
      await h.session.prompt("after idle preparation", { source: "extension" });
      assert.deepEqual(
        h.fake.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.deepEqual(h.errors, []);
    } finally {
      await h.dispose();
    }
  });

  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    it(`protects an immediate first ${mode} request before any lower send`, async () => {
      const h = await preparationFixture({ mode });
      try {
        assert.deepEqual(h.wrappedProviderIds(), []);
        let atFirstSend: number | undefined;
        h.fake.state.beforeReply = () => {
          atFirstSend ??= h.wrappedProviderIds().length;
        };
        await h.session.prompt("immediate oversized request", { source: "extension" });
        assert.equal(atFirstSend, h.providerIds.length);
        assert.equal(h.widgets.size, 0);
        assert.deepEqual(
          h.fake.state.requests.map((request) => request.kind),
          ["summary", "normal"],
        );
        assert.deepEqual(h.errors, []);
      } finally {
        await h.dispose();
      }
    });
  }

  for (const mode of ["rpc", "print", "json"] as const) {
    it(`prepares in ${mode} without requiring a prompt or a TUI render`, async () => {
      const h = await preparationFixture({ mode });
      try {
        await until(() => h.wrappedProviderIds().length === h.providerIds.length);
        assert.deepEqual(h.fake.state.requests, []);
        assert.equal(h.widgets.size, 0);
        assert.deepEqual(h.errors, []);
      } finally {
        await h.dispose();
      }
    });
  }

  it("protects a model selected partway through preparation", async () => {
    const h = await preparationFixture({ second: true });
    try {
      await until(() => h.wrappedProviderIds().length > 0);
      assert.ok(h.wrappedProviderIds().length < h.providerIds.length);
      await h.session.setModel(h.registry.find(h.second.provider.id, "physical")!);
      await h.session.prompt("second model", { source: "extension" });
      assert.deepEqual(
        h.second.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.deepEqual(h.fake.state.requests, []);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.dispose();
    }
  });

  it("stops the old preparation on actual SDK reload and protects the next prompt", async () => {
    const h = await preparationFixture();
    try {
      await until(() => h.wrappedProviderIds().length > 0);
      assert.ok(h.wrappedProviderIds().length < h.providerIds.length);
      await h.session.reload();
      assert.deepEqual(h.wrappedProviderIds(), []);
      await h.session.prompt("after reload", { source: "extension" });
      const providers = h.registry.getRegisteredProviderIds();
      const prepared = providers.map((id) => h.registry.getRegisteredNativeProvider(id));
      await tick();
      await tick();
      assert.deepEqual(
        providers.map((id) => h.registry.getRegisteredNativeProvider(id)),
        prepared,
      );
      assert.deepEqual(
        h.fake.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.deepEqual(h.errors, []);
    } finally {
      await h.dispose();
    }
  });

  for (const path of ["compact", "tree", "warming"] as const) {
    it(`waits for cold preparation before a standard ${path} operation`, async () => {
      const h = await preparationFixture({ mode: "tui" });
      try {
        if (path === "compact") await h.session.compact();
        if (path === "tree") await h.session.navigateTree(h.seed.old, { summarize: true });
        if (path === "warming")
          await h.session.extensionRunner.emitCacheWarmingDecision({
            type: "cache_warming_decision",
            action: "warm",
            warmCost: 0,
            missCost: 1,
            continuationProbability: 1,
          });
        assert.equal(h.wrappedProviderIds().length, h.providerIds.length);
        assert.equal(h.fake.state.requests.length > 0, path !== "warming");
        assert.deepEqual(h.errors, []);
      } finally {
        await h.dispose();
      }
    });
  }
});

describe("registration failure stops ordinary dispatch through public APIs", () => {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    it(`stops a ${mode} ordinary run after a non-selected provider registration fails`, async () => {
      const fault = registrationFault();
      const h = await preparationFixture({ mode, extension: faultExtension(fault) });
      try {
        await h.session.prompt("oversized registration failure", { source: "extension" });
        assert.deepEqual(h.fake.state.requests, []);
        assert.equal(h.widgets.size, 0);
        assert.ok(h.notices.some((notice) => notice.includes("Synthetic provider auth getter")));
        assert.deepEqual(h.errors, []);
        assert.match(JSON.stringify(h.manager.getEntries()), /OLD |old answer/);
      } finally {
        fault.repair();
        await h.dispose();
      }
    });
  }

  it("removes a failed background widget and stops a subsequent ordinary prompt", async () => {
    const fault = registrationFault();
    const h = await preparationFixture({ mode: "tui", extension: faultExtension(fault) });
    try {
      h.widgets.get("recontext-preparation")!.render(80);
      await until(() => h.widgets.size === 0);
      await h.session.prompt("after background failure", { source: "extension" });
      assert.deepEqual(h.fake.state.requests, []);
      assert.deepEqual(h.errors, []);
    } finally {
      fault.repair();
      await h.dispose();
    }
  });

  it("aborts from context when a later turn-start handler replaces a prepared provider", async () => {
    const fault = registrationFault();
    const h = await preparationFixture({ extension: faultExtension(fault, "turn_start") });
    try {
      await h.session.prompt("context must stop dispatch", { source: "extension" });
      assert.deepEqual(h.fake.state.requests, []);
      assert.deepEqual(h.errors, []);
    } finally {
      fault.repair();
      await h.dispose();
    }
  });

  it("aborts the next turn when registration fails after the preceding normal reply", async () => {
    const fault = registrationFault();
    const h = await preparationFixture();
    try {
      let injected = false;
      h.fake.state.beforeReply = (capture) => {
        if (capture.kind !== "normal") return;
        if (injected) {
          h.fake.state.normalReason = "stop";
          h.fake.state.normalContent = undefined;
          return;
        }
        injected = true;
        fault.register(h.getContext());
        h.fake.state.normalReason = "toolUse";
        h.fake.state.normalContent = [
          {
            type: "toolCall",
            id: "synthetic-next-turn",
            name: "missing_fixture_tool",
            arguments: {},
          },
        ];
      };
      await h.session.prompt("fault before the second turn", { source: "extension" });
      assert.deepEqual(
        h.fake.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.ok(h.notices.some((notice) => notice.includes("Synthetic provider auth getter")));
      assert.deepEqual(h.errors, []);
    } finally {
      fault.repair();
      await h.dispose();
    }
  });

  for (const path of ["compact", "tree", "warming"] as const) {
    it(`cancels ${path} rather than falling through after registration failure`, async () => {
      const fault = registrationFault();
      const h = await preparationFixture({ extension: faultExtension(fault) });
      try {
        if (path === "compact") await assert.rejects(h.session.compact(), /cancelled|aborted/i);
        if (path === "tree") {
          const result = await h.session.navigateTree(h.seed.old, { summarize: true });
          assert.equal(result.cancelled, true);
        }
        if (path === "warming") {
          const result = await h.session.extensionRunner.emitCacheWarmingDecision({
            type: "cache_warming_decision",
            action: "warm",
            warmCost: 0,
            missCost: 1,
            continuationProbability: 1,
          });
          assert.equal(result, "stop");
        }
        assert.deepEqual(h.fake.state.requests, []);
        assert.deepEqual(h.errors, []);
      } finally {
        fault.repair();
        await h.dispose();
      }
    });
  }

  it("resumes protected dispatch with a new SDK owner after a registration failure and reload", async () => {
    const fault = registrationFault();
    let injected = false;
    function extension(pi: ExtensionAPI): void {
      pi.on("session_start", (_event, ctx) => {
        if (injected) return;
        injected = true;
        fault.register(ctx);
      });
      recontextExtension(pi);
    }
    const h = await preparationFixture({ extension });
    try {
      await h.session.prompt("blocked before reload", { source: "extension" });
      const beforeReload = h.fake.state.requests.map((request) => request.kind);
      assert.deepEqual(beforeReload, []);
      fault.repair();
      await h.session.reload();
      await h.session.prompt("protected after reload", { source: "extension" });
      assert.deepEqual(
        h.fake.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.deepEqual(h.errors, []);
    } finally {
      fault.repair();
      await h.dispose();
    }
  });

  it("blocks after an active update fails and resumes protected dispatch after a successful update", async () => {
    const h = await preparationFixture();
    let failing = false;
    try {
      await h.session.prompt("initial protected request", { source: "extension" });
      const id = h.providerIds[0]!;
      const next = fakeProvider(id);
      const auth = next.provider.auth;
      Object.defineProperty(next.provider, "auth", {
        get() {
          if (failing) throw new Error("Synthetic active update registration failure");
          return auth;
        },
      });
      const change: ProviderUpdate = {
        registry: h.getContext().modelRegistry,
        providerId: id,
        handled: false,
        register() {
          h.registry.registerProvider(next.provider);
          failing = true;
        },
      };
      h.api.events.emit(PROVIDER_UPDATE_EVENT, change);
      assert.match(String(change.error), /Synthetic active update/);
      const beforeFailure = h.fake.state.requests.length;
      await h.session.prompt("blocked after failed update", { source: "extension" });
      assert.equal(h.fake.state.requests.length, beforeFailure);
      failing = false;
      assert.equal(h.update(fakeProvider(id)).change.error, undefined);
      await h.session.prompt("protected after repaired update", { source: "extension" });
      assert.deepEqual(
        h.fake.state.requests.slice(beforeFailure).map((request) => request.kind),
        ["normal"],
      );
      assert.deepEqual(h.errors, []);
    } finally {
      failing = false;
      await h.dispose();
    }
  });
});
