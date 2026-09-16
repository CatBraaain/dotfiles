// Pure helpers for the headed camoufox setup (SPEC.md §camoufox の表示モード).
// server.mjs uses these to decide the launch mode and to build the Xvfb /
// x11vnc commands. Kept free of side effects so they stay unit-testable.

export const DISPLAY_NUMBER = 99;
export const VNC_PORT = 5900;
export const XVFB_SCREEN = "1920x1080x24";

// SPEC: Linux では既定で headed（Xvfb 上）。`CAMOUFOX_HEADLESS=1` で従来の
// headless に戻せる。Xvfb のない Windows では既定で headless のまま。
export function resolveHeadless(env = process.env, platform = process.platform) {
	if (env.CAMOUFOX_HEADLESS === "1") return true;
	if (env.CAMOUFOX_HEADLESS === "0") return false;
	return platform === "win32";
}

// Readiness probe for the display: Xvfb creates this unix socket on startup.
export function displaySocketPath(displayNumber = DISPLAY_NUMBER) {
	return `/tmp/.X11-unix/X${displayNumber}`;
}

export function xvfbArgs(displayNumber = DISPLAY_NUMBER, screen = XVFB_SCREEN) {
	return [`:${displayNumber}`, "-screen", "0", screen];
}

// SPEC: `-deny_all` 付きで起動し、既定では誰も接続できない。表示は稼働中プロセスへの
// `x11vnc -R nodeny` / `-R deny` + `-R disconnect:all` で切り替える。
export function x11vncArgs(displayNumber = DISPLAY_NUMBER, port = VNC_PORT) {
	return [
		"-display",
		`:${displayNumber}`,
		"-localhost",
		"-rfbport",
		String(port),
		"-forever",
		"-nopw",
		"-deny_all",
	];
}
