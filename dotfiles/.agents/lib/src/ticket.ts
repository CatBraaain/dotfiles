// Ticket tool helpers shared by the pi extension and the dsh plugin.
// Both wrappers spawn the ticket CLI (dotfiles/.agents/cli/ticket.executable)
// with --json and turn the result into LLM-readable text.
// Spec: dotfiles/.agents/cli/ticket-tools.spec.md

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TicketFields {
  id: string;
  status: string;
  title: string;
  depends_on: string[];
  path: string;
  project?: string;
}

export interface TicketWithBody extends TicketFields {
  body: string;
}

// Thrown when the CLI exits non-zero or cannot be executed at all; `stderr`
// carries the CLI's error text for the tool result.
export class TicketCliError extends Error {
  readonly stderr: string;

  constructor(stderr: string, message: string) {
    super(message);
    this.name = "TicketCliError";
    this.stderr = stderr;
  }
}

export function ticketCliPath(): string {
  return join(homedir(), ".agents", "cli", "ticket");
}

// Pure helper so tests can assert the --json flag without spawning the CLI.
export function ticketCliArgs(args: string[]): string[] {
  return [...args, "--json"];
}

// Runs `ticket <args> --json` with `cwd` as the CLI's working directory and
// resolves with the parsed JSON. The CLI resolves the default project from its
// cwd (main worktree basename or cwd basename), so callers pass the session cwd.
export function runTicketCli(args: string[], cwd: string, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      ticketCliPath(),
      ticketCliArgs(args),
      { cwd, signal, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = typeof stderr === "string" ? stderr.trim() : "";
          if (typeof error.code === "number") {
            reject(new TicketCliError(stderrText, stderrText || `ticket exited with code ${error.code}`));
          } else {
            reject(new TicketCliError(stderrText, `ticket CLI is not available: ${error.message}`));
          }
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new TicketCliError(stdout.trim(), "ticket CLI returned non-JSON output"));
        }
      },
    );
  });
}

// One ticket per line: [project<TAB>]id<TAB>status<TAB>title.
export function formatTicketList(tickets: TicketFields[], all: boolean): string {
  if (tickets.length === 0) return "no tickets";
  return tickets
    .map((ticket) => {
      const project = all && ticket.project !== undefined ? `${ticket.project}\t` : "";
      return `${project}${ticket.id}\t${ticket.status}\t${ticket.title}`;
    })
    .join("\n");
}

export function formatTicketShow(ticket: TicketWithBody): string {
  const deps = ticket.depends_on.map((dep) => `  - ${dep}`).join("\n");
  return [ticket.id, `status: ${ticket.status}`, `depends_on:\n${deps}`, ``, `# ${ticket.title}`, ``, ticket.body.trimEnd()].join("\n");
}

export function formatTicketCreated(ticket: TicketFields): string {
  return `created ${ticket.id}\nstatus: ${ticket.status}\npath: ${ticket.path}`;
}

export function formatTicketUpdated(ticket: TicketFields): string {
  return `updated ${ticket.id}\nstatus: ${ticket.status}\npath: ${ticket.path}`;
}
