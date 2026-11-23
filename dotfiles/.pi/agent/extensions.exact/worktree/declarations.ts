import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseWorktreeRoots } from "./worktrees.ts";
import type { ScopedExecution } from "../guardrails/api.ts";

const NO_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_OPTIONS = [
  "--no-replace-objects",
  "-c",
  `core.hooksPath=${NO_CONFIG}`,
  "-c",
  "hook.reference-transaction.enabled=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.ignoreStat=false",
  "-c",
  "core.sharedRepository=false",
  "-c",
  "core.preferSymlinkRefs=false",
  "-c",
  "worktree.useRelativePaths=false",
];
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type WorktreeRecord = ReturnType<typeof parseWorktreeRoots>[number] & {
  ref?: string;
  oid?: string;
  locked: boolean;
};

type Repository = { main: string; common: string; roots: WorktreeRecord[] };

export type VerifiedWorktree = {
  admin: string;
  isCurrent(): boolean;
};

type Destination = { repository: Repository; path: string; name: string };

export type GitOperation = {
  signal: AbortSignal;
  run(call: ScopedExecution, signal: AbortSignal): Promise<string>;
};

type Mutation = Destination & {
  operation: GitOperation;
  assertAllowed(
    paths: readonly string[],
    directories?: readonly string[],
    unlinkSymlinks?: readonly string[],
  ): void;
  beforeMutation(admin: string): void;
};

export async function loadDeclarationRepository(
  cwd: string,
  operation: GitOperation,
): Promise<Repository> {
  const roots = await listWorktrees(cwd, [], operation);
  if (roots[0]!.bare) throw new Error(`No main working tree for ${cwd}`);
  const main = realpathSync.native(roots[0]!.path);
  const commonPath = await git(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    operation,
  );
  const common = realpathSync.native(commonPath.replace(/\r?\n$/, ""));
  if (gitDirectory(main) !== common) throw new Error(`Cannot verify the main worktree at ${main}`);
  return { main, common, roots };
}

export async function selectDeclarationRepository(
  home: string,
  cwd: string,
  project: string | undefined,
  operation: GitOperation,
): Promise<Repository> {
  if (project === undefined) return loadDeclarationRepository(cwd, operation);
  if (!project || /[\\/:\0\r\n]/.test(project) || project === "." || project === "..")
    throw new Error(`Invalid project directory name: ${project}`);
  const canonicalHome = realpathSync.native(home);
  const path = join(canonicalHome, "projects", project);
  assertDirectoryChain(path, canonicalHome);
  if (canonicalDirectory(path) !== path)
    throw new Error(`Project is not a real directory: ${path}`);
  const root = await git(path, ["rev-parse", "--show-toplevel"], operation);
  if (resolve(root.replace(/\r?\n$/, "")) !== path)
    throw new Error(`Project is not a Git repository root: ${path}`);
  return loadDeclarationRepository(path, operation);
}

export function managedWorktreePath(home: string, main: string, name: string): string {
  const folder = /^(?:agents|copilot)-/.test(name) ? `wt-${name}` : name;
  validatePathComponent(folder);
  const canonicalHome = realpathSync.native(home);
  const path = join(canonicalHome, ".agents", "worktrees", basename(main), folder);
  assertDirectoryChain(path, canonicalHome);
  assertMutationStorage(path, canonicalHome, linuxMounts());
  return path;
}

export function verifyDeclaredWorktree(
  repository: Repository,
  path: string,
): VerifiedWorktree | undefined {
  const matches = repository.roots.slice(1).filter((root) => resolve(root.path) === path);
  if (matches.length !== 1 || matches[0]!.bare) return undefined;
  const identity = linkedWorktreeIdentity(repository.common, path);
  if (!identity) return undefined;
  return {
    admin: identity.admin,
    isCurrent() {
      const current = linkedWorktreeIdentity(repository.common, path);
      return current?.admin === identity.admin && current.key === identity.key;
    },
  };
}

export async function isLiveDeclaration(path: string, operation: GitOperation): Promise<boolean> {
  if (!pathExists(path) || canonicalDirectory(path) !== path) return false;
  const pointerPath = join(path, ".git");
  if (!pathExists(pointerPath)) return false;
  const admin = gitDirectory(path);
  if (!admin || basename(dirname(admin)) !== "worktrees") return false;
  const repository = await loadDeclarationRepository(path, operation);
  return verifyDeclaredWorktree(repository, path) !== undefined;
}

export function pathExists(path: string): boolean {
  return statIfPresent(path) !== undefined;
}

export async function createDeclaredWorktree(mutation: Mutation): Promise<VerifiedWorktree> {
  const { repository, path, name, operation, assertAllowed, beforeMutation } = mutation;
  const { main, common } = repository;
  const options = await mutationOptions(repository, operation);
  const ref = branchRef(name);
  const commit = await readMainHead(repository, operation);
  const checkoutPaths = await listCheckoutPaths(repository, commit, path, operation);
  const admin = nextWorktreeAdmin(common, basename(path));
  const adminFiles = [
    "gitdir",
    "commondir",
    "locked",
    "HEAD",
    "HEAD.lock",
    "refs",
    "logs",
    "logs/HEAD",
    "index",
    "index.lock",
  ];

  const initialRef = await readBranch(repository, name, operation);
  const current = await loadDeclarationRepository(main, operation);
  if (initialRef || current.roots.some((root) => overlaps(root.path, path)))
    throw new Error(`Worktree destination or branch already exists: ${path} (${ref})`);
  assertDirectoryChain(path, parse(path).root);
  if (pathExists(path) || pathExists(admin))
    throw new Error(`Worktree destination or registration already exists: ${path}`);
  const branchPaths = branchMutationPaths(repository, name, "add");
  const creationPaths = [
    ...missingParents(dirname(path)),
    path,
    join(path, ".git"),
    ...missingParents(dirname(admin)),
    admin,
    ...adminFiles.map((file) => join(admin, file)),
    ...branchPaths,
  ];
  const creationDirectories = [dirname(path), common];
  const checkout = checkoutWritePlan(path, admin, checkoutPaths);
  assertAllowed(creationPaths, creationDirectories);
  assertAllowed(checkout.paths, checkout.directories);
  return withScratch(mutation, ["HEAD", "config", "objects", "refs"], async (scratch) => {
    initializeCheckoutRepository(scratch, commit);
    assertAllowed(creationPaths, creationDirectories);
    assertAllowed(checkout.paths, checkout.directories);
    beforeMutation(admin);
    await git(
      main,
      [
        ...options.args,
        "worktree",
        "add",
        "--quiet",
        "--no-checkout",
        "--no-track",
        "--no-guess-remote",
        "-b",
        name,
        "--",
        path,
        commit,
      ],
      operation,
      {},
      [],
      {
        paths: creationPaths,
        directories: creationDirectories,
        createDirectories: missingParents(dirname(path)),
        readOnlyFile: mutationConfig(common, commit),
        validate() {
          beforeMutation(admin);
          options.validate();
          if (pathExists(path) || pathExists(admin))
            throw new Error(`Worktree destination or registration already exists: ${path}`);
          assertAllowed(checkout.paths, checkout.directories);
        },
      },
    );

    const refreshed = await loadDeclarationRepository(main, operation);
    const worktree = verifyDeclaredWorktree(refreshed, path);
    if (refreshed.common !== common || worktree?.admin !== admin || !worktree.isCurrent())
      throw new Error(`Git did not create the expected linked worktree at ${path}`);
    await checkoutWithoutRepositoryConfig(mutation, worktree, commit, checkoutPaths, scratch);
    return worktree;
  });
}

export async function removeDeclaredWorktree(
  mutation: Mutation,
  startCwd: string,
  discard: boolean,
  onPathRemoved: () => void,
): Promise<void> {
  const { repository, path, name, operation, assertAllowed, beforeMutation } = mutation;
  const { main, common } = repository;
  const cwd = realpathSync.native(startCwd);
  if (overlaps(cwd, path) || overlaps(main, path))
    throw new Error(`Worktree overlaps the session start or main worktree: ${path}`);
  const options = await mutationOptions(repository, operation);
  const ref = branchRef(name);
  const initial = verifyDeclaredWorktree(repository, path);
  const oid = await readBranch(repository, name, operation);
  if (!oid || !initial)
    throw new Error(`Cannot verify the linked worktree and branch ${ref}: ${path}`);
  assertRemovalTarget(repository, path, initial, ref, oid);
  const removalDirectories = [dirname(path), dirname(initial.admin)];
  const branchDirectories = [common];
  function checkRemovalPlan(worktree: VerifiedWorktree) {
    const plan = removalFootprint(path, worktree);
    assertAllowed(plan.paths, removalDirectories, plan.unlinkSymlinks);
    return plan;
  }

  checkRemovalPlan(initial);
  assertAllowed(branchMutationPaths(repository, name, "remove"), branchDirectories);
  if (!discard) {
    await assertMerged(repository, oid, operation);
    await assertClean(mutation, options, initial, oid);
  }

  const currentOptions = await mutationOptions(repository, operation);
  if (!discard) {
    await assertClean(mutation, currentOptions, initial, oid);
    await assertMerged(repository, oid, operation);
  }
  const currentRef = await readBranch(repository, name, operation);
  const current = await loadDeclarationRepository(main, operation);
  assertRemovalTarget(current, path, initial, ref, oid);
  if (current.common !== common || currentRef !== oid || !initial.isCurrent())
    throw new Error(`Worktree or branch changed before removal: ${path} (${ref})`);
  for (const admin of worktreeAdminPaths(current)) {
    if (admin !== initial.admin) await assertNoScheduledRef(current, admin, ref, operation);
  }
  const removalPlan = checkRemovalPlan(initial);
  assertAllowed(branchMutationPaths(repository, name, "remove"), branchDirectories);
  beforeMutation(initial.admin);
  try {
    await git(
      main,
      [...currentOptions.args, "worktree", "remove", ...(discard ? ["--force"] : []), "--", path],
      operation,
      {},
      [],
      {
        ...removalPlan,
        directories: removalDirectories,
        readOnlyFile: mutationConfig(common, oid),
        readOnlyView: {
          directory: common,
          paths: ["HEAD", "objects", "info", "refs", "packed-refs"].map((entry) =>
            join(common, entry),
          ),
        },
        validate() {
          beforeMutation(initial.admin);
          currentOptions.validate();
          assertRemovalTarget(current, path, initial, ref, oid);
          checkRemovalPlan(initial);
          assertAllowed(branchMutationPaths(repository, name, "remove"), branchDirectories);
        },
      },
    );
  } finally {
    if (!pathExists(path)) onPathRemoved();
  }

  if (!discard) await assertMerged(repository, oid, operation);
  const deletionOptions = await mutationOptions(repository, operation);
  const deletionRef = await readBranch(repository, name, operation);
  const after = await loadDeclarationRepository(main, operation);
  if (
    after.common !== common ||
    pathExists(path) ||
    pathExists(initial.admin) ||
    after.roots.some((root) => samePath(root.path, path) || root.ref === ref) ||
    deletionRef !== oid
  )
    throw new Error(`Cannot verify worktree removal or unchanged, unchecked-out branch ${ref}`);
  await assertBranchUnused(after, ref, operation);
  if (pathExists(path) || pathExists(initial.admin))
    throw new Error(`Cannot verify worktree removal before deleting ${ref}`);
  const branchPaths = branchMutationPaths(repository, name, "remove");
  assertAllowed(branchPaths, branchDirectories);
  beforeMutation(initial.admin);
  await git(
    main,
    [...deletionOptions.args, "update-ref", "--no-deref", "-d", ref, oid],
    operation,
    {},
    [],
    {
      paths: branchPaths,
      directories: branchDirectories,
      readOnlyFile: mutationConfig(common, oid),
      validate() {
        beforeMutation(initial.admin);
        deletionOptions.validate();
        if (pathExists(path) || pathExists(initial.admin))
          throw new Error(`Cannot verify worktree removal before deleting ${ref}`);
      },
    },
  );
  if (await readBranch(repository, name, operation)) throw new Error(`Branch still exists: ${ref}`);
}

async function assertBranchUnused(
  repository: Repository,
  ref: string,
  operation: GitOperation,
): Promise<void> {
  for (const admin of worktreeAdminPaths(repository)) {
    await assertNoScheduledRef(repository, admin, ref, operation);
    const head = readBranchState(join(admin, "HEAD"));
    if (head.startsWith("ref: ")) {
      const target = head.slice(5);
      if (!target.startsWith("refs/heads/"))
        throw new Error("Cannot verify the branch named by HEAD in " + admin);
      if (target === ref) throw new Error(`Branch is still in use: ${ref} (${admin})`);
      await git(
        repository.main,
        [...sourceOptions(repository), "check-ref-format", target],
        operation,
      );
      const loose = join(repository.common, target);
      assertDirectoryChain(dirname(loose), repository.common);
      if (pathExists(loose)) {
        assertRegularFile(loose);
        const contents = readBranchState(loose);
        if (!OBJECT_ID.test(contents)) {
          const resolved = (
            await git(
              repository.main,
              [...sourceOptions(repository), "symbolic-ref", "--quiet", target],
              operation,
            )
          ).trimEnd();
          if (!resolved.startsWith("refs/heads/"))
            throw new Error("Cannot verify a local branch named by HEAD in " + admin);
          if (resolved === ref) throw new Error(`Branch is still in use: ${ref} (${admin})`);
        }
      }
    } else if (!OBJECT_ID.test(head)) {
      throw new Error("Cannot verify the branch named by HEAD in " + admin);
    }

    for (const step of ["rebase-apply", "rebase-merge"]) {
      const state = join(admin, step);
      if (!pathExists(state)) continue;
      if (canonicalDirectory(state) !== state)
        throw new Error("Cannot verify rebase state in " + admin);
      const applying = join(state, "applying");
      if (step === "rebase-apply" && pathExists(applying)) {
        assertRegularFile(applying);
        continue;
      }
      const branch = readBranchState(join(state, "head-name"));
      if (branch === ref || branch === ref.slice("refs/heads/".length))
        throw new Error("Branch is still in use by rebase: " + ref + " (" + admin + ")");
      if (branch !== "detached HEAD" && !OBJECT_ID.test(branch)) {
        if (!branch.startsWith("refs/heads/"))
          throw new Error("Cannot verify rebase branch in " + admin);
        await git(
          repository.main,
          [...sourceOptions(repository), "check-ref-format", branch],
          operation,
        );
      }
    }

    const bisectLog = join(admin, "BISECT_LOG");
    const bisectStart = join(admin, "BISECT_START");
    if (pathExists(bisectLog) || pathExists(bisectStart)) {
      const branch = readBranchState(bisectStart);
      if (branch === ref || branch === ref.slice("refs/heads/".length))
        throw new Error("Branch is still in use by bisect: " + ref + " (" + admin + ")");
      if (!OBJECT_ID.test(branch)) {
        const fullRef = branch.startsWith("refs/") ? branch : branchRef(branch);
        await git(
          repository.main,
          [...sourceOptions(repository), "check-ref-format", fullRef],
          operation,
        );
      }
    }
  }
}

function worktreeAdminPaths({ common }: Repository): string[] {
  const root = join(common, "worktrees");
  assertDirectoryChain(root, common);
  const linked = pathExists(root)
    ? readdirSync(root, { encoding: "buffer" }).map((entry) => join(root, decode.decode(entry)))
    : [];
  const paths = [common, ...linked];
  for (const admin of paths) {
    if (canonicalDirectory(admin) !== admin)
      throw new Error(`Cannot verify branch use in Git metadata: ${admin}`);
  }
  return paths;
}

async function assertNoScheduledRef(
  repository: Repository,
  admin: string,
  ref: string,
  operation: GitOperation,
): Promise<void> {
  const state = join(admin, "rebase-merge");
  if (!pathExists(state)) return;
  assertDirectoryChain(state, admin);
  const path = join(state, "update-refs");
  if (!pathExists(path)) return;
  const contents = readPointer(path);
  if (contents === undefined) throw new Error(`Cannot verify Git rebase update-refs: ${path}`);
  const lines = contents.split(/\r?\n/);
  if (lines.length % 3 !== 0) throw new Error(`Cannot verify Git rebase update-refs: ${path}`);
  for (let index = 0; index < lines.length; index += 3) {
    const target = lines[index]!;
    const before = lines[index + 1]!;
    const after = lines[index + 2]!;
    if (
      !target.startsWith("refs/") ||
      !OBJECT_ID.test(before) ||
      before.length !== after.length ||
      !OBJECT_ID.test(after)
    )
      throw new Error(`Cannot verify Git rebase update-refs: ${path}`);
    if (target === ref)
      throw new Error(`Branch is still in use by rebase update-refs: ${ref} (${admin})`);
    await git(
      repository.main,
      [...sourceOptions(repository), "check-ref-format", target],
      operation,
    );
  }
}

function readBranchState(path: string): string {
  const value = pathExists(path) ? readPointer(path) : undefined;
  if (!value || /[\r\n]/.test(value)) throw new Error("Cannot verify Git branch state: " + path);
  return value;
}

export async function observeMutation(
  { repository, path, name }: Destination,
  original: GitOperation,
  admin?: string,
) {
  const operation = { ...original, signal: AbortSignal.timeout(5_000) };
  const [directory, registration, branch] = await Promise.allSettled([
    Promise.resolve().then(() => pathExists(path)),
    Promise.resolve().then(async () => {
      if (admin !== undefined && pathExists(admin)) return true;
      const { common, roots } = await loadDeclarationRepository(repository.main, operation);
      if (common !== repository.common) throw new Error("Repository changed");
      return roots.some((root) => samePath(root.path, path));
    }),
    readBranch(repository, name, operation).then(Boolean),
  ]);
  function state(result: PromiseSettledResult<boolean>) {
    return result.status === "fulfilled" ? (result.value ? "present" : "absent") : "unverified";
  }
  return `path=${state(directory)}, registration=${state(registration)}, branch ${branchRef(name)}=${state(branch)}`;
}

function assertRemovalTarget(
  repository: Repository,
  path: string,
  worktree: VerifiedWorktree,
  ref: string,
  oid: string,
): void {
  const matching = repository.roots.filter((root) => root.ref === ref);
  if (
    matching.length !== 1 ||
    !samePath(matching[0]!.path, path) ||
    matching[0]!.oid !== oid ||
    readPointer(join(worktree.admin, "HEAD")) !== `ref: ${ref}` ||
    !verifyDeclaredWorktree(repository, path) ||
    !worktree.isCurrent()
  )
    throw new Error(`Worktree does not uniquely check out ${ref} at the expected commit: ${path}`);
  if (matching[0]!.locked || pathExists(join(worktree.admin, "locked")))
    throw new Error(`Worktree is locked: ${path}`);
  if (repository.roots.some((root) => !samePath(root.path, path) && overlaps(root.path, path)))
    throw new Error(`Worktree overlaps another Git workspace: ${path}`);
}

function nextWorktreeAdmin(common: string, folder: string): string {
  const base = join(common, "worktrees", folder);
  for (let i = 0; i < 10_000; i++) {
    const candidate = i === 0 ? base : `${base}${i}`;
    if (!pathExists(candidate)) return candidate;
  }
  throw new Error(`Cannot determine an available Git worktree registration for ${base}`);
}

function removalFootprint(path: string, worktree: VerifiedWorktree) {
  const mounts = linuxMounts();
  const unlinkSymlinks: string[] = [];
  const paths = [
    ...scanRemovalTree(path, mounts, true, unlinkSymlinks),
    ...scanRemovalTree(worktree.admin, mounts, false, unlinkSymlinks),
  ];
  if (readdirSync(dirname(worktree.admin)).length === 1) paths.push(dirname(worktree.admin));
  return { paths, unlinkSymlinks };
}

function scanRemovalTree(
  root: string,
  mounts: ReadonlySet<string>,
  worktree: boolean,
  unlinkSymlinks?: string[],
): string[] {
  const device = lstatSync(root, { bigint: true }).dev;
  const paths: string[] = [];
  walk(root);
  return paths;

  function walk(path: string): void {
    const stats = lstatSync(path, { bigint: true });
    if (stats.dev !== device || mounts.has(path))
      throw new Error(`Refusing to remove a mounted path: ${path}`);
    paths.push(path);
    if (stats.isSymbolicLink()) unlinkSymlinks?.push(path);
    if (!stats.isDirectory()) return;
    if (realpathSync.native(path) !== path)
      throw new Error(`Cannot verify directory path: ${path}`);
    const entries = readdirSync(path, { encoding: "buffer" }).map((bytes) => decode.decode(bytes));
    if (worktree && path !== root && entries.some((entry) => entry.toLowerCase() === ".git"))
      throw new Error(`Refusing to remove a nested Git workspace: ${path}`);
    if (
      worktree &&
      entries.includes("HEAD") &&
      entries.includes("objects") &&
      (entries.includes("refs") || entries.includes("config"))
    )
      throw new Error(`Refusing to remove a nested Git repository: ${path}`);
    for (const entry of entries) walk(join(path, entry));
  }
}

function linuxMounts(): Set<string> {
  if (process.platform !== "linux") return new Set();
  return new Set(
    readFileSync("/proc/self/mountinfo", "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const encoded = line.split(" ")[4];
        if (!encoded?.startsWith("/")) throw new Error("Cannot verify filesystem mount layout");
        return encoded.replace(/\\([0-7]{3})/g, (_, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        );
      }),
  );
}

async function assertClean(
  mutation: Mutation,
  options: Awaited<ReturnType<typeof mutationOptions>>,
  worktree: VerifiedWorktree,
  oid: string,
): Promise<void> {
  const { path, operation } = mutation;
  const target = [...options.args, `--git-dir=${worktree.admin}`, `--work-tree=${path}`];
  const index = join(worktree.admin, "index");
  assertRegularFile(index);
  if (pathExists(join(worktree.admin, "index.lock")))
    throw new Error(`Worktree index is locked: ${path}`);
  const keys = await git(
    path,
    [...target, "config", "--no-includes", "--null", "--name-only", "--list"],
    operation,
  );
  if (keys.split("\0").some((key) => key.startsWith("filter.")))
    throw new Error(`Cannot verify cleanliness with configured Git filters: ${path}`);
  const shared = await git(path, [...target, "rev-parse", "--shared-index-path"], operation);
  if (shared) throw new Error(`Cannot verify a split worktree index: ${path}`);
  const entries = await git(
    path,
    [...target, "ls-files", "-v", "--stage", "--sparse", "-z"],
    operation,
  );
  if (nulRecords(entries).some((entry) => !/^H (?:100644|100755|120000) [0-9a-f]+ 0\t/.test(entry)))
    throw new Error(`Cannot verify special worktree index entries: ${path}`);
  await withScratch(mutation, ["index", "index.lock"], async (scratch) => {
    const overrides = { GIT_INDEX_FILE: join(scratch, "index") };
    await git(path, [...target, "read-tree", oid], operation, overrides, [], {
      paths: [overrides.GIT_INDEX_FILE, `${overrides.GIT_INDEX_FILE}.lock`],
      directories: [scratch],
      validate() {
        options.validate();
        if (!worktree.isCurrent()) throw new Error(`Worktree changed: ${path}`);
      },
    });
    const cleanEntries = await git(
      path,
      [...target, "ls-files", "-v", "--stage", "--sparse", "-z"],
      operation,
      overrides,
    );
    if (entries !== cleanEntries) throw new Error(`Worktree has staged changes: ${path}`);
    options.validate();
    const status = await git(
      path,
      [
        ...target,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
      ],
      operation,
      overrides,
    );
    if (status) throw new Error(`Worktree has unstaged, untracked or ignored changes: ${path}`);
    const trackedPaths = new Set(
      await listCheckoutPaths(mutation.repository, oid, path, operation),
    );
    const entriesOnDisk = scanRemovalTree(path, linuxMounts(), true);
    if (
      entriesOnDisk.some(
        (entry) => entry !== path && entry !== join(path, ".git") && !trackedPaths.has(entry),
      )
    )
      throw new Error(`Worktree has untracked or ignored paths: ${path}`);
  });
}

function initializeCheckoutRepository(scratch: string, commit: string): void {
  mkdirSync(join(scratch, "objects"));
  mkdirSync(join(scratch, "refs"));
  writeFileSync(join(scratch, "HEAD"), "ref: refs/heads/unused\n", { flag: "wx" });
  const config =
    commit.length === 64
      ? "[core]\nrepositoryformatversion=1\n[extensions]\nobjectformat=sha256\n"
      : "";
  writeFileSync(join(scratch, "config"), config, { flag: "wx" });
}

function checkoutWritePlan(path: string, admin: string, checkoutPaths: string[]) {
  const index = join(admin, "index");
  return { index, paths: [...checkoutPaths, index, `${index}.lock`], directories: [path, admin] };
}

async function checkoutWithoutRepositoryConfig(
  mutation: Mutation,
  worktree: VerifiedWorktree,
  commit: string,
  checkoutPaths: string[],
  scratch: string,
): Promise<void> {
  const {
    path,
    repository: { common },
    operation,
    assertAllowed,
    beforeMutation,
  } = mutation;
  const { index, paths, directories } = checkoutWritePlan(path, worktree.admin, checkoutPaths);
  if (
    !worktree.isCurrent() ||
    pathExists(index) ||
    readdirSync(path).some((entry) => entry !== ".git")
  )
    throw new Error(`Worktree changed before checkout: ${path}`);
  assertAllowed(paths, directories);
  beforeMutation(worktree.admin);
  await git(
    scratch,
    [
      `--git-dir=${scratch}`,
      `--work-tree=${path}`,
      "-c",
      `core.attributesFile=${NO_CONFIG}`,
      "read-tree",
      "-m",
      "-u",
      commit,
    ],
    operation,
    { GIT_OBJECT_DIRECTORY: join(common, "objects"), GIT_INDEX_FILE: index },
    [],
    {
      paths,
      directories,
      validate() {
        beforeMutation(worktree.admin);
        if (
          !worktree.isCurrent() ||
          pathExists(index) ||
          readdirSync(path).some((entry) => entry !== ".git")
        )
          throw new Error(`Worktree changed before checkout: ${path}`);
      },
    },
  );
}

async function withScratch<T>(
  mutation: Mutation,
  names: string[],
  use: (scratch: string) => Promise<T>,
): Promise<T> {
  const scratch = join(realpathSync.native(tmpdir()), `pi-worktree-${randomUUID()}`);
  mutation.assertAllowed([scratch, ...names.map((name) => join(scratch, name))]);
  mutation.operation.signal.throwIfAborted();
  mkdirSync(scratch, { mode: 0o700 });
  try {
    return await use(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function assertRepositoryIdentity({ common, main }: Repository): void {
  if (
    common !== join(main, ".git") ||
    canonicalDirectory(common) !== common ||
    gitDirectory(main) !== common
  )
    throw new Error(`Cannot verify a standard in-place Git directory: ${common}`);
  assertRegularFile(join(common, "config"));
}

async function mutationOptions(repository: Repository, operation: GitOperation) {
  assertRepositoryIdentity(repository);
  const { common, main } = repository;
  const config = join(common, "config");
  const original = readFileSync(config);
  function validate(): void {
    assertRepositoryIdentity(repository);
    if (!readFileSync(config).equals(original))
      throw new Error(`Git configuration changed during worktree operation: ${config}`);
  }
  const output = await git(
    main,
    ["config", "--file", config, "--no-includes", "--null", "--name-only", "--list"],
    operation,
  );
  validate();
  const options = sourceOptions(repository);
  for (const key of nulRecords(output)) {
    if (
      /^(?:include(?:if)?\.|core\.(?:worktree|sparsecheckout|sparsecheckoutcone)$|index\.sparse$)/.test(
        key,
      ) ||
      (key.startsWith("extensions.") && key !== "extensions.objectformat")
    )
      throw new Error(`Unsupported Git configuration for worktree mutation: ${key}`);
    const hook = /^hook\.(.+)\.(?:command|event)$/.exec(key)?.[1];
    if (hook) {
      if (!/^[\w.-]+$/.test(hook)) throw new Error("Cannot safely disable a configured Git hook");
      options.push("-c", `hook.${hook}.enabled=false`);
    }
  }
  if (pathExists(join(common, "reftable")))
    throw new Error(`Unsupported Git ref storage: ${common}`);
  assertDirectoryChain(join(common, "worktrees"), common);
  assertMutationStorage(join(common, "worktrees"), main, linuxMounts());
  return { args: options, validate };
}

function sourceOptions({ main, common }: Repository): string[] {
  return [`--git-dir=${common}`, `--work-tree=${main}`];
}

function branchRef(name: string): string {
  return `refs/heads/${name}`;
}

function branchMutationPaths(
  { common }: Repository,
  name: string,
  action: "add" | "remove",
): string[] {
  const ref = branchRef(name);
  const mounts = linuxMounts();
  const files = [ref, `${ref}.lock`, `logs/${ref}`, `logs/${ref}.lock`];
  if (action === "remove") files.push("packed-refs", "packed-refs.lock", "packed-refs.new");
  return files.flatMap((file) => {
    const path = join(common, file);
    assertDirectoryChain(dirname(path), common);
    assertMutationStorage(path, common, mounts);
    if (pathExists(path)) {
      assertRegularFile(path);
      if (lstatSync(path).nlink !== 1) throw new Error(`Linked Git ref metadata: ${path}`);
      if (file.endsWith(".lock") || file === "packed-refs.new")
        throw new Error(`Git ref metadata is busy: ${path}`);
    }
    return [...missingParents(dirname(path)), path];
  });
}

async function readBranch(
  repository: Repository,
  name: string,
  operation: GitOperation,
): Promise<string | undefined> {
  const ref = branchRef(name);
  const loose = join(repository.common, ref);
  assertDirectoryChain(dirname(loose), repository.common);
  if (pathExists(loose)) assertRegularFile(loose);
  const output = await git(
    repository.main,
    [
      ...sourceOptions(repository),
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)",
      "--",
      ref,
    ],
    operation,
  );
  for (const record of output.split("\n")) {
    const [name, oid, symbolic] = record.split("\0");
    if (name !== ref) continue;
    if (symbolic !== "" || !oid || !OBJECT_ID.test(oid))
      throw new Error(`Cannot verify a direct Git ref: ${ref}`);
    return oid;
  }
  if (pathExists(loose)) throw new Error(`Cannot verify the existing branch path: ${loose}`);
}

async function readMainHead(repository: Repository, operation: GitOperation): Promise<string> {
  const oid = (
    await git(
      repository.main,
      [...sourceOptions(repository), "rev-parse", "--verify", "HEAD^{commit}"],
      operation,
    )
  ).trim();
  if (!OBJECT_ID.test(oid)) throw new Error(`Invalid HEAD object ID for ${repository.main}`);
  return oid;
}

async function assertMerged(
  repository: Repository,
  oid: string,
  operation: GitOperation,
): Promise<void> {
  if (pathExists(join(repository.common, "info", "grafts")))
    throw new Error("Cannot verify merge ancestry with Git grafts");
  const head = await readMainHead(repository, operation);
  const base = (
    await git(
      repository.main,
      [...sourceOptions(repository), "merge-base", oid, head],
      operation,
      {},
      [1],
    )
  ).trim();
  if (base !== oid) throw new Error(`Worktree branch ${oid} is not merged into ${repository.main}`);
}

async function listCheckoutPaths(
  repository: Repository,
  oid: string,
  path: string,
  operation: GitOperation,
): Promise<string[]> {
  const output = await git(
    repository.main,
    [...sourceOptions(repository), "ls-tree", "-r", "-t", "-z", oid],
    operation,
  );
  const seen = new Set<string>();
  return nulRecords(output).map((record) => {
    const entry = /^(040000 tree|100644 blob|100755 blob|120000 blob) [0-9a-f]+\t/.exec(record);
    if (!entry) throw new Error("Unsupported Git tree entry for checkout");
    const components = record.slice(entry[0].length).split("/");
    components.forEach(validatePathComponent);
    const destination = join(path, ...components);
    const key = pathKey(destination);
    if (seen.has(key)) throw new Error(`Ambiguous Git checkout path: ${destination}`);
    seen.add(key);
    return destination;
  });
}

function validatePathComponent(component: string): void {
  if (
    !component ||
    component === "." ||
    component === ".." ||
    component.toLowerCase() === ".git" ||
    /[\0\r\n]/.test(component) ||
    (process.platform === "win32" &&
      (/[\\:*?<>|"]|[ .]$/.test(component) ||
        Array.from(component).some((character) => character.charCodeAt(0) < 32) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component)))
  )
    throw new Error(`Cannot verify a portable path component: ${JSON.stringify(component)}`);
}

async function listWorktrees(
  cwd: string,
  options: string[],
  operation: GitOperation,
): Promise<WorktreeRecord[]> {
  const output = await git(cwd, [...options, "worktree", "list", "--porcelain", "-z"], operation);
  const roots = parseWorktreeRoots(output, cwd);
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((record, index) => {
      const fields = record.split("\0");
      const ref = fields.find((field) => field.startsWith("branch "))?.slice(7);
      const oid = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
      const locked = fields.some((field) => field === "locked" || field.startsWith("locked "));
      return { ...roots[index]!, ref, oid, locked };
    });
}

function nulRecords(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith("\0")) throw new Error("Incomplete NUL-terminated Git output");
  return output.slice(0, -1).split("\0");
}

function missingParents(path: string): string[] {
  if (pathExists(path)) return [];
  return [...missingParents(dirname(path)), path];
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  if (process.platform === "win32" || process.platform === "darwin")
    return normalized.normalize("NFC").toLowerCase();
  return normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function overlaps(left: string, right: string): boolean {
  const a = pathKey(left);
  const b = pathKey(right);
  function within(parent: string, child: string): boolean {
    const subpath = relative(parent, child);
    return (
      subpath === "" ||
      (subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath))
    );
  }
  return within(a, b) || within(b, a);
}

function gitExecutable(): string {
  const name = process.platform === "win32" ? "git.exe" : "git";
  const locations =
    process.platform === "linux"
      ? ["/usr/bin/git", "/run/current-system/sw/bin/git"]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .map((path) => join(path, name));
  for (const path of locations) {
    try {
      accessSync(path, constants.X_OK);
      if (lstatSync(realpathSync.native(path)).isFile()) return path;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  throw new Error(
    process.platform === "linux"
      ? "Worktree operations require a system Git executable"
      : "Git not found on PATH",
  );
}

async function git(
  cwd: string,
  args: string[],
  operation: GitOperation,
  overrides: NodeJS.ProcessEnv = {},
  allowedCodes: number[] = [],
  write?: ScopedExecution["write"],
): Promise<string> {
  const { signal, run } = operation;
  signal.throwIfAborted();
  const executable = gitExecutable();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(?:PATH|SYSTEMROOT|WINDIR|TMP|TEMP|TMPDIR)$/i.test(name),
    ),
  );
  return run(
    {
      executable,
      cwd,
      args: ["-C", cwd, ...GIT_OPTIONS, ...args],
      env: {
        ...env,
        ...(process.platform === "linux" ? { PATH: dirname(executable) } : {}),
        ...(process.platform === "win32" ? { MSYS2_ARG_CONV_EXCL: "*" } : {}),
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: NO_CONFIG,
        GIT_CONFIG_SYSTEM: NO_CONFIG,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        ...overrides,
      },
      allowedCodes,
      write,
    },
    signal,
  );
}

function mutationConfig(common: string, oid: string) {
  return {
    path: join(common, "config"),
    contents:
      oid.length === 64
        ? "[core]\nbare=false\nrepositoryformatversion=1\n[extensions]\nobjectFormat=sha256\n"
        : "[core]\nbare=false\nrepositoryformatversion=0\n",
  };
}

function assertDirectoryChain(path: string, root: string): void {
  if (path === root) return;
  const parent = dirname(path);
  if (parent === path) throw new Error(`Path is outside the managed root: ${path}`);
  assertDirectoryChain(parent, root);
  if (pathExists(path) && canonicalDirectory(path) !== path)
    throw new Error(`Expected a directory without symbolic links: ${path}`);
}

function assertMutationStorage(path: string, root: string, mounts: ReadonlySet<string>): void {
  const device = lstatSync(root, { bigint: true }).dev;
  for (let candidate = path; candidate !== root; candidate = dirname(candidate)) {
    if (dirname(candidate) === candidate)
      throw new Error(`Cannot verify storage below ${root}: ${path}`);
    const stats = statIfPresent(candidate);
    if (stats && (lstatSync(candidate, { bigint: true }).dev !== device || mounts.has(candidate)))
      throw new Error(`Cannot mutate storage across a filesystem mount: ${candidate}`);
  }
}

function statIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function canonicalDirectory(path: string): string | undefined {
  return lstatSync(path).isDirectory() ? realpathSync.native(path) : undefined;
}

function assertRegularFile(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.nlink !== 1)
    throw new Error(`Expected a regular, unshared file: ${path}`);
}

function readPointer(path: string): string | undefined {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size > 16_384) return undefined;
  const value = decode.decode(readFileSync(path)).replace(/\r?\n$/, "");
  return value !== "" && !value.includes("\0") ? value : undefined;
}

function gitDirectory(worktree: string): string | undefined {
  const path = join(worktree, ".git");
  if (lstatSync(path).isDirectory()) return realpathSync.native(path);
  const pointer = readPointer(path);
  if (!pointer?.startsWith("gitdir: ")) return undefined;
  const admin = resolve(worktree, pointer.slice(8));
  return pathExists(admin) ? realpathSync.native(admin) : undefined;
}

function linkedWorktreeIdentity(
  common: string,
  path: string,
): { admin: string; key: string } | undefined {
  try {
    const root = lstatSync(path, { bigint: true });
    if (!root.isDirectory() || realpathSync.native(path) !== path) return undefined;
    const admin = gitDirectory(path);
    if (!admin || dirname(admin) !== join(common, "worktrees")) return undefined;
    const adminPointer = readPointer(join(admin, "gitdir"));
    const commonPointer = readPointer(join(admin, "commondir"));
    if (
      !adminPointer ||
      !commonPointer ||
      resolve(admin, adminPointer) !== join(path, ".git") ||
      resolve(admin, commonPointer) !== common
    )
      return undefined;
    const stats = lstatSync(admin, { bigint: true });
    if (!stats.isDirectory()) return undefined;
    return {
      admin,
      key: `${root.dev}:${root.ino}:${root.birthtimeNs}:${stats.dev}:${stats.ino}:${stats.birthtimeNs}`,
    };
  } catch {
    return undefined;
  }
}
