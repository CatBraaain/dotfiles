import { constants, lstatSync, openSync, closeSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";

const instanceId = Type.String({ pattern: "^[a-f0-9-]{36}$" });
const absolutePath = Type.String({ pattern: "^/" });
const sessionFile = Type.Union([absolutePath, Type.Null()]);

export const startupSchema = Type.Object({
  version: Type.Literal(1),
  instanceId,
  sessionId: Type.String({ minLength: 1 }),
  socketPath: absolutePath,
  editorText: Type.String(),
  provisionalSessionFile: Type.Optional(absolutePath),
});

export const manifestSchema = Type.Object({
  version: Type.Literal(1),
  execPath: absolutePath,
  execArgv: Type.Array(Type.String()),
  argv: Type.Array(Type.String(), { minItems: 1 }),
  cwd: absolutePath,
  env: Type.Record(Type.String(), Type.String()),
  startup: startupSchema,
});

export const connectionSchema = Type.Object({
  version: Type.Literal(1),
  instanceId,
  sessionId: Type.String({ minLength: 1 }),
  sessionFile,
  socketPath: absolutePath,
  serverPid: Type.Integer({ minimum: 1 }),
  tmuxSessionId: Type.String({ pattern: "^\\$[0-9]+$" }),
  sessionName: Type.String({ minLength: 1 }),
  windowId: Type.String({ pattern: "^@[0-9]+$" }),
  paneId: Type.String({ pattern: "^%[0-9]+$" }),
  tty: absolutePath,
  pid: Type.Integer({ minimum: 1 }),
  pidStartTime: Type.String({ pattern: "^[0-9]+$" }),
});

export function readPrivateJson(path, schema) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPrivatePath(path, false);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw new Error(`Cannot read private JSON: ${path}`);
    }
    if (!Value.Check(schema, parsed)) throw new Error(`Invalid private JSON: ${path}`);
    return parsed;
  } finally {
    closeSync(fd);
  }
}

export function assertPrivatePath(path, directory) {
  const stat = lstatSync(path);
  const validType = directory ? stat.isDirectory() : stat.isFile();
  if (!validType || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe private path: ${path}`);
  }
}

export const PARENT_PI_ENV_KEYS = [
  "PI_TMUX_HANDOFF",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

export function cleanEnvironment(env) {
  const clean = { ...env };
  for (const key of ["TMUX", "TMUX_PANE", ...PARENT_PI_ENV_KEYS]) delete clean[key];
  return Object.fromEntries(Object.entries(clean).filter(([, value]) => value !== undefined));
}
