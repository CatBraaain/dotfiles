import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { preserveMtime, readHeader, rewriteSession, type SessionHeader } from "./preserve";

const USAGE = `Usage: project-move <old-cwd> <new-cwd>
       project-move --execute --pi-stopped <old-cwd> <new-cwd>
       project-move --help

Preview is the default and never writes files.
Stop pi and all writers of affected sessions, work files, tickets and their paths until completion.
Moves standard normal/archive sessions and ~/.agents/work/<cwd-basename> and ~/.agents/tickets/<cwd-basename>.
Subagents and custom session directories are not scanned.`;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PERMISSIONS_MASK = 0o777;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

type Arguments =
  | { kind: "help" }
  | { kind: "move"; execute: boolean; oldCwd: string; newCwd: string };
interface RunEnv {
  cwd?: string;
  home?: string;
  processEnv?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
interface Runtime {
  cwd: string;
  home: string;
  processEnv: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
interface Entry {
  path: string;
  name: string;
  stat: fs.BigIntStats;
  bytes?: Buffer;
}
interface Identity {
  dev: bigint;
  ino: bigint;
}
interface Artifact {
  identities: Map<string, Identity>;
  verified: boolean;
}
interface Unit {
  kind: "session" | "work" | "tickets";
  source: string;
  destination: string;
  backup: string;
  entries: Entry[];
  header?: SessionHeader;
  output?: Buffer;
  removed: Set<string>;
  backupArtifact: Artifact;
  destinationArtifact: Artifact;
}
interface Plan {
  oldCwd: string;
  newCwd: string;
  sessionsRoot: string;
  sourceSessions: string;
  destinationSessions: string;
  workRoot: string;
  sourceWork: string;
  destinationWork: string;
  workStatus: "move" | "unchanged" | "absent";
  ticketsRoot: string;
  sourceTickets: string;
  destinationTickets: string;
  ticketsStatus: "move" | "unchanged" | "absent";
  backupRoot: string;
  units: Unit[];
}

export function run(argv: readonly string[], env: RunEnv = {}): number {
  const runtime: Runtime = {
    cwd: env.cwd ?? process.cwd(),
    home: env.home ?? homedir(),
    processEnv: env.processEnv ?? process.env,
    stdout: env.stdout ?? console.log,
    stderr: env.stderr ?? console.error,
  };
  let args: Arguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    runtime.stderr(`arguments: ${message(error)}\n${USAGE}`);
    return 2;
  }
  if (args.kind === "help") {
    runtime.stdout(USAGE);
    return 0;
  }
  let stage = "preflight";
  let plan: Plan | undefined;
  try {
    plan = createPlan(args, runtime);
    printPlan(plan, args.execute, runtime.stdout);
    if (!args.execute) {
      runtime.stdout(
        "preview: no files changed; backups: <agent-dir>/project-move-backups/<run-id>/",
      );
      return 0;
    }
    if (plan.units.length === 0) {
      printResults(plan, runtime.stdout);
      return 0;
    }
    stage = "backup";
    ensureDirectory(dirname(plan.backupRoot));
    fs.mkdirSync(plan.backupRoot, { mode: PRIVATE_DIRECTORY_MODE });
    runtime.stdout(`backup: ${JSON.stringify(plan.backupRoot)}`);
    for (const location of ["backup", "destination"] as const) {
      stage = location;
      assertCandidates(plan);
      for (const unit of plan.units) {
        assertSource(unit, "all");
        createArtifact(unit, location);
        verifyArtifact(unit, location);
        artifactFor(unit, location).verified = true;
      }
    }
    stage = "delete";
    assertCandidates(plan);
    for (const unit of plan.units) {
      if (unit.kind === "session") {
        assertCandidates(plan);
        assertSource(unit, "all");
      } else {
        assertSource(unit, "all");
      }
      verifyArtifact(unit, "backup");
      verifyArtifact(unit, "destination");
      const deletionOrder = [...unit.entries].sort(
        (left, right) =>
          depth(right.name) - depth(left.name) || compareNames(left.name, right.name),
      );
      for (const entry of deletionOrder) {
        assertSource(unit, "metadata");
        assertEntry(entry, loadEntry(entry.path, entry.name, true), "all");
        verifyArtifact(unit, "backup");
        verifyArtifact(unit, "destination");
        guardDirectoryChain(dirname(entry.path));
        if (entry.stat.isDirectory()) fs.rmdirSync(entry.path);
        else fs.unlinkSync(entry.path);
        unit.removed.add(entry.name);
      }
    }
    printResults(plan, runtime.stdout);
    return 0;
  } catch (error) {
    runtime.stderr(`${stage}: ${message(error)}`);
    if (plan) printResults(plan, runtime.stdout);
    else
      runtime.stdout("preflight failed: the full target list was not confirmed; no files changed");
    return 1;
  }
}

function parseArguments(argv: readonly string[]): Arguments {
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    tokens: true,
    options: {
      execute: { type: "boolean" },
      "pi-stopped": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate option");
  if (values.help) {
    if (argv.length !== 1) throw new Error("--help must be used alone");
    return { kind: "help" };
  }
  if (positionals.length !== 2 || positionals.some((path) => path.length === 0)) {
    throw new Error("Two non-empty project paths are required");
  }
  if (Boolean(values.execute) !== Boolean(values["pi-stopped"])) {
    throw new Error("Execution requires both --execute and --pi-stopped");
  }
  return {
    kind: "move",
    execute: Boolean(values.execute),
    oldCwd: positionals[0]!,
    newCwd: positionals[1]!,
  };
}

function createPlan(args: Extract<Arguments, { kind: "move" }>, runtime: Runtime): Plan {
  const oldCwd = resolve(runtime.cwd, args.oldCwd);
  const newCwd = resolve(runtime.cwd, args.newCwd);
  if (oldCwd === newCwd) fail("Project paths are identical", oldCwd);
  if (!fs.statSync(newCwd).isDirectory()) fail("New cwd is not a directory", newCwd);
  if (!basename(oldCwd) || !basename(newCwd))
    fail("Project basename is empty", `${oldCwd} -> ${newCwd}`);
  const configuredAgent = runtime.processEnv.PI_CODING_AGENT_DIR;
  if (configuredAgent === "") fail("PI_CODING_AGENT_DIR is empty", runtime.cwd);
  const agentDir = resolve(
    runtime.cwd,
    expandHome(configuredAgent ?? join(runtime.home, ".pi", "agent"), runtime.home),
  );
  const sessionsRoot = join(agentDir, "sessions");
  const sourceSessions = join(sessionsRoot, encodeCwd(oldCwd));
  const destinationSessions = join(sessionsRoot, encodeCwd(newCwd));
  if (pathKey(sourceSessions) === pathKey(destinationSessions))
    fail("Session directory encoding collision", sourceSessions);
  guardDirectoryChain(join(sourceSessions, "archive"));
  guardDirectoryChain(join(destinationSessions, "archive"));
  const backupRoot = join(agentDir, "project-move-backups", randomUUID());
  const units = sessionPaths(sourceSessions).map((source) => {
    const entry = loadEntry(source, "", true);
    const header = readHeaderAt(entry.bytes!, source, "source");
    if (resolve(header.cwd) !== oldCwd) fail("Source header cwd does not match old cwd", source);
    const name = relative(sourceSessions, source);
    const unit = newUnit(
      "session",
      source,
      join(destinationSessions, name),
      join(backupRoot, relative(sessionsRoot, source)),
      [entry],
    );
    unit.header = header;
    return unit;
  });
  const mapping = new Map(units.map((unit) => [unit.source, unit.destination]));
  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.header!.id)) fail("Duplicate source session id", unit.source);
    ids.add(unit.header!.id);
    unit.output = rewriteSession(unit.header!, newCwd, mapping);
    if (lstat(unit.destination)) fail("Destination already exists", unit.destination);
  }
  if (units.length > 0) {
    for (const path of sessionPaths(destinationSessions)) {
      const header = readHeaderAt(loadEntry(path, "", true).bytes!, path, "existing");
      if (resolve(header.cwd) !== newCwd)
        fail("Destination header cwd does not match new cwd", path);
      if (ids.has(header.id)) fail("Session id already exists at destination", path);
    }
  }
  const workRoot = join(runtime.home, ".agents", "work");
  const work = planDirectory("work", workRoot, oldCwd, newCwd, backupRoot);
  const ticketsRoot = join(runtime.home, ".agents", "tickets");
  const tickets = planDirectory("tickets", ticketsRoot, oldCwd, newCwd, backupRoot);
  for (const planned of [work, tickets]) {
    if (planned.unit) units.push(planned.unit);
  }
  const locationSets = units.map((unit) => [unit.source, unit.destination, unit.backup]);
  for (let left = 0; left < locationSets.length; left++) {
    for (const path of locationSets[left]!) {
      const others = locationSets.slice(left + 1).flat();
      if (others.some((other) => overlaps(path, other)))
        fail("Overlapping migration paths", path);
    }
  }
  if (units.length > 0) guardDirectoryChain(dirname(backupRoot));
  return {
    oldCwd,
    newCwd,
    sessionsRoot,
    sourceSessions,
    destinationSessions,
    workRoot,
    sourceWork: work.source,
    destinationWork: work.destination,
    workStatus: work.status,
    ticketsRoot,
    sourceTickets: tickets.source,
    destinationTickets: tickets.destination,
    ticketsStatus: tickets.status,
    backupRoot,
    units,
  };
}

function planDirectory(
  kind: "work" | "tickets",
  root: string,
  oldCwd: string,
  newCwd: string,
  backupRoot: string,
): { source: string; destination: string; status: "move" | "unchanged" | "absent"; unit?: Unit } {
  const label = kind === "work" ? "Work" : "Tickets";
  const source = join(root, basename(oldCwd));
  const destination = join(root, basename(newCwd));
  if (pathKey(source) === pathKey(destination))
    return { source, destination, status: "unchanged" };
  guardDirectoryChain(dirname(source));
  if (!lstat(source)) return { source, destination, status: "absent" };
  guardDirectoryChain(dirname(destination));
  if (lstat(destination)) fail(`${label} destination already exists`, destination);
  const entries = loadTree(source, true);
  if (!entries[0]?.stat.isDirectory()) fail(`${label} source is not a directory`, source);
  const unit = newUnit(
    kind,
    source,
    destination,
    join(backupRoot, kind === "work" ? "work-files" : "tickets", basename(oldCwd)),
    entries,
  );
  return { source, destination, status: "move", unit };
}

function readHeaderAt(bytes: Buffer, path: string, kind: "source" | "existing") {
  try {
    return readHeader(bytes, path, kind);
  } catch (error) {
    throw new Error(`Session header ${JSON.stringify(path)}: ${message(error)}`);
  }
}

function newUnit(
  kind: Unit["kind"],
  source: string,
  destination: string,
  backup: string,
  entries: Entry[],
): Unit {
  return {
    kind,
    source,
    destination,
    backup,
    entries,
    removed: new Set(),
    backupArtifact: { identities: new Map(), verified: false },
    destinationArtifact: { identities: new Map(), verified: false },
  };
}

function sessionPaths(root: string): string[] {
  const paths: string[] = [];
  for (const directory of [root, join(root, "archive")]) {
    guardDirectoryChain(directory);
    if (!lstat(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(directory, name);
      if (!lstat(path)?.isFile()) fail("Session candidate is not a regular file", path);
      paths.push(path);
    }
  }
  return paths.sort();
}

function assertCandidates(plan: Plan): void {
  const expected = plan.units
    .filter((unit) => unit.kind === "session" && !unit.removed.has(""))
    .map((unit) => unit.source)
    .sort();
  const actual = sessionPaths(plan.sourceSessions);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail("Session candidate set changed", plan.sourceSessions);
}

function loadTree(root: string, withBytes: boolean): Entry[] {
  const entries: Entry[] = [];
  function visit(path: string, name: string): void {
    const entry = loadEntry(path, name, withBytes);
    entries.push(entry);
    if (entry.stat.isDirectory()) {
      for (const child of fs.readdirSync(path).sort()) visit(join(path, child), join(name, child));
    }
  }
  visit(root, "");
  return entries;
}

function loadEntry(path: string, name: string, withBytes: boolean): Entry {
  guardDirectoryChain(dirname(path));
  const stat = lstat(path);
  if (!stat || (!stat.isFile() && !stat.isDirectory()))
    fail("Expected regular file or directory", path);
  if (stat.isDirectory() || !withBytes) return { path, name, stat };
  const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    guardDirectoryChain(dirname(path));
    const current = lstat(path);
    if (
      !current ||
      !sameRevision(stat, opened) ||
      !sameRevision(opened, after) ||
      !sameRevision(after, current)
    ) {
      fail("File changed while reading", path);
    }
    return { path, name, stat: opened, bytes };
  } catch (error) {
    throw new Error(`Read ${JSON.stringify(path)}: ${message(error)}`);
  } finally {
    fs.closeSync(fd);
  }
}

function assertSource(unit: Unit, contents: "all" | "metadata"): void {
  const expected = unit.entries.filter((entry) => !unit.removed.has(entry.name));
  const current =
    unit.kind === "session"
      ? [loadEntry(unit.source, "", contents === "all")]
      : loadTree(unit.source, contents === "all");
  if (
    current.length !== expected.length ||
    current.some((entry, index) => entry.name !== expected[index]?.name)
  ) {
    fail("Original entry set changed", unit.source);
  }
  current.forEach((entry, index) => assertEntry(expected[index]!, entry, contents));
}

function assertEntry(expected: Entry, actual: Entry, contents: "all" | "metadata"): void {
  const sameKind = expected.stat.isDirectory() === actual.stat.isDirectory();
  const sameMode = expected.stat.mode === actual.stat.mode;
  const sameFile =
    expected.stat.isDirectory() ||
    (sameRevision(expected.stat, actual.stat) &&
      (contents === "metadata" || expected.bytes!.equals(actual.bytes!)));
  if (!sameIdentity(expected.stat, actual.stat) || !sameKind || !sameMode || !sameFile) {
    fail("Original changed", expected.path);
  }
}

function createArtifact(unit: Unit, location: "backup" | "destination"): void {
  const root = unit[location];
  const artifact = artifactFor(unit, location);
  try {
    for (const entry of unit.entries) {
      const path = entry.name ? join(root, entry.name) : root;
      ensureDirectory(dirname(path));
      if (entry.stat.isDirectory()) {
        fs.mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
        artifact.identities.set(entry.name, lstat(path)!);
        continue;
      }
      guardDirectoryChain(dirname(path));
      const fd = fs.openSync(
        path,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        permissions(entry.stat),
      );
      try {
        const created = fs.fstatSync(fd, { bigint: true });
        artifact.identities.set(entry.name, created);
        guardDirectoryChain(dirname(path));
        const current = lstat(path);
        if (!current?.isFile() || !sameIdentity(created, current))
          fail("Created file was replaced", path);
        const bytes =
          unit.kind === "session" && location === "destination" ? unit.output! : entry.bytes!;
        fs.writeFileSync(fd, bytes);
        fs.fchmodSync(fd, permissions(entry.stat));
        if (unit.kind === "session") preserveMtime(fd, entry.stat, path);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const entry of [...unit.entries].reverse()) {
      if (!entry.stat.isDirectory()) continue;
      const path = entry.name ? join(root, entry.name) : root;
      guardDirectoryChain(path);
      const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW);
      try {
        const current = fs.fstatSync(fd, { bigint: true });
        if (!current.isDirectory() || !sameIdentity(artifact.identities.get(entry.name)!, current))
          fail("Created directory was replaced", path);
        guardDirectoryChain(path);
        if (process.platform === "win32") fs.chmodSync(path, permissions(entry.stat));
        else fs.fchmodSync(fd, permissions(entry.stat));
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (error) {
    throw new Error(`Create ${JSON.stringify(root)}: ${message(error)}`);
  }
}

function verifyArtifact(unit: Unit, location: "backup" | "destination"): void {
  const root = unit[location];
  const artifact = artifactFor(unit, location);
  const actual = unit.kind === "session" ? [loadEntry(root, "", true)] : loadTree(root, true);
  if (actual.length !== unit.entries.length) fail("Artifact entry set differs", root);
  for (const [index, entry] of actual.entries()) {
    const original = unit.entries[index]!;
    const identity = artifact.identities.get(entry.name);
    const hasExpectedKind = entry.stat.isDirectory() === original.stat.isDirectory();
    const hasSafePermissions = (permissions(entry.stat) & ~permissions(original.stat)) === 0;
    if (
      entry.name !== original.name ||
      !identity ||
      !sameIdentity(identity, entry.stat) ||
      !hasExpectedKind ||
      !hasSafePermissions
    ) {
      fail("Artifact identity, kind or permissions differ", entry.path);
    }
    if (entry.stat.isDirectory()) continue;
    const expected =
      unit.kind === "session" && location === "destination" ? unit.output! : original.bytes!;
    if (
      !expected.equals(entry.bytes!) ||
      (unit.kind === "session" && entry.stat.mtimeNs !== original.stat.mtimeNs)
    ) {
      fail("Artifact content or mtime differs", entry.path);
    }
  }
}

function artifactFor(unit: Unit, location: "backup" | "destination"): Artifact {
  return location === "backup" ? unit.backupArtifact : unit.destinationArtifact;
}

function printPlan(plan: Plan, execute: boolean, stdout: Runtime["stdout"]): void {
  const sessions = plan.units.filter((unit) => unit.kind === "session");
  const archived = sessions.filter((unit) => dirname(unit.source) !== plan.sourceSessions).length;
  stdout(
    `plan: ${JSON.stringify({
      mode: execute ? "execute" : "preview",
      oldCwd: plan.oldCwd,
      newCwd: plan.newCwd,
      sessionsRoot: plan.sessionsRoot,
      sourceSessions: plan.sourceSessions,
      destinationSessions: plan.destinationSessions,
      normal: sessions.length - archived,
      archive: archived,
      precondition:
        "pi and all writers of affected sessions, work files, tickets and their paths stopped",
    })}`,
  );
  for (const unit of sessions) {
    const after = readHeaderAt(unit.output!, unit.destination, "source");
    stdout(
      `session: ${JSON.stringify({
        id: unit.header!.id,
        source: unit.source,
        destination: unit.destination,
        cwd: [unit.header!.cwd, after.cwd],
        parentSession: [unit.header!.parentSession ?? null, after.parentSession ?? null],
      })}`,
    );
  }
  printDirectoryPlan(
    "work",
    plan.workRoot,
    plan.sourceWork,
    plan.destinationWork,
    plan.workStatus,
    plan.units.find((unit) => unit.kind === "work"),
    plan.oldCwd,
    plan.newCwd,
    stdout,
  );
  printDirectoryPlan(
    "tickets",
    plan.ticketsRoot,
    plan.sourceTickets,
    plan.destinationTickets,
    plan.ticketsStatus,
    plan.units.find((unit) => unit.kind === "tickets"),
    plan.oldCwd,
    plan.newCwd,
    stdout,
  );
}

function printDirectoryPlan(
  kind: "work" | "tickets",
  root: string,
  source: string,
  destination: string,
  status: "move" | "unchanged" | "absent",
  unit: Unit | undefined,
  oldCwd: string,
  newCwd: string,
  stdout: Runtime["stdout"],
): void {
  stdout(
    `${kind}: ${JSON.stringify({
      source,
      destination,
      oldName: basename(oldCwd),
      newName: basename(newCwd),
      root,
      status,
      files: unit?.entries.filter((entry) => entry.stat.isFile()).length,
      directories: unit?.entries.filter((entry) => entry.name !== "" && entry.stat.isDirectory())
        .length,
      scanned: unit !== undefined,
    })}`,
  );
}

function printResults(plan: Plan, stdout: Runtime["stdout"]): void {
  const sessions = plan.units.filter((unit) => unit.kind === "session");
  const completed = sessions.filter((unit) => unit.removed.has("")).length;
  const work = plan.units.find((unit) => unit.kind === "work");
  const tickets = plan.units.find((unit) => unit.kind === "tickets");
  stdout(
    `result: ${JSON.stringify({
      sessionsCompleted: completed,
      sessionsPending: sessions.length - completed,
      work: work ? unitStatus(work) : plan.workStatus,
      tickets: tickets ? unitStatus(tickets) : plan.ticketsStatus,
      targets: plan.units.length,
    })}`,
  );
  for (const unit of plan.units) {
    let remaining: string[] | "unknown" = [];
    try {
      if (lstat(unit.source))
        remaining =
          unit.kind === "session"
            ? [unit.source]
            : loadTree(unit.source, false).map((entry) => entry.path);
    } catch {
      remaining = "unknown";
    }
    stdout(
      `target: ${JSON.stringify({
        kind: unit.kind,
        source: unit.source,
        destination: unit.destination,
        backup: unit.backup,
        status: unitStatus(unit),
        remaining,
        backupState: artifactStatus(unit, "backup"),
        destinationState: artifactStatus(unit, "destination"),
      })}`,
    );
  }
  if (!work)
    stdout(`work-result: ${JSON.stringify({ status: plan.workStatus, backup: "not-created" })}`);
  if (!tickets)
    stdout(
      `tickets-result: ${JSON.stringify({ status: plan.ticketsStatus, backup: "not-created" })}`,
    );
}

function unitStatus(unit: Unit): "complete" | "pending" | "partially-deleted" {
  if (unit.removed.has("")) return "complete";
  return unit.removed.size > 0 ? "partially-deleted" : "pending";
}

function artifactStatus(unit: Unit, location: "backup" | "destination"): string {
  try {
    if (!lstat(unit[location])) return "not-created";
    const artifact = artifactFor(unit, location);
    if (!artifact.verified) return "created-unverified";
    verifyArtifact(unit, location);
    return "verified";
  } catch {
    return "unknown";
  }
}

function lstat(path: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function guardDirectoryChain(path: string): void {
  const parents: string[] = [];
  let current = resolve(path);
  while (true) {
    parents.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const parent of parents.reverse()) {
    const stat = lstat(parent);
    if (stat && !stat.isDirectory()) fail("Unsafe directory path (including symlinks)", parent);
  }
}

function ensureDirectory(path: string): void {
  guardDirectoryChain(path);
  if (lstat(path)) return;
  ensureDirectory(dirname(path));
  fs.mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  guardDirectoryChain(path);
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRevision(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function permissions(stat: fs.BigIntStats): number {
  return Number(stat.mode) & PERMISSIONS_MASK;
}

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\")))
    return join(home, path.slice(2));
  return path;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function overlaps(left: string, right: string): boolean {
  const a = pathKey(left);
  const b = pathKey(right);
  return (
    a === b ||
    a.startsWith(b.endsWith(sep) ? b : b + sep) ||
    b.startsWith(a.endsWith(sep) ? a : a + sep)
  );
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function depth(name: string): number {
  return name === "" ? 0 : name.split(sep).length;
}

function fail(reason: string, path: string): never {
  throw new Error(`${reason}: ${JSON.stringify(path)}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
