/**
 * CSS for openui-lang previews. Tokens and component rules mirror the OpenUI
 * design system (light palette) so previews match the React library's look.
 * Everything is inline in one <style> block: htmlshot forbids external refs.
 */

export const OPUI_STYLES = `
:root {
  --opui-background: oklch(0.97 0 89.876 / 1);
  --opui-sunk: oklch(0.097 0 0 / 0.04);
  --opui-info-background: oklch(0.623 0.188 259.815 / 0.12);
  --opui-success-background: oklch(0.627 0.17 149.214 / 0.12);
  --opui-alert-background: oklch(0.795 0.162 86.047 / 0.16);
  --opui-danger-background: oklch(0.577 0.215 27.325 / 0.12);
  --opui-text-neutral-primary: oklch(0.097 0 0 / 1);
  --opui-text-neutral-secondary: oklch(0.097 0 0 / 0.5);
  --opui-text-success-primary: oklch(0.448 0.108 151.328 / 1);
  --opui-text-alert-primary: oklch(0.476 0.103 61.907 / 1);
  --opui-text-danger-primary: oklch(0.505 0.19 27.518 / 1);
  --opui-text-info-primary: oklch(0.424 0.181 265.638 / 1);
  --opui-border-default: oklch(0.097 0 0 / 0.06);
  --opui-border-selected: oklch(0.097 0 0 / 1);
  --opui-border-info: oklch(0.546 0.215 262.881 / 1);
  --opui-border-alert: oklch(0.681 0.142 75.834 / 1);
  --opui-border-success: oklch(0.627 0.17 149.214 / 1);
  --opui-border-danger: oklch(0.577 0.215 27.325 / 1);
  --opui-space-2xs: 4px;
  --opui-space-3xs: 2px;
  --opui-space-xs: 6px;
  --opui-space-s: 8px;
  --opui-space-m: 12px;
  --opui-space-l: 18px;
  --opui-space-xl: 24px;
  --opui-radius-s: 6px;
  --opui-radius-m: 8px;
  --opui-radius-2xl: 14px;
  --opui-radius-3xl: 16px;
  --opui-font-body: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --opui-font-code: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--opui-background);
  color: var(--opui-text-neutral-primary);
  font: 400 16px/1.5 var(--opui-font-body);
  letter-spacing: 0;
}
.opui-root {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--opui-space-xl) var(--opui-space-l);
}

.opui-stack { display: flex; min-width: 0; }

.opui-card {
  display: flex;
  min-width: 0;
  flex: 1;
  color: var(--opui-text-neutral-primary);
}
.opui-card--sunk {
  padding: var(--opui-space-l);
  border-radius: var(--opui-radius-3xl);
  background: var(--opui-sunk);
  border: 1px solid var(--opui-border-default);
}
.opui-card--clear { padding: 0 var(--opui-space-l); }

.opui-header {
  display: flex;
  flex-direction: column;
  gap: var(--opui-space-xs);
  margin-bottom: var(--opui-space-2xs);
  overflow-wrap: break-word;
}
.opui-header-top-left {
  color: var(--opui-text-neutral-primary);
  font: 600 18px/1.25 var(--opui-font-body);
}
.opui-header-bottom {
  color: var(--opui-text-neutral-secondary);
  font: 400 16px/1.5 var(--opui-font-body);
}

.opui-separator { background: var(--opui-border-default); }
.opui-separator--horizontal { height: 1px; width: 100%; }
.opui-separator--vertical { width: 1px; align-self: stretch; }

.opui-inline-header {
  display: flex;
  flex-direction: column;
  gap: var(--opui-space-3xs);
  align-items: flex-start;
}
.opui-inline-header-heading {
  color: var(--opui-text-neutral-primary);
  font: 500 16px/1.5 var(--opui-font-body);
}
.opui-inline-header-description {
  color: var(--opui-text-neutral-secondary);
  font: 400 16px/1.5 var(--opui-font-body);
}

.opui-text-content { color: var(--opui-text-neutral-primary); }
.opui-text-content--small { font-size: 14px; }
.opui-text-content--large { font-size: 18px; }
.opui-text-content--small-heavy { font-size: 14px; font-weight: 500; }
.opui-text-content--large-heavy { font-size: 18px; font-weight: 500; }
.opui-text-content p { margin: 0 0 var(--opui-space-s); }
.opui-text-content p:last-child { margin-bottom: 0; }

.opui-text-block {
  display: flex;
  flex-direction: column;
  gap: var(--opui-space-3xs);
  align-items: flex-start;
  text-align: left;
}
.opui-text-block__primary { color: var(--opui-text-neutral-primary); }
.opui-text-block__secondary { color: var(--opui-text-neutral-secondary); font-size: 14px; }
.opui-text-block__secondary--positive { color: var(--opui-text-success-primary); }
.opui-text-block__secondary--negative { color: var(--opui-text-danger-primary); }
.opui-text-block--heavy .opui-text-block__primary { font-weight: 500; }
.opui-text-block--tight { gap: 0; }
.opui-numbers { font-variant-numeric: tabular-nums; }
.opui-text-size--xs { font-size: 12px; }
.opui-text-size--sm { font-size: 14px; }
.opui-text-size--md { font-size: 16px; }
.opui-text-size--lg { font-size: 18px; }
.opui-text-block code {
  font: 400 0.9em var(--opui-font-code);
  background: var(--opui-sunk);
  border-radius: 4px;
  padding: 1px 4px;
}
.opui-text-content code {
  font: 400 0.9em var(--opui-font-code);
  background: var(--opui-sunk);
  border-radius: 4px;
  padding: 1px 4px;
}
.opui-inline-header-heading code,
.opui-inline-header-description code,
.opui-callout-title code,
.opui-callout-description code,
.opui-text-callout-title code,
.opui-text-callout-description code {
  font: 400 0.9em var(--opui-font-code);
  background: var(--opui-sunk);
  border-radius: 4px;
  padding: 1px 4px;
}

.opui-code-block {
  background: var(--opui-sunk);
  border: 1px solid var(--opui-border-default);
  border-radius: var(--opui-radius-m);
  overflow: hidden;
}
.opui-code-block-lang {
  padding: var(--opui-space-xs) var(--opui-space-m);
  color: var(--opui-text-neutral-secondary);
  font: 400 12px/1.5 var(--opui-font-code);
  border-bottom: 1px solid var(--opui-border-default);
}
.opui-code-block pre {
  margin: 0;
  padding: var(--opui-space-m);
  overflow-x: auto;
  color: var(--opui-text-neutral-primary);
  font: 400 14px/1.5 var(--opui-font-code);
}

.opui-callout {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 0 14px;
  border-left: 2px solid;
}
.opui-callout--info { border-color: var(--opui-border-info); }
.opui-callout--info .opui-callout-title { color: var(--opui-text-info-primary); }
.opui-callout--warning { border-color: var(--opui-border-alert); }
.opui-callout--warning .opui-callout-title { color: var(--opui-text-alert-primary); }
.opui-callout--success { border-color: var(--opui-border-success); }
.opui-callout--success .opui-callout-title { color: var(--opui-text-success-primary); }
.opui-callout--neutral { border-color: var(--opui-border-selected); }
.opui-callout--neutral .opui-callout-title { color: var(--opui-text-neutral-primary); }
.opui-callout-title { font: 500 16px/1.5 var(--opui-font-body); }
.opui-callout-description {
  font: 400 16px/1.5 var(--opui-font-body);
  color: var(--opui-text-neutral-primary);
}

.opui-text-callout {
  width: 100%;
  display: flex;
  flex-direction: row;
  gap: var(--opui-space-xs);
  padding: 0 16px;
  border-left: 2px solid;
}
.opui-text-callout--neutral { border-color: var(--opui-border-selected); color: var(--opui-text-neutral-primary); }
.opui-text-callout--info { border-color: var(--opui-border-info); color: var(--opui-text-info-primary); }
.opui-text-callout--warning { border-color: var(--opui-border-alert); color: var(--opui-text-alert-primary); }
.opui-text-callout--success { border-color: var(--opui-border-success); color: var(--opui-text-success-primary); }
.opui-text-callout--danger { border-color: var(--opui-border-danger); color: var(--opui-text-danger-primary); }
.opui-text-callout-content { display: flex; flex-direction: column; }
.opui-text-callout-title { font: 500 16px/1.5 var(--opui-font-body); }
.opui-text-callout-description {
  font: 400 16px/1.5 var(--opui-font-body);
  color: var(--opui-text-neutral-primary);
}

.opui-list-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  gap: var(--opui-space-l);
}
.opui-list-block--small { gap: var(--opui-space-m); }
.opui-list-item {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--opui-space-m);
}
.opui-list-item:has(.opui-list-item-subtitle) { align-items: center; }
.opui-list-block--small .opui-list-item { gap: 10px; }
.opui-list-item-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  background: var(--opui-sunk);
  border-radius: var(--opui-radius-s);
  color: var(--opui-text-neutral-secondary);
  font: 400 16px/1.25 var(--opui-font-body);
}
.opui-list-item-indicator--with-subtitle { width: 40px; height: 40px; border-radius: var(--opui-radius-m); }
.opui-list-block--small .opui-list-item-indicator--with-subtitle { width: 36px; height: 36px; }
.opui-list-block--small .opui-list-item-indicator { width: 20px; height: 20px; font-size: 14px; }
.opui-list-item-content { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.opui-list-item-title { color: var(--opui-text-neutral-primary); font: 400 16px/1.5 var(--opui-font-body); }
.opui-list-item-subtitle { color: var(--opui-text-neutral-secondary); font: 400 16px/1.5 var(--opui-font-body); }
.opui-list-block--small .opui-list-item-title,
.opui-list-block--small .opui-list-item-subtitle { font-size: 14px; }

.opui-entity-list { display: flex; flex-direction: column; width: 100%; }
.opui-entity-list__row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--opui-space-m);
  padding: var(--opui-space-m) 0;
  border-bottom: 1px solid var(--opui-border-default);
  color: var(--opui-text-neutral-primary);
}
.opui-entity-list__row:last-child { border-bottom: none; }
.opui-entity-list__cell-left,
.opui-entity-list__cell-right { flex: 1; min-width: 0; max-width: 50%; overflow-wrap: break-word; }
.opui-entity-list__cell-right { text-align: right; font-weight: 500; }
.opui-entity-list__row--header .opui-entity-list__cell-left,
.opui-entity-list__row--header .opui-entity-list__cell-right { color: var(--opui-text-neutral-secondary); font-weight: 400; }
.opui-entity-list__cell-right--number { font-variant-numeric: tabular-nums; }
.opui-entity-list__row--footer .opui-entity-list__cell-right { font: 500 18px/1.5 var(--opui-font-body); }
.opui-entity-list--small .opui-entity-list__cell-left { font-size: 14px; }
.opui-entity-list--small .opui-entity-list__cell-right { font-size: 14px; }

.opui-table-container {
  width: 100%;
  overflow: auto;
  border: 1px solid var(--opui-border-default);
  border-radius: var(--opui-radius-2xl);
}
.opui-table {
  font: 400 14px/1.5 var(--opui-font-body);
  width: 100%;
  border-collapse: collapse;
}
.opui-table-head,
.opui-table-cell { padding: var(--opui-space-m); color: var(--opui-text-neutral-primary); }
.opui-table-head {
  border-bottom: 1px solid var(--opui-border-default);
  color: var(--opui-text-neutral-secondary);
  text-align: left;
}
.opui-table-row { border-bottom: 1px solid var(--opui-border-default); }
.opui-table-row:last-child { border-bottom: 0; }
.opui-table-row:nth-child(even) { background: oklch(0.097 0 0 / 0.02); }
.opui-table-cell { white-space: nowrap; }

.opui-tag-block { display: flex; flex-wrap: wrap; gap: var(--opui-space-s); max-width: 100%; }
.opui-tag {
  display: flex;
  align-items: center;
  overflow: hidden;
  max-width: 100%;
  gap: var(--opui-space-2xs);
  font: 400 14px/1.25 var(--opui-font-body);
  box-sizing: border-box;
}
.opui-tag--sm { padding: var(--opui-space-2xs) var(--opui-space-xs); border-radius: var(--opui-radius-s); height: 24px; }
.opui-tag--md { padding: var(--opui-space-xs) var(--opui-space-s); border-radius: var(--opui-radius-s); height: 32px; }
.opui-tag--lg { padding: var(--opui-space-s) var(--opui-space-m); border-radius: var(--opui-radius-m); height: 36px; }
.opui-tag--neutral { background: var(--opui-sunk); color: var(--opui-text-neutral-primary); }
.opui-tag--info { background: var(--opui-info-background); color: var(--opui-text-info-primary); }
.opui-tag--success { background: var(--opui-success-background); color: var(--opui-text-success-primary); }
.opui-tag--warning { background: var(--opui-alert-background); color: var(--opui-text-alert-primary); }
.opui-tag--danger { background: var(--opui-danger-background); color: var(--opui-text-danger-primary); }
.opui-tag-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
`;
