import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findWindowsServerProcesses,
  stopWindowsProcess,
  windowsProcessCreatedAt,
} from "./windows-process";

const projectDir = join(import.meta.dir, "..");

describe.skipIf(process.platform !== "win32")("Windows Camoufox restart", () => {
  it("does not terminate a process whose creation time differs", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    try {
      const createdAt = windowsProcessCreatedAt(child.pid);
      assert.match(createdAt ?? "", /^[0-9a-f]{16}$/);
      stopWindowsProcess(child.pid, "0000000000000000", 1_000);
      assert.equal(windowsProcessCreatedAt(child.pid), createdAt);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it("matches only the same script path and server invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "browse windows identity-"));
    const script = join(root, "browse.ts");
    const otherScript = join(root, "other.ts");
    const port = "49778";
    const command = [process.execPath, script];
    const children: Bun.Subprocess[] = [];
    try {
      writeFileSync(script, "await Bun.sleep(30000);");
      writeFileSync(otherScript, "await Bun.sleep(30000);");
      for (const argv of [
        [script, "__server", port],
        [otherScript, "__server", port],
        [join(root, "Browse.ts"), "__server", port],
        [script, "search", "__server", port],
      ]) {
        children.push(Bun.spawn([process.execPath, ...argv]));
      }

      const candidates = findWindowsServerProcesses(command, "__server", port);
      assert.deepEqual(
        candidates.map(({ pid }) => pid),
        [children[0]!.pid],
      );
      const [target] = candidates;
      assert.ok(target);
      stopWindowsProcess(target.pid, target.identity, 2_000);
      const stopped = await Promise.race([
        children[0]!.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      assert.equal(stopped, true);
      for (const child of children.slice(1)) {
        assert.ok(windowsProcessCreatedAt(child.pid));
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("restarts only the matching server, including when it no longer listens", async () => {
    const root = mkdtempSync(join(tmpdir(), "browse-win-restart-"));
    const isolatedProject = join(root, "browse cli");
    const command = [process.execPath, isolatedProject];
    const camoufoxModuleDir = join(root, ".pi", "agent", "node_modules", "camoufox-js", "dist");
    const installDir = join(root, "Camoufox");
    const playwrightModule = join(root, "playwright.cjs");

    function reserveEndpoint() {
      const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const endpoint = "ws://127.0.0.1:" + listener.port + "/camoufox";
      listener.stop(true);
      return endpoint;
    }

    const endpoint = reserveEndpoint();
    const otherEndpoint = reserveEndpoint();
    const port = new URL(endpoint).port;
    const otherPort = new URL(otherEndpoint).port;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: root,
      HOME: root,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: "",
      CAMOUFOX_HEADLESS: "1",
      CAMOUFOX_BASE_URL: endpoint,
      CAMOUFOX_INSTALL_DIR: installDir,
      CAMOUFOX_PLAYWRIGHT_CORE: playwrightModule,
    };
    delete env.CAMOUFOX_EXECUTABLE_PATH;

    mkdirSync(isolatedProject);
    for (const entry of ["src", "scripts", "package.json"]) {
      cpSync(join(projectDir, entry), join(isolatedProject, entry), { recursive: true });
    }
    mkdirSync(camoufoxModuleDir, { recursive: true });
    writeFileSync(join(camoufoxModuleDir, "utils.js"), "export const launchOptions = () => ({});");
    writeFileSync(
      join(camoufoxModuleDir, "pkgman.js"),
      "export const camoufoxPath = () => process.env.CAMOUFOX_INSTALL_DIR;",
    );
    mkdirSync(installDir);
    writeFileSync(join(installDir, "camoufox.exe"), "");
    writeFileSync(
      playwrightModule,
      [
        "module.exports.firefox = { async launchServer({ host, port, wsPath }) {",
        "  if (process.env.FIXTURE_NO_LISTENER === '1') {",
        "    const timer = setInterval(() => {}, 1000);",
        "    return { close() { clearInterval(timer); } };",
        "  }",
        "  const server = Bun.serve({ hostname: host, port, fetch(request, server) {",
        "    if (new URL(request.url).pathname === wsPath && server.upgrade(request)) return;",
        "    return new Response(null, { status: 404 });",
        "  }, websocket: { message() {} } });",
        "  return { close() { server.stop(true); } };",
        "} };",
      ].join("\n"),
    );

    const stale = Bun.spawn([...command, "__server", port], {
      env: { ...env, FIXTURE_NO_LISTENER: "1" },
    });
    const other = Bun.spawn([...command, "__server", otherPort], {
      env: { ...env, CAMOUFOX_BASE_URL: otherEndpoint },
    });
    try {
      const oldIdentity = windowsProcessCreatedAt(stale.pid);
      const otherIdentity = windowsProcessCreatedAt(other.pid);
      assert.ok(oldIdentity && otherIdentity);
      assert.deepEqual(
        findWindowsServerProcesses(command, "__server", port).map((x) => x.pid),
        [stale.pid],
      );
      assert.deepEqual(
        findWindowsServerProcesses(command, "__server", otherPort).map((x) => x.pid),
        [other.pid],
      );

      const restarted = Bun.spawnSync([...command, "server", "restart"], { env, timeout: 20_000 });
      assert.equal(restarted.exitCode, 0, restarted.stderr.toString());
      assert.equal(windowsProcessCreatedAt(stale.pid), undefined);
      assert.equal(windowsProcessCreatedAt(other.pid), otherIdentity);
      const replacements = findWindowsServerProcesses(command, "__server", port);
      assert.equal(replacements.length, 1);
      assert.notEqual(replacements[0]!.identity, oldIdentity);
    } finally {
      try {
        for (const candidate of findWindowsServerProcesses(command, "__server", port)) {
          stopWindowsProcess(candidate.pid, candidate.identity, 2_000);
        }
      } finally {
        for (const child of [stale, other]) {
          if (child.exitCode === null) child.kill();
          await child.exited;
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
