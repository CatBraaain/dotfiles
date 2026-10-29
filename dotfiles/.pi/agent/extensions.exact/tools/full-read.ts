import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main(): Promise<void> {
  try {
    const request = JSON.parse(readFileSync(0, "utf8")) as { params: { path: string } };
    const text = await readFile(resolve(process.cwd(), request.params.path), "utf8");
    const result = { content: [{ type: "text", text }], structuredContent: text };
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
