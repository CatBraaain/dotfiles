import { test as base, type Locator, type Page } from "@playwright/test";

// Copy this fixture into the test project and import `test` from this module.
// Configure Playwright's video: 'on' separately; this only draws on the page.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(installOverlay);
    await page.evaluate(installOverlay);
    await use(page);
  },
});

const lastClickPositions = new WeakMap<Page, { x: number; y: number }>();

// Use this instead of locator.click() for clicks that should show the cursor traveling to the target.
export async function clickWithMotion(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Cannot move to a locator without a visible bounding box");

  const start = lastClickPositions.get(page) ?? { x: 0, y: 0 };
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const durationMs = 420;
  const frames = 24;
  const startedAt = performance.now();
  for (let frame = 1; frame <= frames; frame++) {
    const progress = frame / frames;
    const eased = progress * progress * (3 - 2 * progress);
    const waitMs = Math.max(0, durationMs * progress - (performance.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await page.mouse.move(
      start.x + (target.x - start.x) * eased,
      start.y + (target.y - start.y) * eased,
    );
  }
  lastClickPositions.set(page, target);
  await locator.click();
}

function installOverlay(): void {
  // page.addInitScript also runs in child frames; only the recorded top-level page needs an overlay.
  if (window !== window.top) return;

  const mount = () => {
    if (!document.documentElement || document.querySelector("[data-playwright-recording-overlay]")) return;

    const host = document.createElement("div");
    host.setAttribute("data-playwright-recording-overlay", "");
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      *, *::before, *::after { box-sizing: border-box; pointer-events: none !important; }
      .cursor { position: absolute; width: 28px; height: 32px;
        filter: drop-shadow(0 2px 2px rgba(0, 0, 0, .55)); display: none; }
      .ripple { position: absolute; width: 20px; height: 20px; margin: -10px;
        border: 4px solid #ffdb65; border-radius: 50%; background: rgba(255, 219, 101, .25);
        box-shadow: 0 0 0 3px rgba(0, 0, 0, .6); animation: ripple .65s ease-out forwards; }
      @keyframes ripple { to { transform: scale(4); opacity: 0; } }
      .input-band { --band-fill: rgba(15, 17, 20, .82); --band-ink: #f4f1e9;
        position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
        width: min(960px, calc(100vw - 48px)); padding: 12px 24px;
        background: var(--band-fill); color: var(--band-ink);
        font: 600 30px/1.2 system-ui, sans-serif; text-align: center;
        white-space: pre; overflow: hidden; text-overflow: ellipsis;
        opacity: 0; transition: opacity 300ms ease-out; }
    `;
    shadow.append(style);

    const cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.innerHTML =
      '<svg viewBox="0 0 28 32" width="28" height="32" aria-hidden="true"><path d="M2 2V25L8 19L13 29L18 26L12 16H23Z" fill="white" stroke="#151b29" stroke-width="2.5" stroke-linejoin="round"/></svg>';
    const ripples = document.createElement("div");
    const inputBand = document.createElement("div");
    inputBand.className = "input-band";
    shadow.append(ripples, cursor, inputBand);
    document.documentElement.append(host);

    window.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType !== "mouse") return;
        cursor.style.display = "block";
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      },
      { passive: true, capture: true },
    );
    const rippleTimers = new Map<Element, number>();
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.pointerType !== "mouse") return;
        const ripple = document.createElement("div");
        ripple.className = "ripple";
        ripple.style.left = `${event.clientX}px`;
        ripple.style.top = `${event.clientY}px`;
        ripples.append(ripple);
        if (rippleTimers.size >= 6) {
          const oldest = rippleTimers.keys().next().value;
          if (oldest) {
            window.clearTimeout(rippleTimers.get(oldest));
            rippleTimers.delete(oldest);
            oldest.remove();
          }
        }
        rippleTimers.set(
          ripple,
          window.setTimeout(() => {
            ripple.remove();
            rippleTimers.delete(ripple);
          }, 650),
        );
      },
      { passive: true, capture: true },
    );

    let text = "";
    let showingShortcut = false;
    let lastKeydownMs = -Infinity;
    let holdTimer: number | undefined;
    let clearTimer: number | undefined;
    let pendingTextTimer: number | undefined;
    let deletionVisibleUntilMs = 0;
    const showText = () => {
      window.clearTimeout(holdTimer);
      window.clearTimeout(clearTimer);
      inputBand.textContent = text;
      inputBand.style.opacity = "1";
      holdTimer = window.setTimeout(() => {
        inputBand.style.opacity = "0";
        clearTimer = window.setTimeout(() => {
          text = "";
          showingShortcut = false;
          inputBand.textContent = "";
        }, 300);
      }, 600);
    };
    window.addEventListener(
      "keydown",
      (event) => {
        lastKeydownMs = Date.now();
        window.clearTimeout(pendingTextTimer);
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
          text = `${event.metaKey ? "Meta" : "Ctrl"} + A`;
          showingShortcut = true;
          deletionVisibleUntilMs = 0;
        } else if (event.key === "Backspace" && !event.ctrlKey && !event.metaKey) {
          text = Array.from(text).slice(0, -1).join("");
          // Keep the deletion visible for several frames before an immediate replacement key arrives.
          deletionVisibleUntilMs = performance.now() + 160;
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          text = `${showingShortcut ? "" : text}${event.key}`;
          showingShortcut = false;
        } else {
          return;
        }
        const waitMs = Math.max(0, deletionVisibleUntilMs - performance.now());
        if (waitMs > 0 && event.key !== "Backspace") {
          pendingTextTimer = window.setTimeout(showText, waitMs);
        } else {
          showText();
        }
      },
      { passive: true, capture: true },
    );
    // fill() can dispatch input without keydown; display its result as a new text stream.
    window.addEventListener(
      "input",
      (event) => {
        if (Date.now() - lastKeydownMs < 150) return;
        const target = event.target;
        if (target instanceof HTMLInputElement) {
          if (
            !["text", "search", "email", "tel", "url", "password", "number"].includes(target.type)
          ) {
            return;
          }
          text = target.value;
        } else if (target instanceof HTMLTextAreaElement) {
          text = target.value;
        } else if (target instanceof HTMLElement && target.isContentEditable) {
          text = target.textContent ?? "";
        } else {
          return;
        }
        showingShortcut = false;
        deletionVisibleUntilMs = 0;
        window.clearTimeout(pendingTextTimer);
        showText();
      },
      { passive: true, capture: true },
    );
  };

  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
