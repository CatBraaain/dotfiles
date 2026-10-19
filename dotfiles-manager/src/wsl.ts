import { join, posix, win32 } from "node:path";

export type WslConnection = {
  distro: string;
  user: string;
  home: string;
  bun: string;
  guest: string;
};
export type ProcessResult = { ok: boolean; stdout: string; stderr: string };

export async function resolveWsl(sourceRoot: string): Promise<WslConnection | undefined> {
  if (process.platform !== "win32") return undefined;
  const sourceDistro = uncDistro(sourceRoot);
  const selection = sourceDistro ? ["--distribution", sourceDistro] : [];
  let probe: ProcessResult;
  try {
    probe = await runProcess([
      "wsl.exe",
      ...selection,
      "--exec",
      "bash",
      "-lc",
      'printf "%s\\n%s\\n%s\\n%s\\n" "$WSL_DISTRO_NAME" "$(id -un)" "$HOME" "$(command -v bun)"',
    ]);
  } catch (error) {
    // An unresolvable wsl.exe means WSL is absent on this Windows machine and
    // callers fall back to Windows-local mirrors (spec: §Windows の WSL 接続).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!probe.ok) throw new Error(`WSL resolution failed: ${probe.stderr}`);
  const [distro, user, home, bun] = probe.stdout.split(/\r?\n/);
  if (!distro || !user || !home?.startsWith("/") || !bun?.startsWith("/"))
    throw new Error(
      "WSL resolution failed: distro, default user, HOME or existing Bun unavailable",
    );
  const guestWindowsPath = join(import.meta.dir, "wsl-guest.ts");
  const guest = await resolveGuestPath({ distro, user }, guestWindowsPath);
  const connection: WslConnection = { distro, user, home, bun, guest };
  const ready = await runWsl(connection, [bun, "--version"]);
  if (!ready.ok) throw new Error(`WSL Bun unavailable: ${ready.stderr}`);
  return connection;
}

export function mirrorRoot(connection: WslConnection): string {
  return win32.join(
    `\\\\wsl.localhost\\${connection.distro}`,
    ...posix.join(connection.home, "mirrors", "github.com").split("/"),
  );
}

export function guestMirrorPath(connection: WslConnection, hostPath: string): string {
  const root = mirrorRoot(connection);
  const relativePath = win32.relative(root, hostPath);
  if (relativePath.startsWith("..") || win32.isAbsolute(relativePath))
    throw new Error(`WSL mirror path outside selected HOME: ${hostPath}`);
  return posix.join(connection.home, "mirrors", "github.com", ...relativePath.split("\\"));
}

export async function runWsl(
  connection: WslConnection,
  argv: string[],
  cwd?: string,
): Promise<ProcessResult> {
  const response = await runProcess(guestCommand(connection, { argv, cwd }));
  if (!response.ok) throw new Error(`WSL command bridge failed: ${response.stderr}`);
  let result: ProcessResult;
  try {
    result = JSON.parse(response.stdout);
  } catch {
    throw new Error(`WSL command bridge returned invalid response: ${response.stdout}`);
  }
  if (
    typeof result.ok !== "boolean" ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  )
    throw new Error("WSL command bridge returned invalid result");
  return result;
}

async function resolveGuestPath(
  connection: Pick<WslConnection, "distro" | "user">,
  guestWindowsPath: string,
): Promise<string> {
  const guestDistro = uncDistro(guestWindowsPath);
  if (guestDistro && guestDistro.toLowerCase() !== connection.distro.toLowerCase())
    throw new Error("WSL helper and source workspace belong to different distributions");
  if (guestDistro) return uncGuestPath(guestWindowsPath);
  const path = await runProcess([
    ...wslCommand(connection),
    "wslpath",
    "-a",
    "-u",
    guestWindowsPath,
  ]);
  if (!path.ok || !path.stdout.startsWith("/"))
    throw new Error(`WSL helper path resolution failed: ${path.stderr}`);
  return path.stdout;
}

function guestCommand(connection: WslConnection, payload: unknown): string[] {
  return [
    ...wslCommand(connection),
    connection.bun,
    connection.guest,
    Buffer.from(JSON.stringify(payload)).toString("base64"),
  ];
}

function wslCommand(connection: Pick<WslConnection, "distro" | "user">): string[] {
  return [
    "wsl.exe",
    "--distribution",
    connection.distro,
    "--user",
    connection.user,
    "--exec",
    "sh",
    "-lc",
    'exec "$@"',
    "sh",
  ];
}

export function uncDistro(path: string): string | undefined {
  return /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\|$)/i.exec(path)?.[1];
}

function uncGuestPath(path: string): string {
  return "/" + path.split("\\").slice(4).join("/");
}

export async function runProcess(argv: string[], cwd?: string): Promise<ProcessResult> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const results = await Promise.allSettled([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const [stdout, stderr, code] = results;
  for (const result of results) if (result.status === "rejected") throw result.reason;
  if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled" || code.status !== "fulfilled")
    throw new Error("Child process did not settle");
  return {
    ok: code.value === 0,
    stdout: stdout.value.trim(),
    stderr: stderr.value.trim(),
  };
}
