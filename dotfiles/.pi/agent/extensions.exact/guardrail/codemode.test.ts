import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "bun:test";
import {
  createCodemodeExtension,
  initTheme,
  type AgentToolResult,
  type CodemodeToolDetails,
  type ExtensionAPI,
  type ExtensionToolContext,
  type Theme,
  type ToolDefinition,
  type ToolLoadout,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerCodemode, withCodemodeResultRenderer } from "./codemode.ts";

type CodemodeDefinition = ToolDefinition<
  Type.TObject<{ code: Type.TString }>,
  CodemodeToolDetails | undefined
>;
type CodemodeResult = AgentToolResult<CodemodeToolDetails | undefined>;
type ToolRenderContext = Parameters<NonNullable<CodemodeDefinition["renderResult"]>>[3];

initTheme("dark", false);

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };
const partial = { expanded: false, isPartial: true };
const successfulCalls: CodemodeToolDetails["calls"] = [
  {
    id: "script/1",
    name: "models.classify",
    args: "first",
    status: "ok",
    durationMs: 900,
    cost: 0.01,
  },
  {
    id: "script/2",
    name: "models.classify",
    args: "second",
    status: "ok",
    durationMs: 900,
    cost: 0.02,
  },
];

function standardDefinition(api: Partial<ExtensionAPI> = {}): CodemodeDefinition {
  const definitions: CodemodeDefinition[] = [];
  createCodemodeExtension()({
    ...api,
    registerTool: (tool) => definitions.push(tool as unknown as CodemodeDefinition),
  } as ExtensionAPI);
  assert.equal(definitions.length, 1);
  return definitions[0]!;
}

function completedResult(seconds = "1.2", ...output: string[]): CodemodeResult {
  return {
    content: [
      { type: "text", text: `Script completed\nWall time ${seconds} seconds\nOutput:\n` },
      ...output.map((text) => ({ type: "text" as const, text })),
    ],
    details: { calls: successfulCalls.map((call) => ({ ...call })) },
  };
}

function renderContext(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
  return {
    args: { code: "return 1;" },
    toolCallId: "script",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function renderLines(component: Component, width = 200): string[] {
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

function renderResult(
  definition: CodemodeDefinition,
  result: CodemodeResult,
  options: ToolRenderResultOptions = collapsed,
  context: ToolRenderContext = renderContext(),
  theme = plainTheme,
): Component {
  return definition.renderResult!(result, options, theme, context);
}

const standard = standardDefinition();
const shortened = withCodemodeResultRenderer(standard);

describe("codemode registration", () => {
  it("keeps every standard field except renderResult by reference or value", () => {
    assert.deepEqual(Reflect.ownKeys(shortened), Reflect.ownKeys(standard));
    for (const key of Reflect.ownKeys(standard)) {
      if (key === "renderResult") continue;
      assert.strictEqual(Reflect.get(shortened, key), Reflect.get(standard, key), String(key));
    }
    assert.notStrictEqual(shortened.renderResult, standard.renderResult);
    assert.equal(shortened.defaultActive, false);
    assert.equal(shortened.exposure, "model-only");
    assert.equal(shortened.parameters.properties.code.type, "string");
  });

  it("registers once per factory invocation and retains the public schema and call renderer", () => {
    for (let load = 0; load < 2; load++) {
      const registered: CodemodeDefinition[] = [];
      const api: Partial<ExtensionAPI> = {
        registerTool: (tool) => {
          registered.push(tool as unknown as CodemodeDefinition);
        },
      };
      registerCodemode(api as ExtensionAPI);
      assert.equal(registered.length, 1);
      const definition = registered[0]!;
      assert.equal(definition.name, "codemode");
      assert.strictEqual(definition.parameters, standard.parameters);
      assert.strictEqual(definition.renderCall, standard.renderCall);
      assert.equal(definition.defaultActive, false);
      assert.equal(definition.exposure, standard.exposure);
      assert.deepEqual(definition.constrainedSampling, standard.constrainedSampling);
    }
  });

  it("preserves dynamic codemode mode and inline budget settings through the facade", () => {
    let mode: "on" | "only" = "on";
    let settingsReads = 0;
    let definition: CodemodeDefinition | undefined;
    registerCodemode({
      registerTool: (tool) => {
        definition = tool as unknown as CodemodeDefinition;
      },
      getSettings: () => {
        settingsReads++;
        return { codemode: { mode, inlineBudget: 0 } };
      },
    } as ExtensionAPI);
    assert.equal(settingsReads, 0);
    const fake = {
      name: "fake_tool",
      label: "Fake",
      description: "A safe fake tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    };
    const loadout: ToolLoadout = {
      declared: [fake],
      callable: [fake],
      registered: [fake],
      getExposure: () => "direct",
      getNamespace: () => undefined,
    };
    assert.deepEqual(definition!.prepareLoadout!(loadout)?.hiddenDeclarations, []);
    mode = "only";
    const prepared = definition!.prepareLoadout!(loadout)!;
    assert.deepEqual(prepared.hiddenDeclarations, ["fake_tool"]);
    assert.match(prepared.descriptions!.codemode!, /models/);
    assert.ok(settingsReads >= 4);
  });
});

describe("codemode result display", () => {
  for (const seconds of ["0.0", "1.2"]) {
    it(`shows ${seconds}s from the script wall time, not the nested time sum`, () => {
      const result = completedResult(seconds, "body");
      const actual = renderLines(renderResult(shortened, result));
      const standardBody = renderLines(
        renderResult(standard, { ...result, details: { calls: [] } }),
      );
      assert.deepEqual(actual, [`${seconds}s`, ...standardBody]);
      assert.doesNotMatch(
        actual.join("\n"),
        /models\.classify|Model calls:|Script completed|Wall time|Output:/,
      );
    });
  }

  it("shows wall time even when the body and calls are empty", () => {
    const result = { ...completedResult(), details: { calls: [] } };
    assert.equal(renderLines(renderResult(shortened, result)).join("\n").trim(), "1.2s");
  });

  it("uses the bash summary precision and color", () => {
    const taggedTheme = {
      ...plainTheme,
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as Theme;
    const lines = renderLines(
      renderResult(
        shortened,
        completedResult("1.24", "body"),
        collapsed,
        renderContext(),
        taggedTheme,
      ),
    );
    assert.equal(lines[0], "<success>1.2s</success>");
    assert.ok(lines.includes("<toolOutput>body</toolOutput>"));
  });

  it("preserves multiple blocks, tabs, blank lines, and a fake header inside the body", () => {
    const fakeHeader = "Script completed\nWall time 999.9 seconds\nOutput:\n";
    const result = completedResult("1.2", "first\tcolumn\n\nnext", fakeHeader, "last");
    const view = { ...result, details: { calls: [] } };
    assert.deepEqual(renderLines(renderResult(shortened, result, expanded)), [
      "1.2s",
      ...renderLines(renderResult(standard, result, expanded)),
    ]);
    assert.deepEqual(renderLines(renderResult(shortened, result)), [
      "1.2s",
      ...renderLines(renderResult(standard, view)),
    ]);
  });

  it("restores standard calls, arguments, cost totals, and the full body on expansion", () => {
    const result = completedResult("1.2", "one\ntwo\nthree\nfour\nfive\nsix\nseven");
    const lines = renderLines(renderResult(shortened, result, expanded));
    assert.deepEqual(lines, ["1.2s", ...renderLines(renderResult(standard, result, expanded))]);
    assert.match(lines.join("\n"), /models\.classify first/);
    assert.match(lines.join("\n"), /Model calls: \$0\.03/);
    assert.match(lines.join("\n"), /seven/);
    assert.doesNotMatch(renderLines(renderResult(shortened, result)).join("\n"), /seven/);
  });

  it("keeps standard script failure diagnostics and context errors", () => {
    const failed = completedResult(
      "1.2",
      "partial body",
      "Script error:\nError: failed\nstack\nmore",
    );
    failed.content[0] = { type: "text", text: "Script failed\nWall time 1.2 seconds\nOutput:\n" };
    const flagged = { ...completedResult("1.2", "diagnostic"), isError: true };
    for (const result of [failed, flagged, completedResult("1.2", "context diagnostic")]) {
      for (const options of [collapsed, expanded]) {
        const context = renderContext({ isError: true });
        assert.deepEqual(
          renderLines(renderResult(shortened, result, options, context)),
          renderLines(renderResult(standard, result, options, context)),
        );
      }
    }
    assert.deepEqual(
      renderLines(renderResult(shortened, failed)),
      renderLines(renderResult(standard, failed)),
    );
    assert.deepEqual(
      renderLines(renderResult(shortened, flagged)),
      renderLines(renderResult(standard, flagged)),
    );
  });

  for (const status of ["error", "cancelled"] as const) {
    it(`keeps the standard ${status} marker when the script catches a nested failure`, () => {
      const result = completedResult("1.2", "caught and continued");
      result.details!.calls.push({
        id: "script/3",
        name: "fake_tool",
        args: "{}",
        status,
        error: "nested diagnostic",
      });
      for (const options of [collapsed, expanded]) {
        const lines = renderLines(renderResult(shortened, result, options));
        assert.deepEqual(lines, renderLines(renderResult(standard, result, options)));
        assert.ok(lines.some((line) => line.includes(status === "error" ? "✗" : "⊘")));
        assert.notEqual(lines[0], "1.2s");
      }
    });
  }

  it("keeps partial call progress and never shows body or a final time", () => {
    const result = completedResult("1.2", "unconfirmed body");
    result.details!.calls[0]!.status = "running";
    for (const options of [partial, { ...expanded, isPartial: true }]) {
      const lines = renderLines(renderResult(shortened, result, options));
      assert.deepEqual(lines, renderLines(renderResult(standard, result, options)));
      assert.match(lines.join("\n"), /… models\.classify/);
      assert.doesNotMatch(lines.join("\n"), /unconfirmed body|1\.2s/);
    }
  });

  for (const header of [
    "",
    "invalid options",
    "Script completed\nOutput:\n",
    "Script finished\nWall time 1.2 seconds\nOutput:\n",
    "Script completed\nWall time -1.2 seconds\nOutput:\n",
    "Script completed\nWall time NaN seconds\nOutput:\n",
    "Script completed\nWall time 1..2 seconds\nOutput:\n",
    `Script completed\nWall time ${"9".repeat(400)} seconds\nOutput:\n`,
    "Script completed\nWall time 1.2 seconds\nOutput:\n\n",
    "body\nScript completed\nWall time 1.2 seconds\nOutput:\n",
    "Script completed\nWall time 1.2 seconds\nOutput:\nbody",
  ]) {
    it(`keeps standard output for an unmeasured or unknown header: ${header.slice(0, 60)}`, () => {
      const result = completedResult("1.2", "body");
      result.content[0] = { type: "text", text: header };
      for (const options of [collapsed, expanded]) {
        assert.deepEqual(
          renderLines(renderResult(shortened, result, options)),
          renderLines(renderResult(standard, result, options)),
        );
      }
    });
  }

  it("does not look for a time header in later blocks", () => {
    const result = completedResult("1.2", "body");
    result.content.unshift({ type: "text", text: "ordinary body" });
    assert.deepEqual(
      renderLines(renderResult(shortened, result)),
      renderLines(renderResult(standard, result)),
    );
  });

  it("preserves the standard full output path and width-dependent preview", () => {
    const result = completedResult(
      "1.2",
      "界".repeat(100) + "\nsecond\nthird\nfourth\nfifth\nsixth\n[Full output: /tmp/full.txt]",
    );
    result.details!.fullOutputPath = "/tmp/full.txt";
    for (const options of [collapsed, expanded]) {
      const view = options.expanded
        ? result
        : { ...result, details: { ...result.details, calls: [] } };
      const component = renderResult(shortened, result, options);
      const original = renderResult(standard, view, options);
      for (const width of [12, 200, 24]) {
        assert.deepEqual(renderLines(component, width), ["1.2s", ...renderLines(original, width)]);
      }
      assert.match(renderLines(component).join("\n"), /\/tmp\/full\.txt/);
    }
  });

  it("preserves image blocks and the standard showImages behavior", () => {
    const result = completedResult("0.0", "image body");
    result.content.push({
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=",
    });
    const view = { ...result, details: { calls: [] } };
    for (const showImages of [false, true]) {
      for (const options of [collapsed, expanded]) {
        const context = renderContext({ showImages });
        const standardView = options.expanded ? result : view;
        assert.deepEqual(renderLines(renderResult(shortened, result, options, context)), [
          "0.0s",
          ...renderLines(renderResult(standard, standardView, options, context)),
        ]);
      }
    }
  });

  it("changes only calls on a view copy without mutating the original result", () => {
    const result = completedResult("1.2", "body");
    result.details!.fullOutputPath = "/tmp/full.txt";
    const before = structuredClone(result);
    result.content.forEach(Object.freeze);
    result.details!.calls.forEach(Object.freeze);
    Object.freeze(result.content);
    Object.freeze(result.details!.calls);
    Object.freeze(result.details);
    Object.freeze(result);
    let received: CodemodeResult | undefined;
    let receivedContext: ToolRenderContext | undefined;
    const observed = withCodemodeResultRenderer({
      ...standard,
      renderResult(view, options, theme, context) {
        received = view;
        receivedContext = context;
        return standard.renderResult!(view, options, theme, context);
      },
    });
    const context = renderContext({ lastComponent: new Container() });
    renderResult(observed, result, collapsed, context);
    assert.notStrictEqual(received, result);
    assert.strictEqual(received!.content, result.content);
    assert.notStrictEqual(received!.details, result.details);
    assert.deepEqual(received!.details, { ...result.details, calls: [] });
    assert.equal(receivedContext!.lastComponent, undefined);
    for (const key of Object.keys(context)) {
      if (key === "lastComponent") continue;
      assert.strictEqual(Reflect.get(receivedContext!, key), Reflect.get(context, key), key);
    }
    renderResult(observed, result, expanded, context);
    assert.strictEqual(received, result);
    assert.deepEqual(result, before);
  });

  it("redraws and switches partial, expanded, error, and empty states without self-containment", () => {
    let previous: Component = new Text("stale", 0, 0);
    const result = completedResult("1.2", "body");
    for (const options of [collapsed, expanded, partial, collapsed, expanded, collapsed]) {
      const context = renderContext({ lastComponent: previous, expanded: options.expanded });
      const next = renderResult(shortened, result, options, context);
      assert.notStrictEqual(next, previous);
      const lines = renderLines(next);
      const expected = renderLines(renderResult(shortened, result, options));
      assert.deepEqual(lines, expected);
      next.invalidate();
      assert.deepEqual(renderLines(next), expected);
      previous = next;
    }
    const errorContext = renderContext({ lastComponent: previous, isError: true });
    previous = renderResult(shortened, result, collapsed, errorContext);
    assert.deepEqual(
      renderLines(previous),
      renderLines(renderResult(standard, result, collapsed, renderContext({ isError: true }))),
    );
    const empty: CodemodeResult = { content: [], details: undefined };
    assert.equal(
      renderLines(
        renderResult(shortened, empty, collapsed, renderContext({ lastComponent: previous })),
      ).join("\n"),
      "",
    );
  });
});

describe("codemode standard execution delegation", () => {
  it("retains executeTool delegation, namespace lookup, store, and model globals without a model request", async () => {
    const entries: { type: string; customType: string; data: unknown }[] = [];
    let namespaceReads = 0;
    const registered: CodemodeDefinition[] = [];
    const api: Partial<ExtensionAPI> = {
      registerTool: (tool) => {
        registered.push(tool as unknown as CodemodeDefinition);
      },
      getAllTools: () => {
        namespaceReads++;
        return [
          {
            name: "fake_tool",
            description: "Safe fake tool",
            parameters: Type.Object({}),
            exposure: "direct",
            sourceInfo: {
              path: "<inline:fake>",
              source: "inline",
              scope: "temporary",
              origin: "top-level",
            },
            namespace: { name: "safe", description: "Safe fake tools" },
          },
        ];
      },
      appendEntry: (customType, data) => {
        entries.push({ type: "custom", customType, data });
      },
    };
    registerCodemode(api as ExtensionAPI);
    const fake = {
      name: "fake_tool",
      label: "Fake",
      description: "Safe fake tool",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "nested body" }],
        details: undefined,
      }),
    };
    const calls: { name: string; args: unknown; signal?: AbortSignal }[] = [];
    let modelReads = 0;
    const context = {
      tools: [fake],
      sessionManager: { getBranch: () => entries },
      modelRegistry: {
        getModelsOfType: () => {
          modelReads++;
          return [];
        },
      },
      executeTool: async (name: string, args: unknown, options: { signal?: AbortSignal }) => {
        calls.push({ name, args, signal: options.signal });
        return {
          toolCall: { id: "script/1", name, arguments: args },
          result: await fake.execute(),
          isError: false,
        };
      },
    } as unknown as ExtensionToolContext;
    const definition = registered[0]!;
    const updates: CodemodeResult[] = [];
    const result = await definition.execute(
      "script",
      {
        code: 'const found = await searchTools("fake", {namespace:"safe"}); text(found.length); text(await tools.fake_tool({})); store("count", 7); text(await models.getModelsOfType("chat"));',
      },
      undefined,
      (update) => updates.push(update),
      context,
    );
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "fake_tool");
    assert.deepEqual(calls[0]!.args, {});
    assert.ok(calls[0]!.signal instanceof AbortSignal);
    assert.ok(namespaceReads > 0);
    assert.equal(modelReads, 1);
    assert.deepEqual(entries, [
      { type: "custom", customType: "codemode-store", data: { set: { count: 7 }, delete: [] } },
    ]);
    assert.equal(result.details!.calls[0]!.id, "script/1");
    assert.equal(result.details!.calls[0]!.status, "ok");
    assert.ok(updates.some((update) => update.details!.calls[0]?.status === "running"));
    assert.ok(updates.some((update) => update.details!.calls[0]?.status === "ok"));
    assert.match(
      result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      /1\nnested body\n\[\]/,
    );
    const restored = await definition.execute(
      "restore",
      { code: 'return load("count");' },
      undefined,
      undefined,
      context,
    );
    assert.equal(restored.content.at(-1)?.type, "text");
    assert.deepEqual(restored.content.at(-1), { type: "text", text: "7" });
    const failed = await definition.execute(
      "failed",
      { code: 'store("count", 9); throw new Error("safe failure");' },
      undefined,
      undefined,
      context,
    );
    assert.equal(failed.isError, true);
    assert.equal(entries.length, 1);
    assert.match(
      failed.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      /Script failed[\s\S]*Script error:[\s\S]*safe failure/,
    );
  });
});
