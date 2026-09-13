/**
 * Minimal ambient types for `bun:test` and `node:assert/strict` so the
 * adjacent test files typecheck: the typecheck environment (global
 * `~/.bun/install/global/node_modules`) carries neither `bun-types` nor
 * `@types/node`, and this plugin's tsconfig paths cannot reach them.
 * Mirrors the `react.d.ts` shim; covers only the surface the tests use.
 * Delete it once those type packages become available to the typecheck
 * environment.
 */
declare module 'bun:test' {
    export function describe(name: string, fn: () => void): void
    export function it(name: string, fn: () => void): void
}

declare module 'node:assert/strict' {
    function ok(value: unknown, message?: string): asserts value
    function equal(actual: unknown, expected: unknown, message?: string): void
    function deepEqual(actual: unknown, expected: unknown, message?: string): void
    function throws(fn: () => void, message?: string): void
    export default { ok, equal, deepEqual, throws }
}
