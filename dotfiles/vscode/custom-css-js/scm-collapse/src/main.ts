declare global {
  interface Window {
    __scmCollapseAutoFold?: boolean;
    __scmCollapseObserver?: MutationObserver;
  }
}

export const PANE_ID = "workbench.view.scm";
export const BUTTON_SELECTOR = ".action-item .codicon-collapse-all";
export const ROW_SELECTOR = ".monaco-list-row";
export const POLL_INTERVAL_MS = 250;
export const MAX_ATTEMPTS = 60;

let currentPane: HTMLElement | null = null;
let pendingCheck = 0;

function dispatchCollapse(el: Element): void {
  for (const type of ["mousedown", "mouseup", "click"]) {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }),
    );
  }
}

function runCollapseCycle(pane: HTMLElement): void {
  let attempts = 0;
  let timer = 0;

  function scheduleRetry(): void {
    attempts += 1;
    if (attempts > MAX_ATTEMPTS) return;
    timer = window.setTimeout(step, POLL_INTERVAL_MS);
  }

  function step(): void {
    timer = 0;
    try {
      if (!pane.isConnected) return;
      if (!pane.querySelector(ROW_SELECTOR)) return scheduleRetry();
      const button = pane.querySelector(BUTTON_SELECTOR);
      if (!button) return scheduleRetry();
      const actionItem = button.closest(".action-item");
      if (actionItem && actionItem.classList.contains("disabled")) return scheduleRetry();
      dispatchCollapse(button);
    } catch {
      // Never throw from DOM observation.
    }
  }

  step();
}

function isPaneVisible(pane: HTMLElement): boolean {
  return pane.getClientRects().length > 0;
}

function check(): void {
  try {
    const pane = document.getElementById(PANE_ID);
    if (!pane || !isPaneVisible(pane)) {
      currentPane = null;
      return;
    }
    if (pane === currentPane) return;
    currentPane = pane;
    runCollapseCycle(pane);
  } catch {
    // Never throw from DOM observation.
  }
}

function onMutations(): void {
  if (pendingCheck) return;
  pendingCheck = window.setTimeout(function () {
    pendingCheck = 0;
    check();
  }, 0);
}

export function start(): void {
  try {
    if (window.__scmCollapseAutoFold) return;
    window.__scmCollapseAutoFold = true;
    check();
    const observer = new MutationObserver(onMutations);
    // The Loader injects this script before the DOM exists, so observe the
    // document node itself; documentElement and body are not available yet.
    // View switching toggles pane visibility via class/style changes, not
    // childList mutations.
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    // Keep a reachable reference; an unreferenced observer can be garbage
    // collected before it ever fires.
    window.__scmCollapseObserver = observer;
  } catch {
    // Never throw at injection time.
  }
}
