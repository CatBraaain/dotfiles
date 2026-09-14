/**
 * Minimal ambient types for `bun:test` and `node:assert/strict` so the
 * adjacent test file typechecks: the typecheck environment (global
 * `~/.bun/install/global/node_modules`) carries neither `bun-types` nor
 * `@types/node`, and this plugin's tsconfig paths cannot reach them.
 * Mirrors the footer plugin's shim; covers only the surface the tests use.
 * Delete it once those type packages become available to the typecheck
 * environment.
 */
declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  function equal(actual: unknown, expected: unknown, message?: string): void;
  function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  function ok(value: unknown, message?: string): void;
  function match(value: string, regexp: RegExp, message?: string): void;
  export default { equal, deepEqual, ok, match };
}
