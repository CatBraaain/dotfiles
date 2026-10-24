import { homedir } from "node:os";
import { loadReadingPage, type RoleFilter } from "./records";
import { excerpt, formatListRow, formatSearchHit, formatReadingPage } from "./render";
import { runSearch } from "./search";
import {
  listSessionFiles,
  readSessionTitle,
  resolveSessionById,
  sessionsRootDir,
  statSessionFile,
  type SessionFilters,
} from "./sessions";

const USAGE = `usage: session-search search <query> [--json] [--project <pattern>] [--since <date>] [--until <date>] [--limit <n>] [--role <user|assistant>]
       session-search list [--json] [--project <pattern>] [--since <date>] [--until <date>] [--limit <n>]
       session-search show <id> [--json] [--project <pattern>] [--since <date>] [--until <date>] [--offset <n>] [--limit <n>] [--query <text>] [--role <user|assistant>]`;

const SUBCOMMANDS = new Set(["search", "list", "show"]);
const VALUE_OPTIONS = new Set([
  "--project",
  "--since",
  "--until",
  "--limit",
  "--offset",
  "--query",
  "--role",
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const JSON_TEXT_MAX_CHARS = 2000;
const AMBIGUOUS_CANDIDATE_LIMIT = 20;

type Options = {
  positional: string[];
  json: boolean;
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  query?: string;
  role?: RoleFilter;
};

type RunEnv = { cwd: string; homeDir: string };

export async function run(
  argv: string[],
  env: RunEnv = { cwd: process.cwd(), homeDir: homedir() },
): Promise<number> {
  const [subcommand, ...args] = argv;
  if (subcommand === undefined || !SUBCOMMANDS.has(subcommand)) {
    console.error(USAGE);
    return 1;
  }
  let options: Options;
  try {
    options = parseArgs(args);
    validateCommandOptions(subcommand, options);
  } catch (error) {
    console.error(`session-search: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 1;
  }
  const dateError = validateDates(options);
  if (dateError !== null) {
    console.error(`session-search: ${dateError}`);
    console.error(USAGE);
    return 1;
  }
  const positionalCount = subcommand === "search" || subcommand === "show" ? 1 : 0;
  if (options.positional.length !== positionalCount) {
    console.error(USAGE);
    return 1;
  }
  try {
    return await dispatch(subcommand, options, env);
  } catch (error) {
    console.error(`session-search: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function dispatch(subcommand: string, options: Options, env: RunEnv): Promise<number> {
  const root = sessionsRootDir(env.homeDir);
  const filters: SessionFilters = {
    project: options.project,
    since: options.since,
    until: options.until,
  };
  if (subcommand === "search") return runSearchCommand(root, filters, options);
  if (subcommand === "list") return runListCommand(root, filters, options);
  return runShowCommand(root, filters, options);
}

async function runSearchCommand(
  root: string,
  filters: SessionFilters,
  options: Options,
): Promise<number> {
  const files = listSessionFiles(root, filters);
  const hits = await runSearch(files, options.positional[0]!, {
    limit: options.limit,
    role: options.role,
  });
  if (options.json) {
    for (const hit of hits) {
      console.log(JSON.stringify({ ...hit, text: excerpt(hit.text, JSON_TEXT_MAX_CHARS) }));
    }
  } else {
    for (const hit of hits) console.log(formatSearchHit(hit));
  }
  return 0;
}

async function runListCommand(
  root: string,
  filters: SessionFilters,
  options: Options,
): Promise<number> {
  const files = listSessionFiles(root, filters);
  const stats = files
    .map(statSessionFile)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const shownStats = options.limit === undefined ? stats : stats.slice(0, options.limit);
  for (const stat of shownStats) {
    const title = await readSessionTitle(stat.path);
    if (options.json) {
      console.log(
        JSON.stringify({
          id: stat.sessionId,
          project: stat.project,
          path: stat.path,
          started: stat.startedAt,
          updated: stat.updatedAt.toISOString(),
          sizeBytes: stat.sizeBytes,
          title,
        }),
      );
    } else {
      console.log(formatListRow(stat, title));
    }
  }
  return 0;
}

async function runShowCommand(
  root: string,
  filters: SessionFilters,
  options: Options,
): Promise<number> {
  const files = listSessionFiles(root, filters);
  const resolution = resolveSessionById(files, options.positional[0]!);
  if (resolution.status === "notFound") {
    console.error(`session-search: no session matches id: ${options.positional[0]}`);
    return 1;
  }
  if (resolution.status === "ambiguous") {
    console.error(
      `session-search: ambiguous id: ${options.positional[0]} (${resolution.candidates.length} sessions)`,
    );
    for (const candidate of resolution.candidates.slice(0, AMBIGUOUS_CANDIDATE_LIMIT)) {
      console.error(
        `  ${candidate.sessionId.slice(0, 8)} ${candidate.startedAt} ${candidate.project}`,
      );
    }
    return 1;
  }
  const page = await loadReadingPage(resolution.file.path, resolution.file.sessionId, options);
  console.log(options.json ? JSON.stringify(page) : formatReadingPage(page, options.query));
  return 0;
}

function validateDates(options: Options): string | null {
  if (options.since !== undefined && !DATE_PATTERN.test(options.since)) {
    return `--since must be YYYY-MM-DD: ${options.since}`;
  }
  if (options.until !== undefined && !DATE_PATTERN.test(options.until)) {
    return `--until must be YYYY-MM-DD: ${options.until}`;
  }
  return null;
}

function parseArgs(args: string[]): Options {
  const options: Options = { positional: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      if (arg === "--project") options.project = value;
      else if (arg === "--since") options.since = value;
      else if (arg === "--until") options.until = value;
      else if (arg === "--offset") options.offset = positiveInt(arg, value);
      else if (arg === "--query") options.query = value;
      else if (arg === "--role") {
        if (value !== "user" && value !== "assistant") throw new Error(`invalid role: ${value}`);
        options.role = value;
      } else options.limit = positiveInt(arg, value);
      i++;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`unknown option: ${arg}`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

function validateCommandOptions(subcommand: string, options: Options): void {
  if (options.role !== undefined && subcommand !== "search" && subcommand !== "show") {
    throw new Error(`--role is not supported by ${subcommand}`);
  }
  if (subcommand !== "show" && (options.offset !== undefined || options.query !== undefined)) {
    throw new Error(`--offset and --query are only supported by show`);
  }
}

function positiveInt(option: string, raw: string): number {
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${option} must be a positive integer: ${raw}`);
  }
  return number;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
