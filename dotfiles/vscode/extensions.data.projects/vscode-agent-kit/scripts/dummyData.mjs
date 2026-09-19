// Builds an isolated PI_CODING_AGENT_DIR with three dummy active sessions so
// the captured Agent Sessions view shows real content without touching the
// user's session data or metadata store.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A dummy session to render in the captured view.
 * @typedef {object} DummySession
 * @property {string | undefined} name session_info name; omitted entries fall
 *   back to the first user message for their display name.
 * @property {string} text first user message text.
 */

/** @type {DummySession[]} */
const DUMMY_SESSIONS = [
  {
    // Named via session_info (e.g. /name in pi).
    name: "Stabilize terminal launcher",
    text: "Check into the flaky terminal reuse when switching sessions quickly",
  },
  {
    name: undefined,
    text: "Refactor the metadata store for concurrent writes and add regression tests",
  },
  {
    name: undefined,
    text: "Investigate session refresh missing files written by another window",
  },
];

/** All dummy sessions share this cwd so they render as one group. */
export const DUMMY_CWD = "/home/demo/pi-demo";
/** Base timestamp; sessions are staggered a few minutes apart. */
export const DUMMY_BASE_TIME = new Date("2026-09-19T09:00:00Z");

/**
 * Write one dummy session file and mark it active in the metadata map.
 * @param {string} sessionsDir directory that receives the .jsonl file.
 * @param {DummySession} dummy session contents.
 * @param {number} index position of the session, used to stagger timestamps.
 * @param {Record<string, { active: boolean }>} sessions metadata map to update.
 */
function writeDummySession(sessionsDir, dummy, index, sessions) {
  const id = randomUUID();
  // Stagger timestamps so the list order and descriptions are visible.
  const timestamp = new Date(DUMMY_BASE_TIME.getTime() - index * 3 * 60_000).toISOString();
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: DUMMY_CWD })];
  if (dummy.name !== undefined) {
    lines.push(JSON.stringify({ type: "session_info", timestamp, name: dummy.name }));
  }
  lines.push(
    JSON.stringify({
      type: "message",
      id: randomUUID().slice(0, 8),
      timestamp,
      message: { role: "user", content: [{ type: "text", text: dummy.text }] },
    }),
  );
  // Pi's file name convention: <ISO timestamp with - separators>_<session id>.jsonl
  const filePath = path.join(sessionsDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  const mtime = new Date(timestamp);
  utimesSync(filePath, mtime, mtime);
  sessions[id] = { active: true };
}

/**
 * Build the isolated agent directory with three dummy active sessions.
 * Any existing directory at the target is removed first, so the result is
 * always a fresh environment. Files are only ever written below `dataDir`.
 * @param {string} [dataDir] root of the isolated agent directory.
 * @returns {string} the data directory to pass as PI_CODING_AGENT_DIR.
 */
export function buildDummyDataDir(
  dataDir = path.join(tmpdir(), "pi-sessions-screenshot-data"),
) {
  const sessionsDir = path.join(dataDir, "sessions", "demo");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });

  /** @type {Record<string, { active: boolean }>} */
  const sessions = {};
  DUMMY_SESSIONS.forEach((dummy, index) => writeDummySession(sessionsDir, dummy, index, sessions));
  writeFileSync(
    path.join(dataDir, "session-metadata.json"),
    JSON.stringify({ version: 1, sessions }),
  );
  return dataDir;
}
