// Shared shebang resolution for hooks (spec: SPEC.md §フックシステム): parses
// the "#!" first line into the spawn argv. Returns null when the file has no
// shebang; callers decide whether that is an error or a fallback (pwsh for
// apply scripts). displayPath is used verbatim in error messages so callers
// keep their spec-mandated relative paths.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { readFile } from "node:fs/promises";

export async function resolveHookCommand(
  absolutePath: string,
  displayPath: string,
): Promise<string[] | null> {
  const content = await readFile(absolutePath, "utf8");
  const firstLine = content.split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return null;
  const command = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (command.length === 0) throw new Error(`hook has an empty shebang: ${displayPath}`);
  return command;
}
