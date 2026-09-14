import { Context } from "@deepseek-ai/cordis";
import { describe, it } from "bun:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { apply } from "./index.ts";

interface CapturedRoute {
  readonly path: string;
  readonly fetch: (request: Request) => Promise<Response>;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTestServices(routes: Map<string, CapturedRoute>) {
  return {
    commands: { register: () => () => {} },
    tools: {
      schemas: () => [],
      register: () => () => {},
      restrict: () => () => {},
    },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ["text"] }),
    },
    subagents: { start: async () => undefined },
    systemPrompt: { section: () => () => {} },
    connection: {
      fetch: {
        register: (route: CapturedRoute) => {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    sessionQuery: {
      listSessions: async () => [
        { header: { id: "session-main", origin: "user", delegationDepth: 0 } },
      ],
    },
    shell: {
      resolve: (command: unknown) => command,
      run: async () => ({ exitCode: 1, timedOut: false }),
    },
  };
}

describe("dsh agents browser bundle", () => {
  it("keeps the selected state when a newer menu refresh fails", async () => {
    const firstState = deferred<Response>();
    const selectedState = deferred<Response>();
    const menuProps: Array<Record<string, unknown>> = [];
    const stateUpdates: unknown[] = [];
    let latestState: Record<string, unknown> | undefined;
    let registeredComponent: ((props: Record<string, unknown>) => unknown) | undefined;
    let fetchCount = 0;

    const fakeReact = {
      createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
        const normalizedProps = { ...props, children };
        if (typeof type === "function") return type(normalizedProps);
        return { type, props: normalizedProps, children };
      },
      useEffect(effect: () => unknown) {
        effect();
      },
      useMemo<T>(factory: () => T): T {
        return factory();
      },
      useState<T>(initial: T): [T, (next: T) => void] {
        let value = initial;
        return [
          value,
          (next) => {
            value = next;
            if (typeof next === "object" && next !== null) stateUpdates.push(next);
            if (typeof value === "object" && value !== null && "className" in value) {
              latestState = value as Record<string, unknown>;
            }
          },
        ];
      },
    };
    const fakeMenu = (props: Record<string, unknown>) => {
      menuProps.push(props);
      return { type: "Menu", props };
    };
    const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    const previousDocument = (globalThis as { document?: unknown }).document;
    const previousFetch = globalThis.fetch;
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    try {
      (globalThis as { document: unknown }).document = {
        createElement: () => ({ remove() {}, textContent: "" }),
        head: { appendChild() {} },
        documentElement: { appendChild() {} },
      };
      globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
      globalThis.clearInterval = (() => {}) as typeof clearInterval;
      globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        fetchCount++;
        if (fetchCount === 1) return firstState.promise;
        if (fetchCount === 2) return new Response(JSON.stringify({ ok: true }));
        if (fetchCount === 3) return selectedState.promise;
        if (fetchCount === 4) return new Response(JSON.stringify({ ok: true }));
        if (fetchCount === 5) return new Response(JSON.stringify({ managed: "invalid" }));
        throw new Error(`unexpected fetch ${fetchCount}`);
      }) as typeof fetch;

      let client: { apply: (ctx: unknown) => void } | undefined;
      new Function("window", bundle)({
        __ModuleLoader__: {
          load({ factory }: { factory: (require: (name: string) => unknown) => unknown }) {
            client = factory((name) => {
              if (name === "react") return fakeReact;
              if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Menu: fakeMenu };
              throw new Error(`unexpected require ${name}`);
            }) as { apply: (ctx: unknown) => void };
          },
        },
      });
      assert.ok(client);
      client.apply({
        effect() {},
        slots: {
          inject(_name: string, callback: () => unknown) {
            callback();
          },
          register(_meta: unknown, component: (props: Record<string, unknown>) => unknown) {
            registeredComponent = component;
            return () => {};
          },
        },
      });
      assert.ok(registeredComponent);
      registeredComponent({
        sessionId: "session-main",
        initialState: {
          managed: true,
          agent: "main",
          className: "middle",
          model: "gpt-5.6-luna",
          agents: ["main"],
          classes: ["high", "middle"],
        },
      });
      assert.equal(menuProps.length, 2);

      const classMenu = menuProps[1];
      (classMenu.onSelect as (name: string) => void)("high");
      await Promise.resolve();
      selectedState.resolve(
        new Response(
          JSON.stringify({
            managed: true,
            agent: "main",
            className: "high",
            manual: false,
            model: "gpt-5.6-terra",
            agents: ["main"],
            classes: ["high", "middle"],
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      firstState.resolve(
        new Response(
          JSON.stringify({
            managed: true,
            agent: "main",
            className: "middle",
            manual: false,
            model: "gpt-5.6-luna",
            agents: ["main"],
            classes: ["high", "middle"],
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(fetchCount, 3);
      const selectedStateSnapshot = {
        managed: true,
        agent: "main",
        className: "high",
        model: "gpt-5.6-terra",
        agents: ["main"],
        classes: ["high", "middle"],
      };
      assert.deepEqual(latestState, selectedStateSnapshot);

      (classMenu.onSelect as (name: string) => void)("middle");
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(fetchCount, 5);
      assert.deepEqual(latestState, selectedStateSnapshot);
      assert.deepEqual(stateUpdates, [selectedStateSnapshot]);
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.setInterval = previousSetInterval;
      globalThis.clearInterval = previousClearInterval;
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document: unknown }).document = previousDocument;
    }
  });
});

describe("dsh agents class selection and display", () => {
  it("returns the selected class fallback model immediately after selection", async () => {
    const routes = new Map<string, CapturedRoute>();
    const ctx = new Context();
    const services = createTestServices(routes);
    const disposers = Object.entries(services).map(([name, service]) => ctx.provide(name, service));
    try {
      apply(ctx);
      await Promise.resolve();

      const agent = {
        ctx,
        session: {
          id: "session-main",
          header: { id: "session-main", origin: "user", delegationDepth: 0 },
        },
      } as never;
      ctx.emit("agent/created", { agent });

      const stateRoute = routes.get("/api/dsh-agents/state");
      const selectRoute = routes.get("/api/dsh-agents/select");
      assert.ok(stateRoute);
      assert.ok(selectRoute);

      const stateRequest = (body: unknown) =>
        new Request("http://localhost/api/dsh-agents/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const initial = await stateRoute.fetch(stateRequest({ sessionId: "session-main" }));
      assert.deepEqual(await initial.json(), {
        managed: true,
        agent: "main",
        className: "middle",
        manual: false,
        model: "gpt-5.6-luna",
        agents: ["main", "senior", "junior", "vision", "chat"],
        classes: ["high", "middle", "low", "vision"],
      });

      const selected = await selectRoute.fetch(
        new Request("http://localhost/api/dsh-agents/select", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "session-main", kind: "class", name: "high" }),
        }),
      );
      assert.deepEqual(await selected.json(), { ok: true, text: "class → high" });

      const afterSelection = await stateRoute.fetch(stateRequest({ sessionId: "session-main" }));
      assert.deepEqual(await afterSelection.json(), {
        managed: true,
        agent: "main",
        className: "high",
        manual: false,
        model: "gpt-5.6-terra",
        agents: ["main", "senior", "junior", "vision", "chat"],
        classes: ["high", "middle", "low", "vision"],
      });

      const route = await ctx.waterfall(
        "agent/request",
        { agent, turn: 1, step: 0, signal: new AbortController().signal },
        async () => ({ provider: "fixture", model: "fixture" }),
      );
      assert.equal(route.model, "gpt-5.6-terra");
    } finally {
      for (const dispose of disposers) dispose();
      await ctx.fiber.dispose();
    }
  });
});
