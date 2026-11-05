import { readdir } from "node:fs/promises";

/**
 * Session listing for the new-session flow (no VS Code API, fs only). pi
 * creates the session file lazily, when the first assistant message
 * completes, so detection polls the group directory for the file.
 */

/** *.jsonl file names directly inside dir (missing dir => empty). */
export async function listSessionFileNames(groupDir: string): Promise<string[]> {
  try {
    const entries = await readdir(groupDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
