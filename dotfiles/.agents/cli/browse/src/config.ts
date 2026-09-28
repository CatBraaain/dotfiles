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

export const SERVER_HEALTH_POLL_INTERVAL_MS = 250;
export const WEBSOCKET_HEALTH_TIMEOUT_MS = 1_000;
export const FUNCTIONAL_HEALTH_TIMEOUT_MS = 5_000;

export const CAMOUFOX_DEFAULT_BASE_URL = "ws://127.0.0.1:9378/camoufox";
export const OPENSERP_DEFAULT_BASE_URL = "http://127.0.0.1:7000";
export const CAMOUFOX_SEARCH_SESSION_KEY = "web-search";
export const CAMOUFOX_FETCH_SESSION_KEY = "web-fetch";
export const CAMOUFOX_HEALTH_SESSION_KEY = "web-health";
// Internal subcommand that re-executes the whole CLI under flock(1).
export const LOCKED_SUBCOMMAND = "__locked";
// Internal subcommand that runs the camoufox server process itself.
export const SERVER_SUBCOMMAND = "__server";
export const CAMOUFOX_LOCK_FILE = "camoufox.lock";

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
