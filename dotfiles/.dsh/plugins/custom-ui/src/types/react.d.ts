/**
 * Minimal ambient `react` types so this plugin typechecks without an installed
 * `@types/react` (the global `~/.bun/install/global/node_modules` carries no
 * react). At runtime the browser bundle resolves the real `react` through the
 * dsh frozen module table (`require('react')`); this shim only describes the
 * narrow surface this plugin uses. Delete it once `@types/react` becomes
 * available to the typecheck environment.
 */
declare module 'react' {
  export type ReactNode = unknown
  export function createElement(
    type: string | ((props: never) => ReactNode),
    props: Record<string, unknown> | null,
    ...children: readonly unknown[]
  ): ReactNode
  export function useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void
}
