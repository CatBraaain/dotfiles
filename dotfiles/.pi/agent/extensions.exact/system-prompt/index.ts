// Reproduces Pi's default system prompt from wording owned by this extension.
//
// Two request paths cooperate (see builder.ts for the ported builder):
//
// - Non-forced runs: the `context_with_system` handler folds the transcript's
//   structured section patches, builds the sections it knows from the run's
//   `systemPromptOptions`, adopts Pi-built patch text for sections that
//   changed mid-run or that other extensions own, and swaps the assembled
//   text into the leading system message. Nothing is forced, so Pi's own
//   per-turn section deltas and tool updates keep flowing.
//
// - Forced runs (an earlier extension returned `systemPrompt` at
//   `before_agent_start`): the forced text is opaque, so this extension's
//   `before_agent_start` handler replaces the leading standard part with its
//   own built text when the forced text starts with a byte-identical copy of
//   it, keeping any suffix (e.g. the `agents` addendum). On mismatch or when
//   nothing is forced, it returns nothing and leaves the run untouched.
//
// The `before_agent_start` handler must observe a forced prompt set by an
// earlier extension such as `agents`, which requires this extension to load
// after it. See the implementation report for the load-order basis and the
// fallback when the order differs.
//
// On top of Pi's options, a canonical template file (`~/.agents/`
// `SYSTEM_PROMPT.yaml`, see SPEC.md) owns the standard prompt's wording: it
// must define every required section, and each definition (a `{{VAR}}`
// template, or a list section over skills, tools, rules, or project_context
// runtime data) replaces that section's build. Template-owned sections
// always keep their template build (even on mid-run tool changes), and
// template sections the transcript does not carry yet are appended.
//
// Separately from both request paths, every `session_start` shows a
// collapsed indicator below the editor that summarizes the effective
// prompt (size in characters and lines). The full viewer opens only through
// intentional actions — the ctrl+shift+p shortcut, the /system-prompt
// command, or clicking the indicator (fullscreen mode only) — see
// renderer.ts. Both are display-only and leave the prompt, tools, and
// transcript untouched.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { buildRuleLines, buildSystemPromptSections } from "./builder.ts";
import { PROMPT_VIEW_SHORTCUT, setPromptIndicator, showSystemPromptViewer } from "./renderer.ts";
import {
  buildRuntimeVariables,
  parseSystemPromptTemplate,
  renderListSection,
  renderTemplate,
  type SystemPromptTemplate,
} from "./template.ts";

/** Prompt state of the current run, captured at `before_agent_start`. */
interface RunPromptState {
  /** Live reference to the run's shared options; Pi mutates tool fields per request. */
  options: NormalizedBuildSystemPromptOptions;
  /** True when an earlier handler already forced the prompt for this run. */
  forced: boolean;
  /** Canonical template captured for this run; undefined when unused. */
  template?: SystemPromptTemplate;
  /** Model id and provider captured from the run's context; may be unknown. */
  model?: string;
  provider?: string;
}

/** The parts of a run's state the section assembly needs. */
export type TemplateRunState = Pick<RunPromptState, "template" | "model" | "provider">;

let runState: RunPromptState | undefined;

/** Canonical template loaded at `session_start`; undefined when unused. */
let customTemplate: SystemPromptTemplate | undefined;

/** Canonical template file location in the deployed home. */
const TEMPLATE_PATH = join(homedir(), ".agents", "SYSTEM_PROMPT.yaml");

/** Sections this extension builds from the run's structured prompt options. */
const KNOWN_SECTIONS = new Set([
  "preamble",
  "tools",
  "rules",
  "docs",
  "addendum",
  "project_context",
  "skills",
  "cwd",
]);

/**
 * Known sections whose text also depends on the active tool list. When the
 * transcript's tool declarations no longer match the captured options, the
 * structure changed mid-run, so freshness wins and Pi-built patch text
 * is adopted instead of the extension's (possibly stale) build.
 */
const TOOL_DEPENDENT_SECTIONS = new Set(["tools", "rules"]);

/** System-prompt state replayed from every system message in the transcript. */
export interface FoldedSystemState {
  /** Current section texts in first-seen order; deleted sections are gone. */
  readonly sections: ReadonlyMap<string, string>;
  /** Active tool names declared by toolsAdded/toolsRemoved, in replay order. */
  readonly activeToolNames: readonly string[];
}

export default function systemPromptExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    // A new session invalidates the previous run's prompt options.
    runState = undefined;
    // Reload the canonical template so edits land on the next session.
    customTemplate = loadSystemPromptTemplate(ctx);
    // Show the collapsed prompt indicator; the full viewer never opens
    // automatically, only through the triggers registered below.
    setPromptIndicator(ctx);
  });
  pi.registerShortcut(PROMPT_VIEW_SHORTCUT, {
    description: "View the effective system prompt",
    handler: (ctx) => {
      // Fire-and-forget: key handling must not wait for the viewer to close.
      void showSystemPromptViewer(ctx).catch(() => {});
    },
  });
  pi.registerCommand("system-prompt", {
    description: "Show the effective system prompt in a scrollable overlay",
    handler: async (_args, ctx) => {
      // Fire-and-forget: command dispatch must not wait for the viewer to close.
      void showSystemPromptViewer(ctx).catch(() => {});
    },
  });
  pi.on("before_agent_start", onBeforeAgentStart);
  pi.on("context_with_system", onContextWithSystem);
}

function onBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx?: ExtensionContext,
): { systemPrompt: string } | undefined {
  const options = event.systemPromptOptions;
  const forced = options.forceSystemPrompt;
  runState = {
    options,
    forced: forced !== undefined,
    template: customTemplate,
    model: ctx?.model?.id,
    provider: ctx?.model?.provider,
  };
  if (forced === undefined) return undefined;
  const own = buildOwnPrompt({ ...options, forceSystemPrompt: undefined }, runState);
  return forced.startsWith(own) ? { systemPrompt: own + forced.slice(own.length) } : undefined;
}

async function onContextWithSystem(
  event: ContextWithSystemEvent,
): Promise<{ messages: AgentMessage[] } | undefined> {
  const state = runState;
  // Without run state there is no structured input to build from, and in a
  // forced run the request head is replaced by the forced-prompt projection
  // after this handler, so replacing it here would be discarded anyway.
  if (state === undefined || state.forced) return undefined;
  const head = event.messages[0];
  if (head?.role !== "system") return undefined;
  const folded = foldSystemMessages(event.messages);
  const content = assembleHeadContent(
    folded,
    systemContentText(head.content),
    state.options,
    state,
  );
  const messages = event.messages.map((message, index) =>
    index === 0 ? { ...head, content, sections: undefined } : message,
  );
  return { messages };
}

/** Replay every system message into the current section texts and tool set. */
export function foldSystemMessages(messages: readonly AgentMessage[]): FoldedSystemState {
  const sections = new Map<string, string>();
  const activeTools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) activeTools.add(tool.name);
    for (const reference of message.toolsRemoved ?? []) activeTools.delete(reference.name);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return { sections, activeToolNames: [...activeTools] };
}

/**
 * Assemble the leading system message text from the folded sections and this
 * extension's build of the run options. Sections the canonical template owns
 * always keep the template build; sections other extensions own (custom
 * sections, mid-run patches with unknown structure) keep Pi-built text; the
 * remaining known sections keep this extension's build, falling back to
 * Pi-built text when the tool structure changed mid-run.
 */
export function assembleHeadContent(
  folded: FoldedSystemState,
  headContentText: string,
  options: NormalizedBuildSystemPromptOptions,
  run?: TemplateRunState,
): string {
  const own = buildOwnSections(options, run);
  const templateNames = new Set(
    run?.template === undefined ? [] : Object.keys(run.template.sections),
  );
  const toolsUnchanged = sameToolList(folded.activeToolNames, options.selectedTools);
  const parts = [headContentText];
  for (const [name, piText] of folded.sections) {
    if (templateNames.has(name)) {
      // The canonical text is the user's explicit intent, so it wins over
      // both Pi's freshness rule and other extensions' ownership.
      const ownText = own[name];
      parts.push(ownText ?? piText);
      continue;
    }
    if (isOwnedByOtherExtension(name, options) || !KNOWN_SECTIONS.has(name)) {
      parts.push(piText);
      continue;
    }
    const ownText = own[name];
    if (ownText === undefined) {
      parts.push(piText);
      continue;
    }
    const keepOwnBuild = !TOOL_DEPENDENT_SECTIONS.has(name) || toolsUnchanged;
    parts.push(keepOwnBuild ? ownText : piText);
  }
  // Template sections the transcript does not carry yet (new names) append.
  if (run?.template !== undefined) {
    for (const [name, text] of Object.entries(own)) {
      if (templateNames.has(name) && !folded.sections.has(name) && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/** A custom section entry in the run options overrides Pi's own build for that name. */
function isOwnedByOtherExtension(
  name: string,
  options: NormalizedBuildSystemPromptOptions,
): boolean {
  return options.sections[name] !== undefined;
}

/**
 * Runtime items of a template list section, with the per-section render
 * rules that mirror Pi's own build of that section.
 */
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

/**
 * Build the extension's sections from the run options, replacing entries the
 * canonical template owns. String definitions render with the run variables;
 * list definitions render from the run's matching runtime data. A template
 * skills or project_context section drops out when its list is empty, like
 * Pi's build does.
 */
function buildOwnSections(
  options: NormalizedBuildSystemPromptOptions,
  run?: TemplateRunState,
): Record<string, string> {
  const sections = buildSystemPromptSections(options);
  const template = run?.template;
  if (template === undefined) return sections;
  const fileReadTool = options.selectedTools.includes("read")
    ? ("read" as const)
    : options.selectedTools.includes("bash")
      ? ("bash" as const)
      : undefined;
  const variables = buildRuntimeVariables({
    codingAgent: "pi",
    fileReadTool,
    model: run?.model,
    provider: run?.provider,
    cwd: options.cwd !== undefined ? options.cwd.replace(/\\/g, "/") : undefined,
    readmePath: getReadmePath(),
    docsPath: getDocsPath(),
    examplesPath: getExamplesPath(),
  });
  const mergedVariables = { ...template.variables, ...variables };
  for (const [name, definition] of Object.entries(template.sections)) {
    if (typeof definition === "string") {
      const rendered = renderTemplate(definition, mergedVariables);
      sections[name] = name === "preamble" ? rendered : `<${name}>\n${rendered}\n</${name}>`;
      continue;
    }
    const data = buildListSectionData(name, options, fileReadTool);
    if (data === undefined) continue;
    if (data.dropWhenEmpty && data.items.length === 0) {
      delete sections[name];
      continue;
    }
    const rendered = renderListSection(definition, data.items, mergedVariables, {
      escapeItems: data.escapeItems,
    });
    sections[name] = `<${name}>\n${rendered}\n</${name}>`;
  }
  return sections;
}

/** Join the extension's sections the way buildSystemPrompt joins Pi's. */
function buildOwnPrompt(
  options: NormalizedBuildSystemPromptOptions,
  run?: TemplateRunState,
): string {
  const sections = buildOwnSections(options, run);
  return Object.values(sections)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Load the canonical template file. A missing file means the feature is off;
 * any parse or schema error ignores the whole file with a warning, keeping
 * the session on Pi's standard build.
 */
function loadSystemPromptTemplate(ctx: ExtensionContext): SystemPromptTemplate | undefined {
  let raw: string;
  try {
    raw = readFileSync(TEMPLATE_PATH, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseSystemPromptTemplate(raw);
  } catch (error) {
    warn(
      ctx,
      `Ignoring ${TEMPLATE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function warn(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else console.error(`[system-prompt] ${message}`);
}

function sameToolList(active: readonly string[], selected: readonly string[]): boolean {
  return (
    active.length === selected.length && active.every((name, index) => name === selected[index])
  );
}

function systemContentText(content: SystemMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
