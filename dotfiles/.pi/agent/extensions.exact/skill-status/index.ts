import {
  parseSkillBlock,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const SKILL_STATUS_WIDGET_KEY = "skill-status";
const SKILL_STATUS_ENTRY_TYPE = "skill-status";

export interface SkillStatusState {
  readonly firedSkillNames: string[];
  readonly skillNamesByPath: Map<string, string>;
  readonly pendingSkillReadToolCallIds: Set<string>;
  pendingExplicitSkillName: string | undefined;
}

export function createSkillStatusState(): SkillStatusState {
  return {
    firedSkillNames: [],
    skillNamesByPath: new Map(),
    pendingSkillReadToolCallIds: new Set(),
    pendingExplicitSkillName: undefined,
  };
}

export function buildSkillStatusWidgetLines(
  firedSkillNames: readonly string[],
): string[] | undefined {
  if (firedSkillNames.length === 0) return undefined;
  return [`🎯 skills: ${firedSkillNames.join(", ")}`];
}

export function markSkillFired(state: SkillStatusState, skillName: string): boolean {
  if (state.firedSkillNames.includes(skillName)) return false;
  state.firedSkillNames.push(skillName);
  return true;
}

function persistFiredSkills(pi: ExtensionAPI, state: SkillStatusState): void {
  pi.appendEntry(SKILL_STATUS_ENTRY_TYPE, { firedSkillNames: [...state.firedSkillNames] });
}

function restoreFiredSkills(ctx: ExtensionContext, state: SkillStatusState): void {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SKILL_STATUS_ENTRY_TYPE) continue;
    const firedSkillNames = (entry.data as { firedSkillNames?: unknown } | undefined)
      ?.firedSkillNames;
    if (!Array.isArray(firedSkillNames)) return;
    state.firedSkillNames.push(
      ...firedSkillNames.filter((name): name is string => typeof name === "string"),
    );
    return;
  }
}

function normalizedPath(filePath: string, cwd: string): string {
  const expandedPath =
    filePath === "~" || filePath.startsWith("~/") ? `${homedir()}${filePath.slice(1)}` : filePath;
  return resolve(isAbsolute(expandedPath) ? expandedPath : cwd, expandedPath);
}

export function registerSkillPaths(
  state: SkillStatusState,
  skills: ReadonlyArray<{ name: string; filePath: string }>,
  cwd: string,
): void {
  state.skillNamesByPath.clear();
  for (const skill of skills) {
    state.skillNamesByPath.set(normalizedPath(skill.filePath, cwd), skill.name);
  }
}

export function skillNameForReadPath(
  state: SkillStatusState,
  filePath: string,
  cwd: string,
): string | undefined {
  return state.skillNamesByPath.get(normalizedPath(filePath, cwd));
}

function explicitSkillName(
  text: string,
  commands: ReadonlyArray<{ name: string; source: string }>,
): string | undefined {
  const match = text.match(/^\/(?:skill:)?([^\s/]+)(?:\s[\s\S]*)?$/);
  if (!match) return undefined;

  const skillName = match[1] as string;
  const hasHigherPriorityCommand = commands.some(
    (command) =>
      (command.source === "extension" || command.source === "prompt") && command.name === skillName,
  );
  const hasSkillCommand = commands.some(
    (command) => command.source === "skill" && command.name === `skill:${skillName}`,
  );
  return hasSkillCommand && !hasHigherPriorityCommand ? skillName : undefined;
}

function updateWidget(ctx: ExtensionContext, state: SkillStatusState): void {
  if (!ctx.hasUI) return;
  const lines = buildSkillStatusWidgetLines(state.firedSkillNames);
  ctx.ui.setWidget(
    SKILL_STATUS_WIDGET_KEY,
    lines
      ? (_ui, theme) => ({
          render: (width) => lines.map((line) => truncateToWidth(theme.fg("dim", line), width)),
          invalidate: () => {},
        })
      : undefined,
    { placement: "aboveEditor" },
  );
}

export default function skillStatusExtension(pi: ExtensionAPI): void {
  const state = createSkillStatusState();

  pi.on("session_start", (event, ctx) => {
    state.firedSkillNames.length = 0;
    state.skillNamesByPath.clear();
    state.pendingSkillReadToolCallIds.clear();
    state.pendingExplicitSkillName = undefined;
    if (event.reason === "startup" || event.reason === "reload") {
      restoreFiredSkills(ctx, state);
    }
    updateWidget(ctx, state);
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") {
      state.pendingExplicitSkillName = explicitSkillName(event.text, pi.getCommands());
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    registerSkillPaths(state, event.systemPromptOptions.skills ?? [], ctx.cwd);
    const parsedSkill = parseSkillBlock(event.prompt);
    if (parsedSkill && state.pendingExplicitSkillName === parsedSkill.name) {
      if (markSkillFired(state, parsedSkill.name)) persistFiredSkills(pi, state);
    }
    state.pendingExplicitSkillName = undefined;
    updateWidget(ctx, state);
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read") return;
    const filePath = event.input.path;
    if (typeof filePath !== "string") return;
    if (skillNameForReadPath(state, filePath, ctx.cwd)) {
      state.pendingSkillReadToolCallIds.add(event.toolCallId);
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "read") return;
    const wasSkillRead = state.pendingSkillReadToolCallIds.delete(event.toolCallId);
    if (!wasSkillRead || event.isError) return;
    const filePath = event.input.path;
    if (typeof filePath !== "string") return;
    const skillName = skillNameForReadPath(state, filePath, ctx.cwd);
    if (!skillName) return;
    if (markSkillFired(state, skillName)) persistFiredSkills(pi, state);
    updateWidget(ctx, state);
  });
}
