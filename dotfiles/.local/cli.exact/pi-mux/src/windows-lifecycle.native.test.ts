import { it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  captureWindowsProcesses,
  configureWindowsPeer,
  stopWindowsPeers,
  waitForWindowsExit,
  WINDOWS_BOOTSTRAP_PROOF,
} from "./windows-lifecycle";
import { WindowsManagement } from "./windows-management";

const psmux = process.platform === "win32" ? Bun.which("psmux.exe") : null;

it.skipIf(!psmux)(
  "stops only the audited psmux 3.4 peers and waits for their pane processes",
  async () => {
    assert.ok(psmux);
    const directory = mkdtempSync(join(tmpdir(), "pi-mux-lifecycle-native-"));
    const registryDirectory = join(directory, "registry");
    const config = join(directory, "psmux test.conf");
    const socket = join(directory, "first.sock");
    const external = join(directory, "second.sock");
    mkdirSync(registryDirectory);
    writeFileSync(config, "set -g exit-empty off\n");
    const proof = randomUUID();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [WINDOWS_BOOTSTRAP_PROOF]: proof,
      PSMUX_DATA_DIR: registryDirectory,
      PSMUX_NO_WARM: "1",
    };
    for (const name of Object.keys(env))
      if (
        [
          "TMUX",
          "TMUX_PANE",
          "PSMUX_TARGET_SESSION",
          "PSMUX_TARGET_FULL",
          "PSMUX_ROUTE_WARM",
        ].includes(name.toUpperCase())
      )
        delete env[name];
    const powerShell = join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const sleep = Buffer.from("Start-Sleep -Seconds 90", "utf16le").toString("base64");

    function run(target: string, args: string[]) {
      const result = Bun.spawnSync([psmux!, "-S", target, "-f", config, ...args], {
        cwd: directory,
        env,
        timeout: 10_000,
        windowsHide: true,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    }

    function ok(target: string, ...args: string[]) {
      const result = run(target, args);
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      return result.stdout.trim();
    }

    function newPeer(target: string, name: string) {
      ok(
        target,
        "new-session",
        "-d",
        "-s",
        name,
        "--",
        powerShell,
        "-NoProfile",
        "-EncodedCommand",
        sleep,
      );
    }

    const management = new WindowsManagement({
      socket,
      directory,
      env,
      query: async (args) => run(socket, args),
    });
    const observe = () => management.audit("#{pane_pid}", { requireRestored: false });

    try {
      ok(socket, "start-server", ";", "display-message", "-p", "#{pid}");
      const held = await observe();
      assert.deepEqual(
        held.panes.map(({ peer }) => peer.held),
        [true],
      );
      const options = { configFile: config, hookCommand: 'hook "with spaces"' };
      await assert.rejects(
        configureWindowsPeer(management.scope, held, { ...options, proof: randomUUID() }),
        /Unexpected psmux bootstrap response/,
      );
      assert.equal(ok(socket, "display-message", "-p", "#{@pi-mux-snapshot}"), "");
      await configureWindowsPeer(management.scope, held, { ...options, proof });
      assert.equal(
        ok(socket, "display-message", "-p", "#{@pi-mux-snapshot}"),
        'hook "with spaces"',
      );
      const heldProcesses = await stopWindowsPeers(management.scope, held);
      await waitForWindowsExit(heldProcesses, { timeoutMs: 5000, pollMs: 25 });
      assert.equal(await management.currentBasis(), undefined);

      newPeer(socket, "same");
      newPeer(socket, "other");
      newPeer(external, "same");

      const audited = await observe();
      assert.equal(audited.panes.filter(({ peer }) => !peer.held).length, 2);
      assert.notEqual(audited.basis.instance, held.basis.instance);
      const externalPid = ok(external, "display-message", "-p", "-t", "=same", "#{pid}");
      await assert.rejects(configureWindowsPeer(management.scope, held, options));
      writeFileSync(config, "set -g exit-empty off\nset -g @sourced from-file\n");
      await configureWindowsPeer(management.scope, audited, options);
      const configured = `=${audited.panes[0]!.peer.name}`;
      assert.equal(
        ok(socket, "display-message", "-p", "-t", configured, "#{@sourced}"),
        "from-file",
      );
      assert.equal(ok(external, "display-message", "-p", "-t", "=same", "#{@sourced}"), "");
      const wrongInstance =
        audited.basis.instance === "ffffffffffffffff" ? "aaaaaaaaaaaaaaaa" : "ffffffffffffffff";
      await assert.rejects(
        stopWindowsPeers(management.scope, {
          ...audited,
          basis: { ...audited.basis, instance: wrongInstance },
        }),
        /Cannot confirm shutdown command/,
      );
      assert.deepEqual((await observe()).basis, audited.basis);

      const panes = captureWindowsProcesses(audited.panes.flatMap(({ rows }) => rows.map(Number)));
      assert.equal(panes.length, 2);
      const peers = await stopWindowsPeers(management.scope, audited);
      await waitForWindowsExit([...peers, ...panes], { timeoutMs: 5000, pollMs: 25 });
      assert.equal(await management.currentBasis(), undefined);
      assert.equal(ok(external, "display-message", "-p", "-t", "=same", "#{pid}"), externalPid);

      newPeer(socket, "same");
      assert.notEqual((await observe()).basis.instance, audited.basis.instance);
    } finally {
      run(socket, ["kill-server"]);
      run(external, ["kill-server"]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  40_000,
);
