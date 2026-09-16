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

interface FakeToolExec {
  readonly agent?: unknown;
  readonly signal: AbortSignal;
}

/** Structural slice of the plugin's registered `subagent` tool the tests assert on. */
interface CapturedSubagentTool {
  readonly name: string;
  readonly parameters: { properties?: { agent?: { enum?: readonly string[] } } };
  execute(args: { task: string; agent: string }, exec: FakeToolExec): Promise<string>;
}

/** The `subagents.start` request fields `spawnSubagent` passes (creation booking assertions). */
interface FakeStartRequest {
  readonly label: string;
  readonly prompt: unknown;
  readonly parent: { readonly session: { readonly id: string } };
  readonly signal: unknown;
  readonly agentOptions?: { readonly provider: string; readonly model: string };
  readonly persona?: string;
  readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
}

const KNOWN_SCHEMAS = [{ name: "read" }, { name: "handoff_session" }];

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

describe("dsh agents nested subagent delegation", () => {
  it("gives a delegating child its own subagent tool in the creation window and recurses", async () => {
    const routes = new Map<string, CapturedRoute>();
    const ctx = new Context();
    const services = createTestServices(routes) as Record<string, unknown>;
    const rootTools: CapturedSubagentTool[] = [];
    services.tools = {
      schemas: () => KNOWN_SCHEMAS,
      register: (tool: CapturedSubagentTool) => {
        rootTools.push(tool);
        return () => {};
      },
      restrict: () => () => {},
    };

    const childDisposers: Array<() => void> = [];
    const startedRequests: FakeStartRequest[] = [];
    const seniorResult = deferred<{ stopReason: string; output: Array<{ type: string; text?: string }> }>();
    let startCount = 0;
    let seniorAgent: { ctx: Context; session: { id: string } } | undefined;
    let seniorTool: CapturedSubagentTool | undefined;
    // Tools registered on leaf children (junior, vision): none of them delegate.
    const leafChildTools: CapturedSubagentTool[] = [];

    const makeChildAgent = (
      request: FakeStartRequest,
      id: string,
      tools: CapturedSubagentTool[],
    ) => {
      const childCtx = new Context();
      childDisposers.push(
        childCtx.provide("tools", {
          schemas: () => KNOWN_SCHEMAS,
          register: (tool: CapturedSubagentTool) => {
            tools.push(tool);
            return () => {};
          },
          restrict: () => () => {},
        }),
      );
      return {
        ctx: childCtx,
        session: {
          id,
          header: {
            id,
            origin: "subagent",
            parentSession: request.parent.session.id,
            delegationDepth: id === "session-senior" ? 1 : 2,
          },
        },
      };
    };

    services.subagents = {
      start: async (_kind: string, request: FakeStartRequest) => {
        startCount++;
        startedRequests.push(request);
        if (startCount === 1) {
          const seniorTools: CapturedSubagentTool[] = [];
          const agent = makeChildAgent(request, "session-senior", seniorTools);
          seniorAgent = agent;
          // Real driver ordering: agent/created fires inside start, before it resolves.
          ctx.emit("agent/created", { agent: agent as never });
          seniorTool = seniorTools.find((tool) => tool.name === "subagent");
          return {
            id: "session-senior",
            localAgent: agent,
            result: seniorResult.promise,
            dispose: async () => {},
          };
        }
        const leafId = startCount === 2 ? "session-junior" : "session-vision";
        const agent = makeChildAgent(request, leafId, leafChildTools);
        ctx.emit("agent/created", { agent: agent as never });
        return {
          id: leafId,
          localAgent: agent,
          result: Promise.resolve({
            stopReason: "completed",
            output: [
              { type: "text", text: leafId === "session-junior" ? "junior report" : "vision report" },
            ],
          }),
          dispose: async () => {},
        };
      },
    };

    const disposers = Object.entries(services).map(([name, service]) => ctx.provide(name, service));
    try {
      apply(ctx);
      await Promise.resolve();
      const rootAgent = {
        ctx,
        session: {
          id: "session-main",
          header: { id: "session-main", origin: "user", delegationDepth: 0 },
        },
      };
      ctx.emit("agent/created", { agent: rootAgent as never });
      const rootTool = rootTools.find((tool) => tool.name === "subagent");
      assert.ok(rootTool);
      assert.deepEqual(rootTool.parameters.properties?.agent?.enum, ["senior", "junior", "vision"]);

      const exec = (agent: unknown): FakeToolExec => ({ agent, signal: new AbortController().signal });
      const mainRun = rootTool.execute({ task: "Investigate the design", agent: "senior" }, exec(rootAgent));
      // The senior child is composed inside start: its tool must already exist.
      for (let i = 0; i < 100 && !seniorTool; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.ok(seniorTool);
      const delegateTool = seniorTool;
      assert.deepEqual(delegateTool.parameters.properties?.agent?.enum, ["junior", "vision"]);

      // The senior child routes its first request through its own class state.
      const routed = await ctx.waterfall(
        "agent/request",
        { agent: seniorAgent as never, turn: 1, step: 0, signal: new AbortController().signal },
        async () => ({ provider: "fixture", model: "fixture" }),
      );
      assert.equal(routed.model, "gpt-5.6-terra");

      // Requirement 3: the child path must not attach the root manual-model
      // listener — a model/selection on the child keeps auto routing.
      assert.ok(seniorAgent);
      (seniorAgent.ctx.emit as unknown as (event: string, ...args: unknown[]) => unknown)(
        "session/event",
        seniorAgent,
        { type: "model/selection" },
      );
      const routedAfterSelection = await ctx.waterfall(
        "agent/request",
        { agent: seniorAgent as never, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: "fixture", model: "fixture" }),
      );
      assert.equal(routedAfterSelection.model, "gpt-5.6-terra");

      // Recursive delegation while the parent run is still in flight.
      assert.equal(
        await delegateTool.execute({ task: "Collect facts", agent: "junior" }, exec(seniorAgent)),
        "junior report",
      );
      assert.equal(
        await delegateTool.execute({ task: "Describe the diagram", agent: "vision" }, exec(seniorAgent)),
        "vision report",
      );
      // Delegation gate: outside the child's subagents list it refuses.
      await assert.rejects(() =>
        delegateTool.execute({ task: "Escape", agent: "main" }, exec(seniorAgent)),
      );

      seniorResult.resolve({
        stopReason: "completed",
        output: [{ type: "text", text: "senior report" }],
      });
      assert.equal(await mainRun, "senior report");

      // Start requests carry the configured child composition.
      assert.equal(startedRequests.length, 3);
      assert.equal(startedRequests[0].parent, rootAgent);
      assert.equal(startedRequests[1].parent, seniorAgent);
      assert.equal(startedRequests[2].parent, seniorAgent);
      assert.match(startedRequests[0].label, /^senior: /);
      assert.match(startedRequests[1].label, /^junior: /);
      assert.match(startedRequests[2].label, /^vision: /);
      assert.match(startedRequests[0].persona ?? "", /あなたは senior です/);
      assert.match(startedRequests[1].persona ?? "", /あなたは junior です/);
      // vision reuses junior's systemPrompt (config anchor).
      assert.match(startedRequests[2].persona ?? "", /画像ファイルは read で Vision/);
      assert.deepEqual(startedRequests[0].toolFilter, { deny: ["handoff_session"] });
      assert.deepEqual(startedRequests[0].agentOptions, {
        provider: "openai-codex",
        model: "gpt-5.6-terra",
      });
      assert.deepEqual(startedRequests[2].agentOptions, {
        provider: "commandcode",
        model: "z-ai/glm-5.3-flash",
      });
      // Leaf children (junior, vision) must not receive a delegation tool.
      assert.ok(!leafChildTools.some((tool) => tool.name === "subagent"));
    } finally {
      for (const dispose of childDisposers) dispose();
      for (const dispose of disposers) dispose();
      await ctx.fiber.dispose();
    }
  });

  it("keeps leaf children tool-less and ignores unbooked subagent sessions", async () => {
    const routes = new Map<string, CapturedRoute>();
    const ctx = new Context();
    const services = createTestServices(routes) as Record<string, unknown>;
    const rootTools: CapturedSubagentTool[] = [];
    const childTools: CapturedSubagentTool[] = [];
    services.tools = {
      schemas: () => KNOWN_SCHEMAS,
      register: (tool: CapturedSubagentTool) => {
        rootTools.push(tool);
        return () => {};
      },
      restrict: () => () => {},
    };

    const startedRequests: FakeStartRequest[] = [];
    services.subagents = {
      start: async (_kind: string, request: FakeStartRequest) => {
        startedRequests.push(request);
        const childCtx = new Context();
        childCtx.provide("tools", {
          schemas: () => KNOWN_SCHEMAS,
          register: (tool: CapturedSubagentTool) => {
            childTools.push(tool);
            return () => {};
          },
          restrict: () => () => {},
        });
        const childAgent = {
          ctx: childCtx,
          session: {
            id: "session-junior",
            header: {
              id: "session-junior",
              origin: "subagent",
              parentSession: request.parent.session.id,
              delegationDepth: 1,
            },
          },
        };
        ctx.emit("agent/created", { agent: childAgent as never });
        return {
          id: "session-junior",
          localAgent: childAgent,
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "leaf report" }],
          }),
          dispose: async () => {},
        };
      },
    };

    const disposers = Object.entries(services).map(([name, service]) => ctx.provide(name, service));
    try {
      apply(ctx);
      await Promise.resolve();
      // A subagent session with no matching booking: no state, no tool, no throw.
      const unbooked = {
        ctx,
        session: {
          id: "session-foreign",
          header: {
            id: "session-foreign",
            origin: "subagent",
            parentSession: "session-other",
            delegationDepth: 1,
          },
        },
      };
      ctx.emit("agent/created", { agent: unbooked as never });
      // No booking, no managed state: the request waterfall must pass through.
      const unbookedRouted = await ctx.waterfall(
        "agent/request",
        { agent: unbooked as never, turn: 1, step: 0, signal: new AbortController().signal },
        async () => ({ provider: "fixture", model: "fixture" }),
      );
      assert.equal(unbookedRouted.model, "fixture");

      // main → junior: the leaf child is composed but gets no delegation tool.
      const managedRoot = {
        ctx,
        session: {
          id: "session-main",
          header: { id: "session-main", origin: "user", delegationDepth: 0 },
        },
      };
      ctx.emit("agent/created", { agent: managedRoot as never });
      const rootTool = rootTools.find((tool) => tool.name === "subagent");
      assert.ok(rootTool);
      assert.equal(
        await rootTool.execute(
          { task: "Run the step", agent: "junior" },
          { agent: managedRoot, signal: new AbortController().signal },
        ),
        "leaf report",
      );
      assert.ok(!childTools.some((tool) => tool.name === "subagent"));
      assert.equal(startedRequests.length, 1);
    } finally {
      for (const dispose of disposers) dispose();
      await ctx.fiber.dispose();
    }
  });
});
