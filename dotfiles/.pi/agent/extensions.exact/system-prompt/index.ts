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
// Separately from both request paths, every `session_start` shows a
// collapsed indicator above the editor that summarizes the effective
// prompt (size in characters and lines). The full viewer opens only through
// intentional actions — the ctrl+shift+p shortcut, the /system-prompt
// command, or clicking the indicator (fullscreen mode only) — see
// renderer.ts. Both are display-only and leave the prompt, tools, and
// transcript untouched.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ContextWithSystemEvent,
  ExtensionAPI,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt, buildSystemPromptSections } from "./builder.ts";
import { PROMPT_VIEW_SHORTCUT, setPromptIndicator, showSystemPromptViewer } from "./renderer.ts";

/** Prompt state of the current run, captured at `before_agent_start`. */
interface RunPromptState {
  /** Live reference to the run's shared options; Pi mutates tool fields per request. */
  options: NormalizedBuildSystemPromptOptions;
  /** True when an earlier handler already forced the prompt for this run. */
  forced: boolean;
}

let runState: RunPromptState | undefined;

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

function onBeforeAgentStart(event: BeforeAgentStartEvent): { systemPrompt: string } | undefined {
  const options = event.systemPromptOptions;
  const forced = options.forceSystemPrompt;
  runState = { options, forced: forced !== undefined };
  if (forced === undefined) return undefined;
  const own = buildSystemPrompt({ ...options, forceSystemPrompt: undefined });
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
  const content = assembleHeadContent(folded, systemContentText(head.content), state.options);
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
 * extension's build of the run options. Sections other extensions own
 * (custom sections, mid-run patches with unknown structure) keep Pi-built
 * text; known sections keep this extension's build.
 */
export function assembleHeadContent(
  folded: FoldedSystemState,
  headContentText: string,
  options: NormalizedBuildSystemPromptOptions,
): string {
  const own = buildSystemPromptSections(options);
  const toolsUnchanged = sameToolList(folded.activeToolNames, options.selectedTools);
  const parts = [headContentText];
  for (const [name, piText] of folded.sections) {
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
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/** A custom section entry in the run options overrides Pi's own build for that name. */
function isOwnedByOtherExtension(
  name: string,
  options: NormalizedBuildSystemPromptOptions,
): boolean {
  return options.sections[name] !== undefined;
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
