// pi extension registering five ticket tools that wrap the `ticket` CLI
// (~/.agents/cli/ticket, executable form of dotfiles/.agents/cli/ticket.executable).
// Behavior spec: dotfiles/.agents/cli/ticket-tools.spec.md (tools) and
// dotfiles/.agents/cli/ticket.spec.md (CLI / store).

import {
  formatTicketCreated,
  formatTicketList,
  formatTicketShow,
  formatTicketUpdated,
  runTicketCli,
  TicketCliError,
  type TicketFields,
  type TicketWithBody,
} from "@dotfiles/agent-lib/ticket";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

// --- tool parameter schemas (argument names match ticket-tools.spec.md) ---

const SELECTOR_DESCRIPTION =
  "Ticket selector: a ticket ID, a prefix unique to one ticket, or \"next\" for the " +
  "oldest actionable ticket. Omitted means \"next\".";

export const ticketListParameters = Type.Object({
  status: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter to tickets whose status is any of these values (draft/open/blocked/locked/closed/cancelled).",
    }),
  ),
  project: Type.Optional(
    Type.String({
      description: "Ticket store (project) to list. Defaults to the project resolved from the session cwd.",
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
      description: "Ticket store (project) to look in. Defaults to the project resolved from the session cwd.",
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
      description: "Ticket store (project) to create the ticket in. Defaults to the project resolved from the session cwd.",
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
      description: "Ticket store (project) to update in. Defaults to the project resolved from the session cwd.",
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
      description: "Ticket store (project) to update in. Defaults to the project resolved from the session cwd.",
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
  return ["show", ...(params.selector !== undefined ? [params.selector] : []), ...projectFlag(params.project)];
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
    "selector is a ticket ID, a prefix unique to one ticket, or \"next\" for the oldest actionable ticket (open with its after resolved); omitted means \"next\". " +
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
    "Only status and/or after can be set; selector is a ticket ID, a unique prefix, or \"next\" (default). " +
    "The linkage auto-switches the status unless an explicit status is given: setting an unresolved after blocks the ticket, " +
    "clearing after (null) reopens a blocked ticket. Setting status to closed releases dependent blocked tickets back to open. " +
    "The CLI validates the update: after must exist and must not be closed or cancelled, and cycles fail without rewriting.",
  ticket_edit:
    "Edit a ticket's body via the `ticket edit` CLI subcommand and return the updated id, status, after, and path. " +
    "Call ticket_show first and copy old exactly from its body, including line breaks. " +
    "Replaces the single occurrence of old with new (empty new deletes it); the H1 is part of the body, so it can be replaced. " +
    "Zero or multiple occurrences of old fail without rewriting. " +
    "selector is a ticket ID, a unique prefix, or \"next\" (default); project selects the ticket store.",
} as const;

export const ticketToolPromptSnippets = {
  ticket_list: "List tickets in the project ticket store",
  ticket_show: "Show one ticket's details",
  ticket_create: "Create a new ticket",
  ticket_set: "Update a ticket's status or after",
  ticket_edit: "Edit a ticket's body text",
} as const;

// --- extension ---

// Runner signature of the lib's runTicketCli. Injectable via deps so tests can
// execute the tools without spawning the real CLI.
export type TicketCliRunner = typeof runTicketCli;

export interface TicketsExtensionDeps {
  /** Replaces the CLI runner; defaults to the lib's runTicketCli. */
  runCli?: TicketCliRunner;
}

export default function ticketsExtension(pi: ExtensionAPI, deps: TicketsExtensionDeps = {}): void {
  const runCli = deps.runCli ?? runTicketCli;

  // Runs the CLI for the given tool args, converting TicketCliError into a
  // plain Error so pi reports the tool call as failed. Prefers the CLI's
  // stderr text; falls back to the error message when stderr is empty
  // (e.g. spawn failure: the CLI is not installed or not executable).
  async function runTicket(
    args: string[],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    try {
      return await runCli(args, ctx.cwd, signal);
    } catch (error) {
      if (error instanceof TicketCliError) throw new Error(error.stderr || error.message);
      throw error;
    }
  }

  pi.registerTool({
    name: "ticket_list",
    label: "Ticket List",
    description: ticketToolDescriptions.ticket_list,
    promptSnippet: ticketToolPromptSnippets.ticket_list,
    parameters: ticketListParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const json = (await runTicket(buildListArgs(params), ctx, signal)) as TicketFields[];
      return {
        content: [{ type: "text", text: formatTicketList(json, params.all === true) }],
        details: json,
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
      const json = (await runTicket(buildShowArgs(params), ctx, signal)) as TicketWithBody;
      return {
        content: [{ type: "text", text: formatTicketShow(json) }],
        details: json,
      };
    },
  });

  pi.registerTool({
    name: "ticket_create",
    label: "Ticket Create",
    description: ticketToolDescriptions.ticket_create,
    promptSnippet: ticketToolPromptSnippets.ticket_create,
    parameters: ticketCreateParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const json = (await runTicket(buildCreateArgs(params), ctx, signal)) as TicketFields;
      return {
        content: [{ type: "text", text: formatTicketCreated(json) }],
        details: json,
      };
    },
  });

  pi.registerTool({
    name: "ticket_set",
    label: "Ticket Set",
    description: ticketToolDescriptions.ticket_set,
    promptSnippet: ticketToolPromptSnippets.ticket_set,
    parameters: ticketSetParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const json = (await runTicket(buildSetArgs(params), ctx, signal)) as TicketFields;
      return {
        content: [{ type: "text", text: formatTicketUpdated(json) }],
        details: json,
      };
    },
  });

  pi.registerTool({
    name: "ticket_edit",
    label: "Ticket Edit",
    description: ticketToolDescriptions.ticket_edit,
    promptSnippet: ticketToolPromptSnippets.ticket_edit,
    parameters: ticketEditParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const json = (await runTicket(buildEditArgs(params), ctx, signal)) as TicketFields;
      return {
        content: [{ type: "text", text: formatTicketUpdated(json) }],
        details: json,
      };
    },
  });
}
