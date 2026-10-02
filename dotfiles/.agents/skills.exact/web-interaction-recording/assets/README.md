# Recording annotation assets

Use these dependency-free assets from a recording case that already owns a Playwright Page. Playwright Test and Vitest with the Playwright library use the same Node entry point. The bundled `design.html` provides a self-contained visual gallery.

The current visual baseline remains the parent SKILL.md until the design-source candidates are approved. These HTML/CSS files are the design-source candidates, not a new palette.

## Design gallery

このディレクトリの `design.html` を `file:///absolute/assets/design.html` で開く。サーバーや生成処理は不要。

ギャラリーは、light/darkの各テーマで「操作前」「操作中」「確認待ち」「結果表示」を並べた8例を初期表示する。同じ状態の明暗ペアを見比べられる配置で、設定操作盤や生JSONを表示せず、スクロールして比較する。各例に「表示・非表示を再生」操作を置き、150msの出現と300msの消失を再生する。各例の「1:1で見る」で、外側の表示だけを縮小した状態から原寸へ切り替えられる。映像領域は1280×720のまま変わらない。補助例は折りたたんであり、表示値はデザイン検査用であって録画やテストの合格を示さない。ギャラリーの再生操作は録画を行わない。

補助例には入力帯・実キー・API代行・ラベルのみ・長文・8ステップ・配置制約・動きの低減・サイトCSSとの分離がある。配置制約は日本語で表示し、生JSONの読解を求めない。注釈の外側にある見出しと表示倍率だけがギャラリー専用。タイトル用の領域とページ寸法は見本用であり、録画対象の寸法を変更する指示ではない。

## Recording integration

Import `load-overlay.mjs` from the assets directory supplied by the caller; asset reads resolve relative to that module, not the working directory. No browser URL or runtime package is needed.

```js
import { loadRecordingOverlay } from "./assets/load-overlay.mjs";

const state = {
  title: "Checkout › delivery details",
  steps: [
    { name: "input name", action: "Input name", expected: "Name is preserved" },
    {
      name: "click confirm",
      action: "Click Confirm",
      expected: "Total === ¥3,300",
    },
  ],
  current: 1,
  phase: "waiting",
  theme: "light",
  pageArea: { x: 0, y: 112, width: 1280, height: 788 },
  titleArea: { x: 0, y: 0, width: 1280, height: 112 },
  target: {
    rect: await page.locator("#name").boundingBox(),
    name: "Delivery name",
    kind: "input",
  },
};

const overlay = await loadRecordingOverlay(page, state);
const layout = await overlay.painted();
if (layout.constraints.length)
  throw new Error(JSON.stringify(layout.constraints));

await overlay.update({ phase: "acting" });
// The recording case performs the operation and assertions.
const at = await page.evaluate(() => performance.now());
await overlay.update({ input: { text: "Sample", at } });
await overlay.update({ phase: "checking", result: null });
// The recording case waits for the required one-second confirmation interval.
await overlay.update({
  phase: "result",
  result: {
    rect: await page.locator("#total").boundingBox(),
    name: "Total",
    expected: "¥3,300",
  },
});
await overlay.setVisible(false);
// Screenshot comparison can run without annotation pixels.
await overlay.setVisible(true);
await overlay.dispose();
```

Check non-null bounding boxes before passing them. All rectangles use viewport coordinates in the document receiving the overlay, including the reserved title area. Translate frame-local coordinates in the caller. Keep the page/title areas fixed over a recording and reserve the maximum required title height before operations.

The case owns background acquisition and annotation-theme selection, real actions, waits, assertions, page/frame selection, state restoration, and video saving/conversion. The installer does not analyze backgrounds, perform actions, sleep, select a runner or indicate assertion success.

## State and methods

`OverlayState`, `Rect`, `Layout` and the other public shapes are documented as JSDoc types in `overlay.mjs`.

| Input | Meaning |
| --- | --- |
| `title`, `steps` | Describe hierarchy and a non-empty ordered list of `{ name, action, expected }`. Names remain unchanged across phases. |
| `current` | One-based step number. Past steps are complete; later steps are pending. |
| `phase` | `waiting`, `acting`, `checking` or `result`. Only `result` displays the supplied result frame. Keeping `result` with `result: null` represents the interval between result locations without undoing completion. |
| `theme` | Caller-selected `light` or `dark` annotation theme. A theme-only update preserves geometry and effect timestamps. |
| `pageArea`, `titleArea` | `{ x, y, width, height }` in viewport CSS pixels. The top title area is full-width and separate from the page area. |
| `target` | Optional `{ rect, name, kind }`; kind is `click`, `input`, `key`, `scroll`, `hover`, `drag` or `open`. |
| `result` | One optional `{ rect, name, expected }`. Replacement represents the next confirmation location. |
| `input` | Optional `{ text, at }` with the complete continuous string. Empty text keeps an empty line. Supply actual deletion values and selection operation names from the recording adapter. |
| `key` | Optional `{ name, at, api?, hold? }`; actual key/wheel name, or `api: true` for a substitute shown with the operation-guidance note. `hold: true` maintains an ongoing operation. |
| `pointer` | Optional `{ x, y, at, click? }` from the actual pointer event. Each move adds a stationary trail sample, each click adds a ripple. |
| `reducedMotion` | Boolean override for inspection; null/omitted follows the receiving document's media preference. |

`at` is the receiving document's `performance.now()` timeline in milliseconds. Forward actual event timestamps on that clock. Input/key updates default to a 600ms hold followed by a 300ms fade. Restoring visibility or first supplying a value during its fade draws the remaining opacity/scale on that original `at` timeline; it does not restart the hold or fade. At `at + 900ms` the value is removed, and its primary number returns to the next available annotation. Design examples can also hold an input with `hold: true`; recording adapters use actual updates instead. An immediate retype after a supplied Backspace deletion preserves the deletion display for at most 160ms. Keydown selection shortcuts and non-text inputs are interpreted by the recording adapter, not by a selector engine in the template.

| Method | Result |
| --- | --- |
| `loadRecordingOverlay(page, state)` | Replaces an installed overlay and returns a Node handle with `installed` layout diagnostics. Uses only `Page.evaluate`. |
| `update(patch)` | Shallow top-level patch; supplied nested objects are replaced. The browser API synchronously returns measured layout/constraints; the Node handle resolves that layout through Page.evaluate. Neither waits for entry or exit animations. Supply null to clear optional annotations. |
| `inspect()` | Copies the latest layout; placements include full layout rectangles, not scale-transformed painted bounds. |
| `painted()` | Resolves after two browser animation frames and any in-progress pop-in/pop-out visibility animation present when called. It does not wait for spinner animation or the full input/key display lifetime. This is a rendering boundary, not proof of an MP4 frame or elapsed recording time. Rejects when disposed while pending. |
| `setVisible(boolean)` | Returns `Promise<void>` and waits for the finite animations captured by this request (normally 150ms show or 300ms hide, including any remaining input/key fade). A newer visibility request supersedes a pending one; the old request rejects with `AbortError` and never hides the newer request's host. Cancellation of a captured animation also rejects with `AbortError`; disposal rejects rather than reporting completion. Handle rejection when intentionally overlapping calls. The host remains alive while hidden, without intercepting input or changing site DOM. |
| `dispose()` | Immediately removes the host, media listener, pending paint callbacks and transient animation scheduler; repeated disposal is safe. |

The browser API is also available at `window.recordingOverlay`. It does not register pointer/input/keyboard listeners: the recording adapter forwards real values and events, so both runners and frame boundaries share one rendering contract.

A non-empty `constraints` array means the current composition is not recordable under the specified dimensions/protected targets. Each constraint includes the component, reason, measured rectangle, step/total, page area and complete relevant value. Impossible components remain full-sized for inspection; they are not silently clipped, shrunk or replaced by ellipses to claim success. The caller reports the constraint before recording that composition.

## Isolation and limitations

Styles use an adopted stylesheet inside Shadow DOM, with an inline-important reset on the non-focusable, inert host. The shared implementation supports strict CSP without injecting a network script into the target page. Annotation elements are aria-hidden and pointer-transparent. Visibility hiding does not preserve site-wide element counts; remove the overlay for those assertions.

Site JavaScript can still remove the host. Top-layer dialogs, root transforms/stacking contexts, non-Chromium engines and project-specific cross-origin frame policies require integration verification. This template does not assert universal compatibility. Navigation and new documents require caller-owned reinstall and state restoration.
