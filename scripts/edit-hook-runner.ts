// Child-process runner for edit hooks (spec: SPEC.md §build: edit フック).
// Imports the hook and calls its default function with the target file path
// in dist and its home counterpart. Reading and writing the files is left to
// the hook.
declare const process: { argv: string[] };

export {};

const [hookPath, distPath, homePath] = process.argv.slice(2);
// @ts-ignore The hook path is resolved at runtime.
const hook = await import(hookPath);
await hook.default(distPath, homePath);
