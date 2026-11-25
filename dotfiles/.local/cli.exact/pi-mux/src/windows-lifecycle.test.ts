import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWindowsProcesses,
  readWindowsPeerPaneFields,
  stopWindowsPeers,
  waitForWindowsExit,
} from "./windows-lifecycle";
import { conversationLaunchKey, WindowsLaunchRights } from "./windows-launch-rights";
import type { PsmuxObservation, PsmuxPeer } from "./windows-psmux";
import type { InspectWindowsProcess, WindowsProcessObservation } from "./windows-process";

const instance = "bbbbbbbbbbbbbbbb";
const key = "aaaaaaaaaaaaaaaa";
const namespace = "unit.sock";
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-mux-stop-"));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  const processes = new Map<number, WindowsProcessObservation>();
  const observation: PsmuxObservation = { basis: { instance, witnesses: [] }, panes: [] };
  const requests: string[] = [];

  async function addPeer(
    name: string,
    pid: number,
    {
      rejectAuth = false,
      refuseStop = false,
      held = false,
      paneReply,
    }: { rejectAuth?: boolean; refuseStop?: boolean; held?: boolean; paneReply?: string } = {},
  ) {
    const identity = { pid, creationTime: String(pid * 100) };
    const sockets = new Set<Socket>();
    const listener = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let buffered = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        while (buffered.includes("\n")) {
          const end = buffered.indexOf("\n");
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          requests.push(`${name}:${line}`);
          if (line === `AUTH ${key}`) {
            if (rejectAuth) socket.end("ERROR: Invalid session key\n");
            else socket.write("OK\n");
          } else if (line.startsWith("display-message ")) {
            socket.end(paneReply ?? "");
          } else if (refuseStop) {
            socket.end("PI_MUX_STOP_REFUSED\n");
          } else {
            processes.set(pid, { state: "ended" });
            socket.end();
          }
        }
      });
    });
    cleanup.push(() => {
      for (const socket of sockets) socket.destroy();
      listener.close();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const endpoint = listener.address();
    assert.ok(endpoint && typeof endpoint !== "string");
    const peer: PsmuxPeer = {
      name,
      identity: `${identity.pid}:${identity.creationTime}`,
      port: endpoint.port,
      ...(held ? { held: true } : {}),
    };
    writeFileSync(join(directory, `${namespace}__${name}.key`), key);
    processes.set(pid, { state: "live", identity });
    observation.basis.witnesses.push(peer.identity);
    observation.panes.push({ peer, rows: [] });
  }

  const inspect: InspectWindowsProcess = (pid) => processes.get(pid) ?? { state: "unknown" };
  return {
    addPeer,
    processes,
    requests,
    inspect,
    observation,
    attempts: { timeoutMs: 20, pollMs: 2 },
    stop: () => stopWindowsPeers({ registryDirectory: directory, namespace }, observation, inspect),
    readPane: (peer: PsmuxPeer, pane: string, fields: string[]) =>
      readWindowsPeerPaneFields(
        { registryDirectory: directory, namespace },
        observation,
        peer,
        pane,
        fields,
        inspect,
      ),
  };
}

function launchFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-mux-stop-rights-"));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  const child = { pid: 205, creationTime: "133971000000000000" };
  const basis = { instance, witnesses: ["12:133970000000000000"] };
  const rights = new WindowsLaunchRights({
    path: join(directory, "rights.json"),
    withClaimLock: async (action) => await action(),
    observeManagement: async () => basis,
    inspectProcess: (pid) => {
      assert.equal(pid, child.pid);
      return { state: "live", identity: child };
    },
  });
  const reserve = async (id: string) => {
    const result = await rights.reserveAfterLifecycleAudit([conversationLaunchKey(id)], basis);
    assert.equal(result.state, "reserved");
    return result.token;
  };
  return { child, rights, reserve };
}

describe("Windows restart launch fence", () => {
  it("revokes an unused launch before shutdown but retains a live child's exact identity", async () => {
    const { child, rights, reserve } = launchFixture();
    const reserved = await reserve("waiting");
    const started = await reserve("active");
    await rights.claimAndStart(started, randomUUID(), () => ({ pid: child.pid }));

    await assert.rejects(rights.fenceForRestart(false), /still active/);
    assert.equal((await rights.status(reserved)).state, "reserved");
    assert.deepEqual(await rights.fenceForRestart(true), [child]);
    assert.equal(
      await rights.claimAndStart(reserved, randomUUID(), () => assert.fail()),
      undefined,
    );
    assert.equal((await rights.status(started)).state, "live");
  });

  it("rejects an unresolved claim without discarding other reservations", async () => {
    const { rights, reserve } = launchFixture();
    const reserved = await reserve("waiting");
    const pending = await reserve("pending");
    await assert.rejects(
      rights.claimAndStart(pending, randomUUID(), () => {
        throw new Error("uncertain spawn");
      }),
      /uncertain spawn/,
    );

    await assert.rejects(rights.fenceForRestart(true), /Cannot determine the outcome/);
    assert.equal((await rights.status(reserved)).state, "reserved");
    assert.equal((await rights.status(pending)).state, "pending");
  });
});

describe("exact Windows psmux pane read", () => {
  it("reads one audited peer even when another peer has the same pane ID", async () => {
    const test = await fixture();
    await test.addPeer("first", 12, { paneReply: `12\t${instance}\tfirst\t%0\twaiting\t\n` });
    await test.addPeer("second", 25, { paneReply: `25\t${instance}\tsecond\t%0\trunning\t1\n` });
    assert.deepEqual(
      await test.readPane(test.observation.panes[1]!.peer, "%0", [
        "@pi_session_state",
        "@pi-mux-pending-restart-blocker",
      ]),
      ["running", "1"],
    );
    assert.equal(test.requests.length, 2);
    assert.ok(test.requests.every((line) => line.startsWith("second:")));
    assert.match(test.requests[1]!, /^second:display-message -p -t %0 /);
  });

  it("rejects a response from another generation or pane without a fallback query", async () => {
    const test = await fixture();
    await test.addPeer("first", 12, { paneReply: "12\tffffffffffffffff\tfirst\t%1\trunning\n" });
    await test.addPeer("second", 25);
    await assert.rejects(
      test.readPane(test.observation.panes[0]!.peer, "%0", ["@pi_session_state"]),
      /Cannot verify psmux pane read/,
    );
    assert.ok(test.requests.every((line) => line.startsWith("first:")));
  });

  it("refuses a reused process identity after authentication", async () => {
    const test = await fixture();
    await test.addPeer("first", 12);
    test.processes.set(12, { state: "live", identity: { pid: 12, creationTime: "99999" } });
    await assert.rejects(
      test.readPane(test.observation.panes[0]!.peer, "%0", ["@pi_session_state"]),
      /peer changed before pane read/,
    );
    assert.deepEqual(test.requests, [`first:AUTH ${key}`]);
  });
});

describe("exact Windows psmux shutdown", () => {
  it("authenticates every recorded peer before any shutdown and never sends to another scope", async () => {
    const test = await fixture();
    await test.addPeer("first", 12);
    await test.addPeer("__warm__", 25, { held: true });
    const targets = await test.stop();
    await waitForWindowsExit(targets, test.attempts, test.inspect);

    assert.deepEqual(
      new Set(test.requests.slice(0, 2)),
      new Set([`first:AUTH ${key}`, `__warm__:AUTH ${key}`]),
    );
    const first = test.requests.find((line) => line.startsWith("first:if-shell"));
    assert.match(
      first ?? "",
      /#\{pid\},12\}.*#\{server_instance\},bbbbbbbbbbbbbbbb\}.*#\{session_name\},first\}.*"kill-session"/,
    );
    const held = test.requests.find((line) => line.startsWith("__warm__:if-shell"));
    assert.match(held ?? "", /#\{pid\},25\}.*#\{session_name\},\}.*"kill-server"/);
  });

  it("does not send shutdown to any peer when one authentication fails", async () => {
    const test = await fixture();
    await test.addPeer("first", 12);
    await test.addPeer("replacement", 25, { rejectAuth: true });

    await assert.rejects(test.stop(), /Cannot bind to exact psmux peer replacement/);
    assert.ok(test.requests.every((request) => request.includes(":AUTH ")));
    assert.equal(test.inspect(12).state, "live");
  });

  it("does not send shutdown after the process ID has been reused", async () => {
    const test = await fixture();
    await test.addPeer("first", 12);
    test.processes.set(12, { state: "live", identity: { pid: 12, creationTime: "99999" } });

    await assert.rejects(test.stop(), /peer changed before shutdown: first/);
    assert.deepEqual(test.requests, [`first:AUTH ${key}`]);
  });

  it("reports a native guard refusal rather than treating EOF as successful", async () => {
    const test = await fixture();
    await test.addPeer("first", 12, { refuseStop: true });

    await assert.rejects(test.stop(), /Cannot confirm shutdown command for psmux peer first/);
    assert.equal(test.inspect(12).state, "live");
  });

  it("requires verified old-process exit even after a command has been sent", async () => {
    const test = await fixture();
    await test.addPeer("first", 12);
    const targets = captureWindowsProcesses([12], test.inspect);
    test.processes.set(12, { state: "unknown" });

    await assert.rejects(
      waitForWindowsExit(targets, test.attempts, test.inspect),
      /Cannot confirm the old/,
    );
    test.processes.set(12, { state: "live", identity: { pid: 12, creationTime: "9999" } });
    await waitForWindowsExit(targets, test.attempts, test.inspect);
  });
});
