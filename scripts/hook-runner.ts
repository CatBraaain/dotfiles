declare const process: { execPath: string };

export function resolveHookCommand(
  absolutePath: string,
  displayPath: string,
  hookType: "build" | "apply",
): string[] {
  if (!absolutePath.endsWith(".ts")) {
    throw new Error(`${hookType} hook has unsupported extension: ${displayPath}`);
  }
  return [process.execPath, absolutePath];
}
