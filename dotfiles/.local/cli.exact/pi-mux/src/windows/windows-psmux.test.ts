import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  psmuxNamespace,
  readPsmuxPaneInventory,
  readPsmuxPeers,
  waitForPsmuxClient,
  type PsmuxPeer,
  type PsmuxQuery,
} from "./windows-psmux";

const directories: string[] = [];
const instance = "aaaaaaaaaaaaaaaa";
const paneFormat = "#{pane_pid}\t#{@pi-tmux-session}";
const peers = [
  { name: "alpha", identity: "11:133970000000000000", port: 12341 },
  { name: "beta", identity: "12:133970000000000001", port: 12342 },
];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function registry() {
  const path = mkdtempSync(join(tmpdir(), "pi-mux-psmux-registry-"));
  directories.push(path);
  return path;
}

function row(peer: PsmuxPeer, args = { windows: 1, panes: 1 }) {
  return `${instance}\t${peer.identity.split(":")[0]}\t${peer.name}\t$1\t${args.windows}\t@0\t${args.panes}\t%0\t57\t\tpi-mux-audit-end\n`;
}

async function readPeers() {
  return peers;
}

const exactQuery: PsmuxQuery = async (args) => {
  const peer = peers.find(({ name }) => `=${name}` === args[3]);
  assert.ok(peer);
  assert.deepEqual(args.slice(0, 3), ["list-panes", "-s", "-t"]);
  assert.ok(args[5]?.endsWith(`${paneFormat}\tpi-mux-audit-end`));
  return { stdout: row(peer), stderr: "", exitCode: 0 };
};

describe("psmux registry", () => {
  it("uses the psmux hashed namespace for a socket outside the registry root", () => {
    const socket = psmuxNamespace("C:\\tmp\\audit.sock", "C:\\tmp\\registry");
    assert.equal(socket, "sock-8e7cb57e6d336c4c");
    assert.equal(psmuxNamespace("c:/TMP/audit.sock", "c:/tmp/registry"), socket);
  });

  it("preserves the case of a named namespace socket directly inside the registry root", () => {
    assert.equal(psmuxNamespace("C:\\registry\\Named", "c:/REGISTRY"), "Named");
  });

  it("does not treat another namespace or an unclaimed standby as a registered session", async () => {
    const path = registry();
    writeFileSync(join(path, "other__alpha.port"), "this entry is intentionally malformed");
    writeFileSync(join(path, "mux____warm__.port"), "12340");
    writeFileSync(join(path, "mux__alpha.port"), "12341");
    writeFileSync(join(path, "mux__alpha.pid"), peers[0]!.identity);
    assert.deepEqual(await readPsmuxPeers(path, "mux"), [peers[0]]);
  });

  it("rejects a partially published or read registry instead of ignoring it", async () => {
    const path = registry();
    writeFileSync(join(path, "mux__alpha.port"), "12341");
    await assert.rejects(readPsmuxPeers(path, "mux"), /alpha\.pid/);
  });
});

describe("psmux pane inventory", () => {
  it("reads exact targets and allows separate psmux processes to use the same local pane ID", async () => {
    assert.deepEqual(await readPsmuxPaneInventory(readPeers, exactQuery, instance, paneFormat), [
      { peer: peers[0], rows: ["57\t"] },
      { peer: peers[1], rows: ["57\t"] },
    ]);
  });

  it("does not accept an empty registry as evidence of a healthy management generation", async () => {
    await assert.rejects(
      readPsmuxPaneInventory(async () => [], exactQuery, instance, paneFormat),
      /No preexisting psmux peers/,
    );
  });

  it("accepts an empty pane list after the exact peer confirms zero windows", async () => {
    const [emptyPeer, activePeer] = peers;
    assert.ok(emptyPeer && activePeer);
    const query: PsmuxQuery = async (args) => {
      if (args[3] !== "=alpha") return await exactQuery(args);
      if (args[0] === "list-panes") return { stdout: "", stderr: "", exitCode: 0 };
      assert.deepEqual(args.slice(0, 4), ["display-message", "-p", "-t", "=alpha"]);
      assert.ok(args[4]?.includes("#{session_windows}"));
      return {
        stdout: `11\t${instance}\talpha\t$1\t0\tpi-mux-audit-end\r\n`,
        stderr: "",
        exitCode: 0,
      };
    };
    assert.deepEqual(await readPsmuxPaneInventory(readPeers, query, instance, paneFormat), [
      { peer: emptyPeer, rows: [] },
      { peer: activePeer, rows: ["57\t"] },
    ]);
  });

  it("rejects an empty pane list when the exact peer reports a window", async () => {
    const query: PsmuxQuery = async (args) => ({
      stdout:
        args[0] === "display-message" ? `11\t${instance}\talpha\t$1\t1\tpi-mux-audit-end\n` : "",
      stderr: "",
      exitCode: 0,
    });
    await assert.rejects(
      readPsmuxPaneInventory(async () => [peers[0]!], query, instance, paneFormat),
      /complete psmux pane inventory for alpha/,
    );
  });

  it.each([
    ["process", "12", instance],
    ["generation", "11", "bbbbbbbbbbbbbbbb"],
  ])("rejects a zero window count from a different %s", async (_, pid, reportedInstance) => {
    const query: PsmuxQuery = async (args) => ({
      stdout:
        args[0] === "display-message"
          ? `${pid}\t${reportedInstance}\talpha\t$1\t0\tpi-mux-audit-end\n`
          : "",
      stderr: "",
      exitCode: 0,
    });
    await assert.rejects(
      readPsmuxPaneInventory(async () => [peers[0]!], query, instance, paneFormat),
      /complete psmux pane inventory for alpha/,
    );
  });

  it("does not accept success from a quiet peer as proof of absence", async () => {
    const query: PsmuxQuery = async (args) =>
      args[3] === "=beta" ? { stdout: "", stderr: "", exitCode: 0 } : await exactQuery(args);
    await assert.rejects(
      readPsmuxPaneInventory(readPeers, query, instance, paneFormat),
      /complete psmux pane inventory for beta/,
    );
  });

  it("rejects a truncated payload even when all panes and windows were listed", async () => {
    const query: PsmuxQuery = async () => ({
      stdout: row(peers[0]!).replace("pi-mux-audit-end", ""),
      stderr: "",
      exitCode: 0,
    });
    await assert.rejects(
      readPsmuxPaneInventory(async () => [peers[0]!], query, instance, paneFormat),
      /changed psmux pane inventory/,
    );
  });

  it("detects missing windows in a successful but truncated pane response", async () => {
    const query: PsmuxQuery = async () => ({
      stdout: row(peers[0]!, { windows: 2, panes: 1 }),
      stderr: "",
      exitCode: 0,
    });
    await assert.rejects(
      readPsmuxPaneInventory(async () => [peers[0]!], query, instance, paneFormat),
      /Incomplete psmux pane inventory/,
    );
  });

  it("detects missing panes in a successful but truncated window response", async () => {
    const query: PsmuxQuery = async () => ({
      stdout: row(peers[0]!, { windows: 1, panes: 2 }),
      stderr: "",
      exitCode: 0,
    });
    await assert.rejects(
      readPsmuxPaneInventory(async () => [peers[0]!], query, instance, paneFormat),
      /Incomplete psmux pane inventory/,
    );
  });

  it("rejects an exact-target response from another process", async () => {
    const query: PsmuxQuery = async () => ({ stdout: row(peers[1]!), stderr: "", exitCode: 0 });
    await assert.rejects(
      readPsmuxPaneInventory(async () => [peers[0]!], query, instance, paneFormat),
      /changed psmux pane inventory/,
    );
  });

  it("rejects a session that was replaced during inventory even if it reused the PID", async () => {
    let reads = 0;
    const readRegistry = async () =>
      ++reads === 1 ? peers : [{ ...peers[0]!, identity: "11:133970000000000011" }, peers[1]!];
    await assert.rejects(
      readPsmuxPaneInventory(readRegistry, exactQuery, instance, paneFormat),
      /psmux registry changed/,
    );
  });
});

describe("Windows client switch confirmation", () => {
  const target = { clientPid: 81, name: "beta", serverPid: 12, instance };
  const correct = `81\tbeta\t12\t${instance}`;
  const response = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
  it("polls the exact destination until the resolved client registers", async () => {
    let calls = 0;
    await waitForPsmuxClient(
      async (args, remaining) => {
        assert.deepEqual(args, [
          "list-clients",
          "-t",
          "=beta",
          "-F",
          "#{client_pid}\t#{client_session}\t#{pid}\t#{server_instance}",
        ]);
        assert.ok(remaining > 0 && remaining <= 5000);
        return response(++calls === 1 ? "" : `${correct}\r\n`);
      },
      target,
      () => true,
    );
    assert.equal(calls, 2);
  });
  for (const [label, stdout, same] of [
    ["another terminal", correct.replace("81", "82"), true],
    ["another destination", correct.replace("beta", "alpha"), true],
    ["a replacement server", correct.replace("12", "13"), true],
    ["a replacement generation", correct.replace(instance, "bbbbbbbbbbbbbbbb"), true],
    ["a reused process ID", correct, false],
  ] as const) {
    it(`does not confirm ${label}`, async () => {
      await assert.rejects(
        waitForPsmuxClient(
          async () => response(stdout),
          target,
          () => same,
          15,
        ),
        /outcome unknown/,
      );
    });
  }
  it("rejects a matching report that arrives after the deadline", async () => {
    await assert.rejects(
      waitForPsmuxClient(
        async () => {
          await Bun.sleep(35);
          return response(correct);
        },
        target,
        () => true,
        15,
      ),
      /outcome unknown/,
    );
  });
});
