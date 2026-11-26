import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  INITIAL_REQUEST_DIRECTORY,
  INITIAL_REQUEST_TTL_MS,
  InitialRequestFiles,
} from "./initial-request-files";
import {
  hasPlainLocalWindowsDirectory,
  isPrivateWindowsLaunchAcl,
} from "./windows/windows-launch-directory";

function fixture() {
  const base = "/tmp/work/dotfiles";
  mkdirSync(base, { recursive: true });
  const runtime = mkdtempSync(join(base, "initial-request-files-"));
  const config = { directory: join(runtime, "pi-tmux") };
  mkdirSync(config.directory, { mode: 0o700 });
  const directory = join(config.directory, INITIAL_REQUEST_DIRECTORY);
  const identity = {
    cwd: runtime,
    socket: join(config.directory, "server.sock"),
    generation: randomUUID(),
    session: "pi-session",
    serverPid: 202,
    id: randomUUID(),
    launchToken: randomUUID(),
  };
  const launch = { ...identity, command: ["/usr/local/bin/pi", "--", '-literal "a"\r\nb'] };
  return {
    runtime,
    config,
    directory,
    identity,
    launch,
    cleanup: () => rmSync(runtime, { recursive: true, force: true }),
  };
}

const isNotLinux = process.platform !== "linux";

test.skipIf(isNotLinux)(
  "only one separate launcher can claim the arguments, and cancellation prevents later launches",
  async () => {
    const { config, directory, identity, launch, cleanup } = fixture();
    try {
      const files = InitialRequestFiles.open(config, true);
      const token = randomUUID();
      files.publish(token, launch);
      const module = join(import.meta.dir, "initial-request-files.ts");
      const barrier = join(directory, "begin");
      const claim = `
      import { existsSync } from "node:fs";
      import { InitialRequestFiles } from ${JSON.stringify(module)};
      const [barrier, directory, token, encoded] = process.argv.slice(1);
      while (!existsSync(barrier)) await Bun.sleep(1);
      try {
        const claimed = InitialRequestFiles.open({ directory }).take(token, JSON.parse(encoded));
        console.log(JSON.stringify(claimed));
      } catch {
        process.exitCode = 1;
      }
    `;
      const contenders = Array.from({ length: 8 }, () =>
        Bun.spawn(
          [
            process.execPath,
            "-e",
            claim,
            barrier,
            config.directory,
            token,
            JSON.stringify(identity),
          ],
          { stdout: "pipe", stderr: "pipe", timeout: 5000 },
        ),
      );
      writeFileSync(barrier, "yes");
      const outcomes = await Promise.all(
        contenders.map(async (child) => {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          assert.equal(stderr, "");
          return { code, stdout };
        }),
      );
      const successes = outcomes.filter(({ code }) => code === 0);
      assert.equal(successes.length, 1, JSON.stringify(outcomes.map(({ code }) => code)));
      assert.deepEqual(JSON.parse(successes[0]!.stdout), launch);
      assert.equal(existsSync(join(directory, `${token}.json`)), false);

      const cancelled = randomUUID();
      files.publish(cancelled, launch);
      files.cancel(cancelled);
      assert.throws(
        () => files.take(cancelled, identity),
        /Cannot claim the initial-request arguments/,
      );
    } finally {
      cleanup();
    }
  },
);

test.skipIf(isNotLinux)(
  "refuses unbound, malformed, and expired arguments without exposing the body",
  () => {
    const { config, directory, identity, launch, cleanup } = fixture();
    try {
      const files = InitialRequestFiles.open(config, true);
      const token = randomUUID();
      files.publish(token, launch);
      const path = join(directory, `${token}.json`);
      for (const [key, mismatch] of Object.entries({
        id: randomUUID(),
        cwd: "/not-the-cwd",
        session: "other-pane",
        generation: randomUUID(),
        socket: "/other/socket",
        launchToken: randomUUID(),
        serverPid: 203,
      })) {
        assert.throws(
          () => files.take(token, { ...identity, [key]: mismatch }),
          /Cannot claim the initial-request arguments/,
        );
        assert.equal(existsSync(path), true);
      }
      assert.throws(
        () => files.take(`${token}\n`, identity),
        /Cannot claim the initial-request arguments/,
      );
      assert.throws(
        () => files.take(token, identity, Date.now() + INITIAL_REQUEST_TTL_MS + 1000),
        /Cannot claim the initial-request arguments/,
      );
      writeFileSync(path, "{ corrupt body sentinel");
      assert.throws(() => files.take(token, identity), {
        message: "Cannot claim the initial-request arguments for this launch",
      });
      files.cancel(token);
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      cleanup();
    }
  },
);

test.skipIf(isNotLinux)("sweeps only expired plain launch files in the private directory", () => {
  const { config, directory, runtime, launch, cleanup } = fixture();
  try {
    const files = InitialRequestFiles.open(config, true);
    const valid = randomUUID();
    files.publish(valid, launch);
    const now = Date.now();
    const expired = new Date(now - INITIAL_REQUEST_TTL_MS - 1000);
    function residue(name: string, mode = 0o600) {
      const path = join(directory, name);
      writeFileSync(path, "residue", { mode });
      utimesSync(path, expired, expired);
      return path;
    }
    const pending = residue(`${randomUUID()}.part`);
    const ready = residue(`${randomUUID()}.json`);
    const unrelated = residue(`${randomUUID()}.bak`);
    const insecure = residue(`${randomUUID()}.json`, 0o644);
    const outside = join(runtime, "outside");
    writeFileSync(outside, "do not remove", { mode: 0o600 });
    utimesSync(outside, expired, expired);
    const symbolic = join(directory, `${randomUUID()}.json`);
    const hard = join(directory, `${randomUUID()}.part`);
    symlinkSync(outside, symbolic);
    linkSync(outside, hard);
    InitialRequestFiles.sweep(config, now);
    for (const path of [pending, ready]) assert.equal(existsSync(path), false);
    for (const path of [
      unrelated,
      insecure,
      symbolic,
      hard,
      outside,
      join(directory, `${valid}.json`),
    ])
      assert.equal(existsSync(path), true);
  } finally {
    cleanup();
  }
});

test.skipIf(isNotLinux)("does not list launch files in a non-private directory", () => {
  const { config, directory, cleanup } = fixture();
  const listFiles = spyOn(fs, "readdirSync");
  try {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o755);
    InitialRequestFiles.sweep(config);
    assert.equal(listFiles.mock.calls.length, 0);
  } finally {
    listFiles.mockRestore();
    cleanup();
  }
});

test.skipIf(isNotLinux)(
  "does not create or use a linked or non-private WSL runtime directory",
  () => {
    const { config, directory, runtime, cleanup } = fixture();
    try {
      const outside = join(runtime, "outside");
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, directory);
      assert.throws(
        () => InitialRequestFiles.open(config, true),
        /Unsafe private initial-request directory/,
      );
      assert.deepEqual(readdirSync(outside), []);
      chmodSync(config.directory, 0o755);
      assert.throws(
        () => InitialRequestFiles.open(config, true),
        /Unsafe private initial-request directory/,
      );
    } finally {
      cleanup();
    }
  },
);

test("rejects UNC, device, and drive-relative paths before checking Windows file attributes", () => {
  for (const path of [
    String.raw`\\server\share\launch`,
    String.raw`\\?\UNC\server\share\launch`,
    String.raw`\\.\C:\launch`,
    String.raw`C:launch`,
    String.raw`\launch`,
  ]) {
    assert.equal(hasPlainLocalWindowsDirectory(path), false, path);
  }
});

test("Windows ACL decision requires the current SID to own a protected, private and inheritable DACL", () => {
  const user = "S-1-5-21-100-200-300-500";
  const rule = { sid: user, rights: 0x1f01ff, flags: 3, allow: true };
  const acl = { user, owner: user, protected: true, rules: [rule] };
  assert.equal(isPrivateWindowsLaunchAcl(acl), true);
  for (const rejected of [
    { ...acl, protected: false },
    { ...acl, owner: "S-1-5-18" },
    { ...acl, rules: null },
    { ...acl, rules: [] },
    { ...acl, rules: [rule, { ...rule, sid: "S-1-1-0" }] },
    { ...acl, rules: [{ ...rule, allow: false }] },
    { ...acl, rules: [{ ...rule, flags: 1 }] },
    { ...acl, rules: [{ ...rule, flags: 11 }] },
    { ...acl, rules: [{ ...rule, rights: 0x120089 }] },
  ])
    assert.equal(isPrivateWindowsLaunchAcl(rejected), false);
});
