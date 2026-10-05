// browse CLI — one CLI for web search, web fetch and the shared camoufox
// server. Started as `bun ~/.agents/cli/browse` (bun resolves package.json's
// main field to this file), so no exec bit or dependencies are required.
// Spec: dotfiles/.agents/cli.exact/browse/browse.spec.md
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
  FLOCK_CONFLICT_EXIT_CODE,
  LOCKED_SUBCOMMAND,
  RESTART_LOCK_FILE,
  SLOT_COUNT,
  SLOT_WAIT_POLL_SECONDS,
  SERVER_SUBCOMMAND,
  slotLockFile,
  stateDir,
} from "./config";
import { runX11vncRequest } from "./display";
import { fetchOne, fetchRoute } from "./fetch";
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

// Cross-process coordination protects the shared Camoufox server. Render
// capacity is a 4-slot semaphore: a camoufox search/fetch re-executes itself
// as a child of `flock` holding one slot lock, so the kernel releases the lock
// even when the holder crashes; the lock file is only an anchor and may stay
// behind. Reddit / StackOverflow fetches and `server start` need no slot;
// `server restart` drains all four (see restartCommand and server.ts). While
// waiting, renders yield to an in-flight restart so it can cut to the head of
// the queue (spec: 待機中と獲得の直後には restart ロックの保持を探知し…让位する).
async function runInSlot(run: () => Promise<void>): Promise<void> {
  if (process.argv[2] === LOCKED_SUBCOMMAND) {
    // Spec: 獲得の直後にも restart ロックの保持を探知し、進行していれば让位する。
    // Exiting with the conflict code makes the parent treat the slot as busy;
    // the flock wrapper releases it as this process exits.
    if (restartInFlight()) process.exit(FLOCK_CONFLICT_EXIT_CODE);
    return run();
  }
  const stateDirPath = stateDir();
  // flock(1) does not create the lock file's parent directory.
  mkdirSync(stateDirPath, { recursive: true });
  while (true) {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const outcome = runUnderSlotFlock(stateDirPath, slot, "probe");
      if (outcome === "flock-unavailable") return run(); // no flock(1) (e.g. Windows): run unlocked
      if (outcome === "busy") continue;
    }
    // All slots busy (or their winners just yielded): if a restart is in
    // flight, wait it out before retrying; otherwise wait for a slot briefly
    // (kernel sleep, no busy loop) and re-probe. A freed slot is picked up on
    // the next pass.
    if (restartInFlight()) {
      waitForRestartToFinish();
      continue;
    }
    const outcome = runUnderSlotFlock(stateDirPath, 0, "wait");
    if (outcome === "flock-unavailable") return run();
  }
}

type FlockOutcome = "ran" | "busy" | "flock-unavailable";

function runUnderSlotFlock(
  stateDirPath: string,
  slot: number,
  mode: "probe" | "wait",
): FlockOutcome {
  const options =
    mode === "probe"
      ? ["-n", "-E", String(FLOCK_CONFLICT_EXIT_CODE)]
      : ["-w", String(SLOT_WAIT_POLL_SECONDS), "-E", String(FLOCK_CONFLICT_EXIT_CODE)];
  const result = spawnSync(
    "flock",
    [
      ...options,
      join(stateDirPath, slotLockFile(slot)),
      process.execPath,
      projectDir,
      ...lockedBrowseArgs(LOCKED_SUBCOMMAND, process.argv.slice(2)),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, BROWSE_SLOT: String(slot) },
    },
  );
  if (result.error) return "flock-unavailable";
  if (result.status === FLOCK_CONFLICT_EXIT_CODE) return "busy";
  process.exit(result.status ?? 1);
}

// Spec: restart ロックの保持を探知する。Acquiring it for a no-op (and letting
// go right away) means no restart is in flight; a lost probe means `browse
// server restart` or a render-recovery restart holds the lock. Crashes cannot
// wedge this: the kernel releases the flock, unlike a flag file.
export function restartInFlight(): boolean {
  const probe = spawnSync(
    "flock",
    ["-n", "-E", String(FLOCK_CONFLICT_EXIT_CODE), join(stateDir(), RESTART_LOCK_FILE), "true"],
  );
  if (probe.error) return false; // no flock(1): no restart queue to yield to
  return probe.status === FLOCK_CONFLICT_EXIT_CODE;
}

// Block until the in-flight restart releases the restart lock (running a
// no-op under it, then letting go again right away).
function waitForRestartToFinish(): void {
  const result = spawnSync("flock", [join(stateDir(), RESTART_LOCK_FILE), "true"]);
  if (result.error) return; // no flock(1): nothing to wait for
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
  await runInSlot(async () => {
    const outcome = await searchOne(args.query, args.lang);
    if (args.json) emitJson(searchJson(args.query, outcome));
    else console.log(formatSearchMarkdown(args.query, outcome));
  });
}

async function fetchCommand(argv: string[]): Promise<void> {
  const args = parseFetchArgs(argv);
  if (!isAbsoluteUrl(args.url)) fail(`not an absolute URL: ${args.url}`);
  const emit = async (): Promise<void> => {
    const outcome = await fetchOne(args.url);
    if (args.json) emitJson(fetchJson(args.url, outcome));
    else console.log(outcome.markdown);
  };
  // Spec: Reddit / StackOverflow の専用経路は camoufox を使わないため render
  // スロットを取得せず待ち合わせない。
  if (fetchRoute(args.url) === "camoufox") await runInSlot(emit);
  else await emit();
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
  if (action === "start") return startCamoufoxServer();
  if (action === "restart") return restartCommand();
  usageFail(SERVER_USAGE);
}

// Spec: `browse server restart` は restart ロックと 4 つすべての render スロット
// を獲得してから再起動する（drain: 実行中の render は完了まで、新規の render は
// 再起動完了まで待たされる）。再実行した子は `__locked` 付きなので本体を直接
// 実行する。flock(1) が無い環境では獲得せずに再起動する。
async function restartCommand(): Promise<void> {
  if (process.argv[2] === LOCKED_SUBCOMMAND) return restartCamoufoxServer();
  const stateDirPath = stateDir();
  // flock(1) does not create the lock file's parent directory.
  mkdirSync(stateDirPath, { recursive: true });
  const chain = ["flock", join(stateDirPath, RESTART_LOCK_FILE)];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    chain.push("flock", join(stateDirPath, slotLockFile(slot)));
  }
  const result = spawnSync(
    "flock",
    [
      ...chain,
      process.execPath,
      projectDir,
      ...lockedBrowseArgs(LOCKED_SUBCOMMAND, process.argv.slice(2)),
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) return restartCamoufoxServer(); // no flock(1): nothing to drain
  process.exit(result.status ?? 1);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

