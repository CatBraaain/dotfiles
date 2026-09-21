declare const Bun: {
  file(path: string): { arrayBuffer(): Promise<ArrayBuffer> };
  which(command: string): string | null;
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

if (await filesDifferOnlyByIgnoredLineEndings(destination, target)) {
  process.exitCode = 0;
} else {
  const useDifftastic = Bun.which("difft") !== null;
  const diff = Bun.spawn(
    useDifftastic
      ? [
          "difft",
          "--color=always",
          "--display=inline",
          "--skip-unchanged",
          "--strip-cr=on",
          "--syntax-highlight=on",
          destination,
          target,
        ]
      : [
          "git",
          "-c",
          "core.safecrlf=false",
          "diff",
          "--no-index",
          "--ignore-cr-at-eol",
          "--color=always",
          "--",
          destination,
          target,
        ],
    { stdout: "pipe", stderr: "inherit" },
  );

  const output = await new Response(diff.stdout).text();
  const filteredOutput = useDifftastic
    ? output
    : output
        .split(/\r?\n/)
        .filter((line) => line !== "\\ No newline at end of file")
        .join("\n");

  process.stdout.write(filteredOutput);

  const exitCode = await diff.exited;
  if (useDifftastic ? exitCode > 0 : exitCode > 1) process.exitCode = exitCode;
}

async function filesDifferOnlyByIgnoredLineEndings(
  firstPath: string,
  secondPath: string,
): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([
      Bun.file(firstPath).arrayBuffer(),
      Bun.file(secondPath).arrayBuffer(),
    ]);
    return equalBytes(
      normalizeLineEndings(new Uint8Array(first)),
      normalizeLineEndings(new Uint8Array(second)),
    );
  } catch {
    return false;
  }
}

function normalizeLineEndings(bytes: Uint8Array): Uint8Array {
  const normalized: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) continue;
    normalized.push(bytes[index]);
  }
  if (normalized.at(-1) === 10) normalized.pop();
  return Uint8Array.from(normalized);
}

function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  return (
    first.length === second.length &&
    first.every((byte, index) => byte === second[index])
  );
}

export {};
