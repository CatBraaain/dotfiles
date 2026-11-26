const PI_ARGUMENTS = ["-p", "--no-session", "--no-tools", "--agent", "junior", "--"];
const NOT_FOUND_EXIT_CODE = 127;
class PiNotFoundError extends Error {}

function piCommand(): string {
  const name = process.platform === "win32" ? "pi.exe" : "pi";
  const pi = Bun.which(name);
  if (!pi) throw new PiNotFoundError(`${name} is not on PATH`);
  return pi;
}

async function run(args: string[]): Promise<number> {
  try {
    const child = Bun.spawn([piCommand(), ...PI_ARGUMENTS, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-shot: ${message}\n`);
    return error instanceof PiNotFoundError ? NOT_FOUND_EXIT_CODE : 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
