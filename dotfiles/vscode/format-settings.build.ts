import { existsSync } from "node:fs";

// Runs in the hook's dist folder at its final remapped location
// (spec: SPEC.md §build: ローカルフック).
export default async function build(): Promise<void> {
  if (!existsSync("settings.json")) return;
  const formatter = Bun.spawn(
    [
      process.execPath,
      "x",
      "@biomejs/biome@2.5.14",
      "format",
      "--write",
      "settings.json",
      "--json-formatter-trailing-commas=all",
      "--json-parse-allow-comments=true",
      "--json-parse-allow-trailing-commas=true",
      "--indent-style=space",
      "--indent-width=2",
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await formatter.exited;
  if (exitCode !== 0) {
    const reason = formatter.signalCode
      ? `signal ${formatter.signalCode}`
      : `exit code ${exitCode}`;
    throw new Error(`Biome formatting failed (${reason})`);
  }
}
