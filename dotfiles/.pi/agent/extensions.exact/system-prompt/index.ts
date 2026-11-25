import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { buildRuleLines } from "./builder.ts";
import {
  buildRuntimeVariables,
  parseSystemPromptTemplate,
  renderListSection,
  renderTemplate,
  type SystemPromptTemplate,
} from "./template.ts";

/** Canonical template file location in the deployed home. */
const DEFAULT_TEMPLATE_PATH = () => join(homedir(), ".agents", "SYSTEM_PROMPT.yaml");

/** Injection points for tests; production callers omit them. */
export interface SystemPromptExtensionOptions {
  /** Canonical template file lookup. Defaults to the deployed ~/.agents/SYSTEM_PROMPT.yaml. */
  templatePath?: () => string;
}

export default function systemPromptExtension(
  pi: ExtensionAPI,
  { templatePath = DEFAULT_TEMPLATE_PATH }: SystemPromptExtensionOptions = {},
): void {
  let customTemplate: SystemPromptTemplate | undefined;

  pi.on("session_start", (_event, ctx) => {
    customTemplate = loadSystemPromptTemplate(ctx, templatePath());
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (customTemplate === undefined) return;
    const options = event.systemPromptOptions;
    try {
      const { preamble, sections } = renderPromptOptions(customTemplate, options, ctx.model);
      options.customPrompt = preamble;
      options.sections = sections;
    } catch (error) {
      warn(
        ctx,
        `Cannot apply system prompt template: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

interface ListSectionData {
  items: readonly Record<string, string>[];
  /** Skills fields are XML-escaped like Pi's; other sections interpolate raw. */
  escapeItems: boolean;
  /** Pi omits these sections entirely when their list is empty. */
  dropWhenEmpty: boolean;
}

/** Build the runtime items a template list section renders. */
function buildListSectionData(
  name: string,
  options: NormalizedBuildSystemPromptOptions,
  fileReadTool: "read" | "bash" | undefined,
): ListSectionData | undefined {
  switch (name) {
    case "skills":
      // Like Pi's build, skills vanish when no selected tool can read files.
      if (fileReadTool === undefined) return undefined;
      return {
        items: options.skills
          .filter((skill) => !skill.disableModelInvocation)
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
          })),
        escapeItems: true,
        dropWhenEmpty: true,
      };
    case "tools":
      return {
        items: options.selectedTools
          .filter((tool) => !!options.toolSnippets[tool])
          .map((tool) => ({ name: tool, description: options.toolSnippets[tool] ?? "" })),
        escapeItems: false,
        dropWhenEmpty: false,
      };
    case "rules":
      return {
        items: buildRuleLines(
          options.selectedTools,
          options.toolGuidelines,
          options.promptGuidelines,
        ).map((rule) => ({ rule })),
        escapeItems: false,
        dropWhenEmpty: false,
      };
    case "project_context":
      return {
        items: options.contextFiles.map(({ path, content }) => ({ path, content })),
        escapeItems: false,
        dropWhenEmpty: true,
      };
    default:
      return undefined;
  }
}

function renderPromptOptions(
  template: SystemPromptTemplate,
  options: NormalizedBuildSystemPromptOptions,
  model: ExtensionContext["model"],
): { preamble: string; sections: Record<string, string> } {
  const fileReadTool = options.selectedTools.includes("read")
    ? "read"
    : options.selectedTools.includes("bash")
      ? "bash"
      : undefined;
  const variables = {
    ...template.variables,
    ...buildRuntimeVariables({
      codingAgent: "pi",
      fileReadTool,
      model: model?.id,
      provider: model?.provider,
      cwd: options.cwd.replaceAll("\\", "/"),
      readmePath: getReadmePath(),
      docsPath: getDocsPath(),
      examplesPath: getExamplesPath(),
    }),
  };
  const sections = { ...options.sections };
  let preamble = " ";
  for (const [name, definition] of Object.entries(template.sections)) {
    if (name === "agent_instructions") continue;
    if (typeof definition === "string") {
      const body = renderTemplate(definition, variables) || " ";
      if (name === "preamble") preamble = body;
      else sections[name] = body;
      continue;
    }
    const data = buildListSectionData(name, options, fileReadTool);
    if (data === undefined || (data.dropWhenEmpty && data.items.length === 0)) {
      delete sections[name];
      continue;
    }
    sections[name] =
      renderListSection(definition, data.items, variables, { escapeItems: data.escapeItems }) ||
      " ";
  }
  return { preamble, sections };
}

/**
 * Load the canonical template file. A missing file means the feature is off;
 * any parse or schema error ignores the whole file with a warning, keeping
 * the session on Pi's standard build.
 */
function loadSystemPromptTemplate(
  ctx: ExtensionContext,
  path: string,
): SystemPromptTemplate | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseSystemPromptTemplate(raw);
  } catch (error) {
    warn(ctx, `Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function warn(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else console.error(`[system-prompt] ${message}`);
}
