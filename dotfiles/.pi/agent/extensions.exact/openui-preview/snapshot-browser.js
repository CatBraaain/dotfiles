import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createLibrary, Renderer } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import "@openuidev/react-ui/index.css";
import { INTERACTIVE_COMPONENTS } from "./display-only.ts";

const interactive = new Set(INTERACTIVE_COMPONENTS);
const library = createLibrary({
  components: Object.entries(openuiLibrary.components)
    .filter(([name]) => !interactive.has(name))
    .map(([, component]) => component),
  root: openuiLibrary.root,
});
const STABLE_FRAMES = 5;
const state = { ready: false, error: "" };
window.__openuiSnapshot = state;

window.addEventListener("securitypolicyviolation", (event) => {
  state.error = `Blocked browser reference: ${event.blockedURI} (${event.violatedDirective})`;
});
window.addEventListener("error", (event) => {
  state.error = event.message;
});
window.addEventListener("unhandledrejection", (event) => {
  state.error = String(event.reason);
});

window.__mountOpenui = function mountOpenui(source) {
  const root = document.getElementById("root");
  let parsed = false;
  createRoot(root, {
    onUncaughtError(error) {
      state.error = String(error);
    },
  }).render(
    createElement(Renderer, {
      response: source,
      library,
      isStreaming: false,
      publishObservability: false,
      onParseResult(result) {
        parsed = result?.root != null;
      },
      onError(errors) {
        if (errors.length) state.error = errors.map((error) => error.message).join("; ");
      },
    }),
  );

  let previous = "";
  let stableFrames = 0;
  async function observe() {
    if (state.error) return;
    await document.fonts.ready;
    const elements = [...root.querySelectorAll("*")].filter(isVisible);
    const charts = elements.filter((element) => element.hasAttribute("data-chart"));
    const chartsReady = charts.every((chart) => {
      const svg = chart.querySelector("svg.recharts-surface");
      return svg && svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0;
    });
    const images = elements.filter((element) => element instanceof HTMLImageElement);
    const failedImage = images.find((image) => image.complete && image.naturalWidth === 0);
    if (failedImage) {
      state.error = `Image could not be rendered: ${failedImage.getAttribute("src")}`;
      return;
    }
    const hasAnimation = document
      .getAnimations()
      .some(
        (animation) =>
          (animation.playState === "running" || animation.pending) &&
          animation.effect instanceof KeyframeEffect &&
          isVisible(animation.effect.target),
      );
    const signature = JSON.stringify(
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return [
          element.tagName,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          element.childElementCount ? "" : element.textContent,
          ...["d", "points", "transform", "stroke-dasharray", "stroke-dashoffset"].map((name) =>
            element.getAttribute(name),
          ),
        ];
      }),
    );
    const settled =
      parsed && chartsReady && images.every((image) => image.complete) && !hasAnimation;
    stableFrames = settled && signature === previous ? stableFrames + 1 : 0;
    previous = signature;
    if (stableFrames >= STABLE_FRAMES) {
      state.ready = true;
      return;
    }
    requestAnimationFrame(observe);
  }
  requestAnimationFrame(observe);
};

function isVisible(element) {
  if (
    !(element instanceof Element) ||
    !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
    return false;
  const rect = element.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let right = Math.min(rect.right, innerWidth);
  let top = Math.max(rect.top, 0);
  let bottom = Math.min(rect.bottom, innerHeight);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const box = parent.getBoundingClientRect();
    if (style.overflowX !== "visible") {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (style.overflowY !== "visible") {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  return right > left && bottom > top;
}
