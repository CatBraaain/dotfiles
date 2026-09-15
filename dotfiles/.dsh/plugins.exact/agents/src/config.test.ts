import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { validateAgentsConfig, type ConfigValidation } from "./config.ts";

function sourcePathFromSymlink(symlinkPath: URL): URL {
  const target = readFileSync(symlinkPath, "utf8").trim();
  const deployedPath = new URL(target, symlinkPath);
  return new URL(deployedPath.href.replace("/config/", "/config.exact/"));
}

// Narrow the validation union for assertions below.
function expectConfig(result: ConfigValidation) {
  if ("error" in result) throw new Error(`unexpected config error: ${result.error}`);
  return result.config;
}

function expectError(result: ConfigValidation): string {
  if ("config" in result) throw new Error("expected a config error");
  return result.error;
}

// A minimal valid document shaped like the migrated ~/.pi config.
function validDoc(): Record<string, unknown> {
  return {
    default: "main",
    classes: {
      high: [
        { provider: "p1", model: "m1" },
        { provider: "p2", model: "m2" },
      ],
      low: [{ provider: "p3", model: "m3" }],
      vision: [{ provider: "p4", model: "m4" }],
    },
    agents: {
      main: {
        class: "high",
        tools: ["*"],
        subagents: ["senior", "vision"],
        systemPrompt: ["be main"],
      },
      senior: {
        class: "high",
        tools: ["*", "!handoff_session"],
        subagents: ["junior", "vision"],
        systemPrompt: ["be senior"],
      },
      junior: {
        class: "low",
        tools: ["*"],
        subagents: [],
        systemPrompt: ["be junior"],
      },
      vision: {
        class: "vision",
        tools: ["*"],
        subagents: [],
        systemPrompt: ["be vision"],
      },
    },
  };
}

describe("validateAgentsConfig — acceptance", () => {
  it("accepts a valid document", () => {
    const config = expectConfig(validateAgentsConfig(validDoc()));
    assert.equal(config.default, "main");
    assert.deepEqual(config.classes.high, [
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2" },
    ]);
    assert.equal(config.agents.senior.class, "high");
  });

  it("keeps a `when` string on its candidate and drops it when omitted", () => {
    const doc = validDoc();
    (doc.classes as Record<string, unknown[]>).high = [
      { provider: "p1", model: "m1", when: "true" },
    ];
    const result = expectConfig(validateAgentsConfig(doc));
    assert.deepEqual(result.classes.high, [{ provider: "p1", model: "m1", when: "true" }]);
  });

  it("ignores unknown keys such as legacy tier/_systemPrompts", () => {
    const doc = validDoc();
    doc.tiers = { high: [] };
    doc._when = { zaiOffPeak: "true" };
    doc._systemPrompts = { agentOverview: "x" };
    (doc.agents as Record<string, Record<string, unknown>>).main.tier = "high";
    expectConfig(validateAgentsConfig(doc));
  });

  it("accepts the migrated repository config verbatim", () => {
    // The shared base plus its machine layer must validate as the effective config.
    const basePath = sourcePathFromSymlink(
      new URL("../../../config/agents.yaml.symlink", import.meta.url),
    );
    const base = parseYaml(readFileSync(basePath, "utf8")) as Record<string, unknown>;
    const machinePath = new URL(
      existsSync(new URL("agents.machine.yaml", basePath))
        ? "agents.machine.yaml"
        : "agents.machine.yaml.sample",
      basePath,
    );
    const machine = parseYaml(readFileSync(machinePath, "utf8")) as Record<string, unknown>;
    const config = expectConfig(validateAgentsConfig({ ...base, ...machine }));
    assert.equal(config.default, "main");
    assert.ok(config.agents.vision);
    assert.equal(config.agents.vision.class, "vision");
  });
});

describe("validateAgentsConfig — structure errors", () => {
  it("rejects missing default or agents", () => {
    const noDefault = validDoc() as Record<string, unknown>;
    delete noDefault.default;
    assert.equal(expectError(validateAgentsConfig(noDefault)), "default and agents are required");

    const noAgents = validDoc() as Record<string, unknown>;
    delete noAgents.agents;
    assert.equal(expectError(validateAgentsConfig(noAgents)), "default and agents are required");
  });

  it("rejects missing classes", () => {
    const doc = validDoc();
    delete doc.classes;
    assert.equal(expectError(validateAgentsConfig(doc)), "classes are required");
  });

  it("rejects a non-array class value", () => {
    const doc = validDoc();
    (doc.classes as Record<string, unknown>).high = "m1";
    assert.equal(
      expectError(validateAgentsConfig(doc)),
      "class high must be an array of candidates",
    );
  });

  it("rejects a candidate missing provider/model or with a bad when", () => {
    const doc = validDoc();
    (doc.classes as Record<string, unknown[]>).high = [{ model: "m1" }];
    assert.equal(
      expectError(validateAgentsConfig(doc)),
      "class high candidate needs provider and model strings",
    );

    const whenDoc = validDoc();
    (whenDoc.classes as Record<string, unknown[]>).high = [
      { provider: "p1", model: "m1", when: 3 },
    ];
    assert.equal(
      expectError(validateAgentsConfig(whenDoc)),
      "class high candidate has an invalid when",
    );
  });

  it("rejects a non-object agent definition and bad fields", () => {
    const doc = validDoc();
    (doc.agents as Record<string, unknown>).main = "x";
    assert.equal(expectError(validateAgentsConfig(doc)), "agent main must be an object");

    const toolsDoc = validDoc();
    (toolsDoc.agents as Record<string, Record<string, unknown>>).main.tools = "read";
    assert.equal(expectError(validateAgentsConfig(toolsDoc)), "agent main has invalid tools");

    const promptDoc = validDoc();
    (promptDoc.agents as Record<string, Record<string, unknown>>).main.systemPrompt = [1];
    assert.equal(
      expectError(validateAgentsConfig(promptDoc)),
      "agent main has an invalid systemPrompt",
    );
  });

  it("rejects an agent referencing an undefined class", () => {
    const doc = validDoc();
    (doc.agents as Record<string, Record<string, unknown>>).main.class = "nope";
    assert.equal(
      expectError(validateAgentsConfig(doc)),
      "agent main references undefined class nope",
    );
  });

  it("rejects a default pointing at an undefined agent", () => {
    const doc = validDoc();
    doc.default = "ghost";
    assert.equal(expectError(validateAgentsConfig(doc)), "default agent ghost is not defined");
  });

  it("rejects subagents naming an undefined agent", () => {
    const doc = validDoc();
    (doc.agents as Record<string, Record<string, unknown>>).main.subagents = ["ghost"];
    assert.equal(
      expectError(validateAgentsConfig(doc)),
      "agent main delegates to undefined agent ghost",
    );
  });
});

describe("validateAgentsConfig — vision/tool rules", () => {
  it("rejects a missing vision agent", () => {
    const doc = validDoc();
    (doc.agents as Record<string, Record<string, unknown>>).main.subagents = ["senior"];
    (doc.agents as Record<string, Record<string, unknown>>).senior.subagents = ["junior"];
    delete (doc.agents as Record<string, unknown>).vision;
    assert.equal(expectError(validateAgentsConfig(doc)), "vision agent is required");
  });

  it("rejects a vision agent on another class", () => {
    const doc = validDoc();
    (doc.agents as Record<string, Record<string, unknown>>).vision.class = "low";
    assert.equal(expectError(validateAgentsConfig(doc)), "agent vision must use the vision class");
  });

  it("rejects main/senior without vision and junior with vision", () => {
    const noVisionForMain = validDoc();
    (noVisionForMain.agents as Record<string, Record<string, unknown>>).main.subagents = ["senior"];
    assert.equal(
      expectError(validateAgentsConfig(noVisionForMain)),
      "agent main must delegate to vision",
    );

    const juniorSeesVision = validDoc();
    (juniorSeesVision.agents as Record<string, Record<string, unknown>>).junior.subagents = [
      "vision",
    ];
    assert.equal(
      expectError(validateAgentsConfig(juniorSeesVision)),
      "agent junior must not delegate to vision",
    );
  });

  it("rejects a bare ! negation and allow+deny of the same tool", () => {
    const bare = validDoc();
    (bare.agents as Record<string, Record<string, unknown>>).junior.tools = ["!"];
    assert.equal(expectError(validateAgentsConfig(bare)), 'agent junior has a bare "!" negation');

    const both = validDoc();
    (both.agents as Record<string, Record<string, unknown>>).junior.tools = ["read", "!read"];
    assert.equal(
      expectError(validateAgentsConfig(both)),
      "agent junior both allows and negates tool read",
    );
  });
});
