import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import net from "node:net";

const scenario = process.argv[2]!;
const events: unknown[][] = [];
let socketReady = scenario === "existing";
let now = 0;
spyOn(Date, "now").mockImplementation(() => now);
const nativeSetTimeout = setTimeout;
globalThis.setTimeout = ((callback: () => void, ms: number) => {
  now += ms;
  events.push(["wait", ms]);
  if (scenario !== "timeout") socketReady = true;
  return nativeSetTimeout(callback, 0);
}) as typeof setTimeout;
mock.module("node:fs", () => ({
  ...fs,
  existsSync: (path: string) => (path === "/tmp/.X11-unix/X99" ? socketReady : fs.existsSync(path)),
  readFileSync: () => (scenario === "abstract" ? "@/tmp/.X11-unix/X99" : ""),
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: (command: string, args: string[]) => {
    events.push(["which", command, args]);
    return { status: scenario === "missing-vnc" ? 1 : 0 };
  },
  spawn: (command: string, args: string[], options: unknown) => {
    events.push(["spawn", command, args, options]);
    return {
      unref: () => {
        events.push(["unref", command]);
      },
    };
  },
}));
spyOn(net, "connect").mockImplementation((() => {
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  socket.destroy = () => {
    events.push(["destroy"]);
  };
  queueMicrotask(() => socket.emit(scenario === "existing" ? "connect" : "error"));
  return socket;
}) as never);
const { ensureDisplay, ensureX11vnc } = await import("../display");
let error: string | undefined;
try {
  await ensureDisplay();
  await ensureX11vnc();
} catch (failure) {
  error = String(failure);
}
console.log(JSON.stringify({ events, now, error }));
