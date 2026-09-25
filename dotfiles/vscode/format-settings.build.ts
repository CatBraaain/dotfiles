// Pre-build hook (spec: SPEC.md §build: ローカルフック). Reformats the dist
// copy of settings.json with Biome so that the dist tree matches what VS
// Code writes back after GUI edits: comments are kept, trailing commas are
// printed after every element, and short arrays stay on one line. The Biome
// version is pinned so a formatter update cannot change the dist style.

declare const Bun: {
  spawn(
    command: string[],
    options: { cwd: string; stdout: "inherit"; stderr: "inherit" },
  ): { exited: Promise<number> };
};
declare const process: { cwd(): string };

export {};

const path = `${process.cwd()}/settings.json`;
const child = Bun.spawn(
  [
    "bunx",
    "@biomejs/biome@2.5.14",
    "format",
    "--write",
    path,
    "--json-formatter-trailing-commas=all",
    "--json-parse-allow-comments=true",
    "--json-parse-allow-trailing-commas=true",
    "--indent-style=space",
    "--indent-width=2",
  ],
  { cwd: process.cwd(), stdout: "inherit", stderr: "inherit" },
);
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`biome format failed with exit code ${exitCode}`);
