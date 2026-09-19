/**
 * One-line composer: after custom-ui's deletions the stock tool row holds only
 * the context meter and the send/stop control, so dock it into the card's
 * bottom-right corner instead of spending a second row under the draft.
 * Selectors pin the dsh-v0.1.5-rc.2 InputBar.module.css hashes (`uV2eYG_*`),
 * same policy as HIDE_CSS: a dsh update that changes a hash reverts the row
 * to the stock place below the draft instead of misplacing it.
 */
export const COMPOSER_LINE_CSS = [
  // The docked row leaves the flow, so the card's bottom breathing room
  // (stock: the row's own padding) moves onto the card.
  "[data-composer-card]{padding-bottom:6px}",
  // Reserve the docked strip's width so draft lines wrap left of the buttons:
  // meter 28 + gap 12 + send 34 + row right inset 8 + 6px air.
  '[data-composer-card]>[class*="uV2eYG_scroll"]{margin-right:88px}',
  // Dock the row. container-type:normal undoes the stock inline-size
  // containment, whose zeroed intrinsic width would collapse the absolutely
  // positioned shrink-to-fit row; the only container queries it fed live in
  // controls this plugin already hides. bottom:9px centers the 34px send
  // circle on a single draft line (card: 8 top pad + 36 line + 6 bottom).
  '[data-composer-card]>[class*="uV2eYG_row"]{position:absolute;right:8px;bottom:9px;' +
    "padding:0;container-type:normal}",
  // Stock shifts the send circle up 2px to offset the row's top pad; the pad
  // is gone here, so keeping the shift would misalign it.
  '[data-composer-card] [class*="uV2eYG_primary"]{transform:none}',
  // A continuable subagent session grows the row past the reserved strip
  // (stop + send). Painting the trailing group in the card's own surface
  // keeps draft text reaching underneath from showing through the buttons.
  '[data-composer-card] [class*="uV2eYG_trailing"]{background:var(--dsw-specific-input-major)}',
].join("");
