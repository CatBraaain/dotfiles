import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const CAPTURE_ROOT = process.platform === "win32" ? resolve(tmpdir()) : "/tmp";
const CAPTURE_PREFIX = "pi-cli.";

function absolutePath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Expected an absolute output path");
  return path;
}

function captureDirectory(path: string): string {
  const directory = resolve(absolutePath(path));
  const name = basename(directory);
  if (
    relative(CAPTURE_ROOT, dirname(directory)) ||
    !name.startsWith(CAPTURE_PREFIX) ||
    !/^[a-zA-Z0-9]+$/.test(name.slice(CAPTURE_PREFIX.length))
  ) {
    throw new Error("Expected a CLI capture directory");
  }
  return directory;
}

function integer(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("Invalid CLI capture integer");
  }
  return parsed;
}

function writeOutput(chunk: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeBase64(path: string): Promise<void> {
  for await (const chunk of createReadStream(path, { encoding: "base64" })) {
    await writeOutput(chunk);
  }
}

async function writeFrame(directory: string, code: number): Promise<void> {
  await writeOutput(`PI_CLI_V1:${code}\n`);
  await writeBase64(join(directory, "stdout"));
  await writeOutput("\n");
  await writeBase64(join(directory, "stderr"));
  await writeOutput("\nPI_CLI_END\n");
}

async function writeRange(path: string, offsetBytes: number, sizeBytes: number): Promise<void> {
  let writtenBytes = 0;
  const stream = createReadStream(path, { start: offsetBytes, end: offsetBytes + sizeBytes - 1 });
  for await (const chunk of stream) {
    writtenBytes += chunk.length;
    await writeOutput(chunk);
  }
  if (writtenBytes !== sizeBytes) throw new Error("Incomplete CLI output range");
}

async function main([mode, path, first, second, ...extra]: string[]): Promise<void> {
  if (extra.length > 0) throw new Error("Invalid CLI capture arguments");
  if (mode === "create" && path === undefined) {
    const directory = await mkdtemp(join(CAPTURE_ROOT, CAPTURE_PREFIX));
    const shellPath = process.platform === "win32" ? directory.replaceAll("\\", "/") : directory;
    return writeOutput(shellPath);
  }
  if (path !== undefined) {
    if (mode === "cleanup" && first === undefined) {
      return rm(captureDirectory(path), { recursive: true, force: true });
    }
    if (mode === "frame" && first !== undefined && second === undefined) {
      return writeFrame(captureDirectory(path), integer(first, 0, 255));
    }
    if (mode === "size" && first === undefined) {
      return writeOutput(String((await stat(absolutePath(path))).size));
    }
    if (mode === "read" && first !== undefined && second !== undefined) {
      const sizeBytes = integer(second, 1, Number.MAX_SAFE_INTEGER);
      const offsetBytes = integer(first, 0, Number.MAX_SAFE_INTEGER - sizeBytes);
      return writeRange(absolutePath(path), offsetBytes, sizeBytes);
    }
  }
  throw new Error("Invalid CLI capture arguments");
}

await main(process.argv.slice(2));
