import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export async function requireWorkDirectory(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error(`Work folder must be an absolute path: ${cwd}`);
  const directory = resolve(cwd);
  if (!(await stat(directory)).isDirectory())
    throw new Error(`Work folder is not a directory: ${directory}`);
  return directory;
}
