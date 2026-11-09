import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Operation = { kind: "new" } | { kind: "open"; id: string };
type Session = { id: string; cwd: string; file: string };
type Pane = Session & { pane: string; session: string; name: string };
type Config = ReturnType<typeof configuration>;

const EMPTY_SESSION = "pi-empty";
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const GENERATED_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "TERM",
  "SHELL",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
]);
const PARENT_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_AGENT_NAME",
  "PI_AGENT_CONFIG",
  "PI_TMUX_SESSION_ID",
]);
const PANE_FORMAT =
  "#{pane_id}\t#{session_id}\t#{session_name}\t#{@pi-tmux-session}\t#{pane_pid}\t#{pane_dead}";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const operation = parseOperation(argv);
    const config = configuration();
    prepareDirectory(config.directory);
    const configured = await configuredSessionRoots(config);
    if (configured.preferred) rememberSessionRoot(config, configured.preferred);
    await tmux(config, ["start-server"]);
    await tmux(config, ["source-file", config.tmuxConfig]);
    const target =
      operation.kind === "new" ? await openNew(config) : await openSaved(config, operation.id);
    rememberSessionRoot(config, dirname(target.file));
    const client = Bun.spawn(
      [config.tmux, "-S", config.socket, "attach-session", "-t", target.session],
      { env: config.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return await client.exited;
  } catch (error) {
    console.error(`pimux: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function parseOperation(argv: string[]): Operation {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "new")) return { kind: "new" };
  if (
    argv.length === 2 &&
    argv[0] === "open" &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(argv[1]!)
  )
    return { kind: "open", id: argv[1]! };
  throw new Error("usage: pimux [new | open <session-id>]");
}

function configuration() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  if (!isAbsolute(runtime)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  const agentDir = expandPath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");
  const directory = join(runtime, "pi-tmux");
  const extension = join(agentDir, "extensions", "tmux-handoff", "index.ts");
  const tmuxConfig = join(agentDir, "extensions", "tmux-handoff", "tmux.conf");
  if (!existsSync(extension) || !existsSync(tmuxConfig))
    throw new Error(`Missing pimux extension or tmux configuration in ${agentDir}`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !PARENT_ENV_KEYS.has(entry[0]),
    ),
  );
  return {
    agentDir,
    directory,
    extension,
    tmuxConfig,
    env,
    socket: join(directory, "server.sock"),
    tmux: executable("tmux"),
    pi: executable("pi"),
  };
}

async function openNew(config: Config): Promise<Pane> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const panes = await livePanes(config);
    const empty = panes.filter((pane) => !existsSync(pane.file));
    if (empty.length > 1) throw new Error("Multiple unsaved new sessions are running");
    if (empty[0]) return empty[0];

    const reserved = await hasSession(config, EMPTY_SESSION);
    if (reserved) {
      const previous = (await livePanes(config)).find((pane) => pane.name === EMPTY_SESSION);
      if (!previous) {
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (!existsSync(previous.file)) return previous;
      const renamed = await tmux(
        config,
        ["rename-session", "-t", previous.session, sessionName(previous.id)],
        true,
      );
      if (renamed.exitCode !== 0) continue;
    }
    const id = randomUUID();
    const created = await createSession(config, { id, cwd: process.cwd() }, EMPTY_SESSION);
    if (created) return await waitForSession(config, created, id);
  }
  throw new Error("Timed out reserving an unsaved new session");
}

async function openSaved(config: Config, id: string): Promise<Pane> {
  const running = (await livePanes(config)).filter((pane) => pane.id === id);
  if (running.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const saved = await findSaved(
    config,
    id,
    running.map((pane) => dirname(pane.file)),
  );
  if (running[0]) return running[0];
  if (!saved) throw new Error(`Session not found (use the complete ID): ${id}`);
  if (!existsSync(saved.cwd) || !statSync(saved.cwd).isDirectory())
    throw new Error(`Session working directory does not exist: ${saved.cwd}`);
  const name = sessionName(id);
  const created = await createSession(config, saved, name);
  return await waitForSession(config, created ?? name, id);
}

async function createSession(
  config: Config,
  session: { id: string; cwd: string; file?: string },
  name: string,
): Promise<string | undefined> {
  const desired = { ...config.env, PI_TMUX_SESSION_ID: session.id };
  const global = await tmux(config, ["show-environment", "-gs"]);
  const assignments = global.stdout.replace(/"(?:\\.|[^"\\])*"/gs, "");
  const removed = [...assignments.matchAll(/; export ([^;\n]+);/g)]
    .map((match) => match[1]!)
    .filter((key) => !Object.hasOwn(desired, key) && !GENERATED_ENV_KEYS.has(key));
  const environment = Object.entries(desired).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const selection = session.file ? ["--session", session.file] : ["--session-id", session.id];
  const command = [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}",
    "-s",
    name,
    "-n",
    "pi",
    "-c",
    session.cwd,
    "-x",
    String(process.stdout.columns || 80),
    "-y",
    String(process.stdout.rows || 24),
    ...environment,
    "--",
    "/usr/bin/env",
    ...removed.flatMap((key) => ["-u", key]),
    config.pi,
    ...selection,
    "-e",
    config.extension,
  ]
    .map(quoteTmuxArgument)
    .join(" ");
  const result = await tmux(config, ["source-file", "-"], true, `${command}\n`);
  if (result.exitCode === 0) {
    const target = result.stdout.trim();
    if (!/^\$[0-9]+$/.test(target)) throw new Error("Cannot identify the created tmux session");
    return target;
  }
  if (await hasSession(config, name)) return undefined;
  throw new Error(`Cannot start pi session: ${result.stderr.trim()}`);
}

async function waitForSession(config: Config, target: string, expectedId: string): Promise<Pane> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pane = (await livePanes(config)).find((candidate) => candidate.id === expectedId);
    if (pane) return pane;
    if (!(await hasSession(config, target))) {
      const moved = (await livePanes(config)).find((candidate) => candidate.id === expectedId);
      if (moved) return moved;
      throw new Error(`pi exited before startup: ${expectedId}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`pi startup timed out: ${expectedId}`);
}

async function livePanes(config: Config): Promise<Pane[]> {
  const result = await tmux(config, ["list-panes", "-a", "-F", PANE_FORMAT], true);
  if (result.exitCode !== 0) {
    if (result.stderr.includes("no sessions") || result.stderr.includes("no current target"))
      return [];
    throw new Error(`Cannot inspect pi sessions: ${result.stderr.trim()}`);
  }
  return result.stdout
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const [pane, session, name, encoded, pid, dead] = line.split("\t");
      if (!pane || !session || !name || !encoded || dead !== "0") return [];
      const metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (
        typeof metadata?.id !== "string" ||
        typeof metadata.cwd !== "string" ||
        typeof metadata.file !== "string" ||
        !isAbsolute(metadata.cwd) ||
        !isAbsolute(metadata.file) ||
        metadata.pid !== Number(pid)
      )
        throw new Error(`Invalid pi session metadata in pane ${pane}`);
      return [{ pane, session, name, id: metadata.id, cwd: metadata.cwd, file: metadata.file }];
    });
}

async function hasSession(config: Config, name: string): Promise<boolean> {
  const target = name.startsWith("$") ? name : `=${name}`;
  return (await tmux(config, ["has-session", "-t", target], true)).exitCode === 0;
}

function sessionName(id: string): string {
  return `pi-${createHash("sha256").update(id).digest("hex")}`;
}

async function configuredSessionRoots(config: Config) {
  const settingPaths = [
    join(config.agentDir, "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ];
  const settings = await Promise.all(
    settingPaths.map(async (path) => {
      if (!existsSync(path)) return undefined;
      const parsed = Bun.JSONC.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`Invalid settings in ${path}`);
      const sessionDir = "sessionDir" in parsed ? parsed.sessionDir : undefined;
      if (sessionDir === undefined) return undefined;
      if (typeof sessionDir !== "string") throw new Error(`Invalid sessionDir in ${path}`);
      return expandPath(sessionDir);
    }),
  );
  const override = config.env.PI_CODING_AGENT_SESSION_DIR;
  const preferred = override ? expandPath(override) : settings[1] || settings[0];
  return {
    preferred,
    roots: [
      join(config.agentDir, "sessions"),
      ...settings.filter((path): path is string => Boolean(path)),
      ...(override ? [expandPath(override)] : []),
    ],
  };
}

function registryDirectory(config: Config): string {
  return join(config.agentDir, "pi-tmux", "session-dirs");
}

function rememberSessionRoot(config: Config, root: string): void {
  prepareDirectory(dirname(registryDirectory(config)));
  const directory = registryDirectory(config);
  prepareDirectory(directory);
  const key = createHash("sha256").update(root).digest("hex");
  const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(root) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, `${key}.json`));
}

async function rememberedSessionRoots(config: Config): Promise<string[]> {
  const directory = registryDirectory(config);
  if (!existsSync(directory)) return [];
  prepareDirectory(directory);
  const entries = await readdir(directory);
  return await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const path = join(directory, name);
        const root = JSON.parse(await readFile(path, "utf8"));
        if (typeof root !== "string" || !isAbsolute(root))
          throw new Error(`Invalid recorded session directory: ${path}`);
        return root;
      }),
  );
}

async function findSaved(
  config: Config,
  id: string,
  liveRoots: string[],
): Promise<Session | undefined> {
  const configured = await configuredSessionRoots(config);
  const roots = [
    ...new Set([...configured.roots, ...(await rememberedSessionRoots(config)), ...liveRoots]),
  ];
  const files = [
    ...new Set(
      (await Promise.all(roots.map(sessionFiles))).flat().map((file) => realpathSync(file)),
    ),
  ];
  const matches = files.flatMap((file) => {
    const header = readHeader(file);
    if (header?.id !== id) return [];
    if (header.type !== "session" || typeof header.cwd !== "string" || !isAbsolute(header.cwd))
      throw new Error(`Invalid session header: ${file}`);
    return [{ id, file, cwd: header.cwd }];
  });
  if (matches.length > 1) throw new Error(`Ambiguous session ID: ${id} (${matches.length} files)`);
  return matches[0];
}

async function sessionFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await sessionFiles(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return files.flat();
}

function readHeader(path: string): { type?: unknown; id?: unknown; cwd?: unknown } | undefined {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_MAX_BYTES);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, length).toString("utf8").split("\n")[0]!;
    try {
      return JSON.parse(firstLine);
    } catch {
      return undefined;
    }
  } finally {
    closeSync(fd);
  }
}

function prepareDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
    throw new Error(`Unsafe runtime directory: ${path}`);
}

function expandPath(path: string): string {
  if (path.startsWith("file://")) return fileURLToPath(path);
  return resolve(
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
  );
}

function executable(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Executable not found on PATH: ${name}`);
  return path;
}

function quoteTmuxArgument(argument: string): string {
  return JSON.stringify(argument).replaceAll("$", "\\$");
}

async function tmux(config: Config, args: string[], allowFailure = false, input?: string) {
  const child = Bun.spawn([config.tmux, "-S", config.socket, "-f", config.tmuxConfig, ...args], {
    env: config.env,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) throw new Error(`tmux ${args[0]} failed: ${stderr.trim()}`);
  return { stdout, stderr, exitCode };
}

if (import.meta.main) process.exitCode = await main();
