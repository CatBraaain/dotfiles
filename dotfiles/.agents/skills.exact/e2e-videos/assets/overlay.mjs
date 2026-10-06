export function installRecordingOverlay({ html, css, state: initialState }) {
  const owner = window;
  owner.recordingOverlay?.dispose();
  const host = document.createElement("recording-annotation-overlay");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  const hostStyle = {
    all: "initial",
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    "pointer-events": "none",
    "z-index": "2147483647",
    margin: "0",
    padding: "0",
    border: "0",
    transform: "none",
    opacity: "1",
    display: "block",
    visibility: "visible",
    isolation: "isolate",
    "color-scheme": "normal",
  };
  for (const [name, value] of Object.entries(hostStyle))
    host.style.setProperty(name, value, "important");
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(css);
  shadow.adoptedStyleSheets = [stylesheet];
  // Sites enforcing Trusted Types (for example YouTube) reject string markup,
  // so retry through one reusable named policy. Keep the direct assignment on
  // everything else and never register a default policy.
  const policyName = "recording-annotation-overlay";
  try {
    shadow.innerHTML = html;
  } catch (error) {
    if (!owner.trustedTypes) throw error;
    const policy = (owner[policyName] ??= owner.trustedTypes.createPolicy(policyName, {
      createHTML: (value) => value,
    }));
    shadow.innerHTML = policy.createHTML(html);
  }
  document.documentElement.append(host);
  const root = element(".overlay");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let state = structuredClone(initialState);
  let disposed = false;
  let frame = 0;
  const paintFrames = new Map();
  let layout = {
    constraints: [],
    placements: {},
    requiredTitleHeight: 0,
    at: 0,
  };
  let effects = [];
  let protectedRects = [];
  let lastInputAt = -Infinity;
  let pendingInput = null;
  let inputRevealAt = 0;
  let visible = true;
  let visibilityRequest = 0;
  let checkStartedAt = null;
  let checkStep = 0;
  const firstAts = {
    input: null,
    key: null,
  };
  const dockWidths = { input: 0, key: 0 };
  const presentations = new Map();
  for (const selector of [".task-label", ".result-label", ".input", ".key"])
    presentations.set(element(selector), { visible: false, animation: null });

  const ENTER_MS = 200;
  const HOLD_MS = 1200;
  const EXIT_MS = 250;
  const CHECK_FADE_MS = 360;
  const REVEAL_MS = 160;

  const api = {
    update,
    inspect: () => structuredClone(layout),
    painted: () =>
      new Promise((resolve, reject) => {
        if (disposed) {
          reject(new Error("Recording overlay has been disposed"));
          return;
        }
        const rejectDisposed = () => reject(new Error("Recording overlay has been disposed"));
        const animations = activePresentations();
        const first = requestAnimationFrame(() => {
          paintFrames.delete(first);
          const second = requestAnimationFrame(async () => {
            paintFrames.delete(second);
            await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
            if (disposed) rejectDisposed();
            else resolve(structuredClone(layout));
          });
          paintFrames.set(second, rejectDisposed);
        });
        paintFrames.set(first, rejectDisposed);
      }),
    async setVisible(nextVisible) {
      if (disposed) throw new Error("Recording overlay has been disposed");
      const request = ++visibilityRequest;
      visible = nextVisible;
      if (visible) host.style.setProperty("visibility", "visible", "important");
      render();
      await Promise.all(activePresentations().map((animation) => animation.finished));
      if (disposed) throw new Error("Recording overlay has been disposed");
      if (request !== visibilityRequest)
        throw new DOMException("Recording overlay visibility request was superseded", "AbortError");
      if (!nextVisible) host.style.setProperty("visibility", "hidden", "important");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      for (const [id, reject] of paintFrames) {
        cancelAnimationFrame(id);
        reject();
      }
      paintFrames.clear();
      for (const { animation } of presentations.values()) animation?.cancel();
      presentations.clear();
      motion.removeEventListener("change", onMotion);
      effects = [];
      host.remove();
      if (owner.recordingOverlay === api) delete owner.recordingOverlay;
    },
  };
  owner.recordingOverlay = api;
  motion.addEventListener("change", onMotion);
  update(initialState);
  return layout;

  function update(patch) {
    if (disposed) throw new Error("Recording overlay has been disposed");
    const raw = { ...state, ...structuredClone(patch) };
    const adopted = normalize(raw, state);
    validate(adopted);
    const onlyThemeOrPointer = Object.keys(patch).every((name) =>
      ["theme", "reducedMotion", "pointer"].includes(name),
    );
    const input = patch.input;
    if (
      input &&
      state.key?.name === "Backspace" &&
      input.at - lastInputAt < REVEAL_MS &&
      input.text.length > (state.input?.text.length ?? 0)
    ) {
      pendingInput = input;
      inputRevealAt = lastInputAt + REVEAL_MS;
      adopted.input = state.input;
    } else if ("input" in patch) {
      pendingInput = null;
      if (input) lastInputAt = input.at;
    }
    const pointerAppeared = "pointer" in patch && !!patch.pointer && !state.pointer;
    state = adopted;
    adoptCheckClock(patch);
    applyTheme();
    if (!onlyThemeOrPointer || layout.at === 0) render();
    if ("pointer" in patch) pointer(patch.pointer, pointerAppeared);
    tick();
    return structuredClone(layout);
  }

  function normalize(next, previous) {
    for (const kind of ["input", "key"]) {
      const value = next[kind];
      if (!value) {
        firstAts[kind] = null;
        dockWidths[kind] = 0;
        continue;
      }
      const earlier = previous?.[kind] ?? null;
      const continues =
        earlier != null &&
        performance.now() < transientTimes(earlier.firstAt ?? earlier.at, earlier.at).exitEnd;
      const firstAt = value.firstAt ?? (continues ? (earlier?.firstAt ?? earlier.at) : value.at);
      if (firstAt !== firstAts[kind]) {
        firstAts[kind] = firstAt;
        dockWidths[kind] = 0;
      }
      value.firstAt = firstAt;
    }
    return next;
  }

  function adoptCheckClock(patch) {
    const explicit = "checkAt" in patch;
    if (
      state.phase === "waiting" ||
      state.phase === "acting" ||
      (explicit && patch.checkAt == null)
    ) {
      checkStartedAt = null;
      checkStep = 0;
      return;
    }
    if (state.current !== checkStep || (explicit && patch.checkAt != null)) {
      checkStep = state.current;
      checkStartedAt = explicit ? patch.checkAt : performance.now();
    }
  }

  function validate(candidate) {
    if (!candidate.steps.length) throw new Error("No recording steps; supply a non-empty scenario");
    if (
      !Number.isInteger(candidate.current) ||
      candidate.current < 1 ||
      candidate.current > candidate.steps.length
    )
      throw new Error("current must be a 1-based step number");
    if (!["waiting", "acting", "checking", "result"].includes(candidate.phase))
      throw new Error("Unknown overlay phase");
    if (!["light", "dark"].includes(candidate.theme))
      throw new Error("Pass the observed site theme; docks invert it automatically");
    if (!["both", "title", "page"].includes(candidate.layer ?? "both"))
      throw new Error("Unknown overlay layer");
    if (!candidate.pageArea || !candidate.titleArea)
      throw new Error("Pass the reserved page and title rectangles");
    if (
      typeof candidate.title !== "string" ||
      candidate.steps.some((step) =>
        [step.name, step.action, step.expected].some((text) => typeof text !== "string"),
      )
    )
      throw new Error("Title and step text must be strings");
    if (
      candidate.target &&
      !["click", "input", "key", "scroll", "hover", "drag", "open"].includes(candidate.target.kind)
    )
      throw new Error("Unknown target operation kind");
    if (
      candidate.pointer &&
      ![candidate.pointer.x, candidate.pointer.y, candidate.pointer.at].every(Number.isFinite)
    )
      throw new Error("Pointer samples require finite viewport coordinates and event times");
    for (const value of [candidate.input, candidate.key].filter((value) => value != null)) {
      if (![value.at, value.firstAt].every((time) => time == null || Number.isFinite(time)))
        throw new Error("Input and key timestamps use the document performance clock");
    }
    if (candidate.checkAt != null && !Number.isFinite(candidate.checkAt))
      throw new Error("checkAt uses the document performance clock");
    for (const rect of [
      candidate.pageArea,
      candidate.titleArea,
      candidate.taskAnchor ?? null,
      candidate.target?.rect,
      candidate.result?.rect,
    ].filter(Boolean)) {
      if (
        !rect ||
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 ||
        rect.height <= 0
      )
        throw new Error("Rects require finite viewport coordinates and positive dimensions");
    }
  }

  function applyTheme() {
    root.dataset.theme = state.theme;
    root.dataset.reduced = String(reduced());
    if (reduced()) {
      for (const { animation } of presentations.values()) {
        if (animation?.effect instanceof KeyframeEffect)
          animation.effect.setKeyframes(
            animation.effect
              .getKeyframes()
              .map((keyframe) => ({ ...keyframe, transform: "scale(1)" })),
          );
      }
    }
  }
  function reduced() {
    return state.reducedMotion ?? motion.matches;
  }
  function onMotion() {
    applyTheme();
    tick();
  }
  function scale() {
    return Math.max(1, state.pageArea.width / 1280);
  }

  function render() {
    const area = state.pageArea;
    const s = scale();
    root.style.setProperty("--unit", `${s}px`);
    layout = {
      constraints: [],
      placements: {},
      requiredTitleHeight: 0,
      at: performance.now(),
    };
    const step = state.steps[state.current - 1];
    const showPage = state.layer !== "title";
    const showTitle = state.layer !== "page";
    const occupied = [];
    protectedRects = [
      showPage && state.phase !== "result" ? (state.target?.rect ?? null) : null,
      showPage && state.phase === "result" ? (state.result?.rect ?? null) : null,
    ]
      .filter((rect) => rect != null)
      .map((rect) => expand(rect, 8 * s));
    if (showTitle) renderTitle(s);
    else {
      element(".title").hidden = true;
      layout.requiredTitleHeight = 0;
    }
    const frames = element(".frames");
    frames.hidden = !showPage;
    if (showPage) {
      place(frames, area);
      renderFrame("target", state.phase !== "result" ? (state.target ?? null) : null, area, s);
      renderFrame("result", state.phase === "result" ? (state.result ?? null) : null, area, s);
      renderTaskLabel(step, s, occupied);
      renderResultLabel(s, occupied);
      renderInput(s, occupied);
      renderKey(s, occupied);
      element(".cursor").hidden = !state.pointer;
    } else {
      for (const selector of [".task-label", ".result-label", ".input", ".key", ".cursor"])
        element(selector).hidden = true;
    }
    layout.at = performance.now();
    present(element(".task-label"), visible && showPage);
    present(
      element(".result-label"),
      visible && showPage && state.phase === "result" && !!state.result,
    );
    for (const kind of ["input", "key"]) {
      const value = state[kind];
      const transient = showPage ? value : null;
      presentTransient(element("." + kind), transient, performance.now());
    }
  }

  function renderTitle(s) {
    const title = element(".title");
    title.hidden = false;
    element(".test-title").textContent = state.title;
    const inner = state.titleArea.width - 48 * s;
    const titleLines = wrapLines(state.title, "test-title", inner, 24 * s);
    layout.requiredTitleHeight = Math.max(64 * s, 32 * s + 24 * s * titleLines);
    place(title, state.titleArea);
    if (
      state.titleArea.height < layout.requiredTitleHeight ||
      intersects(state.titleArea, state.pageArea) ||
      state.titleArea.width !== state.pageArea.width ||
      state.titleArea.x !== state.pageArea.x ||
      state.titleArea.y !== 0 ||
      !contains({ x: 0, y: 0, width: innerWidth, height: innerHeight }, state.pageArea) ||
      !contains({ x: 0, y: 0, width: innerWidth, height: innerHeight }, state.titleArea)
    ) {
      constraint(
        "title",
        "Reserve a non-overlapping, full-width title area with the required height",
        state.titleArea,
      );
    }
  }
  function renderFrame(kind, annotation, area, s) {
    const box = element(`.${kind}-frame`);
    box.hidden = !annotation;
    if (!annotation) return;
    const r = annotation.rect;
    const frameRect = {
      x: r.x - area.x - 2 * s,
      y: r.y - area.y - 2 * s,
      width: r.width + 4 * s,
      height: r.height + 4 * s,
    };
    place(box, frameRect);
    box.style.borderRadius = `${Math.min(10 * s, frameRect.width / 2, frameRect.height / 2)}px`;
  }

  function taskAnchorRect() {
    const fallback = state.taskAnchor ?? state.target?.rect ?? state.result?.rect;
    if (fallback) return fallback;
    const safe = inset(state.pageArea, 24);
    return { x: safe.x, y: safe.y, width: safe.width, height: 1 };
  }

  function renderTaskLabel(step, s, occupied) {
    const label = element(".task-label");
    label.hidden = false;
    element(".label-text").textContent = step.action;
    element(".chip").textContent = String(state.current);
    applyCheckPaint(performance.now());
    const area = state.pageArea;
    const safe = inset(area, 24 * s);
    const anchor = taskAnchorRect();
    const width = Math.min(anchor.width, safe.width);
    const textWidth = width - 26 * s - 44 * s;
    const lines = wrapLines(step.action, "label-text", textWidth, 26 * s);
    const height = Math.max(48 * s, 22 * s + 26 * s * lines);
    label.style.width = `${width}px`;
    label.style.height = `${height}px`;
    const x = Math.max(safe.x, Math.min(anchor.x, safe.x + safe.width - width));
    const above = { x, y: anchor.y - 12 * s - height, width, height };
    const below = { x, y: anchor.y + anchor.height + 12 * s, width, height };
    const found = [above, below].find((rect) => fits(rect, occupied, s));
    const fallbackY =
      above.y >= safe.y ? above.y : Math.min(below.y, safe.y + safe.height - height);
    const rect = found ?? {
      x,
      y: Math.max(safe.y, fallbackY),
      width,
      height,
    };
    recordPlacement("task-label", label, rect, occupied);
    if (!found || textWidth <= 0)
      constraint(
        "task-label",
        "No task-label placement preserves full text, safe edges and protected targets",
        rect,
      );
  }

  function applyCheckPaint(now) {
    const check = element(".check");
    check.hidden = checkStartedAt == null;
    if (checkStartedAt == null) return;
    const age = Math.max(0, now - checkStartedAt);
    check.style.opacity = String(checkOpacity(age));
  }
  function checkOpacity(ageMs) {
    const fraction = Math.min(1, ageMs / CHECK_FADE_MS);
    return cssEase(fraction, 0, 0.58);
  }

  function renderResultLabel(s, occupied) {
    const label = element(".result-label");
    const result = state.phase === "result" ? state.result : null;
    if (!result) return;
    label.hidden = false;
    const text = `${result.name} === ${result.expected}`;
    element(".result-text").textContent = text;
    const area = state.pageArea;
    const safe = inset(area, 24 * s);
    const maxTextWidth = Math.max(1, safe.width - 52 * s);
    const textWidth = Math.min(measure(text, "result-text"), maxTextWidth);
    const lines = wrapLines(text, "result-text", Math.max(textWidth, 1), 20 * s);
    const width = Math.min(safe.width, 52 * s + textWidth);
    const height = 16 * s + 20 * s * lines;
    label.style.width = `${width}px`;
    label.style.height = `${height}px`;
    const frame = expand(result.rect, 2 * s);
    const x = Math.max(safe.x, Math.min(frame.x + 8 * s, safe.x + safe.width - width));
    const above = { x, y: frame.y - 8 * s - height, width, height };
    const below = { x, y: frame.y + frame.height + 8 * s, width, height };
    const taskRect = layout.placements["task-label"];
    const overlapsTask = (rect) => !!(taskRect && intersects(rect, expand(taskRect, 16 * s)));
    const found = [above, below].find((rect) => fits(rect, occupied, s) && !overlapsTask(rect));
    const rect = found ?? above;
    recordPlacement("result-label", label, rect, occupied);
    if (!found)
      constraint(
        "result-label",
        "No result-label placement preserves full text, safe edges, the task label and protected targets",
        rect,
      );
  }

  function renderInput(s, occupied) {
    const value = state.input;
    if (!value) return;
    const dock = element(".input");
    dock.hidden = false;
    element(".input-text").textContent = value.text;
    const area = state.pageArea;
    const safe = inset(area, 24 * s);
    const natural = Math.max(360 * s, 42 * s + measure(value.text, "input-text"));
    const width = Math.min(safe.width, Math.max(dockWidths.input, natural));
    dockWidths.input = width;
    const lines = wrapLines(value.text, "input-text", width - 42 * s, 30 * s);
    const height = Math.max(56 * s, 26 * s + 30 * s * lines);
    dock.style.width = `${width}px`;
    dock.style.height = `${height}px`;
    dock.style.borderRadius = `${height / 2}px`;
    const rect = {
      x: area.x + (area.width - width) / 2,
      y: area.y + area.height - 24 * s - height,
      width,
      height,
    };
    const placed = fits(rect, occupied, s);
    recordPlacement("input", dock, rect, occupied);
    if (!placed)
      constraint("input", "The bottom-centre input band collides with protected targets", rect);
  }

  function renderKey(s, occupied) {
    const value = state.key;
    if (!value) return;
    const dock = element(".key");
    dock.hidden = false;
    element(".key-name").textContent = value.name;
    element(".api-note").textContent = value.api ? "操作案内" : "";
    element(".api-note").hidden = !value.api;
    const noteHeight = value.api ? 8 * s + 20 * s : 0;
    const width = Math.max(120 * s, 42 * s + measure(value.name, "key-name"));
    dockWidths.key = Math.max(dockWidths.key, width);
    const lines = wrapLines(value.name, "key-name", width - 42 * s, 30 * s);
    const height = Math.max(56 * s, 26 * s + 30 * s * lines) + noteHeight;
    dock.style.width = `${width}px`;
    dock.style.height = `${height}px`;
    selectPosition("key", dock, positions(inset(state.pageArea, 24 * s), dock, true), occupied, s);
  }

  function measure(text, role) {
    const probe = document.createElement("span");
    probe.className = role;
    probe.textContent = text;
    Object.assign(probe.style, {
      position: "absolute",
      width: "max-content",
      whiteSpace: "pre",
      visibility: "hidden",
    });
    root.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }
  function wrapLines(text, role, width, lineHeight) {
    if (!(width > 0)) return 1;
    const probe = document.createElement("span");
    probe.className = role;
    probe.textContent = text;
    Object.assign(probe.style, {
      position: "absolute",
      width: `${width}px`,
      visibility: "hidden",
    });
    root.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return Math.max(1, Math.ceil(height / lineHeight - 0.01));
  }

  function transientTimes(firstAt, lastAt) {
    const enterEnd = firstAt + ENTER_MS;
    const holdEnd = Math.max(enterEnd, lastAt) + HOLD_MS;
    return { enterEnd, holdEnd, exitEnd: holdEnd + EXIT_MS };
  }
  function activePresentations() {
    return Array.from(presentations.values())
      .map((entry) => entry.animation)
      .filter((animation) => animation != null)
      .filter((animation) => animation.playState !== "finished");
  }
  function present(node, nextVisible, duration = nextVisible ? 150 : 300, immediate = false) {
    const entry = presentations.get(node);
    if (!entry) return;
    if (immediate) {
      entry.animation?.cancel();
      entry.animation = null;
      entry.fadeAt = undefined;
      entry.visible = nextVisible;
      node.hidden = !nextVisible;
      return;
    }
    if (entry.visible === nextVisible) {
      if (!entry.animation) node.hidden = !nextVisible;
      return;
    }
    const style = getComputedStyle(node);
    const from = entry.animation
      ? { opacity: style.opacity, transform: style.transform }
      : {
          opacity: nextVisible ? 0 : 1,
          transform: `scale(${reduced() ? 1 : nextVisible ? 0.96 : 1})`,
        };
    entry.animation?.cancel();
    entry.fadeAt = undefined;
    entry.visible = nextVisible;
    node.hidden = false;
    const animation = node.animate(
      [
        from,
        {
          opacity: nextVisible ? 1 : 0,
          transform: `scale(${reduced() ? 1 : nextVisible ? 1 : 0.96})`,
        },
      ],
      { duration, easing: "linear", fill: "both" },
    );
    entry.animation = animation;
    animation.finished
      .then(() => {
        if (entry.animation !== animation || disposed) return;
        node.hidden = !entry.visible;
        animation.cancel();
        entry.animation = null;
      })
      .catch(() => {});
  }
  function presentTransient(node, value, now) {
    if (!value) {
      present(node, false);
      return;
    }
    const times = transientTimes(value.firstAt ?? value.at, value.at);
    if (!value.hold && now >= times.exitEnd) {
      present(node, false, 0, true);
      return;
    }
    if (visible && (value.hold || now < times.holdEnd)) {
      present(node, visible, ENTER_MS);
      return;
    }
    const entry = presentations.get(node);
    if (!entry) return;
    if (entry.fadeAt === times.holdEnd) {
      node.hidden = false;
      return;
    }
    entry.animation?.cancel();
    entry.visible = false;
    entry.fadeAt = times.holdEnd;
    node.hidden = false;
    const animation = node.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: `scale(${reduced() ? 1 : 0.96})` },
      ],
      { duration: EXIT_MS, easing: "linear", fill: "both" },
    );
    animation.startTime = times.holdEnd;
    entry.animation = animation;
    animation.finished
      .then(() => {
        if (entry.animation !== animation || disposed) return;
        node.hidden = true;
        animation.cancel();
        entry.animation = null;
      })
      .catch(() => {});
  }

  function positions(safe, node, centered) {
    const size = sized(node, 0, 0);
    const centre = {
      x: safe.x + (safe.width - size.width) / 2,
      y: safe.y + (safe.height - size.height) / 2,
    };
    return [
      ...(centered ? [centre] : []),
      { x: centre.x, y: safe.y + safe.height - size.height },
      { x: centre.x, y: safe.y },
      { x: safe.x, y: centre.y },
      { x: safe.x + safe.width - size.width, y: centre.y },
    ];
  }
  function selectPosition(name, node, candidates, occupied, s) {
    const rects = candidates.map((point) => sized(node, point.x, point.y));
    const found = rects.find((rect) => fits(rect, occupied, s));
    const rect = found ?? rects[0];
    recordPlacement(name, node, rect, occupied);
    if (!found)
      constraint(name, "No candidate preserves full text, safe edges and protected targets", rect);
  }
  function fits(rect, occupied, s) {
    const safe = inset(state.pageArea, 24 * s);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      contains(safe, rect) &&
      !protectedRects.some((protectedRect) => intersects(rect, protectedRect)) &&
      !occupied.some((other) => intersects(rect, expand(other, 16 * s)))
    );
  }
  function recordPlacement(name, node, rect, occupied) {
    place(node, rect);
    layout.placements[name] = rect;
    occupied.push(rect);
  }
  function constraint(name, reason, rect) {
    const values = {
      title: state.title,
      "task-label": state.steps[state.current - 1]?.action ?? "",
      "result-label": state.result ? `${state.result.name} === ${state.result.expected}` : "",
      input: state.input?.text ?? "",
      key: state.key?.name ?? "",
    };
    layout.constraints.push({
      element: name,
      reason,
      rect,
      step: state.current,
      total: state.steps.length,
      pageArea: state.pageArea,
      value: values[name] ?? "",
    });
  }
  function element(selector) {
    const found = shadow.querySelector(selector);
    if (!(found instanceof HTMLElement || found instanceof SVGElement))
      throw new Error(`Missing overlay asset element: ${selector}`);
    return found;
  }
  function place(node, rect) {
    Object.assign(node.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
  function sized(node, x, y) {
    return {
      x,
      y,
      width: Number.parseFloat(node.style.width) || 0,
      height: Number.parseFloat(node.style.height) || 0,
    };
  }
  function expand(r, gap) {
    return {
      x: r.x - gap,
      y: r.y - gap,
      width: r.width + gap * 2,
      height: r.height + gap * 2,
    };
  }
  function inset(r, gap) {
    return expand(r, -gap);
  }
  function contains(outer, inner) {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height
    );
  }
  function intersects(a, b) {
    return (
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
  }

  function pointer(sample, appeared) {
    const cursor = element(".cursor");
    cursor.hidden = !sample;
    cursor.classList.remove("pop");
    if (!sample) return;
    cursor.style.left = `${sample.x}px`;
    cursor.style.top = `${sample.y}px`;
    if (appeared && !reduced()) cursor.classList.add("pop");
    if (sample.click) {
      const ripple = document.createElement("div");
      ripple.className = "ripple";
      element(".effects").append(ripple);
      effects.push({
        node: ripple,
        kind: "ripple",
        at: sample.at,
        x: sample.x,
        y: sample.y,
      });
    }
  }

  function tick() {
    cancelAnimationFrame(frame);
    if (disposed) return;
    const now = performance.now();
    if (pendingInput && now >= inputRevealAt) {
      state.input = pendingInput;
      lastInputAt = pendingInput.at;
      pendingInput = null;
      render();
    }
    const s = scale();
    effects = effects.filter((effect) => {
      const age = Math.max(0, now - effect.at);
      if (age >= 450) {
        effect.node.remove();
        return false;
      }
      const fraction = age / 450;
      const diameter = reduced() ? 24 : 12 + fraction * 36;
      effect.node.style.left = `${effect.x - 24 * s}px`;
      effect.node.style.top = `${effect.y - 24 * s}px`;
      effect.node.style.setProperty("--ripple-scale", String(diameter / 48));
      effect.node.style.opacity = String(0.75 * (1 - fraction));
      return true;
    });
    let fading = false;
    let expired = false;
    for (const kind of ["input", "key"]) {
      const value = state[kind];
      if (!value) continue;
      const times = transientTimes(value.firstAt ?? value.at, value.at);
      fading ||= !value.hold && now < times.exitEnd;
      presentTransient(element("." + kind), value, now);
      if (!value.hold && now >= times.exitEnd) {
        present(element("." + kind), false, 0, true);
        state[kind] = null;
        firstAts[kind] = null;
        dockWidths[kind] = 0;
        expired = true;
      }
    }
    const checkFading = checkStartedAt != null && now - checkStartedAt <= CHECK_FADE_MS;
    if (checkFading) applyCheckPaint(now);
    if (expired) render();
    if (effects.length || fading || pendingInput || checkFading)
      frame = requestAnimationFrame(tick);
  }

  function cssEase(progress, x1, x2) {
    if (progress <= 0 || progress >= 1) return progress;
    const bezier = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    let low = 0;
    let high = 1;
    for (let index = 0; index < 24; index++) {
      const mid = (low + high) / 2;
      if (bezier(mid, x1, x2) < progress) low = mid;
      else high = mid;
    }
    return bezier((low + high) / 2, 0, 1);
  }
}
