declare const Bun: {
  spawn(
    command: string[],
    options: { stdout: "pipe"; stderr: "inherit" },
  ): {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
};

declare const process: {
  argv: string[];
  stdout: { write(data: string): void };
  exitCode: number;
};

const [, , destination, target] = process.argv;

if (!destination || !target) {
  throw new Error("chezmoi-diff requires destination and target paths");
}

const git = Bun.spawn(
  [
    "git",
    "-c",
    "core.safecrlf=false",
    "diff",
    "--no-index",
    "--ignore-cr-at-eol",
    "--no-color",
    "--",
    destination,
    target,
  ],
  { stdout: "pipe", stderr: "inherit" },
);

const output = await new Response(git.stdout).text();
const filteredOutput = output
  .split(/\r?\n/)
  .filter((line) => line !== "\\ No newline at end of file")
  .join("\n");

process.stdout.write(filteredOutput);

const exitCode = await git.exited;
if (exitCode > 1) process.exitCode = exitCode;

export {};
