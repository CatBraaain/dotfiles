import { createElement, type ReactNode } from "react";

/** Minimal host slot boundary used only to place registered composer-dock entries. */
export function ComposerDock({ children }: { readonly children: ReactNode }): ReactNode {
  return createElement(
    "div",
    {
      style: {
        maxWidth: "var(--dsh-composer-card-max-width)",
        margin: "0 auto",
      },
    },
    children,
  );
}
