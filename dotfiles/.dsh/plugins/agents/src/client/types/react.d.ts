/**
 * Minimal ambient `react` types so this plugin typechecks without an installed
 * `@types/react` (the global `~/.bun/install/global/node_modules` carries no
 * react). At runtime the browser bundle resolves the real `react` through the
 * dsh frozen module table (`require('react')`); this shim only describes the
 * narrow surface this plugin uses. Delete it once `@types/react` becomes
 * available to the typecheck environment.
 */
declare module "react" {
  export type ReactNode = unknown;
  export type Dispatch<S> = (value: S) => void;
  /** Any function component; callers narrow the props themselves. */
  export type FunctionComponent<P> = (props: P) => ReactNode;
  export function createElement(
    type: string | FunctionComponent<never>,
    props: Record<string, unknown> | null,
    ...children: readonly unknown[]
  ): ReactNode;
  export function useState<S>(initialState: S): [S, Dispatch<S>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
