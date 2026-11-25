import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "./platform";
import { windowsNpmPiCommand } from "./windows-pi-command";

export type Config = ReturnType<typeof configuration>;

export type TmuxConfig = ReturnType<typeof tmuxConfiguration> & {
  noStart?: true;
  timeout?: number;
};

export const GENERATED_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "TERM",
  "SHELL",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
]);

export const PARENT_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_AGENT_NAME",
  "PI_AGENT_CONFIG",
  "PI_TMUX_SESSION_ID",
  "PI_TMUX_TEMPORARY",
  "PI_TMUX_STARTUP_COMMAND",
  "PI_TMUX_STARTUP_MODE",
  "PI_TMUX_LAUNCH_TOKEN",
  "PI_TMUX_FIRST_INPUT",
  "PI_MUX_WINDOWS_START_RIGHT",
  "PI_MUX_WINDOWS_BOOTSTRAP",
  "TICKET_DISPATCH_ROLE",
  "TICKET_DISPATCH_PROJECT",
  "TICKET_DISPATCH_ID",
]);

export const PI_HARDWARE_CURSOR_ENV = "PI_HARDWARE_CURSOR";

export const PSMUX_ROUTING = new Set([
  "TMUX",
  "TMUX_PANE",
  "PSMUX_TARGET_SESSION",
  "PSMUX_TARGET_FULL",
  "PSMUX_ROUTE_WARM",
]);

export function configuration() {
  const config = tmuxConfiguration();
  if (!existsSync(config.extension) || !existsSync(config.tmuxConfig))
    throw new Error(
      `Missing pi-mux extension or tmux configuration: ${config.extension}, ${config.tmuxConfig}`,
    );
  let piCommand = platform.windows ? undefined : [executable("pi")];
  return { ...config, piCommand: () => (piCommand ??= windowsNpmPiCommand()) };
}

export function resolveAgentDirectory(): string {
  return expandPath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");
}

export function tmuxConfiguration() {
  const directory = join(platform.runtimeStateRoot(), "pi-tmux");
  const agentDir = resolveAgentDirectory();
  const extension = join(agentDir, "extensions", "pi-mux-bridge", "index.ts");
  const tmuxConfig = join(homedir(), ".config", platform.windows ? "psmux" : "tmux", "pi.conf");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !PARENT_ENV_KEYS.has(entry[0]) &&
        (!platform.windows ||
          (!PSMUX_ROUTING.has(entry[0]) && entry[0].toUpperCase() !== PI_HARDWARE_CURSOR_ENV)),
    ),
  );
  return {
    agentDir,
    stateDirectory: join(agentDir, "pi-tmux"),
    directory,
    extension,
    tmuxConfig,
    env,
    socket: join(directory, "server.sock"),
    tmux: executable("tmux"),
  };
}

export function cliInvocation(): string[] {
  const isCompiled =
    import.meta.path.startsWith("/$bunfs/") || /^[Bb]:\\+~BUN\\/i.test(import.meta.path);
  return isCompiled
    ? [process.execPath]
    : [process.execPath, fileURLToPath(new URL("./main.ts", import.meta.url))];
}

export function prepareDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  platform.assertDirectorySafety(lstatSync(path), path);
}

export function expandPath(path: string): string {
  if (path.startsWith("file://")) return fileURLToPath(path);
  return resolve(
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
  );
}

export function executable(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Executable not found on PATH: ${name}`);
  return path;
}
