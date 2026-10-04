# Recording annotation assets

Use these dependency-free assets from a recording case that already owns a Playwright Page. Playwright Test and Vitest with the Playwright library use the same Node entry point. The bundled `design.html` provides a self-contained visual gallery, and `recording-example.mjs` shows the external-title composition route.

The parent `SKILL.md` owns the visible specification. These files implement it; when the two disagree, follow `SKILL.md` and report the mismatch.

## Design gallery

このディレクトリの `design.html` を `file:///…/assets/design.html` で開く。サーバーや生成処理は不要。

ギャラリーは、明るいサイトと暗いサイトで「操作前 → 操作中 → 確認待ち → 結果表示」を並べた8例を初期表示する。設定操作盤や生JSONを表示せず、スクロールして比較する。各例に「表示・非表示を再生」操作があり、出現と消失のアニメーションを再生する。「1:1で見る」で外側の表示だけを縮小した状態から原寸へ切り替えられる。映像領域は1280×720のまま変わらない。

補助例（折りたたみ）には入力帯・実キー・API代行・anchorなし・長文・8ステップ・配置制約・動きの低減・サイトCSSとの分離・外タイトルのみ（title layer）がある。配置制約は日本語で表示し、生JSONの読解を求めない。注釈の外側にある見出しと表示倍率だけがギャラリー専用であり、ギャラリーの表示値はデザイン検査用であって録画やテストの合格を示さない。

`overlay.test.mjs` が、このギャラリーに埋め込んだ installer・HTML・CSSと `assets/` の実ファイルの同一性を機械検査する。実assetsを編集したら、`design.html` を生成し直してからテストを通すこと（ギャラリーの再生成手順は(skill リポジトリ外の)作業記録を参照）。

## Recording integration

Import `load-overlay.mjs` from the assets directory supplied by the caller; asset reads resolve relative to that module, not the working directory. No browser URL or runtime package is needed.

```js
import { loadRecordingOverlay } from "./assets/load-overlay.mjs";

const state = {
  title: "Checkout › delivery details",
  steps: [
    {
      name: "input name",
      action: "Type the delivery name",
      expected: "Name is preserved",
    },
    {
      name: "click confirm",
      action: "Click Confirm",
      expected: "Total === ¥3,300",
    },
  ],
  current: 1,
  phase: "waiting",
  theme: "light", // observed SITE theme; docks invert it automatically
  pageArea: { x: 0, y: 0, width: 1280, height: 720 },
  titleArea: { x: 0, y: 0, width: 1280, height: 64 },
  layer: "page", // page-only: the title band is composed externally
  taskAnchor: await page
    .locator("#name")
    .evaluate((node) => node.getBoundingClientRect().toJSON()),
  target: {
    rect: await page.locator("#name").boundingBox(),
    name: "Delivery name",
    kind: "input",
  },
};

const overlay = await loadRecordingOverlay(page, state);
const layout = overlay.installed;
if (layout.constraints.length)
  throw new Error(JSON.stringify(layout.constraints));

await overlay.update({ phase: "acting" });
// The recording case performs the real operation and assertions.
const at = await page.evaluate(() => performance.now());
await overlay.update({ input: { text: "Sample", at } });
await overlay.update({ phase: "checking" }); // the check fades in from this moment
// Wait the 1.2s confirmation interval, then show the result.
await overlay.update({
  phase: "result",
  target: null,
  result: {
    rect: await page.locator("#total").boundingBox(),
    name: "Total",
    expected: "¥3,300",
  },
});
// After the viewing time, clear the result.
await overlay.update({ result: null });
await overlay.setVisible(false);
// Screenshot comparison can run without annotation pixels.
await overlay.setVisible(true);
await overlay.dispose();
```

Check non-null bounding boxes before passing them. All rectangles use viewport coordinates in the document receiving the overlay, including the reserved title area. Translate frame-local coordinates in the caller. Keep the page/title areas fixed over a recording and reserve the maximum required title height before operations.

The case owns background observation and site-theme classification, real actions, waits, assertions, page/frame selection, state restoration, and video saving/conversion. The installer does not analyze backgrounds, perform actions, sleep, select a runner or indicate assertion success. Step progression across the scenario is owned by the generated viewer; the overlay renders only the current step's annotations.

## State and methods

`OverlayState`, `Rect`, `Layout` and the other public shapes are documented as JSDoc types in `overlay.mjs`.

| Input | Meaning |
| --- | --- |
| `title`, `steps` | Describe hierarchy and a non-empty ordered list of `{ name, action, expected }`. `action` (verb-first) is the task-label text; `name` is case-side identification. |
| `current` | One-based step number. |
| `phase` | `waiting`, `acting`, `checking` or `result`. The target frame shows outside `result`; the result frame and label show in `result` while `result` is non-null. |
| `theme` | The observed site theme, `light` or `dark`. Title, task label, frames and cursor follow it; the input band and key display invert it. |
| `layer` | `both` (default), `title` (title band only, for external composition) or `page` (page annotations only; the title area is a reservation and no title constraint is reported). |
| `pageArea`, `titleArea` | `{ x, y, width, height }` in viewport CSS pixels. The title area is full-width, non-overlapping and equal in width to the page area unless `layer` is `page`. |
| `taskAnchor` | Optional anchor rect for the task label. Defaults to the target rect, then the result rect, then the safe top edge of the page area. Supply a measured anchor that stays meaningful for the whole step (a row, a field, a panel). |
| `checkAt` | Optional document-clock ms when the current step's operation ended. Omit it on the natural `checking` transition; supply it when reinstalling mid-step so the 360ms check fade does not restart. `null` clears the check. |
| `target` | Optional `{ rect, name, kind }`; kind is `click`, `input`, `key`, `scroll`, `hover`, `drag` or `open`. The kind is data only; the adopted display has no per-kind captions. |
| `result` | One optional `{ rect, name, expected }` shown at a time. Replacement represents the next confirmation location; `result: null` keeps `phase: "result"` as the between-locations interval without undoing completion. |
| `input` | Optional `{ text, at, firstAt?, hold? }` with the complete continuous string. `at` is the latest update; `firstAt` (optional) pins the first appearance. Updates within a live session inherit the session's `firstAt` so typing never restarts the 200ms enter fade. |
| `key` | Optional `{ name, at, firstAt?, api?, hold? }`; actual key/wheel name, or `api: true` for a substitute shown with the operation-guidance note. |
| `pointer` | Optional `{ x, y, at, click? }` from the actual pointer event. Each move adds a stationary trail sample, each click adds a ripple. |
| `reducedMotion` | Boolean override for inspection; null/omitted follows the receiving document's media preference. |

`at`, `firstAt` and `checkAt` use the receiving document's `performance.now()` timeline in milliseconds. Forward actual event timestamps on that clock; on navigation the caller converts or rebuilds the clock.

Docks (input band, key display) run on a 200ms enter / 1200ms hold / 250ms exit schedule measured from `max(firstAt + enter, at)`. The input band is fixed at the bottom centre of the page area and grows upward; its width never shrinks inside one session. The key display tries the centre first, then the bottom centre, top centre, left and right. Under reduced motion the same timings apply with opacity-only transitions. An immediate retype after a supplied Backspace deletion preserves the deletion display for at most 160ms. At `exitEnd` the value is removed and `update`/`inspect` no longer report it.

| Method | Result |
| --- | --- |
| `loadRecordingOverlay(page, state)` | Replaces an installed overlay and returns a Node handle with `installed` layout diagnostics. Uses only `Page.evaluate`. |
| `update(patch)` | Shallow top-level patch; supplied nested objects are replaced. The browser API synchronously returns measured layout/constraints; the Node handle resolves that layout through Page.evaluate. Neither waits for entry or exit animations. Supply null to clear optional annotations. |
| `inspect()` | Copies the latest layout; placements include full layout rectangles, not scale-transformed painted bounds. |
| `painted()` | Resolves after two browser animation frames and any in-progress visibility animation present when called. Known issue: on some environments this can hang (see `~/.agents/tickets/dotfiles/20261002-235342.md`); budget it with a timeout, do not silently drop the await, and report a hang instead of working around it. |
| `setVisible(boolean)` | Returns `Promise<void>` and waits for the finite animations captured by this request. A newer visibility request supersedes a pending one; the old request rejects with `AbortError`. The host remains alive while hidden, without intercepting input or changing site DOM. |
| `dispose()` | Immediately removes the host, media listener, pending paint callbacks and transient animation scheduler; repeated disposal is safe. |

The browser API is also available at `window.recordingOverlay`. It does not register pointer/input/keyboard listeners: the recording adapter forwards real values and events, so both runners and frame boundaries share one rendering contract.

A non-empty `constraints` array means the current composition is not recordable under the specified dimensions/protected targets. Each constraint includes the component, reason, measured rectangle, step/total, page area and complete relevant value. Impossible components remain full-sized for inspection; they are not silently clipped, shrunk or replaced by ellipses to claim success. The caller reports the constraint before recording that composition.

## Migration from the previous template

- The title band shows only the test title; step progression across the scenario is owned by the generated viewer.
- `theme` now means the observed site theme, not the inverted annotation theme. A dark site takes `theme: "dark"`; the docks invert automatically.
- The step panel, the all-steps list, the rotating spinner/ring decorations and the per-kind target captions are gone. The task label above the anchor carries the number badge, the 360ms check fade and the step text.
- Step timing values moved to the adopted schedule (see the parent `SKILL.md`): explanation 1800ms, per-character 120ms, move 400ms + stop 250ms, confirmation 1200ms, per-result viewing 3000ms, result switch 500ms, next step 600ms.
- Reinstalls after navigation should pass `checkAt` (operation end) and dock `firstAt`/`at` values converted to the new document clock to avoid restarting fades mid-step.

## External title composition

Two supported layouts:

- In-viewport title (default `layer: "both"`): reserve `titleArea` above `pageArea` inside one viewport and let the standard page video carry both.
- External title (`layer: "page"` for the recorded page plus `layer: "title"` strips): `recording-example.mjs` accepts a runner-owned Page and an output directory, records `page.screencast` frames with timestamps, renders each distinct `(current, read)` title state as a 1280×64 PNG with the same installer, and composes one silent H.264 MP4 with `ffmpeg` (`vstack`, 60fps). Requirements: a Playwright build exposing `page.screencast` (1.64.0-alpha-1790635538000 is the recorded known-good build) and an `ffmpeg` executable on PATH or via `ffmpegPath`. Screencast timestamps and `Date.now()` share the Unix epoch on that build; pass `frameClockOffsetMs` when a runner uses a different clock. The example never navigates, selects or asserts — the scenario's `run` callback owns real operations, assertions and overlay updates, and receives a wrapped handle that records the title timeline.

Capture-precision limits (variable frame rate, ~60fps output not equal to the source cadence) are a known boundary; do not treat exact fade boundaries as acceptance criteria. See `~/.agents/tickets/dotfiles/20261003-205058.md`.

## Isolation and limitations

Styles use an adopted stylesheet inside Shadow DOM, with an inline-important reset on the non-focusable, inert host. The shared implementation supports strict CSP without injecting a network script into the target page. Annotation elements are aria-hidden and pointer-transparent. Visibility hiding does not preserve site-wide element counts; remove the overlay for those assertions.

Site JavaScript can still remove the host. Top-layer dialogs, root transforms/stacking contexts, non-Chromium engines and project-specific cross-origin frame policies require integration verification. This template does not assert universal compatibility. Navigation and new documents require caller-owned reinstall and state restoration.

## Viewer template

`viewer.html` is the dependency-free template for the step viewer saved as `recordings/index.html`. Replace the contents of `script#e2e-viewer-data` with the recording data as JSON and save the file next to the step videos. The JSON has the shape `{ title, steps: [{ number, action, expected, video }] }`; `video` paths are relative to `index.html`, and `number` follows the canonical step numbering in the project `SPEC.md`.

The viewer lists the steps (number, action, expected), moves to the previous or next step, and replays the current step. Selecting a step stops the previous video and starts the selected one; ended videos do not advance automatically. All texts are in English. Colors inherit the annotation tokens, and the viewer follows `prefers-color-scheme` for dark display. Opening the template without injected data shows a notice instead of the viewer; `viewer.test.mjs` checks the placeholder, the absence of external references and the required controls.
