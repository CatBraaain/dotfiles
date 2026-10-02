import { readFile } from "node:fs/promises";
import { installRecordingOverlay } from "./overlay.mjs";

/** @typedef {import('./overlay.mjs').OverlayState} OverlayState */
/** @typedef {import('./overlay.mjs').Layout} Layout */
/** @typedef {import('./overlay.mjs').OverlayWindow} OverlayWindow */
/** @typedef {{evaluate: (fn: (...args: any[]) => any, arg?: any) => Promise<any>}} PageLike */

/** Uses only Page.evaluate, shared by Playwright Test and Vitest + Playwright. */
export async function loadRecordingOverlay(
  /** @type {PageLike} */ page,
  /** @type {OverlayState} */ state,
) {
  const [html, css] = await Promise.all([
    readFile(new URL("./overlay.html", import.meta.url), "utf8"),
    readFile(new URL("./overlay.css", import.meta.url), "utf8"),
  ]);
  /** @type {Layout} */
  const installed = await page.evaluate(installRecordingOverlay, { html, css, state });
  return {
    installed,
    /** @returns {Promise<Layout>} */
    update: (/** @type {Partial<OverlayState>} */ patch) => invoke("update", patch),
    /** @returns {Promise<Layout>} */
    inspect: () => invoke("inspect"),
    /** @returns {Promise<Layout>} */
    painted: () => invoke("painted"),
    setVisible: (/** @type {boolean} */ visible) => invoke("setVisible", visible),
    dispose: () => invoke("dispose"),
  };

  function invoke(
    /** @type {'update'|'inspect'|'painted'|'setVisible'|'dispose'} */ operation,
    /** @type {Partial<OverlayState>|boolean|undefined} */ argument = undefined,
  ) {
    return page.evaluate(
      ({ operation, argument }) => {
        const overlay = /** @type {OverlayWindow} */ (window).recordingOverlay;
        if (!overlay) {
          if (operation === "dispose") return;
          throw new Error("Recording overlay is not installed in this document");
        }
        switch (operation) {
          case "update":
            return overlay.update(argument);
          case "inspect":
            return overlay.inspect();
          case "painted":
            return overlay.painted();
          case "setVisible":
            return overlay.setVisible(argument);
          case "dispose":
            return overlay.dispose();
        }
      },
      { operation, argument },
    );
  }
}
