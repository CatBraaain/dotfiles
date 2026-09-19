// Thin preview wiring only: connect the real webview client (lib/client.js)
// to the preview bridge and wire the preview-only controls (demo states,
// width switch). All view logic lives in the shared client.

import { initClient } from "./lib/client.js";
import { createPreviewBridge } from "./previewBridge.mjs";

const { bridge, postSessions, reset } = createPreviewBridge();

initClient(bridge);
postSessions();

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const demoState = target.closest("[data-demo-state]");
  if (demoState instanceof HTMLButtonElement) {
    reset(demoState.dataset.demoState);
    return;
  }
  const width = target.closest("[data-width]");
  if (width instanceof HTMLButtonElement) {
    document.body.dataset.width = width.dataset.width;
  }
});
