import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { executeToolRequest, type ToolRequest } from "../guardrails/run-tools.ts";

type ReadRequest = ToolRequest & { params: { path: string } };

async function main(): Promise<void> {
  try {
    const request = JSON.parse(readFileSync(0, "utf8")) as ReadRequest;
    const path = resolve(process.cwd(), request.params.path);
    const result = shouldReadInFull(path)
      ? await readInFull(path)
      : await executeToolRequest("read", request);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}

function shouldReadInFull(path: string): boolean {
  if (basename(path) === "SKILL.md") return true;
  for (
    let directory = dirname(path);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "references") continue;
    if (hasSkillFile(dirname(directory))) return true;
  }
  return false;
}

function hasSkillFile(skillDirectory: string): boolean {
  try {
    return statSync(join(skillDirectory, "SKILL.md"), { throwIfNoEntry: false })?.isFile() ?? false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM")
      return false;
    throw error;
  }
}

async function readInFull(path: string) {
  const text = await readFile(path, "utf8");
  return { content: [{ type: "text" as const, text }], structuredContent: text };
}

if (import.meta.main) await main();
