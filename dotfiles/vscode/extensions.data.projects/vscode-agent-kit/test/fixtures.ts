import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a unique temp directory for a test. */
export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Recursively remove a test directory (best effort). */
export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Write a JSONL file (each entry serialized per line unless already a string). Returns its path. */
export async function writeJsonl(dir: string, name: string, lines: unknown[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, name);
  const body = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  await writeFile(filePath, `${body}\n`, "utf8");
  return filePath;
}

/** A session header line with overrides. */
export function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session",
    version: 3,
    id: "00000000-0000-0000-0000-000000000001",
    timestamp: "2024-12-03T14:00:00.000Z",
    cwd: "/home/user/project",
    ...overrides,
  };
}

/** A message entry line with overrides. */
export function messageEntry(
  role: string,
  content: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2024-12-03T14:00:01.000Z",
    message: { role, content, timestamp: 1_733_234_401_000 },
    ...overrides,
  };
}
