import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SHOT_WIDTH = 960;
export const SHOT_HEIGHT = 1280;
export const SHOT_TIMEOUT_SECONDS = 15;
export const SHOT_PROCESS_TIMEOUT_SECONDS = 20;
const CLEANUP_WAIT_MS = (SHOT_PROCESS_TIMEOUT_SECONDS - SHOT_TIMEOUT_SECONDS) * 1_000;
const CONTROL_POLL_MS = 20;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface SnapshotInput {
  source: string;
  generatedDir: string;
  pngPath: string;
  deadline: number;
}

export type SnapshotCompletion = { ok: true } | { ok: false; error: string };

export interface ShotOptions {
  outDir: string;
  exec: ExtensionAPI["exec"];
  generatedDir?: string;
  signal?: AbortSignal;
}

export type ShotResult = { ok: true; pngPath: string } | { ok: false; error: string };

export async function shotOpenui(
  source: string,
  id: string,
  options: ShotOptions,
): Promise<ShotResult> {
  const pngPath = join(options.outDir, `${id}.png`);
  const inputDir = await mkdtemp(join(tmpdir(), "op-"));
  let succeeded = false;
  let cleanupConfirmed = true;
  let notificationError: unknown;
  function notifyCancellation(): void {
    try {
      writeFileSync(join(inputDir, "cancel"), "");
    } catch (error) {
      notificationError = error;
    }
  }
  try {
    options.signal?.throwIfAborted();
    await mkdir(options.outDir, { recursive: true });
    const inputPath = join(inputDir, "input.json");
    const input: SnapshotInput = {
      source,
      pngPath: join(inputDir, "shot.png"),
      generatedDir: options.generatedDir ?? EXTENSION_DIR,
      deadline: Date.now() + SHOT_TIMEOUT_SECONDS * 1_000,
    };
    await writeFile(inputPath, JSON.stringify(input));
    await mkdir(join(inputDir, "pending"));
    options.signal?.addEventListener("abort", notifyCancellation, { once: true });
    options.signal?.throwIfAborted();
    cleanupConfirmed = false;
    let completion: SnapshotCompletion | undefined;
    const outcome = await Promise.resolve()
      .then(() =>
        options.exec(
          "env",
          [
            `TMPDIR=${inputDir}`,
            `TMP=${inputDir}`,
            `TEMP=${inputDir}`,
            "bun",
            join(EXTENSION_DIR, "snapshot-cli.ts"),
            inputPath,
          ],
          { timeout: SHOT_PROCESS_TIMEOUT_SECONDS * 1_000 },
        ),
      )
      .then(
        async (result) => {
          if (result.killed || ("truncated" in result && result.truncated === true))
            notifyCancellation();
          completion = await waitForSnapshotExit(
            inputDir,
            !result.killed && !("truncated" in result && result.truncated === true),
          );
          cleanupConfirmed = true;
          return result;
        },
        async (error: unknown) => {
          notifyCancellation();
          await waitForSnapshotExit(inputDir, false);
          cleanupConfirmed = true;
          throw error;
        },
      );
    if (notificationError) throw notificationError;
    options.signal?.throwIfAborted();
    if (completion && !completion.ok) throw new Error(completion.error);
    if (
      outcome.killed ||
      ("truncated" in outcome && outcome.truncated === true) ||
      outcome.code !== 0
    )
      throw new Error(outcome.stderr || outcome.stdout || "snapshot process failed");
    if (!completion) throw new Error("snapshot CLI did not confirm cleanup");
    const png = await readFile(input.pngPath);
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error("snapshot did not produce a PNG");
    }
    options.signal?.throwIfAborted();
    await writeFile(pngPath, png);
    options.signal?.throwIfAborted();
    succeeded = true;
    return { ok: true, pngPath };
  } catch (error) {
    const retained = cleanupConfirmed
      ? ""
      : `; cleanup unconfirmed, control files retained: ${inputDir}`;
    return { ok: false, error: `OpenUI snapshot ${id}: ${String(error)}${retained}` };
  } finally {
    options.signal?.removeEventListener("abort", notifyCancellation);
    if (cleanupConfirmed) await rm(inputDir, { recursive: true, force: true });
    if (!succeeded) await rm(pngPath, { force: true });
  }
}

async function waitForSnapshotExit(
  directory: string,
  bashCompleted: boolean,
): Promise<SnapshotCompletion | undefined> {
  try {
    renameSync(join(directory, "pending"), join(directory, "cancelled"));
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const deadline = Date.now() + CLEANUP_WAIT_MS;
  const ownerPath = join(directory, "running", "owner.json");
  const completionPath = join(directory, "finished.json");
  while (Date.now() < deadline) {
    if (bashCompleted || (existsSync(ownerPath) && !isSnapshotProcessAlive(ownerPath))) {
      if (!existsSync(completionPath)) {
        throw new Error("snapshot CLI exited without confirming browser cleanup");
      }
      return JSON.parse(readFileSync(completionPath, "utf8")) as SnapshotCompletion;
    }
    await delay(CONTROL_POLL_MS);
  }
  throw new Error("snapshot CLI cleanup could not be confirmed within the shutdown wait");
}

function isSnapshotProcessAlive(ownerPath: string): boolean {
  let owner: { pid: number };
  try {
    owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    throw error;
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error("Invalid snapshot CLI process identity");
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
