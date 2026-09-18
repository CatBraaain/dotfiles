/**
 * dotfiles-dsh-tickets — dsh port of the pi `tickets` extension.
 *
 * Registers four tools wrapping the ticket CLI (`~/.agents/cli/ticket`):
 * ticket_list, ticket_show, ticket_create, ticket_update. The behavior
 * contract is dotfiles/.agents/cli/ticket-tools.spec.md (harness-neutral
 * oracle; the CLI itself is specified by ticket.spec.md). The tools never
 * touch the ticket store directly — every read and write goes through the
 * CLI with `--json` via the shared lib (`@dotfiles/agent-lib/ticket`).
 *
 * Result shape: `execute` returns the CLI's parsed JSON as the canonical
 * value, `output.render` turns it into the LLM text with the shared
 * formatTicket* helpers, and `output.presentationMeta` persists the same JSON
 * on `tool/result` — the dsh equivalent of the pi extension's `details`
 * field. CLI failures (non-zero exit, spawn error, non-JSON output) surface
 * as tool-call errors carrying the CLI's stderr text.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type InferValue,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import {
  TicketCliError,
  formatTicketCreated,
  formatTicketList,
  formatTicketShow,
  formatTicketUpdated,
  runTicketCli,
  type TicketFields,
  type TicketWithBody,
} from "@dotfiles/agent-lib/ticket";

/** The CLI's parsed `--json` output, as declared by the tools' output schema. */
type CliJson = InferValue<{ type: "json" }>;

// The CLI's --json contract (ticket.spec.md) fixes these shapes; the cast goes
// through `unknown` because lib interfaces carry no JSON index signature.
function asTicketJson<T>(value: CliJson): T {
  return value as unknown as T;
}

export const name = "dsh-tickets";
export const inject = ["tools"];

// --- tool arguments ---

export interface TicketListArgs {
  status?: string[];
  project?: string;
  all?: boolean;
}

export interface TicketShowArgs {
  id: string;
  project?: string;
}

export interface TicketCreateArgs {
  title: string;
  body?: string;
  status?: string;
  depends_on?: string[];
  project?: string;
}

export interface TicketUpdateArgs {
  id: string;
  metadata?: Record<string, unknown>;
  body?: string;
  project?: string;
}

// --- tool args -> CLI args (ticket-tools.spec.md 共通の振る舞い) ---
// runTicketCli appends `--json`; these builders carry only the subcommand
// and the flags derived from the tool arguments.

function projectFlag(project: string | undefined): string[] {
  return project === undefined ? [] : ["--project", project];
}

export function buildListArgs(args: TicketListArgs): string[] {
  return [
    "list",
    ...(args.all === true ? ["--all"] : []),
    ...(args.status !== undefined && args.status.length > 0
      ? ["--status", args.status.join(",")]
      : []),
    ...projectFlag(args.project),
  ];
}

export function buildShowArgs(args: TicketShowArgs): string[] {
  return ["show", args.id, ...projectFlag(args.project)];
}

export function buildCreateArgs(args: TicketCreateArgs): string[] {
  return [
    "create",
    args.title,
    ...(args.status !== undefined ? ["--status", args.status] : []),
    ...(args.depends_on !== undefined && args.depends_on.length > 0
      ? ["--depends-on", args.depends_on.join(",")]
      : []),
    ...(args.body !== undefined ? ["--body", args.body] : []),
    ...projectFlag(args.project),
  ];
}

export function buildUpdateArgs(args: TicketUpdateArgs): string[] {
  return [
    "update",
    args.id,
    ...(args.metadata !== undefined ? ["--metadata", JSON.stringify(args.metadata)] : []),
    ...(args.body !== undefined ? ["--body", args.body] : []),
    ...projectFlag(args.project),
  ];
}

// --- execution helpers ---

// The session cwd comes from the owning agent's session header — the same
// source dsh's own tools read (tool-bash's workdir resolution,
// agent-loop's `cwd` prompt variable). Fall back to the process cwd when no
// agent or header cwd is available.
export function sessionCwd(exec: Pick<ToolRunContext, "agent">): string {
  return exec.agent?.session.header.cwd ?? process.cwd();
}

// TicketCliError -> tool failure: the CLI's stderr text is the error the
// model sees (ticket-tools.spec.md 共通の振る舞い); other errors pass
// through unchanged.
export function toToolError(error: unknown): unknown {
  if (error instanceof TicketCliError) {
    return new Error(error.stderr || error.message);
  }
  return error;
}

// ticket_update with neither metadata nor body is rejected before the CLI is
// spawned (ticket-tools.spec.md `ticket_update`).
export function assertUpdatable(args: TicketUpdateArgs): void {
  if (args.metadata === undefined && args.body === undefined) {
    throw new Error("nothing to update: pass metadata (status and/or depends_on) or body");
  }
}

// --- tool definitions ---

export interface TicketToolDeps {
  /** CLI runner override for tests; defaults to the shared lib runner. */
  runCli?: typeof runTicketCli;
}

const PROJECT_DESCRIPTION =
  "Read ~/.agents/tickets/<project> instead of the session cwd's project.";

const LIST_DESCRIPTION =
  "List tickets (wraps `ticket list`): one line per ticket with id, status, and title. " +
  "Filter with status, pick the store with project, or set all=true to list every project " +
  "(each line prefixed with the project name). Ticket ids resolve by unique prefix.";

const SHOW_DESCRIPTION =
  "Show one ticket (wraps `ticket show <id>`): id, status, depends_on, title, and body. " +
  "id may be any prefix unique to one ticket.";

const CREATE_DESCRIPTION =
  "Create a ticket (wraps `ticket create <title>`): returns the new id, status, and path. " +
  "body is placed under the title, status defaults to open, depends_on lists prerequisite " +
  "ticket ids (unique prefixes are fine), project picks another store.";

const UPDATE_DESCRIPTION =
  "Update one ticket (wraps `ticket update <id>`): returns the updated id, status, and path. " +
  "metadata merges frontmatter fields (status and/or depends_on only) and body replaces the " +
  "whole body text; id may be any unique prefix. Validation can fail: a locked ticket refuses " +
  "re-locking, and status open requires every depends_on entry closed.";

export function createTicketTools(deps: TicketToolDeps = {}): ToolDefinition[] {
  const runCli = deps.runCli ?? runTicketCli;

  const run = async (cliArgs: string[], exec: ToolRunContext): Promise<CliJson> => {
    try {
      return (await runCli(cliArgs, sessionCwd(exec), exec.signal)) as CliJson;
    } catch (error) {
      throw toToolError(error);
    }
  };

  return [
    defineTool({
      name: "ticket_list",
      description: LIST_DESCRIPTION,
      parameters: {
        status: {
          type: "array",
          items: { type: "string" },
          description: 'Statuses to keep, e.g. ["open", "blocked"] (default: all statuses).',
        },
        project: { type: "string", description: PROJECT_DESCRIPTION },
        all: {
          type: "boolean",
          description: "List every project's tickets, each line prefixed with the project name.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (args, value) => [
          {
            type: "text",
            text: formatTicketList(asTicketJson<TicketFields[]>(value), args.all === true),
          },
        ],
        presentationMeta: (_args, value) => value,
      },
      execute: (args, exec) => run(buildListArgs(args), exec),
    }),
    defineTool({
      name: "ticket_show",
      description: SHOW_DESCRIPTION,
      parameters: {
        id: {
          type: "string",
          required: true,
          description: "Ticket id, or a prefix unique to one ticket.",
        },
        project: { type: "string", description: PROJECT_DESCRIPTION },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: formatTicketShow(asTicketJson<TicketWithBody>(value)) },
        ],
        presentationMeta: (_args, value) => value,
      },
      execute: (args, exec) => run(buildShowArgs(args), exec),
    }),
    defineTool({
      name: "ticket_create",
      description: CREATE_DESCRIPTION,
      parameters: {
        title: { type: "string", required: true, description: "H1 title of the new ticket." },
        body: { type: "string", description: "Body text placed after the title heading." },
        status: {
          type: "string",
          description: "Initial status (draft/open/blocked/locked/closed/cancelled; default open).",
        },
        depends_on: {
          type: "array",
          items: { type: "string" },
          description: "Ids this ticket depends on (same project; unique prefixes are fine).",
        },
        project: { type: "string", description: PROJECT_DESCRIPTION },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: formatTicketCreated(asTicketJson<TicketFields>(value)) },
        ],
        presentationMeta: (_args, value) => value,
      },
      execute: (args, exec) => run(buildCreateArgs(args), exec),
    }),
    defineTool({
      name: "ticket_update",
      description: UPDATE_DESCRIPTION,
      parameters: {
        id: {
          type: "string",
          required: true,
          description: "Ticket id, or a prefix unique to one ticket.",
        },
        metadata: {
          type: "object",
          additionalProperties: true,
          description:
            "Frontmatter fields to merge: status and/or depends_on (any other key fails in the CLI).",
        },
        body: {
          type: "string",
          description: "Full replacement text for the body (the H1 title stays).",
        },
        project: { type: "string", description: PROJECT_DESCRIPTION },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: formatTicketUpdated(asTicketJson<TicketFields>(value)) },
        ],
        presentationMeta: (_args, value) => value,
      },
      execute: (args, exec) => {
        assertUpdatable(args);
        return run(buildUpdateArgs(args), exec);
      },
    }),
  ];
}

export function apply(ctx: Context): void {
  for (const tool of createTicketTools()) ctx.tools.register(tool);
}
