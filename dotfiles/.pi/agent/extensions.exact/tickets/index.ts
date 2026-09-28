// pi extension registering five ticket tools that wrap the `ticket` CLI
// (the dotfiles/.agents/cli/ticket project, deployed to ~/.agents/cli/ticket
// and spawned as `bun <dir>` so bun resolves package.json's main field).
// Behavior spec: dotfiles/.agents/cli/ticket-tools.spec.md (tools) and
// dotfiles/.agents/cli/ticket.spec.md (CLI / store).

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

// --- tool parameter schemas (argument names match ticket-tools.spec.md) ---

const SELECTOR_DESCRIPTION =
  'Ticket selector: a ticket ID, a prefix unique to one ticket, or "next" for the ' +
  'oldest actionable ticket. Omitted means "next".';

export const ticketListParameters = Type.Object({
  status: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter to tickets whose status is any of these values (draft/open/blocked/locked/closed/cancelled).",
    }),
  ),
  project: Type.Optional(
    Type.String({
      description:
        "Ticket store (project) to list. Defaults to the project resolved from the session cwd.",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description: "List tickets across all projects, prefixing each line with the project name.",
    }),
  ),
});

export const ticketShowParameters = Type.Object({
  selector: Type.Optional(
    Type.String({
      description: SELECTOR_DESCRIPTION,
    }),
  ),
  project: Type.Optional(
    Type.String({
      description:
        "Ticket store (project) to look in. Defaults to the project resolved from the session cwd.",
    }),
  ),
});

export const ticketCreateParameters = Type.Object({
  title: Type.String({
    description: "Ticket title. Becomes the ticket H1.",
  }),
  body: Type.Optional(
    Type.String({
      description: "Optional body text placed right after the H1.",
    }),
  ),
  status: Type.Optional(
    Type.String({
      description:
        "Initial status (draft/open/blocked/locked/closed/cancelled). Defaults to open, or blocked when after is set without a status.",
    }),
  ),
  after: Type.Optional(
    Type.String({
      description:
        "ID of the ticket this ticket waits on (resolved within the same project; unique prefixes allowed). " +
        "Must exist and must not be closed or cancelled.",
    }),
  ),
  project: Type.Optional(
    Type.String({
      description:
        "Ticket store (project) to create the ticket in. Defaults to the project resolved from the session cwd.",
    }),
  ),
});

export const ticketSetParameters = Type.Object({
  selector: Type.Optional(
    Type.String({
      description: SELECTOR_DESCRIPTION,
    }),
  ),
  status: Type.Optional(
    Type.String({
      description: "New status (draft/open/blocked/locked/closed/cancelled).",
    }),
  ),
  after: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Ticket this one waits on (string, resolved within the same project), or null to clear. " +
        "Setting an unresolved after blocks the ticket; clearing it reopens a blocked ticket. " +
        "Ignored by the linkage when status is also given.",
    }),
  ),
  project: Type.Optional(
    Type.String({
      description:
        "Ticket store (project) to update in. Defaults to the project resolved from the session cwd.",
    }),
  ),
});

export const ticketEditParameters = Type.Object({
  selector: Type.Optional(
    Type.String({
      description: SELECTOR_DESCRIPTION,
    }),
  ),
  old: Type.String({
    minLength: 1,
    description:
      "Text to replace. Must appear exactly once in the body (the frontmatter is excluded, the H1 is included). Call ticket_show first and copy old exactly, including line breaks.",
  }),
  new: Type.String({
    description: "Replacement text. An empty string deletes the matched text.",
  }),
  project: Type.Optional(
    Type.String({
      description:
        "Ticket store (project) to update in. Defaults to the project resolved from the session cwd.",
    }),
  ),
});

export type TicketListParams = Static<typeof ticketListParameters>;
export type TicketShowParams = Static<typeof ticketShowParameters>;
export type TicketCreateParams = Static<typeof ticketCreateParameters>;
export type TicketSetParams = Static<typeof ticketSetParameters>;
export type TicketEditParams = Static<typeof ticketEditParameters>;

// --- tool args -> CLI args (SPEC: ticket-tools.spec.md, per-tool sections) ---

function projectFlag(project: string | undefined): string[] {
  return project === undefined ? [] : ["--project", project];
}

export function buildListArgs(params: TicketListParams): string[] {
  const args = ["list"];
  if (params.all) args.push("--all");
  if (params.status && params.status.length > 0) args.push("--status", params.status.join(","));
  return [...args, ...projectFlag(params.project)];
}

export function buildShowArgs(params: TicketShowParams): string[] {
  return [
    "show",
    ...(params.selector !== undefined ? [params.selector] : []),
    ...projectFlag(params.project),
  ];
}

// The CLI takes a single JSON object argument; only the given keys are sent.
export function buildCreateArgs(params: TicketCreateParams): string[] {
  const payload: Record<string, unknown> = { title: params.title };
  if (params.status !== undefined) payload.status = params.status;
  if (params.after !== undefined) payload.after = params.after;
  if (params.body !== undefined) payload.body = params.body;
  return ["create", JSON.stringify(payload), ...projectFlag(params.project)];
}

// Throws when there is nothing to set (SPEC: no CLI run without status or after).
export function buildSetArgs(params: TicketSetParams): string[] {
  if (params.status === undefined && params.after === undefined) {
    throw new Error("ticket_set: nothing to set — pass status and/or after");
  }
  const payload: Record<string, unknown> = {};
  if (params.status !== undefined) payload.status = params.status;
  if (params.after !== undefined) payload.after = params.after;
  const selector = params.selector !== undefined ? [params.selector] : [];
  return ["set", ...selector, JSON.stringify(payload), ...projectFlag(params.project)];
}

export function buildEditArgs(params: TicketEditParams): string[] {
  if (params.old === "") throw new Error("ticket_edit: old must be a non-empty string");
  const selector = params.selector !== undefined ? [params.selector] : [];
  return ["edit", ...projectFlag(params.project), ...selector, "--", params.old, params.new];
}

// --- tool descriptions / prompt snippets (SPEC: 共通の振る舞い + per-tool notes) ---

export const ticketToolDescriptions = {
  ticket_list:
    "List tickets in a ticket store via the `ticket list` CLI subcommand. " +
    "Returns one ticket per line as id, status, and title; without status this lists open tickets only. " +
    "status filters tickets by the given statuses; all=true lists every project and prefixes each line with the project name; " +
    "project selects the ticket store (defaults to the project resolved from the session cwd). " +
    "Ticket IDs are unique by prefix, so a prefix returned here can be passed as a selector to the other ticket tools.",
  ticket_show:
    "Show one ticket via the `ticket show` CLI subcommand. " +
    "Returns id, status, after, title, and body. " +
    'selector is a ticket ID, a prefix unique to one ticket, or "next" for the oldest actionable ticket (open with its after resolved); omitted means "next". ' +
    "project selects the ticket store (defaults to the project resolved from the session cwd).",
  ticket_create:
    "Create a ticket via the `ticket create` CLI subcommand and return the created id, status, after, and path. " +
    "title becomes the ticket H1; body is optional text placed after the H1; " +
    "status defaults to open (draft/open/blocked/locked/closed/cancelled); " +
    "after lists the single ticket ID this ticket waits on (same project, unique prefix allowed) and makes it blocked unless a status is given. " +
    "project selects the ticket store (defaults to the project resolved from the session cwd). " +
    "The CLI validates the fields, so creation can fail with the CLI's error text.",
  ticket_set:
    "Update a ticket's frontmatter via the `ticket set` CLI subcommand and return the updated id, status, after, and path. " +
    'Only status and/or after can be set; selector is a ticket ID, a unique prefix, or "next" (default). ' +
    "The linkage auto-switches the status unless an explicit status is given: setting an unresolved after blocks the ticket, " +
    "clearing after (null) reopens a blocked ticket. Setting status to closed releases dependent blocked tickets back to open. " +
    "The CLI validates the update: after must exist and must not be closed or cancelled, and cycles fail without rewriting. " +
    "project selects the ticket store (defaults to the project resolved from the session cwd).",
  ticket_edit:
    "Edit a ticket's body via the `ticket edit` CLI subcommand and return the updated id, status, after, and path. " +
    "Call ticket_show first and copy old exactly from its body, including line breaks. " +
    "Replaces the single occurrence of old with new (empty new deletes it); the H1 is part of the body, so it can be replaced. " +
    "Zero or multiple occurrences of old fail without rewriting. " +
    'selector is a ticket ID, a unique prefix, or "next" (default); project selects the ticket store ' +
    "and defaults to the project resolved from the session cwd.",
} as const;

function truncateTicketOutput(text: string, recoveryHint: string): { text: string; truncated: boolean } {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return { text, truncated: false };

  let content = truncation.content;
  for (let attempt = 0; attempt < 3; attempt++) {
    const marker = `[Output truncated: ${content.split("\n").length} of ${truncation.totalLines} lines (${formatSize(Buffer.byteLength(content, "utf8"))} of ${formatSize(truncation.totalBytes)}). ${recoveryHint}]`;
    const suffix = content === "" ? marker : `\n\n${marker}`;
    const result = `${content}${suffix}`;
    if (
      Buffer.byteLength(result, "utf8") <= DEFAULT_MAX_BYTES &&
      result.split("\n").length <= DEFAULT_MAX_LINES
    ) {
      return { text: result, truncated: true };
    }

    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const suffixLines = content === "" ? 1 : 2;
    content = truncateHead(text, {
      maxBytes: Math.max(0, DEFAULT_MAX_BYTES - suffixBytes),
      maxLines: Math.max(0, DEFAULT_MAX_LINES - suffixLines),
    }).content;
  }

  return {
    text: `[Output truncated: ${truncation.totalLines} lines (${formatSize(truncation.totalBytes)}). ${recoveryHint}]`,
    truncated: true,
  };
}

export const ticketToolPromptSnippets = {
  ticket_list: "List tickets in the project ticket store",
  ticket_show: "Show one ticket's details",
  ticket_create: "Create a new ticket",
  ticket_set: "Update a ticket's status or after",
  ticket_edit: "Edit a ticket's body text",
} as const;

// --- CLI spawn (SPEC: ticket-tools.spec.md common behavior) ---

export type TicketCliRunner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;

// The CLI project directory; bun resolves its package.json main field, so
// spawning needs no exec bit and only `bun` on PATH (same pattern as the
// web-search extension).
function ticketCliDir(): string {
  return join(homedir(), ".agents", "cli", "ticket");
}

// Injectable overrides so the real-spawn tests run a stub project dir without
// depending on the caller's HOME.
export interface SpawnTicketCliDeps {
  /** Overrides the CLI project dir; defaults to ticketCliDir(). */
  cliDir?: string;
  /** Replaces node:child_process.execFile; defaults to the real one. */
  exec?: typeof execFile;
}

// Adds --json before the option terminator so the terminator's positional
// arguments stay literal (SPEC: the -- rule in ticket.spec.md).
export function appendJsonFlag(args: string[]): string[] {
  const terminator = args.indexOf("--");
  if (terminator === -1) return [...args, "--json"];
  return [...args.slice(0, terminator), "--json", ...args.slice(terminator)];
}

// Spawns the ticket CLI and resolves its stdout text. Non-zero exits and
// spawn failures reject with the CLI's stderr text (or a spawn-failure
// message when stderr is empty).
export function spawnTicketCli(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  deps: SpawnTicketCliDeps = {},
): Promise<string> {
  const spawn = deps.exec ?? execFile;
  return new Promise((resolve, reject) => {
    spawn(
      "bun",
      [deps.cliDir ?? ticketCliDir(), ...args],
      { cwd, signal, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = typeof stderr === "string" ? stderr.replace(/\n$/, "") : "";
          if (typeof error.code === "number") {
            reject(new Error(stderrText || `ticket exited with code ${error.code}`));
          } else {
            reject(new Error(`ticket CLI is not available: ${error.message}`));
          }
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// --- extension ---

export interface TicketsExtensionDeps {
  /** Replaces the CLI runner; defaults to `bun ~/.agents/cli/ticket`. */
  runCli?: TicketCliRunner;
}

export default function ticketsExtension(pi: ExtensionAPI, deps: TicketsExtensionDeps = {}): void {
  const runCli: TicketCliRunner =
    deps.runCli ?? ((args, cwd, signal) => spawnTicketCli(args, cwd, signal));

  // Runs the CLI for the tool args; the resolved stdout is the tool text.
  async function runTicket(
    args: string[],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return runCli(args, ctx.cwd, signal);
  }

  // Re-runs a read-only tool's CLI with --json for the result details
  // (SPEC: pi keeps the complete JSON in details when truncating).
  async function runTicketJson(
    args: string[],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    return JSON.parse(await runCli(appendJsonFlag(args), ctx.cwd, signal)) as unknown;
  }

  pi.registerTool({
    name: "ticket_list",
    label: "Ticket List",
    description: ticketToolDescriptions.ticket_list,
    promptSnippet: ticketToolPromptSnippets.ticket_list,
    parameters: ticketListParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = buildListArgs(params);
      const result = truncateTicketOutput(
        await runTicket(args, ctx, signal),
        "Use ticket list with the same filters to read the complete list.",
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.truncated ? await runTicketJson(args, ctx, signal) : undefined,
      };
    },
  });

  pi.registerTool({
    name: "ticket_show",
    label: "Ticket Show",
    description: ticketToolDescriptions.ticket_show,
    promptSnippet: ticketToolPromptSnippets.ticket_show,
    parameters: ticketShowParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = buildShowArgs(params);
      const result = truncateTicketOutput(
        await runTicket(args, ctx, signal),
        "Use ticket show with this selector to read the complete body.",
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.truncated ? await runTicketJson(args, ctx, signal) : undefined,
      };
    },
  });

  pi.registerTool({
    name: "ticket_create",
    label: "Ticket Create",
    description: ticketToolDescriptions.ticket_create,
    promptSnippet: ticketToolPromptSnippets.ticket_create,
    parameters: ticketCreateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: await runTicket(buildCreateArgs(params), ctx, signal) }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "ticket_set",
    label: "Ticket Set",
    description: ticketToolDescriptions.ticket_set,
    promptSnippet: ticketToolPromptSnippets.ticket_set,
    parameters: ticketSetParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: await runTicket(buildSetArgs(params), ctx, signal) }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "ticket_edit",
    label: "Ticket Edit",
    description: ticketToolDescriptions.ticket_edit,
    promptSnippet: ticketToolPromptSnippets.ticket_edit,
    parameters: ticketEditParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: await runTicket(buildEditArgs(params), ctx, signal) }],
        details: undefined,
      };
    },
  });
}
