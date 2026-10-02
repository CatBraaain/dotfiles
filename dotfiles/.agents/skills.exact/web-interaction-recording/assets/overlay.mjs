/**
 * @typedef {{x:number,y:number,width:number,height:number}} Rect
 * @typedef {{name:string,action:string,expected:string}} Step
 * @typedef {{rect:Rect,name:string,kind:'click'|'input'|'key'|'scroll'|'hover'|'drag'|'open'}} Target
 * @typedef {{rect:Rect,name:string,expected:string}} Result
 * @typedef {{text:string,at:number,hold?:boolean}} Input
 * @typedef {{name:string,at:number,api?:boolean,hold?:boolean}} Key
 * @typedef {{x:number,y:number,at:number,click?:boolean}} Pointer
 * @typedef {{title:string,steps:Step[],current:number,phase:'waiting'|'acting'|'checking'|'result',theme:'light'|'dark',pageArea:Rect,titleArea:Rect,reducedMotion?:boolean|null,target?:Target|null,result?:Result|null,input?:Input|null,key?:Key|null,pointer?:Pointer|null}} OverlayState
 * @typedef {{element:string,reason:string,rect:Rect,step:number,total:number,pageArea:Rect,value:string}} Constraint
 * @typedef {{constraints:Constraint[],placements:Record<string,Rect>,requiredTitleHeight:number,at:number}} Layout
 * @typedef {{update:(patch:Partial<OverlayState>)=>Layout,inspect:()=>Layout,painted:()=>Promise<Layout>,setVisible:(visible:boolean)=>Promise<void>,dispose:()=>void}} Overlay
 * @typedef {Window & {recordingOverlay?:Overlay}} OverlayWindow
 */

/** Self-contained for Page.evaluate; assets and state are the only inputs. */
export function installRecordingOverlay(
  /** @type {{html:string,css:string,state:OverlayState}} */ { html, css, state: initialState },
) {
  validate(initialState);
  const owner = /** @type {OverlayWindow} */ (window);
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
  const template = document.createElement("template");
  template.innerHTML = html;
  shadow.append(template.content.cloneNode(true));
  document.documentElement.append(host);
  const root = element(".overlay");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let state = structuredClone(initialState);
  let disposed = false;
  let frame = 0;
  /** @type {Map<number, () => void>} */
  const paintFrames = new Map();
  /** @type {Layout} */
  let layout = { constraints: [], placements: {}, requiredTitleHeight: 0, at: 0 };
  /** @type {{node:HTMLElement|SVGElement,at:number,kind:'trail'|'ripple',x:number,y:number}[]} */
  let effects = [];
  /** @type {Rect[]} */
  let protectedRects = [];
  let lastInputAt = -Infinity;
  let pendingInput = /** @type {Input|null} */ (null);
  let inputRevealAt = 0;
  let visible = true;
  let visibilityRequest = 0;
  /** @type {Map<HTMLElement, {visible:boolean,animation:Animation|null,fadeAt?:number}>} */
  const presentations = new Map();
  for (const selector of [".panel", ".target-caption", ".result-caption", ".input", ".key"])
    presentations.set(element(selector), { visible: false, animation: null });

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
    async setVisible(/** @type {boolean} */ nextVisible) {
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

  function update(/** @type {Partial<OverlayState>} */ patch) {
    if (disposed) throw new Error("Recording overlay has been disposed");
    const next = { ...state, ...structuredClone(patch) };
    validate(next);
    const onlyThemeOrPointer = Object.keys(patch).every((name) =>
      ["theme", "reducedMotion", "pointer"].includes(name),
    );
    const input = patch.input;
    if (
      input &&
      state.key?.name === "Backspace" &&
      input.at - lastInputAt < 160 &&
      input.text.length > (state.input?.text.length ?? 0)
    ) {
      pendingInput = input;
      inputRevealAt = lastInputAt + 160;
      next.input = state.input;
    } else if ("input" in patch) {
      pendingInput = null;
      if (input) lastInputAt = input.at;
    }
    state = next;
    applyTheme();
    if (!onlyThemeOrPointer || layout.at === 0) render();
    if ("pointer" in patch) pointer(patch.pointer);
    tick();
    return structuredClone(layout);
  }

  function validate(/** @type {OverlayState} */ candidate) {
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
      throw new Error("Pass the caller-selected annotation theme");
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
      if (!Number.isFinite(value.at))
        throw new Error("Input and key timestamps use the document performance clock");
    }
    for (const rect of [
      candidate.pageArea,
      candidate.titleArea,
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
      effects.filter((effect) => effect.kind === "trail").forEach((effect) => effect.node.remove());
      effects = effects.filter((effect) => effect.kind !== "trail");
    }
  }
  function reduced() {
    return state.reducedMotion ?? motion.matches;
  }
  function onMotion() {
    applyTheme();
    tick();
  }

  function render() {
    const area = state.pageArea;
    element(".panel").hidden = false;
    const s = Math.max(1, area.width / 1280);
    root.style.setProperty("--unit", `${s}px`);
    layout = { constraints: [], placements: {}, requiredTitleHeight: 0, at: performance.now() };
    protectedRects = [state.target?.rect, state.phase === "result" ? state.result?.rect : null]
      .filter((rect) => rect != null)
      .map((rect) => expand(rect, 8 * s));
    const n = state.steps.length;
    const step = state.steps[state.current - 1];
    element(".test-title").textContent = state.title;
    element(".step-count").textContent = `STEP ${state.current} / ${n}`;
    element(".step-count").style.width = `${measureText(`STEP ${n} / ${n}`, "step-count")}px`;
    const segments = element(".segments");
    segments.replaceChildren();
    segments.style.width = `${Math.max(160, 8 * n - 4) * s}px`;
    for (let i = 1; i <= n; i++) {
      const segment = document.createElement("div");
      segment.className = `segment ${status(i)}`;
      segments.append(segment);
    }
    const title = element(".title");
    title.classList.toggle("stacked", area.width < 720 * s);
    const progress = element(".progress");
    progress.classList.remove("stacked");
    title.style.width = `${state.titleArea.width}px`;
    title.style.height = "auto";
    const titleInner = state.titleArea.width - 48 * s;
    if (
      area.width < 720 * s &&
      measureText(`STEP ${n} / ${n}`, "step-count") +
        12 * s +
        segments.getBoundingClientRect().width >
        titleInner
    )
      progress.classList.add("stacked");
    layout.requiredTitleHeight = Math.max(64 * s, title.getBoundingClientRect().height);
    place(title, state.titleArea);
    title.style.height = `${state.titleArea.height}px`;
    if (
      state.titleArea.height < layout.requiredTitleHeight ||
      segments.getBoundingClientRect().width > titleInner ||
      intersects(state.titleArea, area) ||
      state.titleArea.width !== area.width ||
      state.titleArea.x !== area.x ||
      state.titleArea.y !== 0 ||
      !contains({ x: 0, y: 0, width: innerWidth, height: innerHeight }, area) ||
      !contains({ x: 0, y: 0, width: innerWidth, height: innerHeight }, state.titleArea)
    ) {
      constraint(
        "title",
        "Reserve a non-overlapping, full-width title area with the required height",
        state.titleArea,
      );
    }
    const frames = element(".frames");
    place(frames, area);
    for (const kind of ["target", "result"]) {
      const annotation =
        kind === "target" ? state.target : state.phase === "result" ? state.result : null;
      const box = element(`.${kind}-frame`);
      const caption = element(`.${kind}-caption`);
      box.hidden = !annotation;
      if (annotation) caption.hidden = false;
      if (!annotation) continue;
      const r = annotation.rect;
      const frameRect = {
        x: r.x - area.x - 2 * s,
        y: r.y - area.y - 2 * s,
        width: r.width + 4 * s,
        height: r.height + 4 * s,
      };
      place(box, frameRect);
      box.style.borderRadius = `${Math.min(10 * s, frameRect.width / 2, frameRect.height / 2)}px`;
      const target = state.target;
      const result = state.result;
      if (kind === "target" && target) {
        element(".target-caption .caption-text").textContent = target.name;
        element(".target-caption .icon").innerHTML = icon(target.kind);
      } else if (result) {
        element(".result-caption .caption-text").textContent =
          `${result.name} === ${result.expected}`;
        element(".result-caption .icon").innerHTML = icon("result");
      }
    }
    const primary = state.target
      ? ".target-caption"
      : state.input
        ? ".input"
        : state.key
          ? ".key"
          : ".label";
    for (const slot of shadow.querySelectorAll(".primary")) {
      slot.replaceChildren();
      if (slot.parentElement?.matches(primary)) slot.append(badge(state.current, true));
    }
    element(".label-text").textContent = `${step.action} → ${step.expected}`;
    if (state.input) {
      element(".input").hidden = false;
      element(".input-text").textContent = state.input.text;
    }
    if (state.key) {
      element(".key").hidden = false;
      element(".key-name").textContent = state.key.name;
      element(".api-note").textContent = state.key.api ? "操作案内" : "";
      element(".api-note").hidden = !state.key.api;
    }

    const occupied = /** @type {Rect[]} */ ([]);
    const annotations = [
      { kind: "target", annotation: state.target },
      { kind: "result", annotation: state.phase === "result" ? state.result : null },
    ]
      .filter((entry) => entry.annotation != null)
      .map((entry) => ({
        kind: entry.kind,
        annotation: /** @type {Target|Result} */ (entry.annotation),
      }))
      .sort(
        (a, b) =>
          a.annotation.rect.y - b.annotation.rect.y || a.annotation.rect.x - b.annotation.rect.x,
      );
    for (const { kind, annotation } of annotations) {
      const caption = element(`.${kind}-caption`);
      caption.style.width = `${Math.min(area.width - 48 * s, captionWidth(caption, n, kind === "target", s))}px`;
      const size = dimensions(caption);
      const r = annotation.rect;
      const safe = inset(area, 24 * s);
      const clampX = (/** @type {number} */ x) =>
        Math.max(safe.x, Math.min(x, safe.x + safe.width - size.width));
      const clampY = (/** @type {number} */ y) =>
        Math.max(safe.y, Math.min(y, safe.y + safe.height - size.height));
      const candidates = [
        { x: clampX(r.x + 8 * s), y: r.y - 8 * s - size.height },
        { x: clampX(r.x + 8 * s), y: r.y + r.height + 8 * s },
        { x: r.x + r.width + 8 * s, y: clampY(r.y) },
        { x: r.x - 8 * s - size.width, y: clampY(r.y) },
      ];
      selectPosition(kind + "-caption", caption, candidates, occupied, s);
    }
    const panel = element(".panel");
    const seen = new Set();
    let panelPlaced = false;
    for (const [width, columns] of [
      [420, 1],
      [360, 1],
      [560, 1],
      [720, 1],
      [720, 2],
    ]) {
      const outerWidth = Math.min(width * s, area.width - 48 * s);
      if (columns === 2 && (n <= 5 || outerWidth - 42 * s < 600 * s)) continue;
      const key = `${outerWidth}/${columns}`;
      if (seen.has(key)) continue;
      seen.add(key);
      panel.style.width = `${outerWidth}px`;
      if (!renderRows(columns, outerWidth, s)) continue;
      const size = dimensions(panel);
      const safe = inset(area, 24 * s);
      const candidates = [
        { x: safe.x, y: safe.y },
        { x: safe.x + safe.width - size.width, y: safe.y },
        { x: safe.x, y: safe.y + safe.height - size.height },
        { x: safe.x + safe.width - size.width, y: safe.y + safe.height - size.height },
      ];
      const found = candidates
        .map((point) => ({ ...point, width: size.width, height: size.height }))
        .find((rect) => fits(rect, occupied, s));
      if (found) {
        recordPlacement("panel", panel, found, occupied);
        panelPlaced = true;
        break;
      }
    }
    if (!panelPlaced) {
      panel.style.width = `${Math.min(420 * s, area.width - 48 * s)}px`;
      renderRows(1, dimensions(panel).width, s);
      const rect = sized(panel, area.x + 24 * s, area.y + 24 * s);
      recordPlacement("panel", panel, rect, occupied);
      constraint("panel", "No panel candidate preserves all steps and protected targets", rect);
    }
    if (state.input) {
      const input = element(".input");
      input.style.width = `${Math.min(0.52 * area.width, area.width - 48 * s)}px`;
      input.style.borderRadius = `${dimensions(input).height / 2}px`;
      selectPosition("input", input, positions(input, false, s), occupied, s);
    }
    if (state.key) {
      const key = element(".key");
      const numberWidth =
        primary === ".key"
          ? Math.max(24 * s, 8 * s + measureText(String(n), "step-count")) + 12 * s
          : 0;
      key.style.width = `${Math.min(area.width - 48 * s, Math.max(160 * s, 42 * s + numberWidth + measureText(state.key.name, "key-name")))}px`;
      selectPosition("key", key, positions(key, true, s), occupied, s);
    }
    element(".overlay > .cursor").hidden = !state.pointer;
    layout.at = performance.now();
    present(element(".panel"), visible);
    present(element(".target-caption"), visible && !!state.target);
    present(element(".result-caption"), visible && state.phase === "result" && !!state.result);
    for (const kind of ["input", "key"]) {
      const value = state[/** @type {'input'|'key'} */ (kind)];
      presentTransient(element("." + kind), value, performance.now());
    }
  }

  function dimensions(/** @type {HTMLElement} */ node) {
    const style = getComputedStyle(node);
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
  }
  function activePresentations() {
    return Array.from(presentations.values())
      .map((entry) => entry.animation)
      .filter((animation) => animation != null)
      .filter((animation) => animation.playState !== "finished");
  }
  function present(
    /** @type {HTMLElement} */ node,
    /** @type {boolean} */ nextVisible,
    duration = nextVisible ? 150 : 300,
    immediate = false,
  ) {
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

  function presentTransient(
    /** @type {HTMLElement} */ node,
    /** @type {Input|Key|null|undefined} */ value,
    /** @type {number} */ now,
  ) {
    const age = value ? now - value.at : Infinity;
    if (!value) {
      present(node, false);
      return;
    }
    if (!value.hold && age >= 900) {
      present(node, false, 0, true);
      return;
    }
    if (!visible || value.hold || age < 600) {
      present(node, visible);
      return;
    }
    const entry = presentations.get(node);
    if (!entry) return;
    if (entry.fadeAt === value.at) {
      node.hidden = false;
      return;
    }
    entry.animation?.cancel();
    entry.visible = false;
    entry.fadeAt = value.at;
    node.hidden = false;
    const animation = node.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: `scale(${reduced() ? 1 : 0.96})` },
      ],
      { duration: 300, easing: "linear", fill: "both" },
    );
    animation.startTime = value.at + 600;
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

  function renderRows(
    /** @type {number} */ columns,
    /** @type {number} */ width,
    /** @type {number} */ s,
  ) {
    const list = element(".steps");
    list.replaceChildren();
    list.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    const contentWidth = (width - 42 * s - (columns - 1) * 24 * s) / columns;
    const chipWidth = Math.max(32 * s, 12 * s + measureText(String(state.steps.length), "chip"));
    const nameWidth = contentWidth - 16 * s - chipWidth - 12 * s - 10 * s;
    let maxNameHeight = 0;
    const rows = state.steps.map((step, index) => {
      const row = document.createElement("div");
      row.className = `row ${status(index + 1)}`;
      row.append(badge(index + 1));
      const name = document.createElement("span");
      name.className = "step-name";
      name.textContent = step.name;
      name.style.fontWeight = "600";
      name.style.width = `${Math.max(0, nameWidth)}px`;
      row.append(name);
      list.append(row);
      maxNameHeight = Math.max(maxNameHeight, dimensions(name).height);
      name.style.removeProperty("font-weight");
      return row;
    });
    const height = Math.max(76 * s, 16 * s + Math.max(44 * s, maxNameHeight));
    for (const row of rows) row.style.height = `${height}px`;
    return (
      nameWidth > 0 &&
      rows.every((row) => {
        const name = row.querySelector(".step-name");
        return (
          name != null &&
          row.scrollWidth <= row.clientWidth + 1 &&
          name.scrollWidth <= name.clientWidth + 1
        );
      })
    );
  }

  function status(/** @type {number} */ number) {
    return number < state.current || (number === state.current && state.phase === "result")
      ? "done"
      : number === state.current
        ? "current"
        : "pending";
  }
  function badge(/** @type {number} */ number, primary = false) {
    const s = Math.max(1, state.pageArea.width / 1280);
    const width = Math.max(
      (primary ? 24 : 32) * s,
      (primary ? 8 : 12) * s +
        measureText(String(state.steps.length), primary ? "step-count" : "chip"),
    );
    const badge = document.createElement("span");
    badge.className = `badge ${status(number)}`;
    badge.style.width = `${width + (primary ? 0 : 12 * s)}px`;
    badge.dataset.phase =
      status(number) === "done" ? "result" : number === state.current ? state.phase : "waiting";
    badge.innerHTML = '<span class="chip"></span>';
    if (!primary)
      badge.insertAdjacentHTML(
        "beforeend",
        '<span class="decoration spinner"></span><span class="decoration ring"></span><span class="decoration check"><svg viewBox="0 0 12 12"><path d="m2 6 2.5 2.5L10 3"/></svg></span>',
      );
    const chip = /** @type {HTMLElement} */ (badge.firstElementChild);
    chip.textContent = String(number);
    chip.style.width = `${width}px`;
    return badge;
  }

  function captionWidth(
    /** @type {HTMLElement} */ caption,
    /** @type {number} */ n,
    /** @type {boolean} */ primary,
    /** @type {number} */ s,
  ) {
    const numberWidth = primary
      ? Math.max(24 * s, 8 * s + measureText(String(n), "step-count")) + 8 * s
      : 0;
    return (
      24 * s +
      numberWidth +
      20 * s +
      8 * s +
      measureText(caption.querySelector(".caption-text")?.textContent ?? "", "caption-text")
    );
  }
  function measureText(/** @type {string} */ text, /** @type {string} */ role) {
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
  function positions(
    /** @type {HTMLElement} */ node,
    /** @type {boolean} */ centered,
    /** @type {number} */ s,
  ) {
    const safe = inset(state.pageArea, 24 * s);
    const size = dimensions(node);
    const center = {
      x: safe.x + (safe.width - size.width) / 2,
      y: safe.y + (safe.height - size.height) / 2,
    };
    return [
      ...(centered ? [center] : []),
      { x: center.x, y: safe.y + safe.height - size.height },
      { x: center.x, y: safe.y },
      { x: safe.x, y: center.y },
      { x: safe.x + safe.width - size.width, y: center.y },
    ];
  }
  function selectPosition(
    /** @type {string} */ name,
    /** @type {HTMLElement} */ node,
    /** @type {{x:number,y:number}[]} */ candidates,
    /** @type {Rect[]} */ occupied,
    /** @type {number} */ s,
  ) {
    const rects = candidates.map((point) => sized(node, point.x, point.y));
    const hasContentWidth =
      node.scrollWidth <= node.clientWidth + 1 &&
      Array.from(node.querySelectorAll(".caption-text,.input-text,.key-name")).every(
        (text) => text.clientWidth > 0 && text.scrollWidth <= text.clientWidth + 1,
      );
    const found = hasContentWidth ? rects.find((rect) => fits(rect, occupied, s)) : undefined;
    const rect = found ?? rects[0];
    recordPlacement(name, node, rect, occupied);
    if (!found)
      constraint(name, "No candidate preserves full text, safe edges and protected targets", rect);
  }
  function fits(/** @type {Rect} */ rect, /** @type {Rect[]} */ occupied, /** @type {number} */ s) {
    const safe = inset(state.pageArea, 24 * s);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      contains(safe, rect) &&
      !protectedRects.some((protectedRect) => intersects(rect, protectedRect)) &&
      !occupied.some((other) => intersects(rect, expand(other, 16 * s)))
    );
  }
  function recordPlacement(
    /** @type {string} */ name,
    /** @type {HTMLElement} */ node,
    /** @type {Rect} */ rect,
    /** @type {Rect[]} */ occupied,
  ) {
    place(node, rect);
    layout.placements[name] = rect;
    occupied.push(rect);
  }
  function constraint(
    /** @type {string} */ name,
    /** @type {string} */ reason,
    /** @type {Rect} */ rect,
  ) {
    /** @type {Record<string, string>} */
    const values = {
      title: state.title,
      panel:
        state.steps.map((step) => step.name).join("\n") + "\n" + element(".label-text").textContent,
      input: state.input?.text ?? "",
      key: state.key?.name ?? "",
      "target-caption": state.target?.name ?? "",
      "result-caption": state.result ? state.result.name + " === " + state.result.expected : "",
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
  function element(/** @type {string} */ selector) {
    const found = shadow.querySelector(selector);
    if (!(found instanceof HTMLElement || found instanceof SVGElement))
      throw new Error(`Missing overlay asset element: ${selector}`);
    return /** @type {HTMLElement} */ (found);
  }
  function place(/** @type {HTMLElement} */ node, /** @type {Rect} */ rect) {
    Object.assign(node.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
    });
    if (node.classList.contains("frame") || node.classList.contains("frames"))
      node.style.height = `${rect.height}px`;
  }
  function sized(
    /** @type {HTMLElement} */ node,
    /** @type {number} */ x,
    /** @type {number} */ y,
  ) {
    const { width, height } = dimensions(node);
    return { x, y, width, height };
  }
  function expand(/** @type {Rect} */ r, /** @type {number} */ gap) {
    return { x: r.x - gap, y: r.y - gap, width: r.width + gap * 2, height: r.height + gap * 2 };
  }
  function inset(/** @type {Rect} */ r, /** @type {number} */ gap) {
    return expand(r, -gap);
  }
  function contains(/** @type {Rect} */ outer, /** @type {Rect} */ inner) {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height
    );
  }
  function intersects(/** @type {Rect} */ a, /** @type {Rect} */ b) {
    return (
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
  }

  function pointer(/** @type {Pointer|null|undefined} */ sample) {
    element(".overlay > .cursor").hidden = !sample;
    if (!sample) return;
    const cursor = element(".overlay > .cursor");
    cursor.style.left = `${sample.x}px`;
    cursor.style.top = `${sample.y}px`;
    if (sample.click) {
      const ripple = document.createElement("div");
      ripple.className = "ripple";
      element(".effects").append(ripple);
      effects.push({ node: ripple, kind: "ripple", at: sample.at, x: sample.x, y: sample.y });
    } else if (!reduced()) {
      const trail = /** @type {SVGElement} */ (cursor.cloneNode(true));
      element(".effects").append(trail);
      effects.push({ node: trail, kind: "trail", at: sample.at, x: sample.x, y: sample.y });
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
    const s = Math.max(1, state.pageArea.width / 1280);
    effects = effects.filter((effect) => {
      const age = Math.max(0, now - effect.at);
      const duration = effect.kind === "trail" ? 200 : 450;
      if (age >= duration) {
        effect.node.remove();
        return false;
      }
      const fraction = age / duration;
      if (effect.kind === "trail") {
        const ghost = { x: effect.x, y: effect.y, width: 16 * s, height: 24 * s };
        const overText =
          Object.values(layout.placements).some((rect) => intersects(ghost, rect)) ||
          intersects(ghost, state.titleArea);
        effect.node.style.opacity = String(overText ? 0 : 0.25 * (1 - fraction));
      } else {
        const diameter = reduced() ? 24 : 12 + fraction * 36;
        effect.node.style.left = `${effect.x - 24 * s}px`;
        effect.node.style.top = `${effect.y - 24 * s}px`;
        effect.node.style.setProperty("--ripple-scale", String(diameter / 48));
        effect.node.style.opacity = String(0.75 * (1 - fraction));
      }
      return true;
    });
    let fading = false;
    let expired = false;
    /** @type {[string, Input|Key|null|undefined, "input"|"key"][]} */
    const fadingAnnotations = [
      [".input", state.input, "input"],
      [".key", state.key, "key"],
    ];
    for (const [selector, value, kind] of fadingAnnotations) {
      const node = element(selector);
      if (!value) continue;
      const age = now - value.at;
      fading ||= !value.hold && age < 900;
      presentTransient(node, value, now);
      if (!value.hold && age >= 900) {
        present(node, false, 0, true);
        state[kind] = null;
        expired = true;
      }
    }
    if (expired) render();
    if (effects.length || fading || pendingInput) frame = requestAnimationFrame(tick);
  }
  function icon(/** @type {string} */ kind) {
    /** @type {Record<string, string>} */
    const paths = {
      click: '<path d="M5 3v16l4-4 4 6 3-2-4-6h7Z"/>',
      hover: '<path d="M5 3v16l4-4 4 6 3-2-4-6h7Z"/>',
      input: '<path d="m4 16 12-12 4 4L8 20H4Z M13 7l4 4"/>',
      key: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h2m3 0h2m3 0h1M7 14h10"/>',
      scroll: '<path d="M8 20V4L4 8m4-4 4 4m4-4v16l-4-4m4 4 4-4"/>',
      drag: '<path d="M8 12V5a2 2 0 0 1 4 0v6-4a2 2 0 0 1 4 0v5-2a2 2 0 0 1 4 0v7l-4 5H9l-6-8a2 2 0 0 1 3-2l2 2Z"/>',
      open: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
      result:
        '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    };
    return paths[kind] ?? paths.click;
  }
}
