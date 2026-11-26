import { GENERATED_ENV_KEYS, type TmuxConfig } from "./configuration";
import { platform } from "./platform";
import { WindowsManagement } from "./windows-management";

export function paneEntityGuard(serverPid: number, pane: string, panePid: number): string {
  return `#{&&:#{==:#{pid},${serverPid}},#{&&:#{==:#{pane_id},${pane}},#{==:#{pane_pid},${panePid}}}}`;
}

export function guardedTmuxLine(
  pane: string,
  condition: string,
  whenTrue: string[][],
  elseMarker?: string,
): string {
  const quoted = [
    "if-shell",
    "-t",
    pane,
    "-F",
    condition,
    whenTrue.map((args) => tmuxArguments(args)).join(" ; "),
  ];
  if (elseMarker !== undefined) quoted.push(tmuxArguments(["display-message", "-p", elseMarker]));
  return tmuxArguments(quoted);
}

export function windowsManagement(config: TmuxConfig): WindowsManagement {
  return new WindowsManagement({ ...config, query: (argv) => tmux(config, argv, true) });
}

export type ServerLifetime = { pid: number; generation: string };

export async function serverLifetime(config: TmuxConfig): Promise<ServerLifetime | undefined> {
  if (platform.windows) {
    const basis = await windowsManagement(config).currentBasis();
    if (!basis) return;
    return { pid: Number(basis.witnesses[0]!.split(":")[0]), generation: basis.instance };
  }
  const query = ["display-message", "-p", "#{pid}"];
  const generationOption = "@pi-mux-generation";
  const batch = config.noStart && !platform.windows;
  if (batch) query.push(";", "show-options", "-gqv", generationOption);
  const result = await tmux(config, query, true);
  if (result.exitCode !== 0) {
    if (serverIsAbsent(config, result.stderr)) return undefined;
    throw new Error(`Cannot inspect dedicated server: ${result.stderr.trim()}`);
  }
  const [pidText, ...options] = result.stdout.trimEnd().split("\n");
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid dedicated server PID");
  const generation = batch ? options.join("\n") : await serverOption(config, generationOption);
  return { pid, generation };
}

export async function verifyServerLifetime(
  config: TmuxConfig,
  expected: ServerLifetime,
  phase = "restart",
): Promise<void> {
  const current = await serverLifetime(config);
  if (
    !current ||
    (!platform.windows && current.pid !== expected.pid) ||
    current.generation !== expected.generation
  )
    throw new Error(`Dedicated server changed during ${phase}`);
}

export async function excludedGlobalEnvironment(
  config: TmuxConfig,
  desired: Record<string, string>,
): Promise<string[]> {
  const global = await tmux(config, ["show-environment", "-gs"]);
  const assignments = global.stdout.replace(/"(?:\\.|[^"\\])*"/gs, "");
  return [...assignments.matchAll(/; export ([^;\n]+);/g)]
    .map((match) => match[1]!)
    .filter((key) => !Object.hasOwn(desired, key) && !GENERATED_ENV_KEYS.has(key));
}

export async function tmuxQueries(config: TmuxConfig, commands: string[][]) {
  if (commands.length === 0) return [];
  if (platform.windows) {
    const results: Awaited<ReturnType<typeof tmux>>[] = [];
    for (const command of commands) results.push(await tmux(config, command, true));
    return results;
  }
  const args = commands.flatMap((command, index) => [
    ...(index === 0 ? [] : [";"]),
    "if-shell",
    "-F",
    "1",
    tmuxArguments(command),
  ]);
  const result = await tmux(config, ["-C", ...args], true);
  const frames = [
    ...result.stdout.matchAll(/^%begin (\d+ \d+ \d+)\n([\s\S]*?)^%(end|error) \1\n/gm),
  ];
  if (frames.length !== commands.length * 2)
    throw new Error(
      `Cannot inspect managed sessions: invalid tmux control response ${result.stderr.trim()}`,
    );
  return commands.map((_, index) => {
    const wrapper = frames[index * 2]!;
    const frame = frames[index * 2 + 1]!;
    if (wrapper[3] !== "end") throw new Error("Cannot inspect managed sessions: tmux batch failed");
    return { stdout: frame[2]!, stderr: frame[2]!, exitCode: frame[3] === "end" ? 0 : 1 };
  });
}

export async function serverOption(config: TmuxConfig, option: string): Promise<string> {
  if (
    platform.windows &&
    (option === "@pi-mux-generation" || option.startsWith("@pi-mux-restor"))
  ) {
    const management = windowsManagement(config);
    const basis = await management.currentBasis();
    if (option === "@pi-mux-generation") return basis?.instance ?? "";
    const state = basis && management.startupState(basis);
    if (option === "@pi-mux-restored") return state?.restored ? state.instance : "";
    return state?.restoring.includes(option.slice("@pi-mux-restoring-".length).toLowerCase())
      ? "1"
      : "";
  }
  return (await tmux(config, ["show-options", "-gqv", option])).stdout.trim();
}

export function serverIsAbsent(config: TmuxConfig, stderr: string): boolean {
  return (
    stderr.includes("no server running on ") ||
    stderr.includes(`error connecting to ${config.socket} (No such file or directory)`)
  );
}

export function tmuxArguments(args: string[]): string {
  return args.map(quoteTmuxArgument).join(" ");
}

function quoteTmuxArgument(argument: string): string {
  return JSON.stringify(argument).replaceAll("$", "\\$");
}

export async function tmux(
  config: TmuxConfig,
  args: string[],
  allowFailure = false,
  input?: string,
) {
  const configFileFlag = platform.windows ? "-f" : "-uf";
  const clientFlags = config.noStart && !platform.windows ? ["-N"] : [];
  const child = Bun.spawn(
    [config.tmux, "-S", config.socket, configFileFlag, config.tmuxConfig, ...clientFlags, ...args],
    {
      env: config.env,
      timeout: config.timeout,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) throw new Error(`tmux ${args[0]} failed: ${stderr.trim()}`);
  return platform.windows
    ? { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode }
    : { stdout, stderr, exitCode };
}
