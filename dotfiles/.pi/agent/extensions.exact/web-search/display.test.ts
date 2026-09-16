import { strictEqual } from "node:assert/strict";
import { describe, it } from "bun:test";
import {
	displaySocketPath,
	resolveHeadless,
	x11vncArgs,
	xvfbArgs,
} from "./display.mjs";

describe("resolveHeadless", () => {
	it("defaults to headed on Linux", () => {
		strictEqual(resolveHeadless({}, "linux"), false);
	});

	it("defaults to headless on Windows (no Xvfb there)", () => {
		strictEqual(resolveHeadless({}, "win32"), true);
	});

	it("CAMOUFOX_HEADLESS=1 forces headless even on Linux", () => {
		strictEqual(resolveHeadless({ CAMOUFOX_HEADLESS: "1" }, "linux"), true);
	});

	it("CAMOUFOX_HEADLESS=0 forces headed even on Windows", () => {
		strictEqual(resolveHeadless({ CAMOUFOX_HEADLESS: "0" }, "win32"), false);
	});
});

describe("command builders", () => {
	it("builds the Xvfb args for the virtual display", () => {
		strictEqual(xvfbArgs().join(" "), ":99 -screen 0 1920x1080x24");
	});

	it("builds x11vnc args: display-scoped, localhost-only, denied at startup", () => {
		strictEqual(
			x11vncArgs().join(" "),
			"-display :99 -localhost -rfbport 5900 -forever -nopw -deny_all",
		);
	});
});

describe("displaySocketPath", () => {
	it("matches the /tmp/.X11-unix socket convention", () => {
		strictEqual(displaySocketPath(), "/tmp/.X11-unix/X99");
	});
});
