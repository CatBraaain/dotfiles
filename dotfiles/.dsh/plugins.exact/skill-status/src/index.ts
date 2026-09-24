/**
 * dotfiles-dsh-skill-status — host half.
 *
 * Registers the `skillStatus` session projection, folded purely from the
 * stock `tool/call` / `tool/result` session events: a `skill` call pairs with
 * its result by callId, and each skill's first successful completion adds its
 * name in log order. The plugin appends no session events of its own — the
 * persistence layer refuses to interpret logs carrying event types outside
 * its generated vocabulary unless they carry the `ignorable` marker, which
 * `Session.append` does not expose (see SPEC.md) — so the projection folds
 * only event types every harness build knows.
 *
 * The projection is the client's window-independent read model: the framework
 * folds `init` over the whole in-memory log and drives every committed event
 * through `apply`, so the published names cover events outside the client's
 * paged event window (see SPEC.md).
 *
 * `build.run.sh` bundles this entry: relative imports are inlined and only
 * the script's explicit bare-specifier externals stay external (see
 * dotfiles/.dsh/README.md). Shared literals live in `src/shared.ts`.
 */
import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-session-projection/types";
import type {} from "@deepseek-ai/dsh-session";
import { SKILL_STATUS_PROJECTION_KEY } from "./shared";

export const name = "dsh-skill-status";
export const inject = ["sessionProjections"];

export { SKILL_STATUS_PROJECTION_KEY } from "./shared";

/** Host fold state: used names in first-use order, plus in-flight skill calls. */
export interface SkillStatusProjectionState {
  /** The used skill names, in first-use order. */
  readonly names: readonly string[];
  /** `skill` calls seen without their result yet, as `[callId, name]` pairs. */
  readonly pending: readonly (readonly [string, string])[];
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    skillStatus: SkillStatusProjectionState;
  }
}

/** The dsh tool that loads a skill by name. */
export const SKILL_TOOL_NAME = "skill";

/** Structural subset of a `tool/call` session event payload. */
export interface SkillToolCallData {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** Structural subset of a `tool/result` session event payload. */
export interface ToolResultData {
  readonly message: {
    readonly content: readonly { readonly isError?: boolean }[];
    readonly source: { readonly callId: string };
  };
  readonly error?: { readonly name: string; readonly code: string };
}

/** The name of the skill requested by one `skill` tool call, if parseable. */
export function skillNameFromCallArguments(argsRaw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsRaw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const name = (parsed as { readonly name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function isSkillToolCall(data: unknown): data is SkillToolCallData {
  if (typeof data !== "object" || data === null) return false;
  const call = data as Partial<SkillToolCallData>;
  return (
    call.name === SKILL_TOOL_NAME &&
    typeof call.callId === "string" &&
    typeof call.arguments === "string"
  );
}

function isToolResult(data: unknown): data is ToolResultData {
  if (typeof data !== "object" || data === null) return false;
  const result = data as Partial<ToolResultData>;
  const message = result.message as Partial<ToolResultData["message"]> | undefined;
  return typeof message?.source?.callId === "string" && Array.isArray(message?.content);
}

/** A tool result is successful when it carries no failure identity or error block. */
export function isSuccessfulToolResult(data: ToolResultData): boolean {
  if (data.error !== undefined) return false;
  return data.message.content[0]?.isError !== true;
}

/**
 * Fold the skill usage display state from the stock tool events. Unrelated
 * events and malformed payloads return the same state reference, and a name
 * already recorded is a no-op — the drive keys all downstream work on that.
 */
export const skillStatusProjectionDefinition = {
  key: SKILL_STATUS_PROJECTION_KEY,
  stateVersion: 2,
  stateSchema: z.object({
    names: z.array(z.string()),
    pending: z.array(z.tuple([z.string(), z.string()])),
  }),
  init: (_header, _inheritedEventCount): SkillStatusProjectionState => ({
    names: [],
    pending: [],
  }),
  apply: (state, event) => {
    if (event.type === "tool/call") {
      const call = event.data as unknown;
      if (!isSkillToolCall(call)) return state;
      const name = skillNameFromCallArguments(call.arguments);
      if (name === undefined) return state;
      if (state.pending.some(([callId]) => callId === call.callId)) return state;
      return { names: state.names, pending: [...state.pending, [call.callId, name]] };
    }
    if (event.type === "tool/result") {
      const result = event.data as unknown;
      if (!isToolResult(result)) return state;
      const callId = result.message.source.callId;
      const entry = state.pending.find(([pendingCallId]) => pendingCallId === callId);
      if (entry === undefined) return state;
      const name = entry[1];
      const pending = state.pending.filter(([pendingCallId]) => pendingCallId !== callId);
      if (!isSuccessfulToolResult(result) || state.names.includes(name)) {
        return { names: state.names, pending };
      }
      return { names: [...state.names, name], pending };
    }
    return state;
  },
  wire: {
    viewSchema: z.array(z.string()),
    view: (state) => state.names,
  },
} satisfies ProjectionDefinition<"skillStatus", SkillStatusProjectionState>;

/** Register the projection; the host half has no other runtime behavior. */
export function apply(ctx: Context): void {
  // Explicit type arguments: the registry's generic inference does not
  // recover `key` through its `Omit`-wrapped parameter type.
  ctx.sessionProjections.register<"skillStatus", SkillStatusProjectionState>(
    skillStatusProjectionDefinition,
  );
}
