import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Config, expandPath, prepareDirectory, type TmuxConfig } from "./configuration";
import { type HistorySummaryCache, readSessionHeader } from "./history-summary";
import { readSnapshot } from "./restore-state";
import {
  metadataFileRevision,
  SessionMetadataCache,
  SessionPathChangedError,
  type UnresolvedFile,
} from "./session-metadata";
import { type Session, SESSION_ID_PATTERN } from "./session-model";

export type HistoryEntry = {
  id: string;
  cwd: string;
  file: string;
  title: string | null;
  btime: number | null;
  mtime: number | null;
  size: number;
};

export type LiveArchiveLookup = (session: Pick<Session, "id" | "file">) => HistoryEntry | undefined;

type HistorySelection = { scope: "history"; cwd: string | undefined } | { scope: "list" };

type SavedSessionConfig = Pick<TmuxConfig, "agentDir"> & {
  env: NodeJS.ProcessEnv;
};

function sessionGroupName(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
}

export async function historySessions(
  config: TmuxConfig,
  summaries: HistorySummaryCache,
  selection: HistorySelection,
): Promise<{ entries: HistoryEntry[]; resolveLiveArchive?: LiveArchiveLookup }> {
  const registered = readSnapshot(config)?.cwds ?? [];
  const cwdFilter = selection.scope === "history" ? selection.cwd : undefined;
  const cwds = cwdFilter === undefined ? registered : registered.filter((cwd) => cwd === cwdFilter);
  if (cwds.length === 0) return { entries: [] };
  const targetCwds = new Set(cwds);
  const groups = [
    ...new Set(cwds.map((cwd) => join(config.agentDir, "sessions", sessionGroupName(cwd)))),
  ];
  const { customRoot, layers } = await savedSessionLayers(config, groups);
  const enumeratedLayers =
    selection.scope === "history" ? layers : layers.filter(({ archived }) => !archived);
  const listed = await Promise.all(
    enumeratedLayers.flatMap(({ directories, archived }) =>
      directories.map(async (directory) => ({
        directory,
        archived,
        files: await sessionFiles(directory),
      })),
    ),
  );
  const entries: HistoryEntry[] = [];
  const normalIds = new Set<string>();
  for (const { file, archived } of listed.flatMap(({ files, archived }) =>
    files.map((file) => ({ file, archived })),
  )) {
    const summary = summaries.resolveHistory(file, (header) => {
      if (customRoot && !targetCwds.has(header.cwd)) return false;
      const shadowedByNormalCopy = archived && normalIds.has(header.id);
      return !shadowedByNormalCopy;
    });
    const entry = historyEntry(file, summary);
    if (!entry) continue;
    if (!archived) normalIds.add(entry.id);
    entries.push(entry);
  }
  for (const { directory, files } of listed) summaries.recordDiscoveredFiles(directory, files);
  entries.sort(
    (a, b) =>
      (b.mtime ?? Number.NEGATIVE_INFINITY) - (a.mtime ?? Number.NEGATIVE_INFINITY) ||
      a.file.localeCompare(b.file),
  );

  const archive = layers.find(({ archived }) => archived);
  return selection.scope === "list" && archive
    ? { entries, resolveLiveArchive: liveArchiveLookup(archive.directories, summaries) }
    : { entries };
}

function historyEntry(
  file: string,
  summary: ReturnType<HistorySummaryCache["resolveHistory"]>,
): HistoryEntry | undefined {
  if (!summary?.header) return undefined;
  return {
    id: summary.header.id,
    cwd: summary.header.cwd,
    file,
    title: summary.title,
    btime: summary.btime,
    mtime: summary.mtime,
    size: summary.size,
  };
}

function liveArchiveLookup(
  directories: string[],
  summaries: HistorySummaryCache,
): LiveArchiveLookup {
  const archiveDirectories = new Set(directories);
  const normalDirectories = new Set(directories.map(dirname));
  return ({ id, file }) => {
    const parent = dirname(file);
    if (normalDirectories.has(parent) || !file.endsWith(".jsonl")) return undefined;
    try {
      const parentStat = statSync(parent, { bigint: true });
      if (!parentStat.isDirectory() || parentStat.ino === 0n) return undefined;
      const registered = archiveDirectories.has(parent)
        ? parent
        : directories.find((directory) => matchesDirectory(directory, parentStat));
      if (registered === undefined) return undefined;
      return historyEntry(
        file,
        summaries.resolveDirectHistory(
          file,
          (header) => header.id === id,
          () =>
            matchesDirectory(parent, parentStat) &&
            (registered === parent || matchesDirectory(registered, parentStat)),
        ),
      );
    } catch {
      return undefined;
    }
  };
}

function matchesDirectory(path: string, expected: BigIntStats): boolean {
  try {
    const actual = statSync(path, { bigint: true, throwIfNoEntry: false });
    return (
      actual?.isDirectory() === true && actual.dev === expected.dev && actual.ino === expected.ino
    );
  } catch {
    return false;
  }
}

export async function configuredSessionRoot(
  config: SavedSessionConfig,
): Promise<string | undefined> {
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
  return override ? expandPath(override) : settings[1] || settings[0];
}

function registryDirectory(config: TmuxConfig): string {
  return join(config.agentDir, "pi-tmux", "session-dirs");
}

export function rememberSessionRoot(config: Config, root: string): void {
  prepareDirectory(dirname(registryDirectory(config)));
  const directory = registryDirectory(config);
  prepareDirectory(directory);
  const key = createHash("sha256").update(root).digest("hex");
  const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(root) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, `${key}.json`));
}

type SessionDirectoryLayer = { directories: string[]; archived: boolean };

type SavedSessionLayers = { customRoot: string | undefined; layers: SessionDirectoryLayer[] };

async function savedSessionLayers(
  config: SavedSessionConfig,
  groups?: string[],
): Promise<SavedSessionLayers> {
  const customRoot = await configuredSessionRoot(config);
  if (customRoot) return { customRoot, layers: [{ directories: [customRoot], archived: false }] };
  const directories = groups ?? (await cwdGroupDirectories(config));
  return {
    customRoot: undefined,
    layers: [
      { directories, archived: false },
      { directories: directories.map((group) => join(group, "archive")), archived: true },
    ],
  };
}

async function cwdGroupDirectories(config: SavedSessionConfig): Promise<string[]> {
  const root = join(config.agentDir, "sessions");
  return (await sessionDirectoryEntries(root))
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("--") && entry.name.endsWith("--"),
    )
    .map((entry) => join(root, entry.name));
}

export async function findExactSaved(
  config: TmuxConfig,
  id: string,
  file: string,
): Promise<Session> {
  const customRoot = await configuredSessionRoot(config);
  const roots = await cwdGroupDirectories(config);
  if (customRoot && existsSync(customRoot)) roots.push(customRoot);
  const allowed = roots.some((root) => {
    const directory = realpathSync(root);
    return dirname(file) === directory || dirname(file) === join(directory, "archive");
  });
  if (!allowed)
    throw new Error(`Expected file is outside the supported session directories: ${file}`);
  if (!existsSync(file) || !lstatSync(file).isFile() || realpathSync(file) !== file)
    throw new Error(`Expected session file is not a canonical regular file: ${file}`);
  const header = readHeader(file);
  if (
    header?.type !== "session" ||
    header.id !== id ||
    typeof header.cwd !== "string" ||
    !isAbsolute(header.cwd) ||
    header.cwd.includes("\0")
  )
    throw new Error(`Expected file has an invalid or mismatched session header: ${file}`);
  const cwd = realpathSync(header.cwd);
  if (!statSync(cwd).isDirectory())
    throw new Error(`Session working directory is not a directory: ${cwd}`);
  return { id, file, cwd };
}

export async function findSaved(
  config: TmuxConfig,
  id: string,
  purpose: "open" | "restore" = "open",
): Promise<Session | undefined> {
  const { layers } = await savedSessionLayers(config);
  return findSavedInLayers(layers, id, purpose);
}

export async function readSessionMetadata(config: SavedSessionConfig, id: string) {
  try {
    return await readSessionMetadataOnce(config, id);
  } catch (error) {
    if (!(error instanceof SessionPathChangedError)) throw error;
    return await readSessionMetadataOnce(config, id);
  }
}

async function readSessionMetadataOnce(config: SavedSessionConfig, id: string) {
  const { customRoot, layers } = await savedSessionLayers(config);
  const scope = customRoot ?? join(config.agentDir, "sessions");
  const directories = layers.flatMap((layer) => layer.directories).sort();
  const directoryRevision = createHash("sha256")
    .update(
      JSON.stringify(
        directories.map((path) => {
          const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
          return [path, stat && [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":")];
        }),
      ),
    )
    .digest("hex");
  return new SessionMetadataCache(id, scope, directoryRevision).read(
    async (unresolvedFiles) => (await findSavedInLayers(layers, id, "open", unresolvedFiles))?.file,
  );
}

async function findSavedInLayers(
  layers: SessionDirectoryLayer[],
  id: string,
  purpose: "open" | "restore",
  unresolvedFiles?: UnresolvedFile[],
): Promise<Session | undefined> {
  for (const { directories } of layers) {
    const listed = (await Promise.all(directories.map(sessionFiles))).flat();
    const files = new Set(
      listed.flatMap((file) => {
        const canonical = unresolvedFiles
          ? ifPresent(() => realpathSync(file))
          : realpathSync(file);
        return canonical === undefined ? [] : [canonical];
      }),
    );
    const matches = [...files].flatMap((file) => {
      const revision = unresolvedFiles ? ifPresent(() => metadataFileRevision(file)) : undefined;
      const header = unresolvedFiles
        ? ifPresent(() => readHeader(file, "verified"))
        : readHeader(file);
      if (
        header?.type !== "session" ||
        typeof header.id !== "string" ||
        !SESSION_ID_PATTERN.test(header.id) ||
        typeof header.cwd !== "string" ||
        !isAbsolute(header.cwd)
      ) {
        if (purpose === "restore" || header?.id === id)
          throw new Error(`Invalid session header: ${file}`);
        if (revision !== undefined) unresolvedFiles?.push({ file, revision });
        return [];
      }
      if (header.id !== id) return [];
      return [{ id, file, cwd: header.cwd }];
    });
    if (matches.length > 1)
      throw new Error(`Ambiguous session ID: ${id} (${matches.length} files)`);
    if (matches[0]) return matches[0];
  }
  return undefined;
}

function ifPresent<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
    throw error;
  }
}

async function sessionFiles(directory: string): Promise<string[]> {
  const entries = await sessionDirectoryEntries(directory);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(directory, entry.name));
}

async function sessionDirectoryEntries(directory: string) {
  return await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

function readHeader(path: string, mode?: "verified"): Record<string, unknown> | undefined {
  const fd = openSync(
    path,
    mode === "verified" ? constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW : "r",
  );
  try {
    return mode === "verified" && !fstatSync(fd).isFile() ? undefined : readSessionHeader(fd);
  } finally {
    closeSync(fd);
  }
}
