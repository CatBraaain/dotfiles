import { ConstraintError, shotFile } from "./shot";
import { extractFile, verifyFile } from "./extract";

const USAGE = `usage: htmlshot shot <input.html> [-o <output.png>] [--width <n>] [--height <n>] [--scale <n>] [--unsafe]
       htmlshot extract <input.png> [-o <output.html>]
       htmlshot verify <input.png>`;

type Parsed = {
  positional: string[];
  output?: string;
  width: number;
  height: number;
  scale?: number;
  unsafe: boolean;
};

export async function run(argv: string[]): Promise<number> {
  const [subcommand, ...args] = argv;
  if (subcommand !== "shot" && subcommand !== "extract" && subcommand !== "verify") {
    console.error(USAGE);
    return 1;
  }
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch {
    console.error(USAGE);
    return 1;
  }
  if (parsed.positional.length !== 1) {
    console.error(USAGE);
    return 1;
  }
  const [input] = parsed.positional;
  try {
    const line =
      subcommand === "shot"
        ? await shotFile(input, parsed)
        : subcommand === "extract"
          ? extractFile(input, parsed.output)
          : verifyFile(input);
    console.log(line);
    return 0;
  } catch (error) {
    if (error instanceof ConstraintError) {
      for (const { line, kind, snippet } of error.violations) {
        console.error(`${input}:${line}: ${kind}: ${snippet}`);
      }
    } else {
      console.error(`htmlshot: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

const VALUE_OPTIONS = new Set(["-o", "--width", "--height", "--scale"]);

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { positional: [], width: 1200, height: 800, unsafe: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (): string => {
      const next = args[i + 1];
      if (next === undefined) throw new Error(`missing value for ${arg}`);
      return next;
    };
    if (arg === "-o") parsed.output = value();
    else if (arg === "--width") parsed.width = positiveInt(arg, value());
    else if (arg === "--height") parsed.height = positiveInt(arg, value());
    else if (arg === "--scale") parsed.scale = positiveInt(arg, value());
    else if (arg === "--unsafe") parsed.unsafe = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else parsed.positional.push(arg);
    if (VALUE_OPTIONS.has(arg)) i++;
  }
  return parsed;
}

function positiveInt(option: string, raw: string): number {
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${option} must be a positive integer: ${raw}`);
  return number;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
