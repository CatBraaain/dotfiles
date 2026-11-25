import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  AuthorizationPath,
  expandPathSection,
  expandWindowsDriveGlob,
  repositoryName,
  resolveGitMainWorktreePath,
  resolvePathActionMatch,
  resolvePattern,
  type GlobCache,
} from "./config.ts";
import { Guardrail, type ToolContext } from "./guardrail.ts";
import { credentialSnapshot } from "./sandbox.ts";
import { WindowsPathLookup } from "./windows-path-identity.ts";

type DirectoryEntry = { spelling: string; directory?: boolean; link?: boolean; error?: string };

function mockLookup(entries: Record<string, DirectoryEntry>) {
  return new WindowsPathLookup({
    lstat(path) {
      const entry = entries[path];
      if (entry === undefined || entry.error !== undefined)
        throw Object.assign(new Error("Lookup failed"), { code: entry?.error ?? "ENOENT" });
      return {
        isDirectory: () => entry.directory ?? false,
        isSymbolicLink: () => entry.link ?? false,
      };
    },
    realpath: (path) => entries[path]!.spelling,
  });
}

describe("Windows path identity with simulated filesystem lookups", () => {
  it("uses the verified parent spelling without folding a new name", () => {
    const lookup = mockLookup({
      "C:/": { spelling: "C:\\", directory: true },
      "C:/Notes": { spelling: "C:\\Notes", directory: true },
      "C:/NOTES": { spelling: "C:\\Notes", directory: true },
    });
    const rule = lookup.inspect("C:\\Notes");
    const candidate = lookup.inspect("c:/NOTES/New.txt");
    assert.equal(candidate.spelling, "C:/Notes/New.txt");
    assert.equal(lookup.coverage(rule, candidate), "match");
    assert.equal(lookup.coverage(lookup.inspect("C:/Notes/NEW.txt"), candidate), "possible");
    assert.equal(lookup.coverage(lookup.inspect("C:/Notes/Other.txt"), candidate), "none");
  });

  it("does not combine distinct names in a case-sensitive directory", () => {
    const lookup = mockLookup({
      "C:/": { spelling: "C:\\", directory: true },
      "C:/Notes": { spelling: "C:\\Notes", directory: true },
      "C:/Notes/Page.txt": { spelling: "C:\\Notes\\Page.txt" },
      "C:/Notes/PAGE.txt": { spelling: "C:\\Notes\\PAGE.txt" },
    });
    const rule = lookup.inspect("C:/Notes/Page.txt");
    const candidate = lookup.inspect("c:\\Notes\\PAGE.txt");
    assert.equal(lookup.coverage(rule, candidate), "none");
    assert.equal(lookup.coverage(lookup.inspect("C:/Notes/page.txt"), candidate), "none");
  });

  it("does not establish descendant coverage through a link or an unreadable prefix", () => {
    const lookup = mockLookup({
      "C:/": { spelling: "C:\\", directory: true },
      "C:/Notes": { spelling: "C:\\Notes", directory: true },
      "C:/Notes/Link": { spelling: "C:\\Other", link: true },
      "C:/Notes/Unknown": { spelling: "C:\\Notes\\Unknown", error: "EACCES" },
      "C:/Notes/Alternate": { spelling: "C:\\Notes\\A different name" },
    });
    const rule = lookup.inspect("C:/Notes");
    assert.equal(lookup.coverage(rule, lookup.inspect("C:/Notes/Link/doc.txt")), "possible");
    assert.equal(lookup.coverage(rule, lookup.inspect("C:/Notes/Unknown/doc.txt")), "possible");
    assert.equal(lookup.inspect("C:/Notes/Link/doc.txt").spelling, "C:/Notes/Link/doc.txt");
    assert.equal(lookup.coverage(rule, lookup.inspect("C:/Notes/Alternate")), "possible");
  });
});

describe("Windows authorization with simulated filesystem lookups", () => {
  const root = "C:/Notes";

  it("does not treat an unchecked path as an exact grant match", () => {
    const path = `${root}/Entry.txt`;
    const lookup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
      [path]: { spelling: path, error: "EACCES" },
    });
    const candidate = new AuthorizationPath(path, lookup);
    const section = [{ action: "allow" as const, paths: [root, path] }];
    assert.equal(candidate.coverageOf(path), "possible");
    assert.equal(resolvePathActionMatch(section, path, candidate).action, "deny");
    assert.throws(() => candidate.assertVerified(), /Cannot verify Windows path/);
  });

  it("distinguishes a verified glob nonmatch from an unchecked suffix", () => {
    const path = `${root}/Entry.TXT`;
    const lookup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
      [path]: { spelling: path, error: "EACCES" },
      [`${root}/Other.TXT`]: { spelling: `${root}/Other.TXT` },
    });
    const glob = `${root}/*.txt`;
    assert.equal(new AuthorizationPath(path, lookup).denyGlobCoverage(glob, ""), "possible");
    assert.equal(
      new AuthorizationPath(`${root}/Other.TXT`, lookup).denyGlobCoverage(glob, ""),
      "none",
    );
  });

  it("keeps an unreadable startup glob prefix as a potential credential match", () => {
    const pattern = `${root}/*.txt`;
    const startup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, error: "EACCES" },
    });
    const cwd = process.cwd();
    const key = JSON.stringify([
      resolvePattern(pattern, cwd),
      repositoryName(cwd, resolveGitMainWorktreePath(cwd)),
    ]);
    const cache: GlobCache = new Map([[key, expandWindowsDriveGlob(pattern, "", startup)]]);
    const path = `${root}/Entry.txt`;
    const later = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
      [path]: { spelling: path },
    });
    const credentials = credentialSnapshot({ credentials: [pattern] }, cwd, cache);
    assert.equal(new AuthorizationPath(path, later).matchesRestriction(credentials), true);
  });

  it("does not enumerate directories whose children cannot match a nonrecursive glob", () => {
    const branch = `${root}/Archive`;
    const requested = `${branch}/Entry.txt`;
    const lookup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
      [branch]: { spelling: branch, directory: true },
    });
    const enumerated: string[] = [];
    const startup = expandWindowsDriveGlob(`${root}/*.txt`, "", lookup, (path) => {
      enumerated.push(path);
      if (path !== root) throw new Error("Enumeration unavailable");
      return [{ name: "Archive", isDirectory: () => true, isSymbolicLink: () => false }];
    });
    const allow = { action: "allow" as const, paths: [root] };
    const deny = { action: "deny" as const, ...startup };
    assert.deepEqual(enumerated, [root]);
    assert.equal(
      resolvePathActionMatch([allow, deny], requested, new AuthorizationPath(requested, lookup))
        .action,
      "allow",
    );
  });

  it("allows a verified nonmatch inside a branch that could not be enumerated", () => {
    const requested = `${root}/Entry.md`;
    const startup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
    });
    const later = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
      [requested]: { spelling: requested },
    });
    const snapshot = expandWindowsDriveGlob(`${root}/*.txt`, "", startup, () => {
      throw new Error("Enumeration unavailable");
    });
    const candidate = new AuthorizationPath(requested, later);
    assert.equal(candidate.matchesRestriction(snapshot), false);
    assert.equal(
      resolvePathActionMatch(
        [
          { action: "allow", paths: [root] },
          { action: "deny", ...snapshot },
        ],
        requested,
        candidate,
      ).action,
      "allow",
    );
  });

  it("keeps startup uncertainty after the candidate spelling becomes verifiable", () => {
    const requested = `${root}/Entry.TXT`;
    const lookup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
      [requested]: { spelling: requested },
    });
    const pattern = `${root}/*.txt`;
    const incomplete = expandWindowsDriveGlob(pattern, "", lookup, () => {
      throw new Error("Enumeration unavailable");
    });
    const complete = expandWindowsDriveGlob(pattern, "", lookup, () => [
      { name: "Entry.TXT", isDirectory: () => false, isSymbolicLink: () => false },
    ]);
    const candidate = new AuthorizationPath(requested, lookup);
    assert.equal(candidate.matchesRestriction(incomplete), true);
    assert.equal(candidate.matchesRestriction(complete), false);
  });

  it("does not assume an unseen Unicode name is a verified glob nonmatch", () => {
    const lookup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
    });
    const snapshot = expandWindowsDriveGlob(`${root}/K*.txt`, "", lookup, () => {
      throw new Error("Enumeration unavailable");
    });
    const candidate = new AuthorizationPath(`${root}/Kelvin.txt`, lookup);
    assert.equal(candidate.matchesRestriction(snapshot), true);
  });

  it("keeps an unseen case variant that a negated character class could match", () => {
    const lookup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
    });
    const snapshot = expandWindowsDriveGlob(`${root}/[^K]*.txt`, "", lookup, () => {
      throw new Error("Enumeration unavailable");
    });
    const candidate = new AuthorizationPath(`${root}/Kite.txt`, lookup);
    assert.equal(candidate.matchesRestriction(snapshot), true);
  });

  it("retains a failed enumeration in the original write-rule position", () => {
    const branch = `${root}/Archive`;
    const sibling = `${root}/Current`;
    const lookup = mockLookup({
      "C:/": { spelling: "C:/", directory: true },
      [root]: { spelling: root, directory: true },
      [branch]: { spelling: branch, directory: true },
      [sibling]: { spelling: sibling, directory: true },
      [`${branch}/Entry.txt`]: { spelling: `${branch}/Entry.txt`, directory: true },
    });
    const pattern = `${root}/**/*.txt`;
    const startup = expandWindowsDriveGlob(pattern, "", lookup, (path) => {
      if (path.replaceAll("\\", "/") === branch) throw new Error("Enumeration unavailable");
      if (path === root)
        return ["Archive", "Current"].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }));
      return [];
    });
    const cwd = process.cwd();
    const key = JSON.stringify([resolvePattern(pattern, cwd), repositoryName(cwd, cwd)]);
    const cache: GlobCache = new Map([[key, startup]]);
    const deny = expandPathSection(
      [{ action: "deny", patterns: [pattern] }],
      cwd,
      false,
      cwd,
      cache,
    );
    const allow = { action: "allow" as const, paths: [root] };
    const archived = `${branch}/Entry.txt/Child.md`;
    const unrelated = `${branch}/Other.md`;
    const current = `${sibling}/Entry.txt`;
    assert.equal(
      resolvePathActionMatch([allow, ...deny], unrelated, new AuthorizationPath(unrelated, lookup))
        .action,
      "allow",
    );
    assert.equal(
      resolvePathActionMatch([allow, ...deny], archived, new AuthorizationPath(archived, lookup))
        .action,
      "deny",
    );
    assert.equal(
      resolvePathActionMatch([allow, ...deny], current, new AuthorizationPath(current, lookup))
        .action,
      "allow",
    );
    assert.equal(
      resolvePathActionMatch([...deny, allow], archived, new AuthorizationPath(archived, lookup))
        .action,
      "allow",
    );
  });
});

type FixtureConfig = {
  read?: Record<string, string>[];
  write?: Record<string, string>[];
  credentials?: string[];
};

async function withNativeFixture(
  useFixture: (root: string, guardrail: (config: FixtureConfig) => Guardrail) => Promise<void>,
) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "guardrails-win-"));
  try {
    function guardrail(config: FixtureConfig) {
      const configPath = join(root, "fixture.yaml");
      writeFileSync(configPath, JSON.stringify(config));
      return new Guardrail(root, configPath);
    }
    await useFixture(root, guardrail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const native = it.skipIf(process.platform !== "win32");
const noUI: ToolContext = {};

function alternateSpelling(root: string, name: string): string {
  const drive = root[0]!.toLowerCase();
  return `${drive}${root.slice(1)}/${name.toUpperCase()}`.replaceAll("\\", "/");
}

describe("native Windows local-drive path policy", () => {
  native("preserves last-match order across fixed write rules", async () => {
    await withNativeFixture(async (root, guardrail) => {
      const name = "Notes";
      const directory = join(root, name);
      mkdirSync(directory);
      const policy = guardrail({
        write: [{ allow: root }, { deny: directory }, { allow: alternateSpelling(root, name) }],
      });
      assert.equal(await policy.authorizePath("write", directory, noUI), undefined);
      assert.equal(
        await policy.authorizePath("write", alternateSpelling(root, name), noUI),
        undefined,
      );
    });
  });

  native(
    "honors startup-expanded globs independently of the spelling used for access",
    async () => {
      await withNativeFixture(async (root, guardrail) => {
        const shelf = join(root, "Shelf");
        mkdirSync(shelf);
        const first = join(shelf, "first.txt");
        writeFileSync(first, "first");
        const policy = guardrail({
          read: [{ allow: `${alternateSpelling(root, "Shelf")}/*.txt` }],
        });
        assert.equal(await policy.authorizePath("read", first, noUI), undefined);
        assert.equal(
          await policy.authorizePath("read", alternateSpelling(root, "Shelf/first.txt"), noUI),
          undefined,
        );
        const later = join(shelf, "later.txt");
        writeFileSync(later, "later");
        await assert.rejects(policy.authorizePath("read", later, noUI), /requires confirmation/);
      });
    },
  );

  native("uses the same ordered read-deny glob rules for files created later", async () => {
    await withNativeFixture(async (root, guardrail) => {
      const shelf = join(root, "Shelf");
      mkdirSync(shelf);
      const policy = guardrail({
        read: [
          { allow: "*" },
          { deny: `${alternateSpelling(root, "Shelf")}/*.txt` },
          { allow: join(shelf, "note.txt") },
          { deny: join(shelf, "*.md") },
        ],
      });
      writeFileSync(join(shelf, "note.txt"), "note");
      writeFileSync(join(shelf, "other.txt"), "other");
      assert.equal(
        await policy.authorizePath("read", alternateSpelling(root, "Shelf/note.txt"), noUI),
        undefined,
      );
      await assert.rejects(
        policy.authorizePath("read", alternateSpelling(root, "Shelf/other.txt"), noUI),
        /Access denied/,
      );
      assert.equal(await policy.authorizePath("read", shelf, noUI), undefined);
    });
  });

  native(
    "checks credential globs before read allow, write allow, and approval requests",
    async () => {
      await withNativeFixture(async (root, guardrail) => {
        const examples = join(root, "Examples");
        mkdirSync(examples);
        writeFileSync(join(examples, "sample.txt"), "sample");
        const policy = guardrail({
          credentials: [join(examples, "*.txt")],
          read: [{ allow: "*" }],
          write: [{ allow: root }],
        });
        const candidate = alternateSpelling(root, "Examples/sample.txt");
        await assert.rejects(policy.authorizePath("read", candidate, noUI), /credential path/);
        await assert.rejects(policy.authorizePath("write", candidate, noUI), /credential path/);
        await assert.rejects(
          policy.requestWritePermission(candidate, "fixture", noUI),
          /credential path/,
        );
      });
    },
  );

  native("reuses an approved directory scope for an unambiguous new file", async () => {
    await withNativeFixture(async (root, guardrail) => {
      const library = join(root, "Library");
      mkdirSync(library);
      const policy = guardrail({ write: [{ ask: library }] });
      const confirmed = await policy.requestWritePermission(library, "fixture", {
        hasUI: true,
        ui: { confirm: async () => true },
      });
      assert.equal(confirmed.status, "granted");
      const spelling = `${alternateSpelling(root, "Library")}/New.txt`;
      assert.equal(await policy.authorizePath("write", spelling, noUI), undefined);
      const repeated = await policy.requestWritePermission(spelling, "fixture", noUI);
      assert.equal(repeated.status, "already granted");
      await assert.rejects(
        policy.authorizePath("write", join(root, "Library-other", "New.txt"), noUI),
        /requires confirmation/,
      );
    });
  });

  native("cannot infer coverage from two differently spelled missing targets", async () => {
    await withNativeFixture(async (root, guardrail) => {
      const policy = guardrail({
        write: [{ allow: root }, { deny: join(root, "Later.txt") }],
      });
      for (const name of ["Later.txt", "LATER.txt"]) {
        await assert.rejects(
          policy.authorizePath("write", join(root, name), noUI),
          /Access denied/,
        );
      }
      assert.equal(await policy.authorizePath("write", join(root, "Other.txt"), noUI), undefined);
    });
  });

  native("reuses a read approval without also granting write access", async () => {
    await withNativeFixture(async (root, guardrail) => {
      const file = join(root, "Entry.txt");
      writeFileSync(file, "entry");
      const policy = guardrail({ read: [{ ask: file }] });
      const approval = await policy.authorizePath("read", file, {
        hasUI: true,
        ui: { confirm: async () => true },
      });
      assert.equal(approval?.operation, "read");
      const candidate = alternateSpelling(root, "Entry.txt");
      assert.equal(await policy.authorizePath("read", candidate, noUI), undefined);
      await assert.rejects(policy.authorizePath("write", candidate, noUI), /requires confirmation/);
    });
  });

  native(
    "keeps a possible read-deny glob in rule order when the suffix is not yet verified",
    async () => {
      await withNativeFixture(async (root, guardrail) => {
        const shelf = join(root, "Shelf");
        mkdirSync(shelf);
        const early = join(shelf, "Early.TXT");
        const late = join(shelf, "Late.TXT");
        const verifiedNonmatch = join(shelf, "Existing.TXT");
        writeFileSync(verifiedNonmatch, "entry");
        const policy = guardrail({
          read: [{ allow: "*" }, { allow: early }, { deny: join(shelf, "*.txt") }, { allow: late }],
        });
        await assert.rejects(policy.authorizePath("read", early, noUI), /Access denied/);
        assert.equal(await policy.authorizePath("read", late, noUI), undefined);
        assert.equal(await policy.authorizePath("read", verifiedNonmatch, noUI), undefined);
      });
    },
  );

  native("does not allow or reuse an approval below a path that is not a directory", async () => {
    await withNativeFixture(async (root, guardrail) => {
      const entry = join(root, "Entry.txt");
      const policy = guardrail({ read: [{ allow: "*" }], write: [{ ask: root }] });
      await policy.requestWritePermission(root, "fixture", {
        hasUI: true,
        ui: { confirm: async () => true },
      });
      writeFileSync(entry, "entry");
      const path = join(entry, "Child.txt");
      await assert.rejects(policy.authorizePath("read", path, noUI), /Cannot verify Windows path/);
      await assert.rejects(policy.authorizePath("write", path, noUI), /Cannot verify Windows path/);
      await assert.rejects(
        policy.requestWritePermission(path, "fixture", noUI),
        /Cannot verify Windows path/,
      );
    });
  });

  native("reuses a file approval only for the same existing file", async () => {
    await withNativeFixture(async (root, guardrail) => {
      const file = join(root, "Entry.txt");
      const policy = guardrail({ write: [{ ask: root }] });
      const approval = await policy.authorizePath("write", file, {
        hasUI: true,
        ui: { confirm: async () => true },
      });
      assert.equal(approval?.scope, "file");
      assert.equal(
        await policy.authorizePath("write", alternateSpelling(root, "Entry.txt"), noUI),
        undefined,
      );
      await assert.rejects(
        policy.authorizePath("write", join(root, "Another.txt"), noUI),
        /requires confirmation/,
      );
    });
  });
});
