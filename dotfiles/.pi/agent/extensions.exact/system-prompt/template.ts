// Template rendering for the canonical SYSTEM_PROMPT.yaml: {{VAR}}
// substitution and each-style list sections. The DSL has no loops or
// conditionals; a list section declares an `each` template and the extension
// applies it to runtime data (v1: skills only). The canonical file contract
// lives in SPEC.md.

import YAML from "yaml";

/** A list section: `pre` + items rendered with `each`, joined, + `post`. */
export interface ListSectionDefinition {
  pre?: string;
  each: string;
  join?: string;
  post?: string;
}

/** A `sections` entry: plain text with variable references, or a list section. */
export type SectionDefinition = string | ListSectionDefinition;

/** Parsed canonical template file. */
export interface SystemPromptTemplate {
  variables: Readonly<Record<string, string>>;
  sections: Readonly<Record<string, SectionDefinition>>;
}

/** Item fields a list section can reference; exposed from Pi's Skill type. */
export interface ListItem {
  name: string;
  description: string;
  filePath: string;
}

export interface RuntimeVariableInput {
  /** Harness rendering the prompt; pi here, dsh for the future dsh plugin. */
  codingAgent: string;
  /** Tool that reads skill files; omitted when no selected tool can. */
  fileReadTool?: "read" | "bash";
  /** Model id captured at run start; omitted when unknown. */
  model?: string;
  /** Provider id captured at run start; omitted when unknown. */
  provider?: string;
}

const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SECTION_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Default skills section: byte-identical to Pi's formatSkillsForPrompt output
 * once trimmed upstream. SKILL_READ_PHRASE absorbs Pi's different sentence
 * wording for read ("the read tool to load") and bash ("bash to load").
 */
export const DEFAULT_SKILLS_LIST: ListSectionDefinition = {
  pre: [
    "The following skills provide specialized instructions for specific tasks.",
    "Use {{SKILL_READ_PHRASE}} a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ].join("\n"),
  each: [
    "  <skill>",
    "    <name>{{name}}</name>",
    "    <description>{{description}}</description>",
    "    <location>{{filePath}}</location>",
    "  </skill>",
  ].join("\n"),
  post: "</available_skills>",
};

const SKILL_READ_PHRASES: Record<"read" | "bash", string> = {
  read: "the read tool to load",
  bash: "bash to load",
};

/** Parse and validate the canonical template file content. */
export function parseSystemPromptTemplate(raw: string): SystemPromptTemplate {
  const parsed: unknown = YAML.parse(raw);
  if (parsed === null || parsed === undefined) return { variables: {}, sections: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("top level must be a mapping of variables and sections");
  }
  const root = parsed as Record<string, unknown>;
  return {
    variables: parseVariables(root.variables),
    sections: parseSections(root.sections),
  };
}

/** Variables every rendered section can reference; runtime wins over file ones. */
export function buildRuntimeVariables(input: RuntimeVariableInput): Record<string, string> {
  const variables: Record<string, string> = { CODING_AGENT: input.codingAgent };
  if (input.fileReadTool !== undefined) {
    variables.FILE_READ_TOOL = input.fileReadTool;
    variables.SKILL_READ_PHRASE = SKILL_READ_PHRASES[input.fileReadTool];
  }
  if (input.model !== undefined) variables.MODEL = input.model;
  if (input.provider !== undefined) variables.PROVIDER = input.provider;
  return variables;
}

/** Substitute {{VAR}} references; an unknown variable is an error. */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  // A fresh literal per call keeps lastIndex state out of shared callers.
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (match, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`Undefined template variable: ${match}`);
    return value;
  });
}

/**
 * Render a list section: pre + each item template (fields XML-escaped),
 * joined, + post. Non-empty parts join with a single newline, matching how
 * Pi joins the fixed lines around the skill list.
 */
export function renderListSection(
  definition: ListSectionDefinition,
  items: readonly ListItem[],
  variables: Readonly<Record<string, string>>,
): string {
  const body = items
    .map((item) => {
      const itemVariables: Record<string, string> = { ...variables };
      for (const [key, value] of Object.entries(item)) itemVariables[key] = escapeXmlValue(value);
      return renderTemplate(definition.each, itemVariables);
    })
    .join(definition.join ?? "\n");
  const parts = [
    definition.pre !== undefined ? renderTemplate(definition.pre, variables) : undefined,
    body,
    definition.post !== undefined ? renderTemplate(definition.post, variables) : undefined,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.join("\n");
}

function parseVariables(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("variables must be a mapping of name to string");
  }
  const variables: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!VARIABLE_NAME_PATTERN.test(name)) throw new Error(`invalid variable name: ${name}`);
    if (typeof entry !== "string") throw new Error(`variable ${name} must be a string`);
    variables[name] = entry;
  }
  return variables;
}

function parseSections(value: unknown): Record<string, SectionDefinition> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sections must be a mapping of name to string or list section");
  }
  const sections: Record<string, SectionDefinition> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!SECTION_NAME_PATTERN.test(name)) throw new Error(`invalid section name: ${name}`);
    sections[name] =
      typeof entry === "string" ? entry : parseListSection(name, entry);
  }
  return sections;
}

function parseListSection(name: string, value: unknown): ListSectionDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`section ${name} must be a string or a mapping with an "each" template`);
  }
  const mapping = value as Record<string, unknown>;
  if (typeof mapping.each !== "string" || mapping.each.length === 0) {
    throw new Error(`section ${name} must define a non-empty "each" template`);
  }
  // v1 renders skills data only; other section names have no runtime data to
  // iterate, so defining them would silently produce wrong output.
  if (name !== "skills") throw new Error(`section ${name}: list sections support "skills" only`);
  for (const key of ["pre", "join", "post"] as const) {
    const entry = mapping[key];
    if (entry !== undefined && typeof entry !== "string") {
      throw new Error(`section ${name}: ${key} must be a string`);
    }
  }
  return {
    ...(mapping.pre !== undefined && { pre: mapping.pre as string }),
    each: mapping.each,
    ...(mapping.join !== undefined && { join: mapping.join as string }),
    ...(mapping.post !== undefined && { post: mapping.post as string }),
  };
}

/** Same escaping Pi applies to skill fields inside the XML block. */
function escapeXmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
