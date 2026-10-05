import { readFile } from "node:fs/promises";
import { installRecordingOverlay } from "./overlay.mjs";

export async function loadRecordingOverlay(page, state) {
  const [html, css] = await Promise.all([
    readFile(new URL("./overlay.html", import.meta.url), "utf8"),
    readFile(new URL("./overlay.css", import.meta.url), "utf8"),
  ]);
  const installed = await page.evaluate(installRecordingOverlay, {
    html,
    css,
    state,
  });
  return {
    installed,
    update: (patch) => invoke("update", patch),
    inspect: () => invoke("inspect"),
    painted: () => invoke("painted"),
    setVisible: (visible) => invoke("setVisible", visible),
    dispose: () => invoke("dispose"),
  };

  function invoke(operation, argument = undefined) {
    return page.evaluate(
      ({ operation, argument }) => {
        const overlay = window.recordingOverlay;
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
