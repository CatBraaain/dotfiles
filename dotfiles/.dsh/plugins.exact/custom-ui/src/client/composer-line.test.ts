import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { COMPOSER_LINE_CSS } from "./composer-line.ts";

/**
 * Data-pinning tests for the one-line composer override sheet: every rule the
 * layout relies on must survive refactors of this plugin, and the pinned
 * `uV2eYG` hashes keep the sheet's targeting explicit. A dsh update that
 * rehashes InputBar.module.css changes nothing here — the sheet keeps the old
 * hashes and the layout silently reverts — so that case is caught by visual
 * review (dotfiles/.dsh/test), not by these tests.
 */
describe("COMPOSER_LINE_CSS", () => {
  it("moves the card's bottom breathing room onto the card", () => {
    assert.ok(
      COMPOSER_LINE_CSS.includes('[data-composer-card]{padding-bottom:6px}'),
    );
  });

  it("reserves the docked strip's width in the draft column", () => {
    assert.ok(
      COMPOSER_LINE_CSS.includes(
        '[data-composer-card]>[class*="uV2eYG_scroll"]{margin-right:88px}',
      ),
    );
  });

  it("docks the tool row into the card's bottom-right corner", () => {
    assert.ok(
      COMPOSER_LINE_CSS.includes(
        '[data-composer-card]>[class*="uV2eYG_row"]{position:absolute;right:8px;bottom:9px;' +
          "padding:0;container-type:normal}",
      ),
    );
  });

  it("drops the stock 2px send-circle shift the removed row pad fed", () => {
    assert.ok(
      COMPOSER_LINE_CSS.includes(
        '[data-composer-card] [class*="uV2eYG_primary"]{transform:none}',
      ),
    );
  });

  it("paints the trailing group in the card's own surface", () => {
    assert.ok(
      COMPOSER_LINE_CSS.includes(
        '[data-composer-card] [class*="uV2eYG_trailing"]{background:var(--dsw-specific-input-major)}',
      ),
    );
  });
});
