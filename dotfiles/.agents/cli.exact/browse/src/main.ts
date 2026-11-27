import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { lockedBrowseArgs } from "./backends";
import {
  LOCK_CONFLICT_EXIT_CODE,
  LOCKED_SUBCOMMAND,
  RESTART_LOCK_FILE,
  SLOT_COUNT,
  SLOT_WAIT_POLL_SECONDS,
  SERVER_SUBCOMMAND,
  slotLockFile,
  stateDir,
  withLockCli,
} from "./config";
import { runX11vncRequest } from "./display";
import { fetchOne, fetchRoute } from "./fetch";
import { loginTwitter } from "./twitter-auth";
import { fetchJson, formatSearchMarkdown, searchJson } from "./output";
import { searchOne } from "./search";
import {
  camoufoxServerPort,
  restartCamoufoxServer,
  restartInFlight,
  runCamoufoxServer,
  startCamoufoxServer,
  stopCamoufoxServer,
  waitForRestartToFinish,
} from "./server";
import { emitJson, fail, selfRunArgv, usageFail } from "./util";

// Cross-process coordination protects the shared Camoufox server. Render
// capacity is a 4-slot semaphore: a camoufox search/fetch re-executes itself
// as a child of the with-lock CLI holding one slot lock, so the OS releases the
// lock even when the holder crashes. Reddit / StackOverflow fetches and
// `server start` need no slot;
async function runInSlot(run: () => Promise<void>): Promise<void> {
  if (process.platform === "win32") return run();
  if (process.argv[2] === LOCKED_SUBCOMMAND) {
    // Spec: 獲得の直後にも restart ロックの保持を探知し、進行していれば让位する。
    // Exiting with the conflict code makes the parent treat the slot as busy;
    // the with-lock process releases it as this process exits.
    if (restartInFlight()) process.exit(LOCK_CONFLICT_EXIT_CODE);
    return run();
  }
  const lock = withLockCli();
  if (lock === undefined) return run();
  const stateDirPath = stateDir();
  while (true) {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const outcome = runUnderSlotLock(lock, stateDirPath, slot, "probe");
      if (outcome === "lock-unavailable") return run();
      if (outcome === "busy") continue;
    }
    // All slots busy (or their winners just yielded): if a restart is in
    // flight, wait it out before retrying; otherwise wait for a slot briefly
    // (with-lock -w, no busy loop) and re-probe. A freed slot is picked up on
    // the next pass.
    if (restartInFlight()) {
      waitForRestartToFinish();
      continue;
    }
    const outcome = runUnderSlotLock(lock, stateDirPath, 0, "wait");
    if (outcome === "lock-unavailable") return run();
  }
}

type LockOutcome = "ran" | "busy" | "lock-unavailable";

function runUnderSlotLock(
  lock: string,
  stateDirPath: string,
  slot: number,
  mode: "probe" | "wait",
): LockOutcome {
  const options =
    mode === "probe"
      ? ["-n", "-E", String(LOCK_CONFLICT_EXIT_CODE)]
      : ["-w", String(SLOT_WAIT_POLL_SECONDS), "-E", String(LOCK_CONFLICT_EXIT_CODE)];
  const result = spawnSync(
    lock,
    [
      ...options,
      join(stateDirPath, slotLockFile(slot)),
      ...selfRunArgv,
      ...lockedBrowseArgs(LOCKED_SUBCOMMAND, process.argv.slice(2)),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, BROWSE_SLOT: String(slot) },
    },
  );
  if (result.error) return "lock-unavailable";
  if (result.status === LOCK_CONFLICT_EXIT_CODE) return "busy";
  process.exit(result.status ?? 1);
}

// --- argument parsing ---

const USAGE = `usage: browse search "<query>" [--lang <code>] [--json]
       browse fetch <url> [--json]
       browse login twitter
       browse server start
       browse server stop
       browse server restart
       browse display show
       browse display hide`;

const SEARCH_USAGE = `usage: browse search "<query>" [--lang <code>] [--json]`;
const FETCH_USAGE = `usage: browse fetch <url> [--json]`;
const LOGIN_USAGE = `usage: browse login twitter`;
const DISPLAY_USAGE = `usage: browse display show
       browse display hide`;
const SERVER_USAGE = `usage: browse server start
       browse server stop
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
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
    return;
  }

  const [subcommand, ...rest] = args[0] === LOCKED_SUBCOMMAND ? args.slice(1) : args;
  switch (subcommand) {
    case "search":
      await searchCommand(rest);
      break;
    case "fetch":
      await fetchCommand(rest);
      break;
    case "login":
      await loginCommand(rest);
      break;
    case "server":
      await serverCommand(rest);
      break;
    case "display":
      displayCommand(rest);
      break;
    case SERVER_SUBCOMMAND:
      if (rest.length !== 1 || rest[0] !== camoufoxServerPort()) {
        fail("The internal Camoufox server requires the configured port");
      }
      await runCamoufoxServer();
      break;
    default:
      usageFail(USAGE);
  }
}

async function loginCommand(argv: string[]): Promise<void> {
  const [target, ...extra] = argv;
  if (extra.length > 0 || target !== "twitter") usageFail(LOGIN_USAGE);
  if (process.platform === "win32") {
    console.error("browse login twitter is not supported on Windows.");
    return;
  }
  await runInSlot(loginTwitter);
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
  // Spec: Reddit / StackOverflow / YouTube / Twitter / Hacker News /
  // Wikipedia / arXiv の専用経路は camoufox を使わないため render スロットを
  // 取得せず待ち合わせない。GitHub は camoufox へのフォールバックを持つため
  // 取得する。
  const route = fetchRoute(args.url);
  if (route === "camoufox" || route === "github") await runInSlot(emit);
  else await emit();
}

function displayCommand(argv: string[]): void {
  const action = argv[0];
  if (argv.length !== 1 || (action !== "show" && action !== "hide")) {
    usageFail(DISPLAY_USAGE);
  }
  if (process.platform === "win32") {
    console.error(`browse display ${action} is not supported on Windows.`);
    return;
  }
  const requests = action === "show" ? ["nodeny"] : ["deny", "disconnect:all"];
  for (const request of requests) runX11vncRequest(request, action);
}

// Spec: `server` の action がない・未知の action・余分な引数 → `browse server` の usage。
function serverCommand(argv: string[]): Promise<void> {
  const [action, ...extra] = argv;
  if (extra.length > 0) usageFail(SERVER_USAGE);
  if (action === "start") return startCamoufoxServer();
  if (action === "stop" || action === "restart") return runAfterDrainingRenderSlots(action);
  usageFail(SERVER_USAGE);
}

async function runAfterDrainingRenderSlots(action: "stop" | "restart"): Promise<void> {
  const run = action === "stop" ? stopCamoufoxServer : restartCamoufoxServer;
  if (process.platform === "win32" || process.argv[2] === LOCKED_SUBCOMMAND) return run();
  const lock = withLockCli();
  if (lock === undefined) return run();
  const stateDirPath = stateDir();
  const chain = [join(stateDirPath, RESTART_LOCK_FILE)];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    chain.push(lock, join(stateDirPath, slotLockFile(slot)));
  }
  const result = spawnSync(
    lock,
    [...chain, ...selfRunArgv, ...lockedBrowseArgs(LOCKED_SUBCOMMAND, process.argv.slice(2))],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || action === "restart") return run();
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
