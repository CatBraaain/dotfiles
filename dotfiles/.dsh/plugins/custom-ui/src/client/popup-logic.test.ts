import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  chordPopupTarget,
  modelPopupSpec,
  optionsOf,
  rowId,
  selectionOf,
  type DirectoryLike,
  type DirectoryState,
} from "./popup-logic.ts";

const state: DirectoryState = {
  current: { provider: "zai", model: "glm-5.3", reasoningEffort: "high" },
  groups: [
    {
      id: "zai",
      name: "Z.AI",
      models: [
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          description: "Flagship coding model",
          reasoning: { defaultEffort: "max" },
        },
        { id: "glm-5.2-highspeed", name: "glm-5.2-highspeed" },
      ],
    },
    { id: "openai-codex", name: "OpenAI Codex", models: [{ id: "gpt-5.2", name: "GPT-5.2" }] },
  ],
  failures: [{ id: "broken-provider", name: "Broken", message: "HTTP 500" }],
};

describe("optionsOf", () => {
  it("flattens groups into rows with provider detail", () => {
    assert.deepEqual(optionsOf(state).slice(0, 3), [
      { id: "zai/glm-5.3", label: "GLM-5.3", detail: "Z.AI · Flagship coding model", active: true },
      { id: "zai/glm-5.2-highspeed", label: "glm-5.2-highspeed", detail: "Z.AI" },
      { id: "openai-codex/gpt-5.2", label: "GPT-5.2", detail: "OpenAI Codex" },
    ]);
  });

  it("appends failure rows with the stock load-error copy", () => {
    const rows = optionsOf(state);
    assert.deepEqual(rows.at(-1), {
      id: "failure/broken-provider",
      label: "Broken",
      detail: "Catalog failed to load: HTTP 500",
    });
  });

  it("marks only the current selection active", () => {
    const active = optionsOf(state).filter((row) => row.active);
    assert.deepEqual(
      active.map((row) => row.id),
      ["zai/glm-5.3"],
    );
  });
});

describe("selectionOf", () => {
  it("keeps the current effort when the same model is re-picked", () => {
    assert.deepEqual(selectionOf(state, rowId("zai", "glm-5.3")), {
      provider: "zai",
      model: "glm-5.3",
      reasoningEffort: "high",
    });
  });

  it("uses the model default effort for a different model", () => {
    const withoutCurrent: DirectoryState = { ...state, current: null };
    assert.deepEqual(selectionOf(withoutCurrent, rowId("zai", "glm-5.3")), {
      provider: "zai",
      model: "glm-5.3",
      reasoningEffort: "max",
    });
  });

  it("omits the effort for a model without reasoning metadata", () => {
    assert.deepEqual(selectionOf(state, rowId("openai-codex", "gpt-5.2")), {
      provider: "openai-codex",
      model: "gpt-5.2",
    });
  });

  it("returns undefined for an unknown row", () => {
    assert.equal(selectionOf(state, "failure/broken-provider"), undefined);
  });
});

describe("modelPopupSpec", () => {
  const directory: DirectoryLike = {
    load: async () => state,
    store: { getSnapshot: () => state },
    select: async () => undefined,
  };

  it("resolves the directory lazily from the open-time context, not at spec build", async () => {
    const resolved: string[] = [];
    const spec = modelPopupSpec((sessionId) => {
      resolved.push(sessionId);
      return directory;
    });
    assert.deepEqual(resolved, []);
    await spec.options({ sessionId: "s1" });
    assert.deepEqual(resolved, ["s1"]);
  });

  it("maps the loaded state into rows via options", async () => {
    const spec = modelPopupSpec(() => directory);
    const rows = await spec.options({ sessionId: "s1" });
    assert.equal(rows.length, optionsOf(state).length);
    assert.equal(rows[0]?.id, rowId("zai", "glm-5.3"));
  });

  it("selects the resolved selection for the context's session", async () => {
    const picked: { sessionId: string; provider: string; model: string }[] = [];
    const spec = modelPopupSpec((sessionId) => ({
      ...directory,
      select: async (selection) => {
        picked.push({ sessionId, provider: selection.provider, model: selection.model });
      },
    }));
    await spec.onSelect(optionsOf(state)[0]!, { sessionId: "s1" });
    assert.deepEqual(picked, [{ sessionId: "s1", provider: "zai", model: "glm-5.3" }]);
  });

  it("rejects with the stock failure copy for an unknown row", async () => {
    const spec = modelPopupSpec(() => directory);
    await assert.rejects(
      spec.onSelect(
        { id: "failure/broken-provider", label: "Broken", detail: "" },
        {
          sessionId: "s1",
        },
      ),
      /failed to load/,
    );
  });
});

describe("chordPopupTarget", () => {
  it("returns the current ordinary session", () => {
    assert.equal(
      chordPopupTarget("s1", () => undefined),
      "s1",
    );
  });

  it("returns undefined when no session is current (New Session screen)", () => {
    assert.equal(
      chordPopupTarget(undefined, () => undefined),
      undefined,
    );
  });

  it("returns undefined for an addressed subagent session (same availability as /model)", () => {
    assert.equal(
      chordPopupTarget("s1", (id) => (id === "s1" ? { parent: "p" } : undefined)),
      undefined,
    );
  });
});
