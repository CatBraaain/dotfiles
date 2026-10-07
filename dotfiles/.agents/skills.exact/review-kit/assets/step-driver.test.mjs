import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createStepDriver, recordingMetadata, TIMING } from "./step-driver.mjs";

const spec = readFileSync(new URL("./SPEC.md", import.meta.url), "utf8");
const driverSection = spec.split("## 録画ドライバ")[1].split("## ビューアと生成スクリプト")[0];
const intervalSection = spec.split("### 時間の間隔")[1].split(/\n### /)[0];

const PLAN = {
  title: "TodoMVC flow",
  steps: [
    {
      action: "Type “Read a book” and press Enter",
      video: "step-1-add-read-a-book.mp4",
    },
    { action: "Click the checkbox of “Read a book”" },
  ],
};

function fakeClock() {
  let now = 0;
  const waits = [];
  return {
    get now() {
      return now;
    },
    waits,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
}

function fakePage(clock) {
  const calls = {
    mouseMoves: [],
    events: [],
    downs: 0,
    ups: 0,
    wheels: [],
    keyboard: [],
    focus: 0,
    fill: [],
  };
  const locator = (rect) => ({
    boundingBox: async () => ({ ...rect }),
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    focus: async () => {
      calls.focus += 1;
    },
    fill: async (text) => {
      calls.fill.push(text);
    },
  });
  return {
    locator,
    calls,
    unmeasurableLocator: {
      boundingBox: async () => null,
      waitFor: async () => {},
      scrollIntoViewIfNeeded: async () => {},
    },
    viewportSize: () => ({ width: 1280, height: 720 }),
    evaluate: async () => clock.now,
    mouse: {
      move: async (x, y) => {
        calls.mouseMoves.push({ x, y });
        calls.events.push({
          kind: "move",
          at: clock.now,
          x,
          y,
          pressed: calls.downs > calls.ups,
        });
      },
      down: async () => {
        calls.downs += 1;
        calls.events.push({ kind: "down", at: clock.now });
      },
      up: async () => {
        calls.ups += 1;
        calls.events.push({ kind: "up", at: clock.now });
      },
      wheel: async (dx, dy) => {
        calls.wheels.push({ dx, dy });
      },
    },
    keyboard: {
      type: async (text) => {
        calls.keyboard.push(["type", text]);
      },
      press: async (key) => {
        calls.keyboard.push(["press", key]);
      },
    },
  };
}

function fakeOverlay(clock) {
  const patches = [];
  return {
    patches,
    update: async (patch) => {
      patches.push(patch);
      return {};
    },
    inspect: async () => {
      const pointer = patches.findLast((patch) => "pointer" in patch)?.pointer;
      if (!pointer) return { pointer: null };
      const fraction = Math.min(1, (clock.now - pointer.at) / pointer.move.durationMs);
      const from = pointer.move.from;
      return {
        pointer: {
          x: from.x + (pointer.x - from.x) * fraction,
          y: from.y + (pointer.y - from.y) * fraction,
          at: clock.now,
          moving: fraction < 1,
        },
      };
    },
    painted: async () => {},
  };
}

async function driverFor(clock, page, overlay, options = {}) {
  return createStepDriver(page, overlay, PLAN, { step: 1, clock, ...options });
}

function specTimingRow(label) {
  const line = driverSection.split("\n").find((line) => line.startsWith(`| ${label}`));
  assert.ok(line, `SPEC.md 録画ドライバ timing row for ${label}`);
  return Number(/(\d+) ms/.exec(line)[1]);
}

test("driver timing matches the SPEC.md 録画ドライバ table", () => {
  assert.equal(TIMING.announceMs, specTimingRow("予告"));
  assert.equal(TIMING.moveMs, specTimingRow("カーソルの接近・保持移動"));
  assert.equal(TIMING.holdMs, specTimingRow("到着後の操作までの停止"));
  assert.equal(TIMING.typeIntervalMs, specTimingRow("1 文字ごとの入力間隔"));
  assert.equal(TIMING.fillHoldMs, specTimingRow("一括設定後の入力帯と対象枠の表示"));
  assert.equal(TIMING.resultViewMs, specTimingRow("結果の視聴"));
  assert.equal(TIMING.resultSwitchMs, specTimingRow("結果枠・ラベルの切替間隔"));
});

test("driver timing satisfies the SPEC.md 時間の間隔 minimums", () => {
  const minimum = (pattern) => {
    const match = pattern.exec(intervalSection);
    assert.ok(match, `SPEC.md 時間の間隔 pattern ${pattern}`);
    return Number(match[1]);
  };
  const seconds = (pattern) => minimum(pattern) * 1000;
  assert.ok(TIMING.holdMs >= minimum(/最低 (\d+)ms 止める/));
  assert.ok(TIMING.typeIntervalMs >= minimum(/1 文字ごとに (\d+)ms 以上空ける/));
  assert.ok(TIMING.fillHoldMs >= minimum(/最低 (\d+)ms 表示してから結果の確認へ移る/));
  assert.ok(TIMING.resultViewMs >= seconds(/最低 (\d+) 秒維持/));
  assert.ok(TIMING.resultSwitchMs >= seconds(/(\d+(?:\.\d+)?) 秒空ける/));
});

test("builds metadata.json data from the plan declaration", () => {
  assert.deepEqual(recordingMetadata(PLAN), {
    title: PLAN.title,
    steps: [
      {
        number: 1,
        action: PLAN.steps[0].action,
        video: "step-1-add-read-a-book.mp4",
      },
      { number: 2, action: PLAN.steps[1].action, video: "step-2.mp4" },
    ],
  });
});

test("rejects an invalid plan", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  await assert.rejects(
    () => createStepDriver(page, overlay, { title: " ", steps: PLAN.steps }, { clock }),
    /non-empty title/,
  );
  await assert.rejects(
    () => createStepDriver(page, overlay, { title: "t", steps: [] }, { clock }),
    /steps/,
  );
  await assert.rejects(
    () => createStepDriver(page, overlay, { title: "t", steps: [{ action: " " }] }, { clock }),
    /action/,
  );
  await assert.rejects(
    () =>
      createStepDriver(
        page,
        overlay,
        { title: "t", steps: [{ action: "a", video: "" }] },
        { clock },
      ),
    /video/,
  );
});

test("rejects a step number outside the declared steps", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  await assert.rejects(() => driverFor(clock, page, overlay, { step: 3 }), /outside/);
});

test("click runs the announce → act → check → result sequence with real values", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await driver.click({
    locator: page.locator({ x: 100, y: 200, width: 300, height: 40 }),
    result: {
      name: "list",
      expected: "Read a book",
      locator: page.locator({ x: 100, y: 260, width: 300, height: 40 }),
    },
  });

  const setup = overlay.patches[0];
  assert.equal(setup.title, PLAN.title);
  assert.equal(setup.current, 1);
  assert.equal(setup.phase, "waiting");
  assert.equal(setup.layer, "page");
  assert.deepEqual(setup.pageArea, { x: 0, y: 64, width: 1280, height: 656 });
  assert.deepEqual(setup.titleArea, { x: 0, y: 0, width: 1280, height: 64 });
  assert.deepEqual(
    setup.steps.map((step) => step.action),
    PLAN.steps.map((step) => step.action),
  );

  const announce = overlay.patches.find((patch) => "target" in patch);
  const targetRect = { x: 100, y: 200, width: 300, height: 40 };
  assert.deepEqual(announce.target, { kind: "click", rect: targetRect });
  assert.deepEqual(announce.taskAnchor, targetRect);
  assert.equal(announce.input, null);
  assert.equal(announce.key, null);
  assert.equal(announce.result, null);
  assert.equal(announce.checkAt, null);

  assert.ok(overlay.patches.some((patch) => patch.phase === "acting"));

  const pointers = overlay.patches
    .filter((patch) => patch.pointer)
    .map((patch) => patch.pointer);
  assert.ok(pointers.length >= 2, "the cursor appears at the target and then clicks");
  assert.deepEqual(
    { x: pointers[0].x, y: pointers[0].y },
    { x: 250, y: 220 },
    "the cursor appears at the target center",
  );
  const clicked = pointers.find((pointer) => pointer.released);
  assert.deepEqual({ x: clicked.x, y: clicked.y }, { x: 250, y: 220 });
  assert.ok(pointers.every((pointer) => Number.isFinite(pointer.at)));
  assert.equal(page.calls.downs, 1);
  assert.equal(page.calls.ups, 1);
  assert.deepEqual(page.calls.mouseMoves[0], { x: 24, y: 88 });
  assert.deepEqual(page.calls.mouseMoves.at(-1), { x: 250, y: 220 });
  assert.ok(page.calls.mouseMoves.length > 3);
  assert.equal(pointers.length, 3, "one approach patch, down and up; no frame updates");
  assert.equal(pointers[1].pressed, true);
  assert.ok(clicked.at - pointers[0].at >= TIMING.moveMs + TIMING.holdMs);

  const checking = overlay.patches.find((patch) => patch.phase === "checking");
  assert.ok(Number.isFinite(checking.checkAt));
  assert.ok(checking.checkAt >= clicked.at);
  assert.equal(checking.pointer, null, "the cursor hides after the operation");

  const shown = overlay.patches.find((patch) => patch.result);
  assert.equal(shown.phase, "result");
  assert.deepEqual(shown.result, {
    rect: { x: 100, y: 260, width: 300, height: 40 },
    name: "list",
    expected: "Read a book",
  });

  assert.ok(clock.waits.includes(TIMING.announceMs));
  assert.ok(clock.waits.includes(TIMING.holdMs));
  assert.ok(clock.waits.includes(TIMING.resultViewMs));
  assert.ok(
    clock.waits.reduce((total, wait) => total + wait, 0) >=
      TIMING.announceMs + TIMING.holdMs + TIMING.resultViewMs,
  );
});

test("type transfers the accumulating text one character at a time and presses Enter", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await driver.type({
    locator: page.locator({ x: 100, y: 200, width: 400, height: 40 }),
    text: "ab",
    key: "Enter",
    result: {
      name: "list",
      expected: "Read a book",
      locator: page.locator({ x: 100, y: 260, width: 300, height: 40 }),
    },
  });

  const inputs = overlay.patches.filter((patch) => patch.input).map((patch) => patch.input);
  assert.deepEqual(
    inputs.map((input) => input.text),
    ["a", "ab"],
  );
  assert.ok(inputs.every((input) => Number.isFinite(input.at)));
  assert.equal(page.calls.focus, 1);
  assert.deepEqual(page.calls.keyboard, [
    ["type", "a"],
    ["type", "b"],
    ["press", "Enter"],
  ]);
  assert.ok(clock.waits.filter((wait) => wait === TIMING.typeIntervalMs).length >= 2);

  const keyPatch = overlay.patches.find((patch) => patch.key);
  assert.equal(keyPatch.key.name, "Enter");
  assert.ok(Number.isFinite(keyPatch.key.at));
});

test("fill transfers the whole value and keeps the dock and target frame for its hold", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await driver.fill({
    locator: page.locator({ x: 100, y: 200, width: 400, height: 40 }),
    text: "Buy milk",
    result: {
      name: "field",
      expected: "Buy milk",
      locator: page.locator({ x: 100, y: 200, width: 400, height: 40 }),
    },
  });

  assert.deepEqual(page.calls.fill, ["Buy milk"]);
  const input = overlay.patches.find((patch) => patch.input).input;
  assert.equal(input.text, "Buy milk");
  assert.ok(clock.waits.includes(TIMING.fillHoldMs));
});

test("press without a locator shows the key and relies on the fallback anchor", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await driver.press({
    key: "Enter",
    result: {
      name: "list",
      expected: "1 row",
      locator: page.locator({ x: 0, y: 100, width: 200, height: 40 }),
    },
  });

  const announce = overlay.patches.find((patch) => "target" in patch);
  assert.equal(announce.target, null);
  assert.equal(announce.taskAnchor, null);
  const keyPatch = overlay.patches.find((patch) => patch.key);
  assert.equal(keyPatch.key.name, "Enter");
  assert.deepEqual(page.calls.keyboard, [["press", "Enter"]]);
});

test("scroll splits the wheel into small steps and names the direction", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await driver.scroll({
    deltaY: 400,
    result: {
      name: "content",
      expected: "footer visible",
      locator: page.locator({ x: 0, y: 300, width: 1280, height: 100 }),
    },
  });

  const keyPatch = overlay.patches.find((patch) => patch.key);
  assert.equal(keyPatch.key.name, "ScrollDown");
  assert.deepEqual(page.calls.wheels, [
    { dx: 0, dy: 100 },
    { dx: 0, dy: 100 },
    { dx: 0, dy: 100 },
    { dx: 0, dy: 100 },
  ]);
  assert.ok(!clock.waits.includes(120), "wheel steps run without an inter-step wait");

  const upClock = fakeClock();
  const upPage = fakePage(upClock);
  const upOverlay = fakeOverlay(upClock);
  const upDriver = await driverFor(upClock, upPage, upOverlay);
  await upDriver.scroll({
    deltaY: -200,
    result: {
      name: "content",
      expected: "header visible",
      locator: upPage.locator({ x: 0, y: 0, width: 1280, height: 100 }),
    },
  });
  assert.equal(upOverlay.patches.find((patch) => patch.key).key.name, "ScrollUp");
});

test("lets the recording case widen the task anchor", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  const rowRect = { x: 40, y: 180, width: 560, height: 60 };
  await driver.click({
    locator: page.locator({ x: 40, y: 190, width: 28, height: 28 }),
    anchor: page.locator(rowRect),
    result: {
      name: "checkbox",
      expected: "checked",
      locator: page.locator({ x: 40, y: 190, width: 28, height: 28 }),
    },
  });
  const announce = overlay.patches.find((patch) => "target" in patch);
  assert.deepEqual(announce.taskAnchor, rowRect);
  assert.deepEqual(announce.target.rect, {
    x: 40,
    y: 190,
    width: 28,
    height: 28,
  });
});

test("shows multiple results one pair at a time with the switch gap", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await driver.click({
    locator: page.locator({ x: 100, y: 200, width: 300, height: 40 }),
    results: [
      {
        name: "checkbox",
        expected: "checked",
        locator: page.locator({ x: 100, y: 260, width: 20, height: 20 }),
      },
      {
        name: "items left",
        expected: "1 item left",
        locator: page.locator({ x: 500, y: 400, width: 100, height: 30 }),
      },
    ],
  });

  const shown = overlay.patches.filter((patch) => patch.result);
  assert.equal(shown.length, 2);
  assert.equal(shown[0].result.name, "checkbox");
  assert.equal(shown[1].result.name, "items left");
  assert.deepEqual(shown[1].result.rect, {
    x: 500,
    y: 400,
    width: 100,
    height: 30,
  });

  const firstResultAt = overlay.patches.indexOf(shown[0]);
  const clearedAt = overlay.patches.findIndex(
    (patch, index) => index > firstResultAt && patch.result === null,
  );
  const secondResultAt = overlay.patches.indexOf(shown[1]);
  assert.ok(clearedAt > firstResultAt && secondResultAt > clearedAt);
  assert.ok(clock.waits.includes(TIMING.resultSwitchMs));
  assert.equal(clock.waits.filter((wait) => wait === TIMING.resultViewMs).length, 2);
});

test("throws when the target cannot be measured in viewport coordinates", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await assert.rejects(
    () =>
      driver.click({
        locator: page.unmeasurableLocator,
        result: {
          name: "x",
          expected: "y",
          locator: page.locator({ x: 0, y: 0, width: 10, height: 10 }),
        },
      }),
    /iframe elements/,
  );
});

test("each driver runs exactly one step", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await driver.hover({
    locator: page.locator({ x: 100, y: 200, width: 100, height: 30 }),
    result: {
      name: "row",
      expected: "hovered",
      locator: page.locator({ x: 100, y: 200, width: 100, height: 30 }),
    },
  });
  await assert.rejects(
    () =>
      driver.hover({
        locator: page.locator({ x: 100, y: 200, width: 100, height: 30 }),
        result: {
          name: "row",
          expected: "hovered",
          locator: page.locator({ x: 100, y: 200, width: 100, height: 30 }),
        },
      }),
    /one driver per step video/,
  );
});

test("requires a target locator and at least one result", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  await assert.rejects(
    () =>
      driver.click({
        result: {
          name: "x",
          expected: "y",
          locator: page.locator({ x: 0, y: 0, width: 10, height: 10 }),
        },
      }),
    /target locator/,
  );
  await assert.rejects(
    () =>
      driver.click({
        locator: page.locator({ x: 0, y: 0, width: 10, height: 10 }),
      }),
    /at least one result/,
  );
  await assert.rejects(
    () =>
      driver.click({
        locator: page.locator({ x: 0, y: 0, width: 10, height: 10 }),
        result: { name: "x", expected: "y" },
      }),
    /requires a locator/,
  );
  await assert.rejects(
    () =>
      driver.click({
        locator: page.locator({ x: 0, y: 0, width: 10, height: 10 }),
        result: {
          name: "x",
          locator: page.locator({ x: 0, y: 0, width: 10, height: 10 }),
        },
      }),
    /name and expected/,
  );
});

test("drag approaches from the margin, holds a pressed circle through the straight move and checks at up", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const driver = await driverFor(clock, page, overlay);
  const source = page.locator({ x: 100, y: 200, width: 100, height: 40 });
  const target = page.locator({ x: 500, y: 300, width: 100, height: 40 });
  await driver.drag({
    source,
    target,
    result: { locator: target, name: "row", expected: "moved" },
  });
  const pointers = overlay.patches
    .filter((patch) => patch.pointer)
    .map((patch) => patch.pointer);
  assert.equal(pointers.length, 4);
  assert.deepEqual(pointers[0].move.from, { x: 24, y: 88 });
  assert.deepEqual(pointers[2].move.from, { x: 150, y: 220 });
  assert.equal(pointers[2].pressed, true);
  assert.equal(pointers[3].released, true);
  assert.equal(
    pointers.some((pointer) => pointer.click),
    false,
  );
  const down = page.calls.events.find((event) => event.kind === "down");
  const up = page.calls.events.find((event) => event.kind === "up");
  assert.equal(down.at - pointers[0].at, 800);
  assert.equal(up.at - down.at, 800);
  const heldMoves = page.calls.events.filter((event) => event.kind === "move" && event.pressed);
  assert.ok(heldMoves.length > 3);
  assert.ok(
    heldMoves.every((event) => Math.abs((event.x - 150) / 400 - (event.y - 220) / 100) < 1e-9),
  );
  assert.equal(
    overlay.patches.find((patch) => patch.phase === "checking").checkAt,
    pointers[3].at,
  );
  assert.deepEqual(page.calls.mouseMoves.at(-1), { x: 550, y: 320 });
});

test("drag failure releases pressed input and preserves the original error even if cleanup fails", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  const inspect = overlay.inspect;
  const original = new Error("drag movement failed");
  overlay.inspect = async () => {
    if (page.calls.downs) throw original;
    return inspect();
  };
  page.mouse.up = async () => {
    page.calls.ups++;
    throw new Error("cleanup failed");
  };
  const driver = await driverFor(clock, page, overlay);
  const locator = page.locator({ x: 100, y: 200, width: 100, height: 40 });
  await assert.rejects(
    driver.drag({
      source: locator,
      target: locator,
      result: { locator, name: "row", expected: "moved" },
    }),
    (error) => error === original,
  );
  assert.equal(page.calls.ups, 1);
  assert.equal(overlay.patches.at(-1).pointer, null);
});

test("all pointer operations approach from the scaled margin without per-frame overlay updates", async () => {
  for (const kind of ["hover", "press", "scroll"]) {
    const clock = fakeClock();
    const page = fakePage(clock);
    const overlay = fakeOverlay(clock);
    const driver = await driverFor(clock, page, overlay, {
      pageArea: { x: 12, y: 90, width: 2560, height: 1440 },
    });
    const locator = page.locator({ x: 100, y: 200, width: 100, height: 40 });
    await driver[kind]({
      locator,
      key: "Enter",
      deltaY: 400,
      result: { locator, name: "row", expected: "changed" },
    });
    assert.deepEqual(page.calls.mouseMoves[0], { x: 60, y: 138 });
    assert.ok(page.calls.mouseMoves.length > 3);
    assert.equal(overlay.patches.filter((patch) => patch.pointer).length, 1);
    assert.ok(clock.waits.includes(400));
  }
});

test("pointer timing stays fixed and targets from another document are rejected", async () => {
  const clock = fakeClock();
  const page = fakePage(clock);
  const overlay = fakeOverlay(clock);
  await assert.rejects(driverFor(clock, page, overlay, { timing: { moveMs: 0 } }), /400ms/);
  const driver = await driverFor(clock, page, overlay);
  const locator = page.locator({ x: 100, y: 200, width: 100, height: 40 });
  locator.evaluate = async () => false;
  await assert.rejects(
    driver.drag({
      source: locator,
      target: locator,
      result: { locator, name: "row", expected: "changed" },
    }),
    /same main document/,
  );
  assert.equal(page.calls.downs, 0);
});
