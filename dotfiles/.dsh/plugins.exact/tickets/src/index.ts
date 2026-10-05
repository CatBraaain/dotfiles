import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";

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

// --- tool args -> CLI args (ticket/SPEC.md tool ラッパーの共通) ---
// These builders carry only the subcommand and the flags derived from the
// tool arguments; the CLI's text output is the tool result as-is.

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
  return [
    "show",
    ...(args.selector !== undefined ? [args.selector] : []),
    ...projectFlag(args.project),
  ];
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

// The CLI project directory; bun resolves its package.json main field, so
// spawning needs no exec bit (`bun <script>` pattern of the web-search plugin).
function ticketCliDir(): string {
  return join(homedir(), ".agents", "cli", "ticket");
}

export type TicketCliRunner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;

// Spawns the ticket CLI and resolves its stdout text. Non-zero exits and
// spawn failures reject with the CLI's stderr text (or a spawn-failure
// message when stderr is empty) — the model-facing error per SPEC.
function spawnTicketCli(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "bun",
      [ticketCliDir(), ...args],
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

// --- tool definitions ---

export interface TicketToolDeps {
  /** CLI runner override for tests; defaults to the real spawn. */
  runCli?: TicketCliRunner;
}

const PROJECT_DESCRIPTION =
  "Read ~/.agents/tickets/<project> instead of the session cwd's project.";

const SELECTOR_DESCRIPTION =
  'Ticket selector: a ticket id, a prefix unique to one ticket, or "next" ' +
  '(the oldest actionable ticket). Omitted means "next".';

const LIST_DESCRIPTION =
  "List tickets (wraps `ticket list`): one line per ticket with id, status, and title — " +
  "open tickets only unless you filter with status. Pick the store with project " +
  "(defaults to the project resolved from the session cwd), or set all=true to list every " +
  "project (each line prefixed with the project name). Ticket ids resolve by unique prefix.";

const SHOW_DESCRIPTION =
  "Show one ticket (wraps `ticket show`): id, status, after, title, and body. " +
  'selector is a ticket id, a prefix unique to one ticket, or "next" (default). ' +
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
  '"next" (default). The linkage auto-switches the status unless an explicit status wins: ' +
  "setting an unresolved after blocks the ticket, clearing after (null) reopens a blocked one, " +
  "and status closed releases dependent blocked tickets back to open. The CLI validates the " +
  "update: after must exist and must not be closed or cancelled, and cycles fail without rewriting. " +
  "project picks the ticket store (defaults to the project resolved from the session cwd).";

const EDIT_DESCRIPTION =
  "Edit one ticket's body (wraps `ticket edit`): returns the updated id, status, after, and path. " +
  "Call ticket_show first and copy old exactly from its body, including line breaks. " +
  "Replaces the single occurrence of old with new (empty new deletes it); the H1 is part of the " +
  "body, so it can be replaced. Zero or multiple occurrences of old fail without rewriting. " +
  'selector is a ticket id, a unique prefix, or "next" (default); project picks the store ' +
  "(defaults to the project resolved from the session cwd).";

export function createTicketTools(deps: TicketToolDeps = {}): ToolDefinition[] {
  const runCli: TicketCliRunner =
    deps.runCli ?? ((args, cwd, signal) => spawnTicketCli(args, cwd, signal));

  const run = (cliArgs: string[], exec: ToolRunContext): Promise<string> =>
    runCli(cliArgs, sessionCwd(exec), exec.signal);

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
        schema: { type: "string" },
        render: (_args, text) => [{ type: "text", text }],
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
        schema: { type: "string" },
        render: (_args, text) => [{ type: "text", text }],
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
        schema: { type: "string" },
        render: (_args, text) => [{ type: "text", text }],
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
        schema: { type: "string" },
        render: (_args, text) => [{ type: "text", text }],
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
        schema: { type: "string" },
        render: (_args, text) => [{ type: "text", text }],
      },
      execute: (args, exec) => run(buildEditArgs(args), exec),
    }),
  ];
}

export function apply(ctx: Context): void {
  for (const tool of createTicketTools()) ctx.tools.register(tool);
}
