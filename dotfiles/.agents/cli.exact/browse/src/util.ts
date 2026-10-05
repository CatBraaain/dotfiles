// Low-level helpers: CLI failure exits, timing, subprocess piping and error
// detail extraction.
import { execFile } from "node:child_process";
import { CONVERT_TIMEOUT_MS } from "./config";

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function usageFail(usage: string): never {
  console.error(usage);
  process.exit(1);
}

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}


export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function runWithStdin(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number = CONVERT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(input);
  });
}

// Prefer the openserp error body ({"message": "..."}) over the bare status.
export async function responseDetail(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
  return typeof body?.message === "string" && body.message
    ? body.message
    : `${response.status} ${response.statusText}`;
}


