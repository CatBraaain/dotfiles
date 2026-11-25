import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { platform } from "./platform";
import { mutateWindowsPeerPane } from "./windows-lifecycle";
import { WindowsManagement } from "./windows-management";
import { inspectWindowsProcess } from "./windows-process";

const tmux = process.platform === "win32" ? Bun.which("tmux.exe") : null;

test.skipIf(!tmux)(
  "publishes state atomically to the audited Windows pane and repairs a contended promotion",
  async () => {
    assert.ok(tmux);
    const root = mkdtempSync(join(tmpdir(), "pi-mux native state-"));
    const profile = join(root, "home");
    const config = join(profile, ".config", "psmux", "pi.conf");
    const agent = join(profile, ".pi", "agent");
    const registry = join(root, "registry");
    const socket = join(profile, ".local", "state", "pi-tmux", "server.sock");
    const snapshot = join(agent, "pi-tmux", "pi-mux-restore.json");
    const mux = join(root, "pi-mux.exe");
    const id = randomUUID();
    const token = randomUUID();
    const title = "alpha \"quotes\" 'single' \\ ${STATE_TEST_TITLE} #{pid};\n秒";
    const lastRun = { atMs: 1760000000000, aborted: true };
    const file = join(root, "test.jsonl");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: profile,
      USERPROFILE: profile,
      PI_CODING_AGENT_DIR: agent,
      PSMUX_DATA_DIR: registry,
      PSMUX_NO_WARM: "1",
      STATE_TEST_TITLE: "not literal",
    };
    for (const key of Object.keys(environment)) {
      if (
        /^(TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM|PI_TMUX_.*)$/i.test(
          key,
        )
      )
        delete environment[key];
    }
    async function run(argv: string[]) {
      const child = Bun.spawn(argv, {
        cwd: root,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
        windowsHide: true,
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        exitCode,
        stdout: stdout.replaceAll("\r\n", "\n"),
        stderr: stderr.replaceAll("\r\n", "\n"),
      };
    }
    async function ok(argv: string[]) {
      const result = await run(argv);
      assert.equal(result.exitCode, 0, JSON.stringify({ argv, ...result }));
      return result.stdout.trimEnd();
    }
    const tmuxArgs = (...argv: string[]) => [tmux, "-S", socket, "-f", config, ...argv];
    const query = (...argv: string[]) => ok(tmuxArgs(...argv));
    const powershell = join(
      environment.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const paneCommand = [
      "--",
      powershell,
      "-NoProfile",
      "-EncodedCommand",
      Buffer.from("Start-Sleep -Seconds 120", "utf16le").toString("base64"),
    ];
    const get = (peer: string, format: string) =>
      query("display-message", "-p", "-t", peer, format);
    const set = (peer: string, option: string, value: string) =>
      query("set-option", "-p", "-t", peer, option, value);

    try {
      for (const directory of [dirname(config), agent, registry])
        mkdirSync(directory, { recursive: true });
      writeFileSync(config, "set -g exit-empty off\n");
      writeFileSync(
        file,
        [
          { type: "session", version: 3, id, cwd: root, timestamp: "2025-10-09T00:00:00Z" },
          {
            type: "custom",
            customType: "pi-mux-last-run",
            id: "last-run",
            parentId: null,
            timestamp: "2025-10-09T00:00:00Z",
            data: { sessionId: id, ...lastRun },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      await ok([
        process.execPath,
        "build",
        "--compile",
        join(import.meta.dir, "main.ts"),
        "--outfile",
        mux,
      ]);
      await query(
        "new-session",
        "-d",
        "-s",
        "one",
        "-c",
        root,
        "-e",
        `PI_TMUX_SESSION_ID=${id}`,
        ...paneCommand,
      );
      await query("new-session", "-d", "-s", "two", "-c", root, ...paneCommand);

      const pane = await get("=one", "#{pane_id}");
      assert.equal(await get("=two", "#{pane_id}"), pane);
      const serverPid = Number(await get("=one", "#{pid}"));
      const pid = Number(await get("=one", "#{pane_pid}"));
      const source = { socket, serverPid, pane, pid, token };
      const peerPane = `=one:0.${pane}`;
      await query("rename-window", "-t", "=one", "initial");
      const encoded = (overrides = {}) =>
        Buffer.from(
          JSON.stringify({ id, pid, token, file, startup: "ready", ...overrides }),
        ).toString("base64");
      await set(peerPane, "@pi-mux-launch", JSON.stringify({ id, pid, token }));
      await set(peerPane, "@pi-tmux-session", encoded());
      await set("=two", "@pi_session_state", "peer-two");
      await query("set-environment", "-t", "=one", "STATE_TEST_TITLE", "not literal");
      await query("bind-key", "-T", "root", "F11", "display-message", "custom");
      const secondPane = await query(
        "split-window",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "=one",
        ...paneCommand,
      );
      assert.notEqual(secondPane, pane);
      assert.equal(await get("=one", "#{pane_id}"), secondPane);
      const original = () => get(peerPane, "#{@pi_session_state}");
      const notify = (state: string, overrides = {}, sessionTitle: string | null = title) =>
        run([
          mux,
          "state",
          id,
          state,
          "--source",
          JSON.stringify({ ...source, ...overrides }),
          ...(state === "--clear" ? [] : ["--title", JSON.stringify(sessionTitle)]),
        ]);
      const success = { exitCode: 0, stdout: "", stderr: "" };
      assert.deepEqual(await notify("waiting-user"), success);
      const waiting = { version: 1, sessionId: id, state: "waiting-user", title, lastRun };
      assert.deepEqual(JSON.parse(await original()), waiting);
      assert.equal(await get(`=one:0.${secondPane}`, "#{@pi_session_state}"), "");
      assert.equal(await get("=two", "#{@pi_session_state}"), "peer-two");
      assert.equal(await get("=one", "#{pane_id}"), secondPane);
      assert.match(await query("list-keys", "-T", "root", "F11"), /display-message custom/);
      assert.equal(existsSync(snapshot), false);
      assert.equal((await notify("running", { token: randomUUID() })).exitCode, 1);
      assert.equal(
        (await notify("--clear", { serverPid: Number(await get("=two", "#{pid}")) })).exitCode,
        1,
      );
      await set(
        "=two",
        "@pi-tmux-session",
        encoded({ pid: Number(await get("=two", "#{pane_pid}")) }),
      );
      assert.equal((await notify("running")).exitCode, 1);
      await query("set-option", "-pu", "-t", "=two", "@pi-tmux-session");
      assert.deepEqual(JSON.parse(await original()), waiting);
      await set(peerPane, "@pi-mux-state-source", "new-owner");
      assert.deepEqual(await notify("--clear"), success);
      assert.deepEqual(JSON.parse(await original()), waiting);
      assert.deepEqual(await notify("waiting-approval", {}, null), success);
      assert.deepEqual(JSON.parse(await original()), {
        version: 1,
        sessionId: id,
        state: "waiting-approval",
        title: null,
      });

      const management = new WindowsManagement({
        socket,
        directory: dirname(socket),
        env: environment,
        query: (argv) => run(tmuxArgs(...argv)),
      });
      const basis = await management.currentBasis();
      assert.ok(basis);
      await management.prepareStartup(basis, [], (action) => action());
      await query("set-environment", "-t", "=one", "PI_TMUX_TEMPORARY", id);
      const lock = createServer();
      const key = createHash("sha256").update(management.lockResource).digest("hex");
      await new Promise<void>((resolve, reject) => {
        lock.once("error", reject);
        lock.listen(platform.lockAddress(key), resolve);
      });
      try {
        const busy = await notify("running");
        assert.equal(busy.exitCode, 75, JSON.stringify(busy));
        assert.match(busy.stderr, /holds the lock/);
        assert.equal(JSON.parse(await original()).state, "running");
        assert.equal(await get(peerPane, "#{@pi-mux-pending-restart-blocker}"), "1");
        assert.match(await get("=one", "#{@pi-mux-restart-veto}"), /^[-a-f0-9]{36}$/);
        const pending = JSON.parse(await get(peerPane, "#{@pi_session_state_pending}"));
        assert.equal(pending.sessionId, id);
        assert.ok(Number.isSafeInteger(pending.attemptAt) && pending.attemptAt > 0);
        assert.equal(await get("=one", "#{PI_TMUX_TEMPORARY}"), id);
        assert.equal(existsSync(snapshot), false);
        assert.deepEqual(await notify("waiting-user"), success);
        assert.deepEqual(JSON.parse(await original()), waiting);
        assert.equal(await get(peerPane, "#{@pi-mux-pending-restart-blocker}"), "");
        assert.deepEqual(JSON.parse(await get(peerPane, "#{@pi_session_state_pending}")), pending);
      } finally {
        await new Promise<void>((resolve, reject) =>
          lock.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await management.markRestored(basis, (action) => action());
      assert.deepEqual(await notify("running"), success);
      assert.equal(await get("=one", "#{PI_TMUX_TEMPORARY}"), "");
      assert.equal(await get(peerPane, "#{@pi_session_state_pending}"), "");
      assert.equal(Number(await get(peerPane, "#{pane_pid}")), pid);
      const saved = JSON.parse(readFileSync(snapshot, "utf8"));
      assert.equal(saved.generation, basis.instance);
      assert.deepEqual(
        saved.workspaces.flatMap((workspace: { sessions: string[] }) => workspace.sessions),
        [id],
      );
      rmSync(snapshot);
      assert.deepEqual(await notify("running"), success);
      assert.deepEqual(JSON.parse(readFileSync(snapshot, "utf8")), saved);
      assert.deepEqual(await notify("--clear"), success);
      assert.equal(await original(), "");
      assert.equal(await get(peerPane, "#{@pi-mux-state-source}"), "");
      assert.equal(await get("=two", "#{@pi_session_state}"), "peer-two");
      const replacementToken = randomUUID();
      await set(peerPane, "@pi-mux-launch", JSON.stringify({ id, pid, token: replacementToken }));
      await set(peerPane, "@pi-tmux-session", encoded({ token: replacementToken }));
      assert.deepEqual(await notify("waiting-user", { token: replacementToken }), success);
      assert.equal((await notify("--clear")).exitCode, 1);
      const audited = await management.audit("#{pane_id}");
      const { peer } = audited.panes.find(({ peer }) => peer.name === "one")!;
      const observed = inspectWindowsProcess(pid);
      assert.equal(observed.state, "live");
      await assert.rejects(
        mutateWindowsPeerPane(management.scope, audited, peer, pane, {
          expected: [
            ["pane_pid", String(pid)],
            ["@pi-tmux-session", encoded()],
            ["@pi-mux-launch", JSON.stringify({ id, pid, token })],
          ],
          mutations: [{ option: "@pi_session_state" }],
          processes: [observed.identity],
        }),
        /Cannot confirm guarded psmux pane mutation/,
      );
      assert.deepEqual(JSON.parse(await original()), waiting);
      assert.equal(await get("=one", "#{pane_id}"), secondPane);
    } finally {
      await run(tmuxArgs("kill-server"));
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  120_000,
);
