// Shared CLI argument parsing for the direct diff/apply command-line entry
// points. Each entry point keeps its own thin parseArgs wrapper so its
// options and usage text stay close to the command they belong to.
import { homedir } from "node:os";

export function expandHomeRoot(homeRootArgument: string): string {
  return homeRootArgument === "~" ? homedir() : homeRootArgument;
}

export function positionalArguments(argv: readonly string[], flags: readonly string[]): string[] {
  return argv.filter((argument) => !flags.includes(argument));
}
