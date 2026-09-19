/**
 * Quote a single shell argument for POSIX-like shells (sh, bash, zsh).
 * Uses double quotes with `$`, backtick, `"`, and `\` escaped.
 * The extension's default deployment target is Linux/macOS; Windows default
 * shells are not fully covered (see README/report notes).
 */
export function shellQuote(arg: string): string {
  return `"${arg.replace(/([$`"\\])/g, "\\$1")}"`;
}
