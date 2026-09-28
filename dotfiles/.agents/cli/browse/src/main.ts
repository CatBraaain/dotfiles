// browse CLI — one CLI for web search, web fetch and the shared camoufox
// server. Started as `bun ~/.agents/cli/browse` (bun resolves package.json's
// main field to this file), so no exec bit or dependencies are required.
// Spec: dotfiles/.agents/cli/browse/browse.spec.md
//
// Subcommands:
//   browse search "<query>" [--lang <code>] [--json]
//   browse fetch <url> [--json]
//   browse server start     ensure the camoufox server is running (idempotent)
//   browse server restart   stop and respawn the camoufox server (hang recovery)
//   browse display show|hide  toggle VNC display access
//
// The `__server` subcommand is internal: it is the camoufox server process
// itself, spawned detached by `browse server start` (and by search/fetch when
// they find the server down). It stays running until the machine shuts down or
// the process is killed.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockedBrowseArgs } from "./backends";
import {
  CAMOUFOX_LOCK_FILE,
  LOCKED_SUBCOMMAND,
  SERVER_SUBCOMMAND,
  stateDir,
} from "./config";
import { runX11vncRequest } from "./display";
import { fetchOne } from "./fetch";
import { fetchJson, formatSearchMarkdown, searchJson } from "./output";
import { searchOne } from "./search";
import {
  restartCamoufoxServer,
  runCamoufoxServer,
  startCamoufoxServer,
} from "./server";
import { emitJson, fail, usageFail } from "./util";

// The CLI project directory (the parent of src/): the flock re-exec goes
// through `bun <projectDir>` so bun resolves package.json's main field again.
const projectDir = dirname(import.meta.dir);

// Cross-process serialization protects the shared Camoufox server. The whole
// command re-executes as a child of `flock`, so the kernel releases the lock
// even when the holder crashes; the lock file is only an anchor and may stay
// behind. A single lock also prevents search/fetch and start/restart races.
async function runSerialized(run: () => Promise<void>): Promise<void> {
  if (process.argv[2] === LOCKED_SUBCOMMAND) return run();
  const stateDirPath = stateDir();
  const lockPath = join(stateDirPath, CAMOUFOX_LOCK_FILE);
  // flock(1) does not create the lock file's parent directory.
  mkdirSync(stateDirPath, { recursive: true });
  const result = spawnSync(
    "flock",
    [
      lockPath,
      process.execPath,
      projectDir,
      ...lockedBrowseArgs(LOCKED_SUBCOMMAND, process.argv.slice(2)),
    ],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) return run(); // flock(1) unavailable (e.g. Windows): run unlocked
  process.exit(result.status ?? 1);
}

// --- argument parsing ---

const USAGE = `usage: browse search "<query>" [--lang <code>] [--json]
       browse fetch <url> [--json]
       browse server start
       browse server restart
       browse display show
       browse display hide`;

const SEARCH_USAGE = `usage: browse search "<query>" [--lang <code>] [--json]`;
const FETCH_USAGE = `usage: browse fetch <url> [--json]`;
const DISPLAY_USAGE = `usage: browse display show
       browse display hide`;
const SERVER_USAGE = `usage: browse server start
       browse server restart`;

interface SearchArgs {
  query: string;
  lang?: string;
  json: boolean;
}

function parseSearchArgs(argv: string[]): SearchArgs {
  const flags: { json: boolean; lang?: string } = { json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") flags.json = true;
    else if (arg === "--lang") flags.lang = argv[++i] ?? usageFail(SEARCH_USAGE);
    else if (arg.startsWith("--")) usageFail(SEARCH_USAGE);
    else positional.push(arg);
  }
  if (positional.length !== 1) usageFail(SEARCH_USAGE);
  return { ...flags, query: positional[0]! };
}

interface FetchArgs {
  url: string;
  json: boolean;
}

function parseFetchArgs(argv: string[]): FetchArgs {
  const flags = { json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") flags.json = true;
    else if (arg.startsWith("--")) usageFail(FETCH_USAGE);
    else positional.push(arg);
  }
  if (positional.length !== 1) usageFail(FETCH_USAGE);
  return { ...flags, url: positional[0]! };
}

// Spec: 引数が絶対 URL でない → エラー 1 行を stderr へ出力し、終了コード 1。
function isAbsoluteUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

// --- subcommand dispatch ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [subcommand, ...rest] =
    args[0] === LOCKED_SUBCOMMAND ? args.slice(1) : args;
  switch (subcommand) {
    case "search":
      await searchCommand(rest);
      break;
    case "fetch":
      await fetchCommand(rest);
      break;
    case "server":
      await serverCommand(rest);
      break;
    case "display":
      displayCommand(rest);
      break;
    case SERVER_SUBCOMMAND:
      await runCamoufoxServer();
      break;
    default:
      usageFail(USAGE);
  }
}

async function searchCommand(argv: string[]): Promise<void> {
  const args = parseSearchArgs(argv);
  await runSerialized(async () => {
    const outcome = await searchOne(args.query, args.lang);
    if (args.json) emitJson(searchJson(args.query, outcome));
    else console.log(formatSearchMarkdown(args.query, outcome));
  });
}

async function fetchCommand(argv: string[]): Promise<void> {
  const args = parseFetchArgs(argv);
  if (!isAbsoluteUrl(args.url)) fail(`not an absolute URL: ${args.url}`);
  await runSerialized(async () => {
    const outcome = await fetchOne(args.url);
    if (args.json) emitJson(fetchJson(args.url, outcome));
    else console.log(outcome.markdown);
  });
}

function displayCommand(argv: string[]): void {
  const action = argv[0];
  if (argv.length !== 1 || (action !== "show" && action !== "hide")) {
    usageFail(DISPLAY_USAGE);
  }
  const requests = action === "show" ? ["nodeny"] : ["deny", "disconnect:all"];
  for (const request of requests) runX11vncRequest(request, action);
}

// Spec: `server` の action がない・未知の action・余分な引数 → `browse server` の usage。
function serverCommand(argv: string[]): Promise<void> {
  const [action, ...extra] = argv;
  if (extra.length > 0) usageFail(SERVER_USAGE);
  if (action === "start") return runSerialized(startCamoufoxServer);
  if (action === "restart") return runSerialized(restartCamoufoxServer);
  usageFail(SERVER_USAGE);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

