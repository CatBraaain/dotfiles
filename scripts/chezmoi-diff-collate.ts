// diff.command wrapper for `chezmoi diff`: appends each invocation to a JSONL
// record file, then delegates to scripts/chezmoi-diff.ts with the same
// arguments and forwards its output and exit code.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { appendFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

declare const Bun: {
  spawn(
    command: string[],
    options: { stdout: "inherit"; stderr: "inherit" },
  ): { exited: Promise<number> };
};
declare const process: {
  argv: string[];
  execPath: string;
  exitCode: number;
};
declare const console: { error(...data: unknown[]): void };
declare global {
  interface ImportMeta {
    readonly main: boolean;
    readonly dir: string;
  }
}

export type CollateRecord = { destination: string; target: string };

export async function recordInvocation(
  recordPath: string,
  destination: string,
  target: string,
): Promise<void> {
  await appendFile(recordPath, `${JSON.stringify({ destination, target })}\n`);
}

export async function run(argv: readonly string[]): Promise<number> {
  const [, , destination, target, recordPath] = argv;
  if (!destination || !target)
    throw new Error("chezmoi-diff-collate requires destination and target paths");
  if (!recordPath) throw new Error("chezmoi-diff-collate requires a record file path");
  await recordInvocation(recordPath, destination, target);
  const diff = Bun.spawn(
    [process.execPath, join(import.meta.dir, "chezmoi-diff.ts"), destination, target],
    { stdout: "inherit", stderr: "inherit" },
  );
  return await diff.exited;
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
