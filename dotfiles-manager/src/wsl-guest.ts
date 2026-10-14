import { runProcess } from "./wsl.ts";

async function main(): Promise<void> {
  const [encoded] = process.argv.slice(2);
  if (!encoded) throw new Error("Missing WSL guest payload");
  const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (
    !Array.isArray(payload.argv) ||
    payload.argv.length === 0 ||
    payload.argv.some((arg: unknown) => typeof arg !== "string")
  )
    throw new Error("Invalid WSL command argv");
  console.log(JSON.stringify(await runProcess(payload.argv, payload.cwd)));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
