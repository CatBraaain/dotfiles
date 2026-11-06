import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export async function requireWorkDirectory(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error(`Work folder must be an absolute path: ${cwd}`);
  const directory = resolve(cwd);
  if (!(await stat(directory)).isDirectory())
    throw new Error(`Work folder is not a directory: ${directory}`);
  return directory;
}

export function expandWorkDirectoryInput(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}
