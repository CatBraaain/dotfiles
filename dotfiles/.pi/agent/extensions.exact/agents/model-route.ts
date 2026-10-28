import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import type { ModelCandidate } from "./routing.ts";

const ROUTE_TIMEOUT_SECONDS = 25;

export async function runModelRoute(
  candidates: readonly ModelCandidate[],
  signal?: AbortSignal,
  operations: BashOperations = createLocalBashOperations(),
): Promise<{ exitCode: number | null; stdout: string }> {
  const directory = mkdtempSync(join(tmpdir(), "pi-agents-route-"));
  const inputPath = join(directory, "candidates.json");
  const outputPath = join(directory, "output.json");
  try {
    writeFileSync(
      inputPath,
      JSON.stringify({
        candidates: candidates.map(({ provider, model }) => ({ provider, model })),
      }),
    );
    const { exitCode } = await operations.exec(
      `${quote(["model-route", "score", inputPath])} > ${quote([outputPath])}`,
      process.cwd(),
      { onData: () => {}, signal, timeout: ROUTE_TIMEOUT_SECONDS },
    );
    return {
      exitCode,
      stdout: exitCode === 0 ? readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
