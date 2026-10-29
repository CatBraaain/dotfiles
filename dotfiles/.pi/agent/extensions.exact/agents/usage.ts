import { execFile } from "node:child_process";

const USAGE_TIMEOUT_MS = 25_000;

export async function runUsage(
  signal?: AbortSignal,
  execute: typeof execFile = execFile,
): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    execute(
      "usage",
      ["--json"],
      {
        encoding: "utf8",
        signal,
        timeout: USAGE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error === null) resolve({ exitCode: 0, stdout });
        else if (error.code === "ENOENT") resolve({ exitCode: 127, stdout: "" });
        else if (typeof error.code === "number") resolve({ exitCode: error.code, stdout });
        else reject(error);
      },
    );
  });
}
