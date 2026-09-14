// Persistent Camoufox server for the dsh-web-search plugin (SPEC.md §常駐サーバー).
// Started lazily by the plugin entry with `bun server.mjs` and kept running
// until the machine shuts down or the process is killed. The websocket endpoint
// defaults to ws://127.0.0.1:9378/camoufox and follows CAMOUFOX_BASE_URL when
// set (the plugin resolves config > env > default and passes the result here
// through the child environment, so connect target and listen address always
// agree). A second launch fails on port collision, which is harmless: the
// first server keeps serving.
//
// Fingerprint generation borrows camoufox-js; the browser itself is launched by
// the same playwright-core that playwright-cli embeds, so the server always
// speaks the client's protocol version (no HTTP 428 on connect).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launchOptions } from "camoufox-js/dist/utils.js";

const DEFAULT_BASE_URL = "ws://127.0.0.1:9378/camoufox";
const EXECUTABLE_PATH =
	process.env.CAMOUFOX_EXECUTABLE_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox-bin");

const require = createRequire(import.meta.url);

// SPEC: 接続先は環境変数 CAMOUFOX_BASE_URL で変更できる（既定はローカルホストの websocket）。
const baseUrl = new URL(process.env.CAMOUFOX_BASE_URL ?? DEFAULT_BASE_URL);

// The plugin appends this server's stdout/stderr to the log file across
// starts, so leave a timestamped line to tell the runs apart when debugging
// hangs.
console.log(`[camoufox-server] starting on ${baseUrl} at ${new Date().toISOString()}`);

// The playwright-cli-embedded playwright-core is the single source of truth for
// the server's protocol version: clients must send a matching major.minor in
// their User-Agent or the upgrade is rejected with HTTP 428.
function resolvePlaywrightCore() {
	const override = process.env.CAMOUFOX_PLAYWRIGHT_CORE;
	if (override) return require(override);
	const finder = process.platform === "win32" ? "where" : "which";
	const output = spawnSync(finder, ["playwright-cli"], { encoding: "utf8" });
	const binary = output.stdout?.trim().split(/\r?\n/)[0];
	if (!binary) throw new Error("playwright-cli not found on PATH");
	const packageDir = dirname(realpathSync(binary));
	return require(require.resolve("playwright-core", { paths: [packageDir] }));
}

const { firefox } = resolvePlaywrightCore();

// Fingerprint: freshly generated on every server start (os spoofed to Windows).
// block_webgl disables WebGL instead of spoofing it: sampling the WebGL
// fingerprint needs better-sqlite3, whose native build is unavailable here.
const launch = await launchOptions({
	headless: true,
	os: ["windows"],
	executable_path: EXECUTABLE_PATH,
	i_know_what_im_doing: true,
	block_webgl: true,
});

// Firefox hangs in sandboxed environments here (same root cause as Chrome's
// --no-sandbox), so disable all Firefox process sandboxes.
launch.env = {
	...launch.env,
	MOZ_DISABLE_CONTENT_SANDBOX: "1",
	MOZ_DISABLE_GMP_SANDBOX: "1",
	MOZ_DISABLE_RDD_SANDBOX: "1",
	MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: "1",
	XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
};

const server = await firefox.launchServer({
	...launch,
	// SPEC: 接続先（CAMOUFOX_BASE_URL）の host・port・path で待ち受ける。
	host: baseUrl.hostname,
	port: Number(baseUrl.port),
	wsPath: baseUrl.pathname === "/" ? "/camoufox" : baseUrl.pathname,
});

console.log(`[camoufox-server] listening on ${baseUrl}`);
console.log(`[camoufox-server] executablePath: ${launch.executablePath}`);

process.on("SIGINT", async () => {
	await server.close();
	process.exit(0);
});
process.on("SIGTERM", async () => {
	await server.close();
	process.exit(0);
});
