import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";
import { quote } from "shell-quote";

type Outcome = { out: string; err: string; code: number };
type Pane = { id: string; file: string; cwd: string; pid: number; pane: string; session: string };
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(EXTENSION_DIR, "../../../../.agents/cli.exact/pimux/src/main.ts");
const TIMEOUT_MS = 60_000;

async function fixture(test: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try {
    await test(f);
  } finally {
    writeFileSync(join(f.root, "has-released"), "");
    writeFileSync(join(f.root, "create-released"), "");
    await f.tmux(["kill-server"]);
    await f.tmux(["kill-server"], f.outer);
  }
}

async function createFixture() {
  const parent = "/tmp/work/dotfiles";
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "pimux-regression-"));
  const agent = join(root, "agent");
  const runtime = join(root, "runtime");
  const bin = join(root, "bin");
  const cwdA = join(root, "cwd-a");
  const cwdB = join(root, "cwd-b");
  const outer = join(root, "outer.sock");
  const socket = join(runtime, "pi-tmux/server.sock");
  for (const path of [join(agent, "extensions"), runtime, bin, cwdA, cwdB, join(root, "home")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  symlinkSync(EXTENSION_DIR, join(agent, "extensions/tmux-handoff"));
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture",
      defaultProjectTrust: "never",
      quietStartup: true,
      compaction: { enabled: false },
    }),
  );
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 10000,
              maxTokens: 100,
            },
          ],
        },
      },
    }),
  );
  const realTmux = Bun.which("tmux");
  assert.ok(realTmux, "tmux is required");
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/sh
case "$*" in
  *"has-session -t =pi-empty")
    if test "$TEST_PAUSE_HAS" = 1; then
      ${quote([realTmux])} "$@"; code=$?
      if test "$code" = 0 && ! test -f ${quote([join(root, "has-released")])}; then
        touch ${quote([join(root, "has-ready")])}
        while ! test -f ${quote([join(root, "has-released")])}; do sleep 0.02; done
      fi
      exit "$code"
    fi ;;
  *"source-file -")
    if test "$TEST_PAUSE_CREATE" = 1; then
      touch ${quote([join(root, "create-ready")])}
      while ! test -f ${quote([join(root, "create-released")])}; do sleep 0.02; done
    fi ;;
esac
exec ${quote([realTmux])} "$@"
`,
  );
  chmodSync(join(bin, "tmux"), 0o700);
  const env = {
    PATH: bin + ":" + process.env.PATH!,
    HOME: join(root, "home"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: runtime,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
  const outerConfig = join(root, "outer.conf");
  writeFileSync(outerConfig, "set -g exit-empty off\nset -g exit-unattached off\n");

  async function run(
    args: string[],
    cwd = cwdB,
    extra: Record<string, string> = {},
  ): Promise<Outcome> {
    const child = Bun.spawn([process.execPath, CLI, ...args], {
      cwd,
      env: { ...env, ...extra },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  }

  async function tmux(args: string[], target = socket): Promise<Outcome> {
    const child = Bun.spawn([realTmux!, "-S", target, ...args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  }

  async function panes(): Promise<Pane[]> {
    const result = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_id}\t#{@pi-tmux-session}",
    ]);
    if (result.code !== 0) return [];
    return result.out
      .trimEnd()
      .split("\n")
      .flatMap((line) => {
        const [pane, session, encoded] = line.split("\t");
        if (!encoded) return [];
        return [{ ...JSON.parse(Buffer.from(encoded, "base64").toString()), pane, session }];
      });
  }

  async function client(
    name: string,
    args: string[],
    cwd = cwdB,
    extra: Record<string, string> = {},
  ) {
    const command = quote([
      "env",
      "-i",
      ...Object.entries({ ...env, ...extra }).map(([key, value]) => `${key}=${value}`),
      process.execPath,
      CLI,
      ...args,
    ]);
    const script = `${command}; code=$?; printf '%s' "$code" > ${quote([join(root, name + ".code")])}; sleep 30`;
    const result = await tmux(
      [
        "-f",
        outerConfig,
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        "-x",
        "110",
        "-y",
        "32",
        "--",
        "/bin/sh",
        "-c",
        script,
      ],
      outer,
    );
    assert.equal(result.code, 0, result.err);
  }

  async function persist(pane: Pane) {
    await tmux(["send-keys", "-t", pane.pane, "-l", "regression user message"]);
    await tmux(["send-keys", "-t", pane.pane, "Enter"]);
    await waitFor(() =>
      existsSync(pane.file) && readFileSync(pane.file, "utf8").includes("regression user message")
        ? true
        : undefined,
    );
  }

  async function detachAll(expectedClients = 1) {
    const names = await waitFor(async () => {
      const result = await tmux(["list-clients", "-F", "#{client_name}"]);
      const connected = result.out.trim().split("\n").filter(Boolean);
      return connected.length >= expectedClients ? connected : undefined;
    });
    for (const name of names) await tmux(["detach-client", "-t", name]);
  }

  async function exitCode(name: string) {
    return await waitFor(() => {
      const path = join(root, name + ".code");
      return existsSync(path) ? Number(readFileSync(path, "utf8")) : undefined;
    });
  }

  return {
    root,
    agent,
    runtime,
    socket,
    outer,
    cwdA,
    cwdB,
    run,
    tmux,
    panes,
    client,
    persist,
    detachAll,
    exitCode,
  };
}

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for the isolated pi fixture");
}

async function firstPane(f: Awaited<ReturnType<typeof createFixture>>): Promise<Pane> {
  return await waitFor(async () => (await f.panes())[0]);
}

function processEnvironment(pid: number): string[] {
  return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
}

describe("pimux CLI boundaries", () => {
  it(
    "keeps concurrent new and open attached across a saved reservation rename",
    async () => {
      await fixture(async (f) => {
        await f.client("initial", ["new"], f.cwdA);
        const first = await firstPane(f);
        await f.persist(first);
        await f.detachAll();
        assert.equal(await f.exitCode("initial"), 0);

        await f.client("slow", ["new"], f.cwdB, { TEST_PAUSE_HAS: "1" });
        await waitFor(() => (existsSync(join(f.root, "has-ready")) ? true : undefined));
        await f.client("fast", ["new"], f.cwdB, { TEST_PAUSE_CREATE: "1" });
        await waitFor(() => (existsSync(join(f.root, "create-ready")) ? true : undefined));
        await f.client("open", ["open", first.id], f.cwdB);
        writeFileSync(join(f.root, "has-released"), "");
        await waitFor(async () => {
          if (existsSync(join(f.root, "slow.code")))
            assert.equal(await f.exitCode("slow"), 0, "A renamed reservation is not a pi exit");
          return (await f.panes()).some((pane) => !existsSync(pane.file)) ? true : undefined;
        });
        writeFileSync(join(f.root, "create-released"), "");
        await waitFor(async () => {
          const clients = await f.tmux(["list-clients", "-F", "#{client_name}"]);
          return clients.out.trim().split("\n").length === 3 ? true : undefined;
        });
        const panes = await f.panes();
        assert.equal(panes.filter((pane) => !existsSync(pane.file)).length, 1);
        assert.equal(panes.find((pane) => pane.id === first.id)?.pid, first.pid);
        await f.detachAll();
        for (const name of ["slow", "fast", "open"]) assert.equal(await f.exitCode(name), 0, name);
      });
    },
    TIMEOUT_MS,
  );

  for (const relative of [false, true]) {
    it(
      `reopens ${relative ? "a relative" : "an absolute"} project store after runtime loss from another cwd`,
      async () => {
        await fixture(async (f) => {
          const store = join(f.root, "project-store");
          mkdirSync(join(f.cwdA, ".pi"));
          writeFileSync(
            join(f.cwdA, ".pi/settings.json"),
            JSON.stringify({
              sessionDir: relative ? "../project-store" : store,
            }),
          );
          await f.client("initial", ["new"], f.cwdA);
          const first = await firstPane(f);
          assert.equal(dirname(first.file), store);
          await f.persist(first);
          await f.detachAll();
          assert.equal(await f.exitCode("initial"), 0);
          await f.tmux(["kill-server"]);
          rmSync(f.runtime, { recursive: true });
          mkdirSync(f.runtime, { mode: 0o700 });
          await f.client("reopen", ["open", first.id], f.cwdB);
          const reopened = await firstPane(f);
          assert.equal(reopened.id, first.id);
          assert.equal(reopened.file, first.file);
          assert.equal(reopened.cwd, f.cwdA);
          assert.notEqual(reopened.pid, first.pid);
          await f.detachAll();
          assert.equal(await f.exitCode("reopen"), 0);
        });
      },
      TIMEOUT_MS,
    );
  }

  for (const symlink of [false, true]) {
    it(
      `reopens registered ${symlink ? "symlink" : "ordinary"} storage below the standard root without false ambiguity`,
      async () => {
        await fixture(async (f) => {
          const standard = join(f.agent, "sessions");
          const store = join(standard, symlink ? "alias" : "custom-store");
          if (symlink) {
            const physicalStore = join(f.root, "physical-store");
            mkdirSync(standard);
            mkdirSync(physicalStore);
            symlinkSync(physicalStore, store);
          } else {
            assert.equal(existsSync(store), false);
          }
          mkdirSync(join(f.cwdA, ".pi"));
          writeFileSync(join(f.cwdA, ".pi/settings.json"), JSON.stringify({ sessionDir: store }));
          await f.client("initial", ["new"], f.cwdA);
          const first = await firstPane(f);
          assert.equal(dirname(first.file), store);
          await f.persist(first);
          await f.detachAll();
          assert.equal(await f.exitCode("initial"), 0);
          const registry = join(f.agent, "pi-tmux/session-dirs");
          assert.ok(existsSync(registry), "Used storage roots must be recorded");
          const recorded = readdirSync(registry)
            .filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(registry, name), "utf8")));
          assert.ok(recorded.includes(store));
          await f.tmux(["kill-server"]);
          rmSync(f.runtime, { recursive: true });
          mkdirSync(f.runtime, { mode: 0o700 });
          await f.client("reopen", ["open", first.id], f.cwdB);
          const reopened = await firstPane(f);
          assert.equal(reopened.id, first.id);
          assert.equal(realpathSync(reopened.file), realpathSync(first.file));
          assert.equal(reopened.cwd, f.cwdA);
          assert.notEqual(reopened.pid, first.pid);
          await f.client("same-file-open", ["open", first.id], f.cwdB);
          await waitFor(async () => {
            const clients = await f.tmux(["list-clients", "-F", "#{client_name}"]);
            return clients.out.trim().split("\n").length === 2 ? true : undefined;
          });
          assert.equal((await f.panes()).filter((pane) => pane.id === first.id).length, 1);
          await f.detachAll(2);
          assert.equal(await f.exitCode("reopen"), 0);
          assert.equal(await f.exitCode("same-file-open"), 0);
        });
      },
      TIMEOUT_MS,
    );
  }

  it(
    "retains every concurrently registered project storage directory",
    async () => {
      await fixture(async (f) => {
        const directories = Array.from({ length: 8 }, (_, index) =>
          join(f.root, "project-" + index),
        );
        const stores = directories.map((cwd) => join(cwd, "store"));
        for (const [index, cwd] of directories.entries()) {
          mkdirSync(join(cwd, ".pi"), { recursive: true });
          writeFileSync(
            join(cwd, ".pi/settings.json"),
            JSON.stringify({ sessionDir: stores[index] }),
          );
        }
        const results = await Promise.all(
          directories.map((cwd) => f.run(["open", "missing-id"], cwd)),
        );
        for (const result of results) assert.match(result.err, /Session not found/);
        const registry = join(f.agent, "pi-tmux/session-dirs");
        const recorded = readdirSync(registry)
          .filter((name) => name.endsWith(".json"))
          .map((name) => JSON.parse(readFileSync(join(registry, name), "utf8")));
        assert.deepEqual(recorded.sort(), stores.sort());
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects duplicate saved IDs before attaching to a live pi and permits an unsaved live ID",
    async () => {
      await fixture(async (f) => {
        await f.client("initial", ["new"], f.cwdA);
        const first = await firstPane(f);
        await f.persist(first);
        await f.detachAll();
        const duplicate = join(f.agent, "sessions/duplicate.jsonl");
        copyFileSync(first.file, duplicate);
        const ambiguous = await f.run(["open", first.id]);
        assert.notEqual(ambiguous.code, 0);
        assert.match(ambiguous.err, /Ambiguous session ID/);
        assert.equal((await f.panes()).find((pane) => pane.id === first.id)?.pid, first.pid);
        assert.equal((await f.tmux(["list-clients", "-F", "#{client_name}"])).out.trim(), "");
        rmSync(duplicate);
        await f.client("empty", ["new"], f.cwdB);
        const empty = await waitFor(async () =>
          (await f.panes()).find((pane) => pane.id !== first.id),
        );
        assert.equal(existsSync(empty.file), false);
        await f.client("unsaved-open", ["open", empty.id], f.cwdA);
        await waitFor(async () => {
          const clients = await f.tmux(["list-clients", "-F", "#{client_name}"]);
          return clients.out.trim().split("\n").length === 2 ? true : undefined;
        });
        assert.equal((await f.panes()).filter((pane) => pane.id === empty.id).length, 1);
        await f.detachAll();
        assert.equal(await f.exitCode("unsaved-open"), 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "drops past caller variables without mixing concurrent new and open environments",
    async () => {
      await fixture(async (f) => {
        const token =
          'caller-A-dummy-token\nDECOY=secret-fragment; export DECOY;\nquote\\" dollar$';
        await f.client("initial", ["new"], f.cwdA, { REVIEW_ONLY_TOKEN: token });
        const first = await firstPane(f);
        assert.ok(processEnvironment(first.pid).includes("REVIEW_ONLY_TOKEN=" + token));
        await f.persist(first);
        await f.detachAll();
        await f.client("second", ["new"], f.cwdB);
        const second = await waitFor(async () =>
          (await f.panes()).find((pane) => pane.id !== first.id),
        );
        assert.equal(
          processEnvironment(second.pid).some((entry) => entry.startsWith("REVIEW_ONLY_TOKEN=")),
          false,
        );
        await f.persist(second);
        await f.detachAll();
        await Promise.all([
          f.client("third", ["new"], f.cwdB, { CALLER_TAG: "new-caller" }),
          f.client("old-open", ["open", first.id], f.cwdA, { CALLER_TAG: "open-caller" }),
        ]);
        const third = await waitFor(async () =>
          (await f.panes()).find((pane) => !existsSync(pane.file)),
        );
        const thirdEnvironment = processEnvironment(third.pid);
        assert.ok(thirdEnvironment.includes("CALLER_TAG=new-caller"));
        assert.equal(
          thirdEnvironment.some((entry) => entry.startsWith("REVIEW_ONLY_TOKEN=")),
          false,
        );
        assert.equal(
          readFileSync(`/proc/${third.pid}/cmdline`, "utf8").includes("secret-fragment"),
          false,
        );
        assert.ok(processEnvironment(first.pid).includes("REVIEW_ONLY_TOKEN=" + token));
        assert.equal(
          processEnvironment(first.pid).some((entry) => entry.startsWith("CALLER_TAG=")),
          false,
        );
        assert.equal(readFileSync(`/proc/${first.pid}/cmdline`, "utf8").includes(token), false);
        await f.detachAll(2);
        assert.equal(await f.exitCode("third"), 0);
        assert.equal(await f.exitCode("old-open"), 0);
      });
    },
    TIMEOUT_MS,
  );
});
