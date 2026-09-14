// config — parse and validate ~/.dsh/config/agents.yaml (same schema as the
// pi agents extension: `default` / `classes` (ordered candidates with `when`)
// / `agents` (`class` / `tools` / `subagents` / `systemPrompt`)). Pure logic:
// takes the already-parsed YAML document so tests and the glue share one
// validation path without a YAML dependency.

export interface ModelCandidate {
  provider: string;
  model: string;
  when?: string;
}

export interface AgentDefinition {
  class: string;
  tools: readonly string[];
  subagents: readonly string[];
  systemPrompt: readonly string[];
}

export interface AgentsConfig {
  default: string;
  classes: Record<string, readonly ModelCandidate[]>;
  agents: Record<string, AgentDefinition>;
}

export type ConfigValidation = { config: AgentsConfig } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Validate one class's candidate array. Returns the candidates or an error.
function parseCandidates(raw: unknown, className: string): ModelCandidate[] | string {
  if (!Array.isArray(raw)) return `class ${className} must be an array of candidates`;
  const candidates: ModelCandidate[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return `class ${className} candidate must be an object`;
    const { provider, model, when } = entry;
    if (!isNonEmptyString(provider) || !isNonEmptyString(model)) {
      return `class ${className} candidate needs provider and model strings`;
    }
    if (when !== undefined && typeof when !== "string") {
      return `class ${className} candidate has an invalid when`;
    }
    candidates.push(when === undefined ? { provider, model } : { provider, model, when });
  }
  return candidates;
}

// Validate the whole agents.yaml document. Unknown top-level and per-agent
// keys (e.g. legacy `tier`, template `_systemPrompts`) are ignored, mirroring
// the pi extension, so the same file can serve both harnesses.
export function validateAgentsConfig(doc: unknown): ConfigValidation {
  if (!isRecord(doc) || !isNonEmptyString(doc.default) || !isRecord(doc.agents)) {
    return { error: "default and agents are required" };
  }
  if (!isRecord(doc.classes)) return { error: "classes are required" };

  const classes: Record<string, readonly ModelCandidate[]> = {};
  for (const [className, rawCandidates] of Object.entries(doc.classes)) {
    const candidates = parseCandidates(rawCandidates, className);
    if (typeof candidates === "string") return { error: candidates };
    classes[className] = candidates;
  }

  const agents: Record<string, AgentDefinition> = {};
  for (const [name, rawDefinition] of Object.entries(doc.agents)) {
    if (!isRecord(rawDefinition)) return { error: `agent ${name} must be an object` };
    const { class: className, tools, subagents, systemPrompt } = rawDefinition;
    if (!isNonEmptyString(className)) return { error: `agent ${name} has an invalid class` };
    if (!(className in classes)) {
      return { error: `agent ${name} references undefined class ${className}` };
    }
    if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
      return { error: `agent ${name} has invalid tools` };
    }
    if (!Array.isArray(subagents) || !subagents.every((agent) => typeof agent === "string")) {
      return { error: `agent ${name} has invalid subagents` };
    }
    if (
      !Array.isArray(systemPrompt) ||
      !systemPrompt.every((prompt) => typeof prompt === "string")
    ) {
      return { error: `agent ${name} has an invalid systemPrompt` };
    }
    agents[name] = { class: className, tools, subagents, systemPrompt };
  }

  if (!agents[doc.default]) {
    return { error: `default agent ${doc.default} is not defined` };
  }
  for (const [name, definition] of Object.entries(agents)) {
    const unknownSubagent = definition.subagents.find((agent) => !agents[agent]);
    if (unknownSubagent) {
      return { error: `agent ${name} delegates to undefined agent ${unknownSubagent}` };
    }
  }

  const visionAgent = agents.vision;
  if (!visionAgent) return { error: "vision agent is required" };
  if (visionAgent.class !== "vision") {
    return { error: "agent vision must use the vision class" };
  }
  for (const [name, definition] of Object.entries(agents)) {
    for (const entry of definition.tools) {
      if (!entry.startsWith("!")) continue;
      const negatedTool = entry.slice(1);
      if (negatedTool === "") {
        return { error: `agent ${name} has a bare "!" negation` };
      }
      if (negatedTool !== "*" && definition.tools.includes(negatedTool)) {
        return { error: `agent ${name} both allows and negates tool ${negatedTool}` };
      }
    }
    if (name === "main" || name === "senior") {
      if (!definition.subagents.includes("vision")) {
        return { error: `agent ${name} must delegate to vision` };
      }
    }
    if (name === "junior" && definition.subagents.includes("vision")) {
      return { error: "agent junior must not delegate to vision" };
    }
  }

  return { config: { default: doc.default, classes, agents } };
}
