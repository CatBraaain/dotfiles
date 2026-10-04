// Template rendering for the canonical SYSTEM_PROMPT.yaml: {{VAR}}
// substitution and each-style list sections. The DSL has no loops or
// conditionals; a list section declares an `each` template and the extension
// applies it to runtime data (skills, tools, rules, project_context). The
// canonical file must define every required section; the contract lives in
// SPEC.md.

import YAML from "yaml";

/**
 * A list section: `pre` + items rendered with `each` + `post`, all joined
 * with `join`. `empty` replaces the item body when the list is empty.
 */
export interface ListSectionDefinition {
  pre?: string;
  each: string;
  join?: string;
  post?: string;
  empty?: string;
}

/** A `sections` entry: plain text with variable references, or a list section. */
export type SectionDefinition = string | ListSectionDefinition;

/** Parsed canonical template file. */
export interface SystemPromptTemplate {
  variables: Readonly<Record<string, string>>;
  sections: Readonly<Record<string, SectionDefinition>>;
}

/** One runtime item of a list section: fields the `each` template can reference. */
export type ListItem = Record<string, string>;

export interface RuntimeVariableInput {
  /** Harness rendering the prompt; pi here, dsh for the future dsh plugin. */
  codingAgent: string;
  /** Tool that reads skill files; omitted when no selected tool can. */
  fileReadTool?: "read" | "bash";
  /** Model id captured at run start; omitted when unknown. */
  model?: string;
  /** Provider id captured at run start; omitted when unknown. */
  provider?: string;
  /** Run working directory, backslashes normalized; omitted when unknown. */
  cwd?: string;
  /** Installed pi's readme/docs/examples paths; omitted when unknown. */
  readmePath?: string;
  docsPath?: string;
  examplesPath?: string;
}

const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SECTION_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Section names a list definition may own; other names have no runtime data. */
export const LIST_SECTION_NAMES = new Set(["tools", "rules", "project_context", "skills"]);

/** Sections the canonical file must define; a missing one invalidates the file. */
export const REQUIRED_SECTION_NAMES = [
  "preamble",
  "tools",
  "rules",
  "docs",
  "skills",
  "cwd",
  "project_context",
] as const;

/**
 * Default skills section: byte-identical to Pi's formatSkillsForPrompt output
 * once trimmed upstream. SKILL_READ_PHRASE absorbs Pi's different sentence
 * wording for read ("the read tool to load") and bash ("bash to load"). It
 * mirrors the canonical file's skills section and item fields are rendered
 * XML-escaped (renderListSection escapes by default).
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
  // An empty document defines nothing, which strict mode treats like any
  // other missing-section file: ignored with a warning.
  const root: unknown = parsed === null || parsed === undefined ? {} : parsed;
  if (typeof root !== "object" || Array.isArray(root)) {
    throw new Error("top level must be a mapping of variables and sections");
  }
  const mapping = root as Record<string, unknown>;
  const template = {
    variables: parseVariables(mapping.variables),
    sections: parseSections(mapping.sections),
  };
  for (const name of REQUIRED_SECTION_NAMES) {
    if (!(name in template.sections)) throw new Error(`missing required section: ${name}`);
  }
  return template;
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
  if (input.cwd !== undefined) variables.CWD = input.cwd;
  if (input.readmePath !== undefined) variables.README_PATH = input.readmePath;
  if (input.docsPath !== undefined) variables.DOCS_PATH = input.docsPath;
  if (input.examplesPath !== undefined) variables.EXAMPLES_PATH = input.examplesPath;
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

export interface RenderListOptions {
  /** XML-escape item fields; on by default, matching the skills section. */
  escapeItems?: boolean;
}

/**
 * Render a list section: pre + each item template + post, plus `empty` as
 * the body when there are no items. `join` separates both the rendered
 * items and the pre/body/post parts. Item fields are XML-escaped unless
 * `escapeItems: false`; raw sections interpolate Pi's unescaped data.
 */
export function renderListSection(
  definition: ListSectionDefinition,
  items: readonly ListItem[],
  variables: Readonly<Record<string, string>>,
  options: RenderListOptions = {},
): string {
  const join = definition.join ?? "\n";
  const body =
    items.length > 0
      ? items
          .map((item) => {
            const itemVariables: Record<string, string> = { ...variables };
            const escape = options.escapeItems ?? true;
            for (const [key, value] of Object.entries(item)) {
              itemVariables[key] = escape ? escapeXmlValue(value) : value;
            }
            return renderTemplate(definition.each, itemVariables);
          })
          .join(join)
      : renderTemplate(definition.empty ?? "", variables);
  const parts = [
    definition.pre !== undefined ? renderTemplate(definition.pre, variables) : undefined,
    body,
    definition.post !== undefined ? renderTemplate(definition.post, variables) : undefined,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.join(join);
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
    sections[name] = typeof entry === "string" ? entry : parseListSection(name, entry);
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
  // Only sections with runtime data can be list sections; a list definition
  // on any other name would silently produce wrong output.
  if (!LIST_SECTION_NAMES.has(name)) {
    throw new Error(
      `section ${name}: list sections support skills, tools, rules, and project_context only`,
    );
  }
  for (const key of ["pre", "join", "post", "empty"] as const) {
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
    ...(mapping.empty !== undefined && { empty: mapping.empty as string }),
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
