import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_ARGUMENTS = ["-p", "--no-session", "--no-tools", "--agent", "junior", "--"];
const NOT_FOUND_EXIT_CODE = 127;

type Which = (name: string) => string | undefined;
type RunOptions = { platform?: string; which?: Which; stderr?: (text: string) => void };

class PiNotFoundError extends Error {}

export function piCommand(platform: string, which: Which): string[] {
  if (platform !== "win32") {
    const pi = which("pi");
    if (!pi) throw new PiNotFoundError("pi is not on PATH");
    return [pi];
  }
  const piExe = which("pi.exe");
  if (piExe) return [piExe];
  const node = which("node.exe");
  const npmShim = which("pi.cmd");
  if (!node || !npmShim) {
    throw new PiNotFoundError("pi is not on PATH: found neither pi.exe nor the npm shim pi.cmd");
  }
  return [node, npmPiEntry(npmShim)];
}

export function npmPiEntry(npmShim: string): string {
  const packageDirectory = join(dirname(npmShim), "node_modules", PI_PACKAGE);
  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: { pi?: unknown } };
  const entry = manifest.bin?.pi;
  if (typeof entry !== "string")
    throw new Error(`pi package manifest has no bin.pi: ${manifestPath}`);
  return resolve(packageDirectory, entry);
}

export async function run(args: string[], options: RunOptions = {}): Promise<number> {
  try {
    const platform = options.platform ?? process.platform;
    const which = options.which ?? ((name: string) => Bun.which(name) ?? undefined);
    const child = Bun.spawn([...piCommand(platform, which), ...PI_ARGUMENTS, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } catch (error) {
    (options.stderr ?? writeStderr)(`pi-shot: ${message(error)}\n`);
    return error instanceof PiNotFoundError ? NOT_FOUND_EXIT_CODE : 1;
  }
}

function writeStderr(text: string): void {
  process.stderr.write(text);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
