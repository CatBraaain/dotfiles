(function () {
  "use strict";

  const GUARD_KEY = "__scmCollapseAutoFold";
  if (window[GUARD_KEY]) return;
  window[GUARD_KEY] = true;

  const PANE_ID = "workbench.view.scm";
  const BUTTON_SELECTOR = ".action-item .codicon-collapse-all";
  const EXPANDED_ROW_SELECTOR = ".monaco-list-row[aria-expanded='true']";
  const POLL_INTERVAL_MS = 250;
  const MAX_ATTEMPTS = 60;

  let currentPane = null;
  let pendingCheck = 0;

  function dispatchCollapse(el) {
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }),
      );
    }
  }

  function runCollapseCycle(pane) {
    let attempts = 0;
    let timer = 0;

    function scheduleRetry() {
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) return;
      timer = setTimeout(step, POLL_INTERVAL_MS);
    }

    function step() {
      timer = 0;
      try {
        if (!pane.isConnected) return;
        if (!pane.querySelector(EXPANDED_ROW_SELECTOR)) return;
        const el = pane.querySelector(BUTTON_SELECTOR);
        if (!el) return scheduleRetry();
        const actionItem = el.closest(".action-item");
        if (actionItem && actionItem.classList.contains("disabled")) return scheduleRetry();
        dispatchCollapse(el);
        scheduleRetry();
      } catch {
        // Never throw from DOM observation.
      }
    }

    step();
  }

  function check() {
    try {
      const pane = document.getElementById(PANE_ID);
      if (!pane) {
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

  function onMutations() {
    if (pendingCheck) return;
    pendingCheck = setTimeout(function () {
      pendingCheck = 0;
      check();
    }, 0);
  }

  try {
    check();
    const observer = new MutationObserver(onMutations);
    // The Loader injects this script before the DOM exists, so observe the
    // document node itself; documentElement and body are not available yet.
    observer.observe(document, { childList: true, subtree: true });
    // Keep a reachable reference; an unreferenced observer can be garbage
    // collected before it ever fires.
    window["__scmCollapseObserver"] = observer;
  } catch {
    // Never throw at injection time.
  }
})();
