import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { cliExecutableName, CliFailure, runCliViaBash } from "../tools/cli.ts";

// --- tool parameter schemas (argument names match ticket/SPEC.md) ---

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

// --- tool args -> CLI args (SPEC: ticket/SPEC.md, per-tool sections) ---

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

const projectDescription =
  "`project` でチケットストアを指定する。省略時はセッションの作業ディレクトリからプロジェクトを特定する。";

export const ticketToolDescriptions = {
  ticket_list:
    "`ticket list` でチケットストアのチケットを一覧表示する。1件につき1行で `id`・`status`・`title` を返す。" +
    " `status` で状態を絞り込む。省略時は `open` のみ表示する。`all=true` なら全プロジェクトを対象とし、各行の先頭にプロジェクト名を付ける。 " +
    projectDescription +
    " 一覧に表示された ID の一意な接頭辞は、ほかのチケットツールの `selector` に渡せる。",
  ticket_show:
    "`ticket show` でチケット1件の `id`・`status`・`after`・`title`・`body` を表示する。" +
    " `selector` にはチケット ID、一意な接頭辞、または着手可能な最古のチケット（`open` かつ待機先が解消済み）を示す `next` を指定する。省略時は `next`。 " +
    projectDescription,
  ticket_create:
    "`ticket create` でチケットを作成し、`id`・`status`・`after`・`path` を返す。" +
    " `title` はチケットの H1 見出しになる。`body` を指定すると、H1 の直後に本文として追加する。" +
    " `status` の既定は `open` で、すぐに引き渡せる。自分で着手する場合は `locked` を指定する。" +
    " ほかのチケットを待つ場合は、同じプロジェクトのチケット ID（一意な接頭辞も可）を `after` に指定し、`status` を省略すると `blocked` になる。 " +
    projectDescription +
    " 入力は CLI が検証し、不正な場合は CLI のエラーを返す。",
  ticket_set:
    "`ticket set` でチケットのフロントマターを更新し、更新後の `id`・`status`・`after`・`path` を返す。" +
    " 更新できるのは `status` と `after` のみ。`selector` にはチケット ID、一意な接頭辞、または `next`（既定）を指定する。" +
    " `status` を明示しない場合、未解消の待機先を `after` に設定すると `blocked` になり、`after` を `null` にすると `blocked` から `open` に戻る。" +
    " `status` を `closed` にすると、このチケットを待つ `blocked` のチケットが `open` に戻る。" +
    " `after` は実在するチケットを指定し、`closed` または `cancelled` のチケットは指定できない。循環する依存関係は CLI が拒否し、書き換えない。 " +
    projectDescription,
  ticket_edit:
    "`ticket edit` でチケット本文を編集し、更新後の `id`・`status`・`after`・`path` を返す。" +
    " 先に `ticket_show` を呼び、本文から改行も含めて正確に `old` をコピーする。" +
    " 一致する1箇所を `new` に置換する。`new` が空文字列なら削除する。H1 見出しも本文に含まれ、置換できる。" +
    " `old` が0箇所または複数箇所に一致する場合は、書き換えずに失敗する。" +
    " `selector` にはチケット ID、一意な接頭辞、または `next`（既定）を指定する。 " +
    projectDescription,
} as const;

const ticketListOutput = Type.Array(
  Type.Object({
    id: Type.String(),
    status: Type.String(),
    after: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
    path: Type.String(),
    project: Type.Optional(Type.String()),
  }),
);

function truncateTicketOutput(
  text: string,
  recoveryHint: string,
): { text: string; truncated: boolean } {
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

// --- CLI spawn (SPEC: ticket/SPEC.md common behavior) ---

export type TicketCliRunner = (
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: Pick<ExtensionToolContext, "executeTool">,
) => Promise<string>;

function ticketCliPath(): string {
  return join(homedir(), ".agents", "cli", cliExecutableName("ticket"));
}

export interface SpawnTicketCliDeps {
  cliPath?: string;
}

// Adds --json before the option terminator so the terminator's positional
// arguments stay literal (SPEC: the -- rule in ticket/SPEC.md).
export function appendJsonFlag(args: string[]): string[] {
  const terminator = args.indexOf("--");
  if (terminator === -1) return [...args, "--json"];
  return [...args.slice(0, terminator), "--json", ...args.slice(terminator)];
}

export async function spawnTicketCli(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: Pick<ExtensionToolContext, "executeTool">,
  deps: SpawnTicketCliDeps = {},
): Promise<string> {
  const outcome = await runCliViaBash({
    context: ctx,
    params: { executable: deps.cliPath ?? ticketCliPath(), args, cwd },
    signal,
  });
  if (outcome.status !== "completed") {
    const error =
      outcome.status === "aborted"
        ? new Error(`Registered bash aborted: ${String(outcome.reason)}`, { cause: outcome.reason })
        : outcome.error;
    if (outcome.result && outcome.isError !== undefined)
      throw new CliFailure(
        error instanceof Error ? error.message : String(error),
        { result: outcome.result, isError: outcome.isError },
        outcome.status === "aborted" ? { reason: outcome.reason } : { error: outcome.error },
      );
    if (outcome.status === "aborted")
      throw new CliFailure(`Registered bash aborted: ${String(outcome.reason)}`, undefined, {
        reason: outcome.reason,
      });
    throw error;
  }
  const result = outcome.cli!;
  if (result.code !== 0) {
    throw new CliFailure(
      result.stderr.replace(/\n$/, "") || `ticket exited with code ${result.code}`,
      outcome,
    );
  }
  return result.stdout;
}

// --- extension ---

export interface TicketsExtensionDeps {
  /** Replaces the CLI runner for the deployed executable. */
  runCli?: TicketCliRunner;
}

export default function ticketsExtension(pi: ExtensionAPI, deps: TicketsExtensionDeps = {}): void {
  const runCli: TicketCliRunner = deps.runCli ?? spawnTicketCli;

  async function runTicket(
    args: string[],
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return runCli(args, ctx.cwd, signal, ctx);
  }

  async function runTicketJson(
    args: string[],
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    return JSON.parse(await runCli(appendJsonFlag(args), ctx.cwd, signal, ctx)) as unknown;
  }

  pi.registerTool({
    name: "ticket_list",
    label: "Ticket List",
    description: ticketToolDescriptions.ticket_list,
    promptSnippet: ticketToolPromptSnippets.ticket_list,
    parameters: ticketListParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const entries = await runTicketJson(buildListArgs(params), ctx, signal);
        const allProjects = params.all ?? false;
        if (
          !Value.Check(ticketListOutput, entries) ||
          entries.some(({ project }) =>
            allProjects ? project === undefined : project !== undefined,
          )
        ) {
          throw new Error("Invalid ticket list JSON");
        }
        const text =
          entries.length === 0
            ? "no tickets\n"
            : entries
                .map(
                  ({ id, status, title, project }) =>
                    `${allProjects ? `${project}\t` : ""}${id}\t${status}\t${title}\n`,
                )
                .join("");
        const result = truncateTicketOutput(
          text,
          "Use ticket list with the same filters to read the complete list.",
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: result.truncated ? entries : undefined,
        };
      } catch (error) {
        if (error instanceof CliFailure) return error.toolResult;
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "ticket_show",
    label: "Ticket Show",
    description: ticketToolDescriptions.ticket_show,
    promptSnippet: ticketToolPromptSnippets.ticket_show,
    parameters: ticketShowParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const args = buildShowArgs(params);
        const result = truncateTicketOutput(
          await runTicket(args, ctx, signal),
          "Use ticket show with this selector to read the complete body.",
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: result.truncated ? await runTicketJson(args, ctx, signal) : undefined,
        };
      } catch (error) {
        if (error instanceof CliFailure) return error.toolResult;
        throw error;
      }
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
      try {
        return {
          content: [{ type: "text", text: await runTicket(buildCreateArgs(params), ctx, signal) }],
          details: undefined,
        };
      } catch (error) {
        if (error instanceof CliFailure) return error.toolResult;
        throw error;
      }
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
      try {
        return {
          content: [{ type: "text", text: await runTicket(buildSetArgs(params), ctx, signal) }],
          details: undefined,
        };
      } catch (error) {
        if (error instanceof CliFailure) return error.toolResult;
        throw error;
      }
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
      try {
        return {
          content: [{ type: "text", text: await runTicket(buildEditArgs(params), ctx, signal) }],
          details: undefined,
        };
      } catch (error) {
        if (error instanceof CliFailure) return error.toolResult;
        throw error;
      }
    },
  });
}
