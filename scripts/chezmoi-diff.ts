// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { statSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdtemp, rm } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

declare const Bun: {
  file(path: string): { text(): Promise<string> };
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

if (await filesDifferOnlyByIgnorableDifferences(destination, target)) {
  process.exitCode = 0;
} else {
  const hasDirectoryInput =
    isDirectoryPath(destination) || isDirectoryPath(target);
  // chezmoi invokes the custom diff command for directory entries too, while
  // difftastic accepts files only.
  const useDifftastic = !hasDirectoryInput && Bun.which("difft") !== null;
  const diffInputs = hasDirectoryInput
    ? await prepareDirectoryInputs(destination, target)
    : {
        firstPath: destination,
        secondPath: target,
        cleanup: async () => {},
      };
  let exitCode: number;
  try {
    const diff = Bun.spawn(
      useDifftastic
        ? [
            "difft",
            "--color=always",
            "--display=inline",
            "--skip-unchanged",
            "--strip-cr=on",
            "--syntax-highlight=on",
            diffInputs.firstPath,
            diffInputs.secondPath,
          ]
        : [
            "git",
            "-c",
            "core.safecrlf=false",
            "-c",
            "core.autocrlf=false",
            "diff",
            "--no-index",
            "--ignore-cr-at-eol",
            "--color=always",
            "--",
            diffInputs.firstPath,
            diffInputs.secondPath,
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
    exitCode = await diff.exited;
  } finally {
    await diffInputs.cleanup();
  }

  if (useDifftastic ? exitCode > 0 : exitCode > 1) process.exitCode = exitCode;
}

async function prepareDirectoryInputs(
  firstPath: string,
  secondPath: string,
): Promise<{
  firstPath: string;
  secondPath: string;
  cleanup: () => Promise<void>;
}> {
  const temporaryDirectories: string[] = [];
  const inputPaths = await Promise.all(
    [firstPath, secondPath].map(async (path) => {
      if (isDirectoryPath(path) || !isNullDevice(path)) return path;
      const emptyDirectory = await mkdtemp(join(tmpdir(), "chezmoi-diff-"));
      temporaryDirectories.push(emptyDirectory);
      return emptyDirectory;
    }),
  );

  return {
    firstPath: inputPaths[0],
    secondPath: inputPaths[1],
    cleanup: async () => {
      await Promise.all(
        temporaryDirectories.map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    },
  };
}

function isNullDevice(path: string): boolean {
  return path === "/dev/null" || path.toUpperCase() === "NUL";
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function filesDifferOnlyByIgnorableDifferences(
  firstPath: string,
  secondPath: string,
): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([
      Bun.file(firstPath).text(),
      Bun.file(secondPath).text(),
    ]);
    const ignoreTrailingCommas =
      isJsonPath(firstPath) && isJsonPath(secondPath);
    return (
      normalizeLineEndings(
        ignoreTrailingCommas ? stripTrailingCommas(first) : first,
      ) ===
      normalizeLineEndings(
        ignoreTrailingCommas ? stripTrailingCommas(second) : second,
      )
    );
  } catch {
    return false;
  }
}

// Normalizes JSON(C) so a trailing comma's presence or absence never shows
// as a diff: whitespace and commas immediately before a closing brace or
// bracket are dropped, outside string literals.
function stripTrailingCommas(text: string): string {
  return text
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, index) =>
      index % 2 === 0 ? part.replace(/[\s,]*(?=[}\]])/g, "") : part,
    )
    .join("");
}

function isJsonPath(path: string): boolean {
  const lowercasePath = path.toLowerCase();
  return lowercasePath.endsWith(".json") || lowercasePath.endsWith(".jsonc");
}

function normalizeLineEndings(text: string): string {
  const withoutCarriageReturnPairs = text.replaceAll("\r\n", "");
  return withoutCarriageReturnPairs.endsWith("\n")
    ? withoutCarriageReturnPairs.slice(0, -1)
    : withoutCarriageReturnPairs;
}

export {};
