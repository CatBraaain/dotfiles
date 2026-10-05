// Shared configuration: environment-resolved endpoints, the machine-local
// state directory and stage timeouts (spec: browse.spec.md "タイムアウト").

import { homedir } from "node:os";
import { join } from "node:path";

export const SERVER_WAIT_TIMEOUT_MS = 15_000;
export const RENDER_TIMEOUT_MS = 30_000;
export const PARSE_TIMEOUT_MS = 15_000;
export const CONVERT_TIMEOUT_MS = 15_000;
export const REDDIT_TIMEOUT_MS = 15_000;
export const STACKOVERFLOW_TIMEOUT_MS = 15_000;
export const SERVER_STOP_TIMEOUT_MS = 10_000;
// Spec: yt-dlp による YouTube メタデータ・字幕の取得は 60 秒。
export const YTDLP_TIMEOUT_MS = 60_000;
// Spec: twikit_client.py の実行（login・ツイート・タイムライン・検索）は 120 秒。
export const TWIKIT_TIMEOUT_MS = 120_000;
// Spec: login の待ち合わせは poll 間隔 5 秒・上限 10 分。
export const LOGIN_POLL_INTERVAL_MS = 5_000;
export const LOGIN_WAIT_TIMEOUT_MS = 600_000;
// Twitter 取得用の cookie と login 専用 session。
export const TWITTER_COOKIE_FILE = "twitter-cookies.json";
export const TWITTER_LOGIN_SESSION_KEY = "twitter-login";

export const SERVER_HEALTH_POLL_INTERVAL_MS = 250;
export const WEBSOCKET_HEALTH_TIMEOUT_MS = 1_000;
export const FUNCTIONAL_HEALTH_TIMEOUT_MS = 5_000;

export const CAMOUFOX_DEFAULT_BASE_URL = "ws://127.0.0.1:9378/camoufox";
export const OPENSERP_DEFAULT_BASE_URL = "http://127.0.0.1:7000";
// Base names of the playwright-cli sessions; the render slot number (or the
// pid when flock(1) is unavailable) is appended per run (camoufoxSessionKey).
export const CAMOUFOX_SEARCH_SESSION_KEY = "web-search";
export const CAMOUFOX_FETCH_SESSION_KEY = "web-fetch";
// Fixed key: the functional health check is coordinated by the restart lock
// and never runs concurrently with renders.
export const CAMOUFOX_HEALTH_SESSION_KEY = "web-health";
// Internal subcommand that re-executes the whole CLI under a slot flock(1).
export const LOCKED_SUBCOMMAND = "__locked";
// Internal subcommand that runs the camoufox server process itself.
export const SERVER_SUBCOMMAND = "__server";

// Render capacity is a semaphore of flock(1) slot locks (spec: render スロット
// セマフォ（既定 4 スロット）). The restart lock arbitrates server restarts.
export const SLOT_COUNT = 4;
// Poll interval (seconds, flock -w) while waiting for a busy render slot;
// short enough to notice an in-flight restart and yield to it (spec: 让位).
export const SLOT_WAIT_POLL_SECONDS = 0.2;
// flock(1)'s exit code for "-n and the lock is held" (via -E). browse commands
// only ever exit 0 or 1, so this value unambiguously marks a busy slot.
export const FLOCK_CONFLICT_EXIT_CODE = 192;
// Environment variable carrying the acquired slot number into the re-exec.
export const SLOT_ENV = "BROWSE_SLOT";
export const RESTART_LOCK_FILE = "browse-restart.lock";

export function slotLockFile(slot: number): string {
  return `browse-slot-${slot}.lock`;
}

export function currentSlotNumber(): number | undefined {
  const raw = process.env[SLOT_ENV];
  if (raw === undefined) return undefined;
  const slot = Number.parseInt(raw, 10);
  return Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT ? slot : undefined;
}

// Per-run playwright-cli session keys. Slot acquisition is exclusive, so the
// slot number names the session and keys cannot collide; without flock(1) the
// pid stands in for the slot so concurrent runs never share a session either
// way.
export function camoufoxSessionKey(base: string): string {
  const slot = currentSlotNumber();
  return slot === undefined ? `${base}-${process.pid}` : `${base}-${slot}`;
}

export function camoufoxBaseUrl(): string {
  return process.env.CAMOUFOX_BASE_URL ?? CAMOUFOX_DEFAULT_BASE_URL;
}

export function openserpBaseUrl(): string {
  return process.env.OPENSERP_BASE_URL ?? OPENSERP_DEFAULT_BASE_URL;
}

// Log, lock, pid file and playwright-cli config all live next to the shared
// camoufox-server log (spec: "camoufox server のログは
// <XDG_CACHE_HOME または ~/.cache>/pi/web-search/camoufox-server.log へ追記").
export function stateDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi", "web-search");
}
