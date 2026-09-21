/**
 * dotfiles-dsh-tickets — dsh port of the pi `tickets` extension.
 *
 * Registers five tools wrapping the ticket CLI (`~/.agents/cli/ticket`):
 * ticket_list, ticket_show, ticket_create, ticket_set, ticket_edit. The
 * behavior contract is dotfiles/.agents/cli/ticket-tools.spec.md
 * (harness-neutral oracle; the CLI itself is specified by ticket.spec.md).
 * The tools never touch the ticket store directly — every read and write
 * goes through the CLI with `--json` via the shared lib
 * (`@dotfiles/agent-lib/ticket`).
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
  selector?: string;
  project?: string;
}

export interface TicketCreateArgs {
  title: string;
  body?: string;
  status?: string;
  after?: string;
  project?: string;
}

export interface TicketSetArgs {
  selector?: string;
  status?: string;
  after?: string | null;
  project?: string;
}

export interface TicketEditArgs {
  selector?: string;
  old: string;
  new: string;
  project?: string;
}

// --- tool args -> CLI args (ticket-tools.spec.md 共通の振る舞い) ---
// runTicketCli appends `--json`; these builders carry only the subcommand
// and the flags derived from the tool arguments.

function projectFlag(project: string | undefined): string[] {
  return project === undefined ? [] : ["--project", project];
}

function addOwner(args: string[], owner: string): string[] {
  const optionTerminator = args.indexOf("--");
  if (optionTerminator === -1) return [...args, "--owner", owner];
  return [...args.slice(0, optionTerminator), "--owner", owner, ...args.slice(optionTerminator)];
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
  return ["show", ...(args.selector !== undefined ? [args.selector] : []), ...projectFlag(args.project)];
}

// The CLI takes a single JSON object argument; only the given keys are sent.
export function buildCreateArgs(args: TicketCreateArgs): string[] {
  const payload: Record<string, unknown> = { title: args.title };
  if (args.status !== undefined) payload.status = args.status;
  if (args.after !== undefined) payload.after = args.after;
  if (args.body !== undefined) payload.body = args.body;
  return ["create", JSON.stringify(payload), ...projectFlag(args.project)];
}

// Throws when there is nothing to set (SPEC: no CLI run without status or after).
export function buildSetArgs(args: TicketSetArgs): string[] {
  if (args.status === undefined && args.after === undefined) {
    throw new Error("nothing to set: pass status and/or after");
  }
  const payload: Record<string, unknown> = {};
  if (args.status !== undefined) payload.status = args.status;
  if (args.after !== undefined) payload.after = args.after;
  const selector = args.selector !== undefined ? [args.selector] : [];
  return ["set", ...selector, JSON.stringify(payload), ...projectFlag(args.project)];
}

export function buildEditArgs(args: TicketEditArgs): string[] {
  if (args.old === "") throw new Error("old must be a non-empty string");
  const selector = args.selector !== undefined ? [args.selector] : [];
  return ["edit", ...projectFlag(args.project), ...selector, "--", args.old, args.new];
}

// --- execution helpers ---

// The session cwd comes from the owning agent's session header — the same
// source dsh's own tools read (tool-bash's workdir resolution,
// agent-loop's `cwd` prompt variable). Fall back to the process cwd when no
// agent or header cwd is available.
export function sessionCwd(exec: Pick<ToolRunContext, "agent">): string {
  return exec.agent?.session.header.cwd ?? process.cwd();
}

function sessionOwner(exec: Pick<ToolRunContext, "agent">): string {
  const owner = exec.agent?.session.header.id;
  if (!owner) throw new Error("ticket write tools require an agent session owner");
  return owner;
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

// --- tool definitions ---

export interface TicketToolDeps {
  /** CLI runner override for tests; defaults to the shared lib runner. */
  runCli?: typeof runTicketCli;
}

const PROJECT_DESCRIPTION =
  "Read ~/.agents/tickets/<project> instead of the session cwd's project.";

const SELECTOR_DESCRIPTION =
  "Ticket selector: a ticket id, a prefix unique to one ticket, or \"next\" " +
  "(the oldest actionable ticket). Omitted means \"next\".";

const LIST_DESCRIPTION =
  "List tickets (wraps `ticket list`): one line per ticket with id, status, and title — " +
  "open tickets only unless you filter with status. Pick the store with project " +
  "(defaults to the project resolved from the session cwd), or set all=true to list every " +
  "project (each line prefixed with the project name). Ticket ids resolve by unique prefix.";

const SHOW_DESCRIPTION =
  "Show one ticket (wraps `ticket show`): id, status, after, title, and body. " +
  "selector is a ticket id, a prefix unique to one ticket, or \"next\" (default). " +
  "project picks the ticket store (defaults to the project resolved from the session cwd).";

const CREATE_DESCRIPTION =
  "Create a ticket (wraps `ticket create`): returns the new id, status, after, and path. " +
  "body is placed under the title, status defaults to open, and after sets the single ticket " +
  "id this ticket waits on (unique prefixes are fine) — it blocks the ticket unless a status " +
  "is given, and it must exist and not be closed or cancelled. project picks the store " +
  "(defaults to the project resolved from the session cwd).";

const SET_DESCRIPTION =
  "Update one ticket's frontmatter (wraps `ticket set`): returns the updated id, status, after, " +
  "and path. Only status and/or after can be set; selector is a ticket id, a unique prefix, or " +
  "\"next\" (default). The linkage auto-switches the status unless an explicit status wins: " +
  "setting an unresolved after blocks the ticket, clearing after (null) reopens a blocked one, " +
  "and status closed releases dependent blocked tickets back to open. The CLI validates the " +
  "update: after must exist and must not be closed or cancelled, and cycles fail without rewriting. " +
  "project picks the ticket store (defaults to the project resolved from the session cwd).";

const EDIT_DESCRIPTION =
  "Edit one ticket's body (wraps `ticket edit`): returns the updated id, status, after, and path. " +
  "Call ticket_show first and copy old exactly from its body, including line breaks. " +
  "Replaces the single occurrence of old with new (empty new deletes it); the H1 is part of the " +
  "body, so it can be replaced. Zero or multiple occurrences of old fail without rewriting. " +
  "selector is a ticket id, a unique prefix, or \"next\" (default); project picks the store " +
  "(defaults to the project resolved from the session cwd).";

export function createTicketTools(deps: TicketToolDeps = {}): ToolDefinition[] {
  const runCli = deps.runCli ?? runTicketCli;

  const run = async (cliArgs: string[], exec: ToolRunContext): Promise<CliJson> => {
    try {
      const writeCommand = ["create", "set", "edit"].includes(cliArgs[0]!);
      const args = writeCommand ? addOwner(cliArgs, sessionOwner(exec)) : cliArgs;
      return (await runCli(args, sessionCwd(exec), exec.signal)) as CliJson;
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
          description: 'Statuses to keep, e.g. ["open", "blocked"] (default: open tickets).',
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
        selector: { type: "string", description: SELECTOR_DESCRIPTION },
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
          description:
            "Initial status (draft/open/blocked/locked/closed/cancelled; default open, or blocked when after is set).",
        },
        after: {
          type: "string",
          description:
            "Id of the ticket this one waits on (same project; unique prefixes are fine).",
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
      name: "ticket_set",
      description: SET_DESCRIPTION,
      parameters: {
        selector: { type: "string", description: SELECTOR_DESCRIPTION },
        status: {
          type: "string",
          description: "New status (draft/open/blocked/locked/closed/cancelled).",
        },
        after: {
          oneOf: [{ type: "string" }, { type: "null" }],
          description:
            "Ticket this one waits on (string, same project; unique prefixes are fine), or null to clear.",
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
      execute: (args, exec) => run(buildSetArgs(args), exec),
    }),
    defineTool({
      name: "ticket_edit",
      description: EDIT_DESCRIPTION,
      parameters: {
        selector: { type: "string", description: SELECTOR_DESCRIPTION },
        old: {
          type: "string",
          required: true,
          description:
            "Non-empty text to replace; it must appear exactly once in the body. Call ticket_show first and copy it exactly, including line breaks.",
        },
        new: {
          type: "string",
          required: true,
          description: "Replacement text; an empty string deletes the matched text.",
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
      execute: (args, exec) => run(buildEditArgs(args), exec),
    }),
  ];
}

export function apply(ctx: Context): void {
  for (const tool of createTicketTools()) ctx.tools.register(tool);
}
