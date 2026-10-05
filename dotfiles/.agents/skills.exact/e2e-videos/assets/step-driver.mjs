// Annotation waits declared by SPEC.md ("録画ドライバ" section). Values are
// checked against that section by step-driver.test.mjs.
export const TIMING = {
  announceMs: 1800,
  moveMs: 400,
  holdMs: 250,
  typeIntervalMs: 120,
  fillHoldMs: 600,
  resultViewMs: 3000,
  resultSwitchMs: 200,
};

const PAINT_TIMEOUT_MS = 500;
const ACTION_WAIT_TIMEOUT_MS = 10_000;
const RESULT_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_HOME_BELOW_VIEWPORT = 60;
const GLIDE_SEGMENT_MS = 25;
const SCROLL_WHEEL_STEPS = 4;
const SCROLL_WHEEL_GAP_MS = 120;

const DEFAULT_CLOCK = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function createStepDriver(page, overlay, plan, options = {}) {
  const steps = validatedSteps(plan);
  const step = options.step ?? 1;
  if (!Number.isInteger(step) || step < 1 || step > steps.length)
    throw new Error(`Step ${step} is outside the declared steps 1..${steps.length}`);
  const timing = { ...TIMING, ...options.timing };
  const clock = options.clock ?? DEFAULT_CLOCK;
  const theme = options.theme ?? "light";
  const layer = options.layer ?? "page";
  const titleHeight = options.titleHeight ?? 64;
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const pageArea = options.pageArea ?? {
    x: 0,
    y: titleHeight,
    width: viewport.width,
    height: viewport.height - titleHeight,
  };
  const titleArea = options.titleArea ?? {
    x: 0,
    y: 0,
    width: viewport.width,
    height: titleHeight,
  };
  let cursor = {
    x: pageArea.x + pageArea.width / 2,
    y: pageArea.y + pageArea.height + CURSOR_HOME_BELOW_VIEWPORT,
  };
  let consumed = false;

  await overlay.update({
    title: plan.title,
    steps: steps.map((planStep) => ({
      name: planStep.action,
      action: planStep.action,
      expected: "",
    })),
    current: step,
    phase: "waiting",
    theme,
    layer,
    pageArea,
    titleArea,
  });
  await settlePainted();

  const driver = {
    metadata: () => recordingMetadata(plan),
    async click(operation) {
      const locator = requireLocator(operation, "click");
      const results = requireResults(operation, "click");
      return runStep({
        kind: "click",
        locator,
        anchor: operation.anchor ?? null,
        results,
        act: async (rect) => {
          await overlay.update({ phase: "acting" });
          const center = rectCenter(rect);
          cursor = await glide(cursor, center, timing.moveMs);
          await clock.sleep(timing.holdMs);
          const at = await pageNow();
          await overlay.update({
            pointer: { x: center.x, y: center.y, at, click: true },
          });
          await page.mouse.down();
          await page.mouse.up();
        },
      });
    },
    async hover(operation) {
      const locator = requireLocator(operation, "hover");
      const results = requireResults(operation, "hover");
      return runStep({
        kind: "hover",
        locator,
        anchor: operation.anchor ?? null,
        results,
        act: async (rect) => {
          await overlay.update({ phase: "acting" });
          cursor = await glide(cursor, rectCenter(rect), timing.moveMs);
          await clock.sleep(timing.holdMs);
        },
      });
    },
    async type(operation) {
      const locator = requireLocator(operation, "type");
      const results = requireResults(operation, "type");
      return runStep({
        kind: "input",
        locator,
        anchor: operation.anchor ?? null,
        results,
        act: async () => {
          await overlay.update({ phase: "acting" });
          await locator.focus();
          let text = "";
          for (const character of Array.from(operation.text)) {
            await page.keyboard.type(character);
            text += character;
            const at = await pageNow();
            await overlay.update({ input: { text, at } });
            await clock.sleep(timing.typeIntervalMs);
          }
          if (operation.key) await pressKey(operation.key);
        },
      });
    },
    async fill(operation) {
      const locator = requireLocator(operation, "fill");
      const results = requireResults(operation, "fill");
      return runStep({
        kind: "input",
        locator,
        anchor: operation.anchor ?? null,
        results,
        act: async () => {
          await overlay.update({ phase: "acting" });
          await locator.focus();
          await locator.fill(operation.text);
          const at = await pageNow();
          await overlay.update({ input: { text: operation.text, at } });
          await clock.sleep(timing.fillHoldMs);
        },
      });
    },
    async press(operation) {
      const results = requireResults(operation, "press");
      const locator = operation.locator ?? null;
      return runStep({
        kind: "key",
        locator,
        anchor: operation.anchor ?? null,
        results,
        act: async (rect) => {
          await overlay.update({ phase: "acting" });
          if (locator) {
            await locator.focus();
            cursor = await glide(cursor, rectCenter(rect), timing.moveMs);
            await clock.sleep(timing.holdMs);
          }
          await pressKey(operation.key);
        },
      });
    },
    async scroll(operation) {
      const results = requireResults(operation, "scroll");
      const locator = operation.locator ?? null;
      return runStep({
        kind: "scroll",
        locator,
        anchor: operation.anchor ?? null,
        results,
        act: async (rect) => {
          await overlay.update({ phase: "acting" });
          const center = locator
            ? rectCenter(rect)
            : {
                x: pageArea.x + pageArea.width / 2,
                y: pageArea.y + pageArea.height / 2,
              };
          cursor = await glide(cursor, center, timing.moveMs);
          const name = operation.deltaY >= 0 ? "ScrollDown" : "ScrollUp";
          const perWheel = operation.deltaY / SCROLL_WHEEL_STEPS;
          for (let wheel = 0; wheel < SCROLL_WHEEL_STEPS; wheel++) {
            const at = await pageNow();
            await overlay.update({ key: { name, at } });
            await page.mouse.wheel(0, perWheel);
            await clock.sleep(SCROLL_WHEEL_GAP_MS);
          }
        },
      });
    },
  };
  return driver;

  function pageNow() {
    return page.evaluate(() => performance.now());
  }

  async function pressKey(key) {
    const at = await pageNow();
    await overlay.update({ key: { name: key, at } });
    await page.keyboard.press(key);
  }

  async function runStep({ kind, locator, anchor, results, act }) {
    if (consumed)
      throw new Error("This driver already ran its single step; create one driver per step video");
    consumed = true;
    let targetRect = null;
    let anchorRect = null;
    if (locator) {
      await locator.waitFor({
        state: "visible",
        timeout: ACTION_WAIT_TIMEOUT_MS,
      });
      await locator.scrollIntoViewIfNeeded();
      targetRect = await measure(locator);
      anchorRect = anchor ? await measure(anchor) : targetRect;
    }
    await overlay.update({
      current: step,
      phase: "waiting",
      target: targetRect ? { kind, rect: targetRect } : null,
      taskAnchor: anchorRect,
      input: null,
      key: null,
      result: null,
      checkAt: null,
    });
    await settlePainted();
    await clock.sleep(timing.announceMs);
    await act(targetRect);
    const endAt = await pageNow();
    await overlay.update({ phase: "checking", checkAt: endAt });
    await showResults(results);
    return driver.metadata();
  }

  async function glide(from, to, durationMs) {
    const segments = Math.max(2, Math.ceil(durationMs / GLIDE_SEGMENT_MS));
    let position = from;
    for (let segment = 1; segment <= segments; segment++) {
      const progress = cubicBezier(0.42, 0.58, segment / segments);
      position = lerp(from, to, progress);
      const at = await pageNow();
      await overlay.update({ pointer: { x: position.x, y: position.y, at } });
      await page.mouse.move(position.x, position.y);
      await clock.sleep(durationMs / segments);
    }
    return to;
  }

  async function showResults(results) {
    for (const [index, result] of results.entries()) {
      if (index > 0) {
        await overlay.update({ result: null });
        await clock.sleep(timing.resultSwitchMs);
      }
      await result.locator.waitFor({
        state: "visible",
        timeout: RESULT_WAIT_TIMEOUT_MS,
      });
      const rect = await measure(result.locator);
      await overlay.update({
        phase: "result",
        result: { rect, name: result.name, expected: result.expected },
      });
      await settlePainted();
      await clock.sleep(timing.resultViewMs);
    }
  }

  async function settlePainted() {
    let failure;
    const finished = overlay.painted().catch((error) => {
      failure = error;
    });
    const didPaint = await Promise.race([
      finished.then(() => true),
      clock.sleep(PAINT_TIMEOUT_MS).then(() => false),
    ]);
    if (!didPaint && failure) throw failure;
  }

  async function measure(locator) {
    const rect = await locator.boundingBox();
    if (!rect)
      throw new Error(
        "Cannot measure the target in viewport coordinates; iframe elements are outside the step driver's scope",
      );
    return rect;
  }
}

export function recordingMetadata(plan) {
  const steps = validatedSteps(plan);
  return {
    title: plan.title,
    steps: steps.map((step, index) => ({
      number: index + 1,
      action: step.action,
      video: step.video ?? `step-${index + 1}.mp4`,
    })),
  };
}

function validatedSteps(plan) {
  if (!plan || typeof plan.title !== "string" || !plan.title.trim())
    throw new Error("Recording plan requires a non-empty title");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0)
    throw new Error("Recording plan requires a non-empty steps array");
  for (const step of plan.steps) {
    if (!step || typeof step.action !== "string" || !step.action.trim())
      throw new Error("Each recording step requires a non-empty action");
    if (step.video != null && (typeof step.video !== "string" || !step.video.trim()))
      throw new Error("Each recording step video must be a non-empty string");
  }
  return plan.steps;
}

function requireLocator(operation, name) {
  if (!operation?.locator) throw new Error(`The ${name} step requires a target locator`);
  return operation.locator;
}

function requireResults(operation, name) {
  const provided = operation?.result ?? operation?.results;
  if (provided == null) throw new Error(`The ${name} step requires at least one result to show`);
  const entries = Array.isArray(provided) ? provided : [provided];
  for (const entry of entries) {
    if (!entry?.locator)
      throw new Error(`Every result of the ${name} step requires a locator to measure`);
    if (
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      typeof entry.expected !== "string"
    ) {
      throw new Error(
        `Every result of the ${name} step requires non-empty name and expected strings for the result label`,
      );
    }
  }
  return entries.map((entry) => ({
    name: entry.name,
    expected: entry.expected,
    locator: entry.locator,
  }));
}

function rectCenter(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function lerp(from, to, progress) {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

function cubicBezier(x1, x2, progress) {
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
