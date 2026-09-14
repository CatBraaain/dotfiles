// dotfiles-dsh-agents — host-side port of the pi agents extension.
//
// Reads ~/.dsh/config/agents.yaml (same schema as pi's agents.yaml), then per
// live root agent: applies the persona system-prompt section and tool
// restrictions, routes model requests through class candidate lists (`when`
// guards evaluated via the shell contract), falls back to the next candidate
// on 429/QUOTA failures with cooldowns, exposes a pi-compatible `subagent`
// tool backed by the in-process one-shot subagent seam, and delegates image
// reads from image-incapable routes to a vision-class one-shot child.
//
// Glue only: pure logic lives in config.ts / routing.ts / tool-allowlist.ts /
// subagent-slots.ts (unit-tested there). Types come from the global
// @deepseek-ai/* install via tsconfig paths; the runtime resolves them from
// the profile closure (the build bundles the relative imports and keeps
// package imports external).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
// Type-only imports also pull in the `declare module '@deepseek-ai/cordis'`
// service/event augmentations (commands, subagents, fs, shell, attachments,
// model/selection session events).
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type { CmdlineArgs } from "@deepseek-ai/dsh-cmdline";
import type { AttachmentStore, ImageMediaType } from "@deepseek-ai/dsh-attachment";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import type { ShellExecutor } from "@deepseek-ai/dsh-shell";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-subagent";
// Type-only imports also pull in the `declare module '@deepseek-ai/cordis'`
// augmentation that puts the host `ctx.connection` registries on Context.
import type {
  ConnectionFetchRoute,
  HostConnectionHandle,
} from "@deepseek-ai/dsh-client-connection";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { parse as parseYaml } from "yaml";
import { validateAgentsConfig, type AgentDefinition, type AgentsConfig } from "./config.ts";
import {
  DEFAULT_COOLDOWN_MS,
  WHEN_TIMEOUT_MS,
  cooldownMs,
  createPredictionCache,
  isCoolingDown,
  isRateLimitFailure,
  modelKey,
  pickCandidate,
  recordCooldown,
} from "./routing.ts";
import { translateTools, type ToolFilter } from "./tool-allowlist.ts";
import { SubagentSlots } from "./subagent-slots.ts";
import { sessionNameFor, settleChildRun } from "./child-run.ts";
import {
  AGENTS_SELECT_PATH,
  AGENTS_STATE_PATH,
  buildStatePayload,
  isDisplayedAgent,
  isRootSessionHeader,
  mergePendingSelection,
  parseSelectRequest,
  parseStateRequest,
  resolveStartSelection,
  type AgentStatePayload,
  type IdleDisplay,
  type PendingSelection,
  type SelectOutcome,
} from "./state-rpc.ts";

export const name = "dsh-agents";
// `connection` backs the browser display: the exact /api route below needs
// ctx.get("connection").fetch.register, and the host-runner sandbox only
// exposes services listed in `inject`.
// `sessionQuery` feeds the idle-session fallback below: dsh resumes an agent
// lazily, so the display must answer for sessions with no live agent yet.
export const inject = ["commands", "tools", "llm", "systemPrompt", "subagents", "connection", "sessionQuery"];

/** Prompt-section order: after the deployment persona suffix (10200). */
const PERSONA_SECTION_ORDER = 10250;
/**
 * Global tool names hidden from every managed agent: the stock delegation
 * tools are replaced by this plugin's pi-compatible `subagent` tool (which
 * stays visible only to agents whose `subagents` list is non-empty).
 */
const STOCK_SUBAGENT_TOOLS = [
  "subagent",
  "subagent_fork",
  "send_message",
  "interrupt_agent",
  "list_agents",
];
/** Image extensions the delegation shadow accepts (declared media type). */
const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

interface AgentState {
  agentName: string;
  effectiveClass: string;
  cooldowns: Map<string, number>;
  /** Bumped whenever a cooldown is recorded so cached display predictions
   *  (keyed on it) re-evaluate immediately after a 429 fallback. */
  cooldownEpoch: number;
  manualSelect: boolean;
  slots: SubagentSlots;
  /** Route resolved by the most recent `agent/request` (cooldown key source). */
  lastRoute: { provider: string; model: string } | undefined;
  /** Persona/restrict/subagent-tool registration swapped by `/agent`. */
  appliedDisposers: Array<() => void>;
  /** read_image shadow kept while the active route cannot take images. */
  imageShadow: (() => void) | undefined;
}

export function apply(ctx: Context) {
  const logger = ctx.logger("dsh-agents");

  // ---- configuration -------------------------------------------------------
  const configPath = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "config", "agents.yaml");
  // Load and validate agents.yaml. Returns the config, or the failure reason.
  const loadConfig = (): AgentsConfig | string => {
    try {
      const validation = validateAgentsConfig(parseYaml(readFileSync(configPath, "utf8")));
      if ("error" in validation) return validation.error;
      return validation.config;
    } catch (error) {
      return String(error);
    }
  };
  let config: AgentsConfig;
  const loaded = loadConfig();
  if (typeof loaded === "string") {
    logger.error(`agents config ${configPath} is invalid; dsh-agents stays inert: ${loaded}`);
    return;
  }
  config = loaded;

  // ---- initial agent / class from the command line -------------------------
  const flags = readInitialFlags(ctx);
  let initialAgent = config.default;
  if (flags.agent !== undefined) {
    if (config.agents[flags.agent]) initialAgent = flags.agent;
    else logger.warn(`--agent ${flags.agent} is not a defined agent; ignored`);
  }
  let initialClass = config.agents[initialAgent].class;
  if (flags.class !== undefined) {
    if (flags.class in config.classes) initialClass = flags.class;
    else logger.warn(`--class ${flags.class} is not a defined class; ignored`);
  }

  // ---- per-agent state ------------------------------------------------------
  const states = new Map<Agent, AgentState>();

  const knownToolNames = (): Set<string> =>
    new Set(ctx.tools.schemas().map((schema) => schema.name));

  const shell = (): ShellExecutor | undefined => ctx.get?.("shell") as ShellExecutor | undefined;
  const fs = (): FileSystem | undefined => ctx.get?.("fs") as FileSystem | undefined;
  const attachments = (): AttachmentStore | undefined =>
    ctx.get?.("attachments") as AttachmentStore | undefined;

  const evalWhen = async (when: string | undefined, signal?: AbortSignal): Promise<boolean> => {
    if (!when || when.trim() === "") return true;
    const executor = shell();
    if (!executor) {
      logger.warn("shell contract unavailable; skipping `when` candidate");
      return false;
    }
    try {
      const result = await executor.run(
        executor.resolve({ command: when, timeoutMs: WHEN_TIMEOUT_MS, signal }),
      );
      return result.exitCode === 0 && !result.timedOut;
    } catch {
      return false;
    }
  };

  const modelExists = async (candidate: { provider: string; model: string }): Promise<boolean> => {
    try {
      await ctx.llm.resolveModelInfo(candidate.provider, candidate.model);
      return true;
    } catch {
      return false;
    }
  };

  const pickForClass = (state: AgentState, signal?: AbortSignal) =>
    pickCandidate(
      config.classes[state.effectiveClass] ?? [],
      state.cooldowns,
      modelExists,
      (when) => evalWhen(when, signal),
      Date.now(),
    );

  // ---- display prediction (the browser poll's auto model) -----------------
  // The auto display shows the model the next request would resolve to: the
  // first valid candidate of the effective class under the same rules as
  // routing. Predictions re-run `when` commands and registry lookups, so they
  // are cached per session/class/cooldown generation for a short window; the
  // poll therefore stays cheap in steady state while a switch, a /reload, or
  // a 429 fallback (new class or epoch in the key) is reflected immediately.
  const predictionCache = createPredictionCache(10_000);
  const predictDisplayModel = (
    cacheKey: string,
    className: string,
    cooldowns: Map<string, number>,
    cooldownEpoch: number,
  ): Promise<string | undefined> =>
    predictionCache.read(`${cacheKey}|${className}|${cooldownEpoch}`, () =>
      pickCandidate(
        config.classes[className] ?? [],
        cooldowns,
        modelExists,
        (when) => evalWhen(when),
        Date.now(),
      ).then((picked) => picked?.model),
    );

  // Idle-session picks (see the select route below): one entry per root
  // session, consumed when the session's first live agent is created.
  const pendingSelections = new Map<string, PendingSelection>();

  // What an idle root session displays: its pending pick (or the process
  // initial agent/class) plus the model its first turn would resolve to.
  const idleDisplayFor = async (sessionId: string): Promise<IdleDisplay> => {
    const start = resolveStartSelection(
      pendingSelections.get(sessionId),
      config,
      initialAgent,
      initialClass,
    );
    const model = await predictDisplayModel(`idle:${start.className}`, start.className, new Map(), 0);
    return {
      agent: start.agentName,
      className: start.className,
      ...(model !== undefined ? { model } : {}),
    };
  };

  // One tool filter for both `tools.restrict` (root agents) and `toolFilter`
  // (one-shot children): translate the pi list, hide the stock delegation
  // tools, and keep the plugin's `subagent` visible for delegating agents.
  // Returns the skipped (unknown) names for logging.
  const toolFilterFor = (
    definition: AgentDefinition,
  ): { filter: ToolFilter | undefined; skipped: readonly string[] } => {
    const known = knownToolNames();
    const { filter, skipped } = translateTools(definition.tools, known);
    // An empty allow mask must survive: `[]` means "no global tools", not
    // unrestricted. Only `"*"` yields no allow mask.
    const allow = filter?.allow !== undefined ? new Set(filter.allow) : undefined;
    const deny = new Set(filter?.deny);
    for (const tool of STOCK_SUBAGENT_TOOLS) {
      if (known.has(tool)) deny.add(tool);
    }
    // The plugin's own `subagent` tool is registered in each delegating
    // agent's own layer, which restrictions never filter — no allow entry.
    if (allow === undefined && deny.size === 0) return { filter: undefined, skipped };
    return {
      filter: {
        ...(allow !== undefined ? { allow: [...allow] } : {}),
        ...(deny.size > 0 ? { deny: [...deny] } : {}),
      },
      skipped,
    };
  };

  // ---- one-shot subagent spawning (pi-compatible `subagent` tool) -----------
  const settleRunText = async (
    run: Awaited<ReturnType<typeof ctx.subagents.start>>,
    childName: string,
  ): Promise<string> => {
    const settled = settleChildRun(await run.result, childName);
    if (!settled.ok) throw new Error(settled.message);
    return settled.text;
  };

  const spawnSubagent = async (
    parent: Agent,
    childName: string,
    task: string,
    signal: AbortSignal,
    extraPrompt: ContentBlock[] = [],
  ): Promise<string> => {
    const definition = config.agents[childName];
    if (!definition) throw new Error(`undefined agent ${childName}`);
    // Resolve the child's default class here; its own 429s then fall back
    // through the child state registered below (pi: the child session runs
    // the same routing rules).
    const picked = await pickCandidate(
      config.classes[definition.class] ?? [],
      new Map<string, number>(),
      modelExists,
      (when) => evalWhen(when, signal),
      Date.now(),
    );
    if (!picked) {
      throw new Error(`no available model for agent ${childName}: class ${definition.class}`);
    }
    const { filter } = toolFilterFor(definition);
    const run = await ctx.subagents.start("spawn", {
      label: sessionNameFor(childName, task),
      prompt: [{ type: "text", text: task }, ...extraPrompt],
      parent,
      signal,
      agentOptions: { provider: picked.provider, model: picked.model },
      persona:
        definition.systemPrompt.length > 0 ? definition.systemPrompt.join("\n\n") : undefined,
      toolFilter: filter,
    });
    const child = run.localAgent;
    if (child) {
      states.set(child, {
        agentName: childName,
        effectiveClass: definition.class,
        cooldowns: new Map<string, number>(),
        cooldownEpoch: 0,
        manualSelect: false,
        slots: new SubagentSlots(),
        lastRoute: undefined,
        appliedDisposers: [],
        imageShadow: undefined,
      });
    }
    try {
      return await settleRunText(run, childName);
    } finally {
      if (child) states.delete(child);
      await run.dispose();
    }
  };

  const registerSubagentTool = (agent: Agent, state: AgentState): (() => void) => {
    const definition = config.agents[state.agentName];
    return agent.ctx.tools.register(
      defineTool({
        name: "subagent",
        description:
          "Spawn a one-shot subagent and return its final report. The agent name must be one of the agents you may delegate to.",
        parameters: {
          task: {
            type: "string",
            required: true,
            description:
              "Task for the subagent. Include purpose, inputs, scope, and completion criteria.",
          },
          agent: {
            type: "string",
            required: true,
            enum: [...definition.subagents],
            description: "Subagent to delegate to.",
          },
          cwd: {
            type: "string",
            description:
              "Accepted for pi compatibility; the child always starts in the parent cwd.",
          },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args, exec) {
          if (!exec.agent) throw new Error("subagent requires a calling agent");
          if (args.cwd) {
            logger.warn(
              "subagent `cwd` is ignored (SubagentStartRequest has no cwd); using the parent cwd",
            );
          }
          if (!definition.subagents.includes(args.agent)) {
            throw new Error(`agent ${state.agentName} cannot delegate to ${args.agent}`);
          }
          const release = await state.slots.acquire(exec.signal);
          try {
            return await spawnSubagent(exec.agent, args.agent, args.task, exec.signal);
          } finally {
            release();
          }
        },
      }),
    );
  };

  // ---- vision delegation (read_image shadow) --------------------------------
  const delegateImageRead = async (
    agent: Agent,
    state: AgentState,
    filePath: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const parentDefinition = config.agents[state.agentName];
    if (!parentDefinition.subagents.includes("vision")) {
      throw new Error(
        `cannot read "${filePath}": agent ${state.agentName} cannot delegate to vision`,
      );
    }
    const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[extension];
    if (!mediaType) {
      throw new Error(
        `cannot read "${filePath}": not a recognized image extension (png/jpg/jpeg/webp/gif)`,
      );
    }
    const fsService = fs();
    const attachmentStore = attachments();
    if (!fsService || !attachmentStore) {
      throw new Error(
        `cannot read "${filePath}" as an image: filesystem or attachment service is unavailable`,
      );
    }
    const target = await fsService.resolve(filePath, { signal });
    const data = await fsService.readBytes(
      target,
      signal,
      attachmentStore.imageLimits.maxImageBytes,
    );
    const ref = await attachmentStore.saveImage({
      data,
      mediaType,
      name: basename(target.displayPath),
    });
    return spawnSubagent(
      agent,
      "vision",
      `Read the attached image (originally at ${target.displayPath}). Describe what you observe and report your conclusion as text for the calling agent.`,
      signal,
      [{ type: "image", attachment: ref }],
    );
  };

  const ensureImageShadow = (agent: Agent, state: AgentState): void => {
    if (state.imageShadow) return;
    if (!knownToolNames().has("read_image")) return;
    state.imageShadow = agent.ctx.tools.register(
      defineTool({
        name: "read_image",
        description:
          "Read a PNG/JPEG/WebP/GIF file. The current model route cannot take images, so the image is delegated to a vision-capable subagent and this tool returns its textual report.",
        parameters: {
          file_path: { type: "string", required: true, description: "Path to the image file." },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args, exec) {
          if (!exec.agent) throw new Error("read_image requires a calling agent");
          return delegateImageRead(exec.agent, state, args.file_path, exec.signal);
        },
      }),
    );
  };

  const removeImageShadow = (state: AgentState): void => {
    state.imageShadow?.();
    state.imageShadow = undefined;
  };

  // ---- applying one agent definition to a live agent ------------------------
  const applyDefinition = (agent: Agent, state: AgentState, agentName: string): boolean => {
    for (const dispose of state.appliedDisposers) dispose();
    state.appliedDisposers = [];
    removeImageShadow(state);
    const definition = config.agents[agentName];
    if (!definition) return false;
    state.agentName = agentName;
    state.manualSelect = false;

    if (definition.systemPrompt.length > 0) {
      state.appliedDisposers.push(
        agent.ctx.systemPrompt.section({
          name: `dsh-agents:persona:${agentName}`,
          order: PERSONA_SECTION_ORDER,
          text: definition.systemPrompt.join("\n\n"),
        }),
      );
    }
    const { filter, skipped } = toolFilterFor(definition);
    if (skipped.length > 0) {
      logger.warn(
        `agent ${agentName}: tools unknown to the registry ignored: ${skipped.join(", ")}`,
      );
    }
    if (filter) state.appliedDisposers.push(agent.ctx.tools.restrict(filter));
    if (definition.subagents.length > 0) {
      state.appliedDisposers.push(registerSubagentTool(agent, state));
    }
    return true;
  };

  ctx.on("agent/created", ({ agent }) => {
    // Root agents adopt the initial agent, overridden by an idle-session
    // pick recorded before the session's first turn; one-shot children are
    // registered by spawnSubagent (their sessions carry origin: 'subagent').
    if (agent.session.header.origin === "subagent") return;
    if (states.has(agent)) return;
    const pending = pendingSelections.get(agent.session.id);
    pendingSelections.delete(agent.session.id);
    const start = resolveStartSelection(pending, config, initialAgent, initialClass);
    const state: AgentState = {
      agentName: start.agentName,
      effectiveClass: start.className,
      cooldowns: new Map<string, number>(),
      cooldownEpoch: 0,
      manualSelect: false,
      slots: new SubagentSlots(),
      lastRoute: undefined,
      appliedDisposers: [],
      imageShadow: undefined,
    };
    states.set(agent, state);
    applyDefinition(agent, state, start.agentName);
    // Manual /model selections suspend auto routing (pi "manual" state) until
    // the next `/agent` or `/class` switch clears the flag.
    agent.ctx.on("session/event", (_session, event) => {
      if (event.type === "model/selection") state.manualSelect = true;
    });
    agent.ctx.on("agent/disposed", () => states.delete(agent));
  });

  // ---- routing --------------------------------------------------------------
  ctx.on("agent/request", async (payload, next) => {
    const state = states.get(payload.agent);
    if (!state) return next();
    const base = await next();
    const now = Date.now();
    // Remember the route each attempt actually uses: `agent/request` runs per
    // attempt, so this is the route a following `agent/request-error` must
    // cool down.
    const remember = (route: { provider: string; model: string }) => {
      state.lastRoute = { provider: route.provider, model: route.model };
      return route;
    };
    // Manual selection keeps its route unless that route is cooling down.
    if (state.manualSelect && !isCoolingDown(modelKey(base), state.cooldowns, now)) {
      return remember(base);
    }
    const picked = await pickForClass(state, payload.signal);
    if (!picked) {
      logger.warn(`no available model for agent ${state.agentName}: class ${state.effectiveClass}`);
      return remember(base);
    }
    if (picked.provider !== base.provider || picked.model !== base.model) {
      logger.info(`agent model → ${picked.provider}/${picked.model}`);
    }
    // Keep the shadow read_image in sync with the resolved route's image
    // capability (absent inputModalities counts as incapable).
    const resolved = await ctx.llm
      .resolveModelInfo(picked.provider, picked.model)
      .catch(() => undefined);
    if (resolved?.inputModalities?.includes("image") ?? false) removeImageShadow(state);
    else ensureImageShadow(payload.agent, state);
    return remember({ ...base, provider: picked.provider, model: picked.model });
  });

  ctx.on("agent/request-error", async (payload, next) => {
    const state = states.get(payload.agent);
    if (!state) return next();
    if (!isRateLimitFailure(payload.failure)) return next();
    // The failed route is the one this attempt resolved (see `remember` in
    // the request handler); fall back to the request header only when the
    // plugin did not route the attempt.
    const failed = state.lastRoute ?? {
      provider: payload.provider,
      model:
        payload.agent.session.requestHeader()?.config.model ?? payload.agent.options.model ?? "",
    };
    const failedKey = modelKey(failed);
    recordCooldown(
      state.cooldowns,
      failedKey,
      cooldownMs(payload.failure) || DEFAULT_COOLDOWN_MS,
      Date.now(),
    );
    // Cached display predictions must not keep showing the cooled-down model.
    state.cooldownEpoch++;
    // Pre-evaluate the next live candidate: retry only when a fallback exists
    // (pi parity — otherwise the failure stays terminal).
    const picked = await pickForClass(state, payload.signal);
    if (!picked) {
      logger.error(
        `rate limited on ${failedKey}; no fallback available: ${payload.failure.message} (resend the message to retry)`,
      );
      return next();
    }
    logger.warn(`rate limited on ${failedKey}; switched to ${modelKey(picked)}`);
    return { kind: "retry" };
  });

  // ---- commands --------------------------------------------------------------
  // dsh command names match /^[a-z][a-z0-9_-]*$/ so pi's `/agent:<name>`
  // syntax is unreachable; use `/agent <name>` instead.
  const availableAgents = () => Object.keys(config.agents).join(", ");
  const availableClasses = () => Object.keys(config.classes).join(", ");
  const asCommandResult = (outcome: SelectOutcome) =>
    outcome.ok
      ? { kind: "success" as const, text: outcome.text }
      : { kind: "error" as const, text: outcome.text };

  // Shared apply path for `/agent <name>` and the selector menu's select
  // route: one switch point so both take effect identically (class reset,
  // manual-pick release, tool/persona swap).
  const applyAgentSelection = (agent: Agent, state: AgentState, name: string): SelectOutcome => {
    if (!config.agents[name]) {
      return { ok: false, text: `unknown agent: ${name} (available: ${availableAgents()})` };
    }
    state.effectiveClass = config.agents[name].class;
    applyDefinition(agent, state, name);
    return { ok: true, text: `agent → ${name} (class ${state.effectiveClass})` };
  };

  // Shared apply path for `/class <name>` and the selector menu's select
  // route (see applyAgentSelection).
  const applyClassSelection = (state: AgentState, name: string): SelectOutcome => {
    if (!(name in config.classes)) {
      return { ok: false, text: `unknown class: ${name} (available: ${availableClasses()})` };
    }
    state.effectiveClass = name;
    state.manualSelect = false;
    return { ok: true, text: `class → ${name}` };
  };

  const agentCommand: CommandDefinition = {
    name: "agent",
    description: "Switch the active agents.yaml agent (pi: /agent:<name>)",
    input: { hint: "<name> [message]" },
    handler({ agent, rawInput }) {
      const state = states.get(agent);
      if (!state) return { kind: "error", text: "dsh-agents does not manage this agent" };
      const [name, ...rest] = rawInput.trim().split(/\s+/);
      if (!name) {
        return {
          kind: "error",
          text: `unknown agent: (none) (available: ${availableAgents()})`,
        };
      }
      const outcome = applyAgentSelection(agent, state, name);
      const message = rest.join(" ").trim();
      if (outcome.ok && message) {
        agent.followup(
          createUserMessage({
            content: [{ type: "text", text: message }],
            source: { kind: "user" },
          }),
        );
      }
      return asCommandResult(outcome);
    },
  };

  const classCommand: CommandDefinition = {
    name: "class",
    description: "Switch the effective model class",
    input: { hint: "[name]" },
    handler({ agent, rawInput }) {
      const state = states.get(agent);
      if (!state) return { kind: "error", text: "dsh-agents does not manage this agent" };
      const name = rawInput.trim();
      if (!name) {
        return {
          kind: "success",
          text: `classes: ${availableClasses()} (current: ${state.effectiveClass})`,
        };
      }
      return asCommandResult(applyClassSelection(state, name));
    },
  };

  // pi /reload equivalent: re-read agents.yaml and re-apply definitions,
  // keeping per-agent state (manual selection, effective class, cooldowns).
  // Live agents or classes missing from the new config fall back to the
  // initial agent / the agent's default class. A failed load keeps the
  // current config.
  const reloadCommand: CommandDefinition = {
    name: "reload",
    description: "Reload agents.yaml and re-apply agent definitions",
    handler({ agent }) {
      const state = states.get(agent);
      if (!state) return { kind: "error", text: "dsh-agents does not manage this agent" };
      const reloaded = loadConfig();
      if (typeof reloaded === "string") {
        logger.error(`agents config reload failed; keeping the current config: ${reloaded}`);
        return { kind: "error", text: `reload failed: ${reloaded}` };
      }
      config = reloaded;
      for (const [managed, managedState] of states) {
        const wasManual = managedState.manualSelect;
        if (!config.agents[managedState.agentName]) {
          const fallback = config.agents[initialAgent] ? initialAgent : config.default;
          managedState.agentName = fallback;
          managedState.effectiveClass = config.agents[fallback].class;
        } else if (!config.classes[managedState.effectiveClass]) {
          managedState.effectiveClass = config.agents[managedState.agentName].class;
        }
        applyDefinition(managed, managedState, managedState.agentName);
        managedState.manualSelect = wasManual;
      }
      return { kind: "success", text: "agents config reloaded" };
    },
  };

  ctx.effect(function* () {
    yield ctx.commands.register(agentCommand);
    yield ctx.commands.register(classCommand);
    yield ctx.commands.register(reloadCommand);
  }, "dsh-agents commands");

  // ---- client state route (the browser display polls the agent/class) ------
  const connection = ctx.get?.("connection") as HostConnectionHandle | undefined;
  if (!connection) {
    logger.warn("connection contract unavailable; the browser agent/class display stays empty");
    return;
  }
  // Idle sessions have no live agent, so the display falls back to the durable
  // top-level session set with the initial agent/class. Small TTL cache: the
  // browser polls every 2 s and the corpus listing is a persistence read; a
  // newly created session invalidates via session/created.
  let rootIdsCache: { ids: ReadonlySet<string>; loadedAtMs: number } | undefined;
  const ROOT_IDS_CACHE_TTL_MS = 10_000;
  ctx.on("session/created", () => {
    rootIdsCache = undefined;
  });
  const rootSessionIds = async (): Promise<ReadonlySet<string>> => {
    if (rootIdsCache && Date.now() - rootIdsCache.loadedAtMs < ROOT_IDS_CACHE_TTL_MS) {
      return rootIdsCache.ids;
    }
    try {
      const sessionQuery = ctx.get("sessionQuery") as SessionQueryEngine;
      const records = await sessionQuery.listSessions();
      rootIdsCache = {
        ids: new Set(
          records
            .filter((record) => isRootSessionHeader(record.header))
            .map((record) => record.header.id),
        ),
        loadedAtMs: Date.now(),
      };
    } catch {
      // Unreadable corpus: keep the last known set (empty before the first
      // success); the next poll retries.
    }
    return rootIdsCache?.ids ?? new Set();
  };
  // spawnSubagent transiently registers one-shot children in `states` for
  // routing; the display RPC must still answer as if only roots existed.
  const stateForSession = async (sessionId: string | undefined): Promise<AgentStatePayload> => {
    const rootIds = await rootSessionIds();
    // Auto display shows the predicted next-request model (see the note above
    // predictDisplayModel); manual keeps its resolved route.
    const entries = await Promise.all(
      [...states]
        .filter(([managedAgent]) => isDisplayedAgent(managedAgent))
        .map(async ([managedAgent, state]) => {
          const model = state.manualSelect
            ? state.lastRoute?.model
            : await predictDisplayModel(
                managedAgent.session.id,
                state.effectiveClass,
                state.cooldowns,
                state.cooldownEpoch,
              );
          return {
            sessionId: managedAgent.session.id,
            agentName: state.agentName,
            effectiveClass: state.effectiveClass,
            manualSelect: state.manualSelect,
            ...(model !== undefined ? { model } : {}),
          };
        }),
    );
    // An idle root session displays its pending (or initial) selection; skip
    // the idle prediction when a live entry already answers for the session.
    const idle =
      sessionId !== undefined &&
      rootIds.has(sessionId) &&
      !entries.some((candidate) => candidate.sessionId === sessionId)
        ? await idleDisplayFor(sessionId)
        : undefined;
    return buildStatePayload(
      entries,
      rootIds,
      { agents: Object.keys(config.agents), classes: Object.keys(config.classes) },
      sessionId,
      idle,
    );
  };
  // Exact Fetch routes on the /api channel. dsh rc.2 gives the shared-channel
  // RPC interceptor to the stock typert gateway, so plugins must not call
  // `connection.rpc.intercept` themselves; an exact route keeps the same
  // trust + browser-auth fence and answers before the gateway's 404 fallback.
  const stateRoute: ConnectionFetchRoute = {
    path: AGENTS_STATE_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const payload: unknown = await request.json().catch(() => undefined);
      const requestState = parseStateRequest(payload);
      if (!requestState) {
        return Response.json({ error: "payload must be { sessionId?: string }" }, { status: 400 });
      }
      return Response.json(await stateForSession(requestState.sessionId));
    },
  };
  // Selection write path for the selector menus: resolves the session's live
  // root agent, then applies the pick through the same switch points as
  // `/agent <name>` / `/class <name>`. A root session with no live agent yet
  // (dsh creates it lazily on first use) records the pick as pending: the
  // display switches immediately and the selection applies when the session's
  // first turn creates its agent. Child sessions stay rejected politely.
  const selectRoute: ConnectionFetchRoute = {
    path: AGENTS_SELECT_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const payload: unknown = await request.json().catch(() => undefined);
      const selection = parseSelectRequest(payload);
      if (!selection) {
        return Response.json(
          { error: "payload must be { sessionId?: string, kind: 'agent' | 'class', name: string }" },
          { status: 400 },
        );
      }
      const found = [...states].find(
        ([managedAgent]) =>
          isDisplayedAgent(managedAgent) && managedAgent.session.id === selection.sessionId,
      );
      if (!found) {
        // A root session with no live agent yet records the pick as pending;
        // unknown names fail with the same error as the live path. Child
        // sessions are not selectable.
        const id = selection.sessionId;
        if (id !== undefined && (await rootSessionIds()).has(id)) {
          if (selection.kind === "agent" && !config.agents[selection.name]) {
            return Response.json({
              ok: false,
              text: `unknown agent: ${selection.name} (available: ${availableAgents()})`,
            });
          }
          if (selection.kind === "class" && !(selection.name in config.classes)) {
            return Response.json({
              ok: false,
              text: `unknown class: ${selection.name} (available: ${availableClasses()})`,
            });
          }
          pendingSelections.set(
            id,
            mergePendingSelection(pendingSelections.get(id), selection.kind, selection.name),
          );
          return Response.json({
            ok: true,
            text: `${selection.kind} → ${selection.name} (applies when the session starts)`,
          });
        }
        return Response.json({
          ok: false,
          text: "dsh-agents does not manage this session (no live agent)",
        });
      }
      const [managedAgent, managedState] = found;
      const outcome =
        selection.kind === "agent"
          ? applyAgentSelection(managedAgent, managedState, selection.name)
          : applyClassSelection(managedState, selection.name);
      return Response.json(outcome);
    },
  };
  ctx.effect(function* () {
    yield connection.fetch.register(stateRoute);
    yield connection.fetch.register(selectRoute);
  }, "dsh-agents state rpc");
}

// Read `--agent <name>` / `--class <name>` (space or `=` separated) from the
// launcher's raw inner arguments. Undefined values are the caller's business
// (warned and ignored in apply).
function readInitialFlags(ctx: Context): { agent?: string; class?: string } {
  const args = (ctx.get?.("cmdlineArgs") as CmdlineArgs | undefined)?.get() ?? [];
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(`--${flag}`);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    const prefix = args.find((arg) => arg.startsWith(`--${flag}=`));
    return prefix?.slice(prefix.indexOf("=") + 1);
  };
  return { agent: value("agent"), class: value("class") };
}
