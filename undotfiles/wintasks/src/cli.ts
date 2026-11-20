// CLI entry point.

import { readFileSync } from "node:fs";
import { runSync, type Writer } from "./apply.ts";
import { parseDefs } from "./def.ts";
import { commandSchtasks, type Schtasks } from "./schtasks.ts";

const DEFAULT_DEFINITIONS_FILE = "wintasks.yaml";
const DEFAULT_MOUNT_FOLDER = "wintasks";

export const USAGE = "usage: wintasks [OPTIONS]";
export const HELP =
  "wintasks - synchronize Windows Task Scheduler tasks from wintasks.yaml\n\n" +
  "Usage: wintasks [OPTIONS]\n\n" +
  "Options:\n" +
  "  --mount FOLDER  Synchronize tasks under this Task Scheduler folder (default: wintasks)\n" +
  "  --dry-run       Show planned changes without modifying the system\n" +
  "  --path FILE     Read task definitions from FILE (default: wintasks.yaml)\n" +
  "  -h, --help      Show this help message";

export interface CliOptions {
  dryRun: boolean;
  mount: string;
  path: string;
  help: boolean;
}

export function nowLocal() {
  const now = new Date();
  return {
    y: now.getFullYear(),
    mo: now.getMonth() + 1,
    d: now.getDate(),
    h: now.getHours(),
    mi: now.getMinutes(),
    s: now.getSeconds(),
  };
}

export function run(args: string[], out: Writer, err: Writer): number {
  return runWithScheduler(args, out, err, commandSchtasks);
}

export function runWithScheduler(
  args: string[],
  out: Writer,
  err: Writer,
  scheduler: Schtasks,
): number {
  let options: CliOptions;
  try {
    options = parseCli(args);
  } catch (cliError) {
    return usageError((cliError as Error).message, err);
  }
  if (options.help) {
    out.write(HELP);
    return 0;
  }
  let definitionsText: string;
  try {
    definitionsText = readFileSync(options.path, "utf8");
  } catch (readError) {
    return error(`${options.path}: ${(readError as Error).message}`, err);
  }
  let definitions;
  try {
    definitions = parseDefs(definitionsText, options.path, options.mount);
  } catch (parseError) {
    return error((parseError as Error).message, err);
  }
  return runSync(
    definitions,
    options.path,
    { dryRun: options.dryRun },
    scheduler,
    nowLocal(),
    out,
    err,
  );
}

export function parseCli(args: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    mount: DEFAULT_MOUNT_FOLDER,
    path: DEFAULT_DEFINITIONS_FILE,
    help: false,
  };
  let index = 0;
  while (index < args.length) {
    const argument = args[index++];
    switch (argument) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--mount": {
        const mount = args[index++];
        if (mount === undefined || mount.startsWith("-")) {
          throw new Error("--mount requires a folder path");
        }
        options.mount = mount;
        break;
      }
      case "--path": {
        const path = args[index++];
        if (path === undefined) throw new Error("--path requires a file path");
        options.path = path;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unexpected argument \`${argument}\``);
    }
  }
  return options;
}

function error(message: string, err: Writer): number {
  err.write(`wintasks: ${message}\n`);
  return 1;
}

function usageError(message: string, err: Writer): number {
  err.write(`wintasks: ${message}\n${USAGE}\n`);
  return 2;
}

const stdoutWriter: Writer = { write: (text) => process.stdout.write(text) };
const stderrWriter: Writer = { write: (text) => process.stderr.write(text) };

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), stdoutWriter, stderrWriter);
}
