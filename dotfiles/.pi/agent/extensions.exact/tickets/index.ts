// pi extension registering four ticket tools that wrap the `ticket` CLI
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
  id: Type.String({
    description: "Ticket ID. A unique prefix is enough to identify a ticket.",
  }),
  project: Type.Optional(
    Type.String({
      description: "Ticket store (project) to look in. Defaults to the project resolved from the session cwd.",
    }),
  ),
});

export const ticketCreateParameters = Type.Object({
  title: Type.String({
    description: "Ticket title. Becomes the ticket H1 and the basis of its ID slug.",
  }),
  body: Type.Optional(
    Type.String({
      description: "Optional body text placed right after the H1.",
    }),
  ),
  status: Type.Optional(
    Type.String({
      description:
        "Initial status (draft/open/blocked/locked/closed/cancelled). Defaults to open.",
    }),
  ),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description: "IDs of tickets this ticket depends on (resolved within the same project).",
    }),
  ),
  project: Type.Optional(
    Type.String({
      description: "Ticket store (project) to create the ticket in. Defaults to the project resolved from the session cwd.",
    }),
  ),
});

export const ticketUpdateParameters = Type.Object({
  id: Type.String({
    description: "Ticket ID. A unique prefix is enough to identify a ticket.",
  }),
  metadata: Type.Optional(
    Type.Object(
      {
        status: Type.Optional(
          Type.String({
            description: "New status (draft/open/blocked/locked/closed/cancelled).",
          }),
        ),
        depends_on: Type.Optional(
          Type.Array(Type.String(), {
            description: "Replaces depends_on with these ticket IDs (resolved within the same project).",
          }),
        ),
      },
      {
        description:
          "Object with only status and/or depends_on keys to merge into the frontmatter. Other keys fail the update.",
      },
    ),
  ),
  body: Type.Optional(
    Type.String({
      description: "Replaces the whole ticket body (everything after the H1).",
    }),
  ),
  project: Type.Optional(
    Type.String({
      description: "Ticket store (project) to update in. Defaults to the project resolved from the session cwd.",
    }),
  ),
});

export type TicketListParams = Static<typeof ticketListParameters>;
export type TicketShowParams = Static<typeof ticketShowParameters>;
export type TicketCreateParams = Static<typeof ticketCreateParameters>;
export type TicketUpdateParams = Static<typeof ticketUpdateParameters>;

// --- tool args -> CLI args (SPEC: ticket-tools.spec.md, per-tool sections) ---

export function buildListArgs(params: TicketListParams): string[] {
  const args = ["list"];
  if (params.all) args.push("--all");
  if (params.status && params.status.length > 0) args.push("--status", params.status.join(","));
  if (params.project !== undefined) args.push("--project", params.project);
  return args;
}

export function buildShowArgs(params: TicketShowParams): string[] {
  const args = ["show", params.id];
  if (params.project !== undefined) args.push("--project", params.project);
  return args;
}

export function buildCreateArgs(params: TicketCreateParams): string[] {
  const args = ["create", params.title];
  if (params.status !== undefined) args.push("--status", params.status);
  if (params.depends_on && params.depends_on.length > 0) {
    args.push("--depends-on", params.depends_on.join(","));
  }
  if (params.body !== undefined) args.push("--body", params.body);
  if (params.project !== undefined) args.push("--project", params.project);
  return args;
}

// Throws when there is nothing to update (SPEC: no CLI run without metadata or body).
export function buildUpdateArgs(params: TicketUpdateParams): string[] {
  if (params.metadata === undefined && params.body === undefined) {
    throw new Error("ticket_update: nothing to update — pass metadata and/or body");
  }
  const args = ["update", params.id];
  if (params.metadata !== undefined) args.push("--metadata", JSON.stringify(params.metadata));
  if (params.body !== undefined) args.push("--body", params.body);
  if (params.project !== undefined) args.push("--project", params.project);
  return args;
}

// --- tool descriptions / prompt snippets (SPEC: 共通の振る舞い + per-tool notes) ---

export const ticketToolDescriptions = {
  ticket_list:
    "List tickets in a ticket store via the `ticket list` CLI subcommand. " +
    "Returns one ticket per line as id, status, and title. " +
    "status filters tickets by the given statuses; all=true lists every project and prefixes each line with the project name; " +
    "project selects the ticket store (defaults to the project resolved from the session cwd). " +
    "Ticket IDs are unique by prefix, so a prefix returned here can be passed as id to the other ticket tools.",
  ticket_show:
    "Show one ticket via the `ticket show` CLI subcommand. " +
    "Returns id, status, depends_on, title, and body. " +
    "id is a ticket ID; a unique prefix is enough to identify a ticket, and an unknown or ambiguous prefix fails. " +
    "project selects the ticket store (defaults to the project resolved from the session cwd).",
  ticket_create:
    "Create a ticket via the `ticket create` CLI subcommand and return the created id, status, and path. " +
    "title becomes the ticket H1; body is optional text placed after the H1; " +
    "status defaults to open (draft/open/blocked/locked/closed/cancelled); " +
    "depends_on lists ticket IDs this ticket depends on (same project, unique prefixes allowed); " +
    "project selects the ticket store (defaults to the project resolved from the session cwd). " +
    "The CLI validates the fields, so creation can fail with the CLI's error text.",
  ticket_update:
    "Update a ticket via the `ticket update` CLI subcommand and return the updated id, status, and path. " +
    "metadata is an object whose keys are only status and/or depends_on; body replaces the whole ticket body; " +
    "id is a ticket ID (a unique prefix is enough); project selects the ticket store " +
    "(defaults to the project resolved from the session cwd). " +
    "The CLI validates updates and can fail them: exclusivity (locking a ticket that is already locked fails) " +
    "and dependency resolution (an open ticket must not depend on non-closed tickets).",
} as const;

export const ticketToolPromptSnippets = {
  ticket_list: "List tickets in the project ticket store",
  ticket_show: "Show one ticket's details",
  ticket_create: "Create a new ticket",
  ticket_update: "Update a ticket's status, dependencies, or body",
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
    name: "ticket_update",
    label: "Ticket Update",
    description: ticketToolDescriptions.ticket_update,
    promptSnippet: ticketToolPromptSnippets.ticket_update,
    parameters: ticketUpdateParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = buildUpdateArgs(params);
      const json = (await runTicket(args, ctx, signal)) as TicketFields;
      return {
        content: [{ type: "text", text: formatTicketUpdated(json) }],
        details: json,
      };
    },
  });
}
