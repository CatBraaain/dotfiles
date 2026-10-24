/**
 * openui-lang → HTML renderer for previews.
 *
 * Parses a fenced openui-lang program with @openuidev/lang-core and emits one
 * self-contained HTML document (tokens + component styles inline, no scripts
 * and no external references, per htmlshot's constraints). Only a lightweight
 * display component set is supported; anything else is rejected so the caller
 * can show a guidance card instead of a broken render.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createParser,
  isASTNode,
  type ElementNode,
  type LibrarySpec,
  type Parser,
} from "@openuidev/lang-core";
import { OPUI_STYLES } from "./styles";

export const SUPPORTED_COMPONENTS = [
  "Stack",
  "Card",
  "CardHeader",
  "Separator",
  "InlineHeader",
  "TextContent",
  "Text",
  "BoldText",
  "CodeBlock",
  "Callout",
  "TextCallout",
  "ListBlock",
  "ListItem",
  "EntityList",
  "Table",
  "Col",
  "TagBlock",
  "Tag",
] as const;

const SUPPORTED = new Set<string>(SUPPORTED_COMPONENTS);

/** Matches the React Table's first page size; previews render page 1 only. */
const TABLE_PAGE_SIZE = 10;

export type OpuiRenderResult = { ok: true; html: string } | { ok: false; error: string };

const parserCache = new Map<string, Parser>();

function getParser(dir: string): Parser {
  let parser = parserCache.get(dir);
  if (parser === undefined) {
    const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as LibrarySpec;
    if (spec.schema === undefined) {
      throw new Error("spec.json has no library schema");
    }
    parser = createParser(spec.schema, spec.root);
    parserCache.set(dir, parser);
  }
  return parser;
}

function isElementNode(value: unknown): value is ElementNode {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "element"
  );
}

function elementChildren(node: ElementNode): ElementNode[] {
  const children = node.props.children;
  return Array.isArray(children) ? children.filter(isElementNode) : [];
}

function eachElementProp(node: ElementNode, visit: (element: ElementNode) => void): void {
  const walk = (value: unknown): void => {
    if (isElementNode(value)) {
      visit(value);
      Object.values(value.props).forEach(walk);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(walk);
    }
  };
  Object.values(node.props).forEach(walk);
}

function containsDynamicProps(node: ElementNode): boolean {
  let dynamic = false;
  eachElementProp(node, (element) => {
    if (dynamic || element.hasDynamicProps === true) {
      dynamic = true;
    }
  });
  if (dynamic) return true;
  let found = false;
  const walk = (value: unknown): void => {
    if (found) return;
    if (isASTNode(value)) {
      found = true;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(walk);
    }
  };
  Object.values(node.props).forEach(walk);
  return found;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Minimal inline markdown for display text: bold, italic, and inline code.
 * Paragraphs (blank-line separated) become <p> blocks; single newlines
 * become <br>. Links degrade to their text (hrefs would trip htmlshot's
 * external-reference check).
 */
export function inlineMarkdown(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  return paragraphs
    .map((paragraph) => {
      const withBreaks = escapeHtml(paragraph).replaceAll("\n", "<br>");
      return `<p>${styledSpan(withBreaks)}</p>`;
    })
    .join("");
}

function styledSpan(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

const GAP: Record<string, string> = {
  none: "0",
  xs: "6px",
  s: "8px",
  m: "12px",
  l: "18px",
  xl: "24px",
  "2xl": "36px",
};
const ALIGN: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};
const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

interface FlexProps {
  direction?: string;
  gap?: string;
  align?: string;
  justify?: string;
  wrap?: boolean;
}

function flexStyle(
  props: FlexProps,
  defaults: { gap?: string; align?: string; justify?: string; cardSizing?: boolean } = {},
): string {
  const entries = [
    ["flex-direction", props.direction ?? "column"],
    ["flex-wrap", props.wrap ? "wrap" : "nowrap"],
    ["gap", GAP[props.gap ?? ""] ?? defaults.gap ?? GAP.m],
    ["align-items", ALIGN[props.align ?? ""] ?? defaults.align],
    ["justify-content", JUSTIFY[props.justify ?? ""] ?? defaults.justify],
    ...(defaults.cardSizing
      ? ([
          ["flex", "1"],
          ["min-width", "0"],
        ] as const)
      : []),
  ];
  return entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

function propString(node: ElementNode, key: string): string | undefined {
  const value = node.props[key];
  return typeof value === "string" ? value : undefined;
}

function renderChildren(node: ElementNode): string {
  return elementChildren(node).map(renderNode).join("");
}

function renderStack(node: ElementNode): string {
  return `<div class="opui-stack" style="${flexStyle(node.props as FlexProps)}">${renderChildren(node)}</div>`;
}

function renderCard(node: ElementNode): string {
  const variant = propString(node, "variant") ?? "card";
  const style = flexStyle(node.props as FlexProps, {
    align: ALIGN.stretch,
    justify: JUSTIFY.start,
    cardSizing: true,
  });
  return `<div class="opui-card opui-card--${escapeHtml(variant)}" style="${style}">${renderChildren(node)}</div>`;
}

function renderCardHeader(node: ElementNode): string {
  const title = propString(node, "title");
  const subtitle = propString(node, "subtitle");
  const top = title ? `<div class="opui-header-top-left">${inlineMarkdown(title)}</div>` : "";
  const bottom = subtitle
    ? `<div class="opui-header-bottom">${inlineMarkdown(subtitle)}</div>`
    : "";
  if (!top && !bottom) return "";
  return `<div class="opui-header"><div class="opui-header-top">${top}</div>${bottom}</div>`;
}

function renderSeparator(node: ElementNode): string {
  const orientation = propString(node, "orientation") === "vertical" ? "vertical" : "horizontal";
  return `<div class="opui-separator opui-separator--${orientation}"></div>`;
}

function renderInlineHeader(node: ElementNode): string {
  const heading = propString(node, "heading");
  const description = propString(node, "description");
  if (!heading && !description) return "";
  const headingHtml = heading
    ? `<div class="opui-inline-header-heading">${inlineMarkdown(heading)}</div>`
    : "";
  const descriptionHtml = description
    ? `<div class="opui-inline-header-description">${inlineMarkdown(description)}</div>`
    : "";
  return `<div class="opui-inline-header">${headingHtml}${descriptionHtml}</div>`;
}

function renderTextContent(node: ElementNode): string {
  const text = propString(node, "text") ?? "";
  const size = propString(node, "size") ?? "default";
  const sizeClass = size === "default" ? "" : ` opui-text-content--${escapeHtml(size)}`;
  return `<div class="opui-text-content${sizeClass}">${inlineMarkdown(text)}</div>`;
}

const TEXT_SIZES = new Set(["xs", "sm", "md", "lg"]);

function textBlock(
  node: ElementNode,
  options: { heavy: boolean },
): string {
  const value = propString(node, "value") ?? "";
  const subtext = propString(node, "subtext");
  const variant = propString(node, "variant") === "number" ? "number" : "text";
  const subtextVariant = propString(node, "subtextVariant") ?? "text";
  const size = propString(node, "size") ?? "sm";
  const sizeClass = TEXT_SIZES.has(size) ? ` opui-text-size--${size}` : "";
  const classes = [
    "opui-text-block",
    options.heavy ? "opui-text-block--heavy" : "",
    options.heavy && subtext ? "opui-text-block--tight" : "",
    variant === "number" ? "opui-numbers" : "",
    sizeClass,
  ]
    .filter(Boolean)
    .join(" ");
  const metricTone =
    subtextVariant === "metric" && subtext
      ? subtext.startsWith("+")
        ? " opui-text-block__secondary--positive"
        : subtext.startsWith("-")
          ? " opui-text-block__secondary--negative"
          : ""
      : "";
  const subtextHtml = subtext
    ? `<div class="opui-text-block__secondary${metricTone}">${escapeHtml(subtext)}</div>`
    : "";
  return `<div class="${classes}"><div class="opui-text-block__primary">${escapeHtml(value)}</div>${subtextHtml}</div>`;
}

function renderText(node: ElementNode): string {
  return textBlock(node, { heavy: false });
}

function renderBoldText(node: ElementNode): string {
  return textBlock(node, { heavy: true });
}

function renderCodeBlock(node: ElementNode): string {
  const language = propString(node, "language") ?? "";
  const code = propString(node, "codeString") ?? "";
  return `<div class="opui-code-block"><div class="opui-code-block-lang">${escapeHtml(language)}</div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

const CALLOUT_VARIANTS: Record<string, string> = {
  info: "info",
  warning: "warning",
  error: "warning",
  success: "success",
  neutral: "neutral",
};

function renderCallout(node: ElementNode): string {
  const variant = CALLOUT_VARIANTS[propString(node, "variant") ?? ""] ?? "info";
  const title = propString(node, "title") ?? "";
  const description = propString(node, "description") ?? "";
  return `<div class="opui-callout opui-callout--${variant}"><div class="opui-callout-title">${inlineMarkdown(title)}</div><div class="opui-callout-description">${inlineMarkdown(description)}</div></div>`;
}

const TEXT_CALLOUT_VARIANTS = new Set(["neutral", "info", "warning", "success", "danger"]);

function renderTextCallout(node: ElementNode): string {
  const variant = propString(node, "variant") ?? "neutral";
  const variantClass = TEXT_CALLOUT_VARIANTS.has(variant) ? variant : "neutral";
  const title = propString(node, "title");
  const description = propString(node, "description");
  if (!title && !description) return "";
  const titleHtml = title
    ? `<div class="opui-text-callout-title">${inlineMarkdown(title)}</div>`
    : "";
  const descriptionHtml = description
    ? `<div class="opui-text-callout-description">${inlineMarkdown(description)}</div>`
    : "";
  return `<div class="opui-text-callout opui-text-callout--${variantClass}"><div class="opui-text-callout-content">${titleHtml}${descriptionHtml}</div></div>`;
}

function listItems(node: ElementNode): ElementNode[] {
  const items = node.props.items;
  return Array.isArray(items) ? items.filter(isElementNode) : [];
}

function renderListBlock(node: ElementNode): string {
  const variant = propString(node, "variant") ?? "number";
  if (variant === "image") {
    throw new UnsupportedError("ListBlock image variant (external images cannot be previewed)");
  }
  const size = propString(node, "size") === "small" ? "small" : "default";
  const items = listItems(node);
  const hasSubtitle = items.some((item) => propString(item, "subtitle") !== undefined);
  const itemsHtml = items
    .map((item, index) => {
      const title = propString(item, "title") ?? "";
      const subtitle = propString(item, "subtitle");
      const indicatorClass = hasSubtitle ? " opui-list-item-indicator--with-subtitle" : "";
      const subtitleHtml = subtitle
        ? `<div class="opui-list-item-subtitle">${escapeHtml(subtitle)}</div>`
        : "";
      return `<div class="opui-list-item"><div class="opui-list-item-indicator${indicatorClass}">${index + 1}</div><div class="opui-list-item-content"><div class="opui-list-item-title">${inlineMarkdown(title)}</div>${subtitleHtml}</div></div>`;
    })
    .join("");
  return `<div class="opui-list-block${size === "small" ? " opui-list-block--small" : ""}">${itemsHtml}</div>`;
}

interface EntityRow {
  left?: string;
  right?: string;
  rightVariant?: string;
}

function asRows(value: unknown): EntityRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is EntityRow => typeof row === "object" && row !== null)
    : [];
}

function entityRow(row: EntityRow, classes: { row: string; right: string }): string {
  const number = row.rightVariant === "number";
  const rightClass = [classes.right, number ? "opui-entity-list__cell-right--number" : ""]
    .filter(Boolean)
    .join(" ");
  return `<div class="${classes.row}"><div class="opui-entity-list__cell-left">${escapeHtml(row.left ?? "")}</div><div class="${rightClass}">${escapeHtml(row.right ?? "")}</div></div>`;
}

function renderEntityList(node: ElementNode): string {
  const size = propString(node, "size") === "small" ? "small" : "default";
  const rows = asRows(node.props.rows);
  const header = node.props.header as EntityRow | undefined;
  const footer = node.props.footer as EntityRow | undefined;
  const headerHtml =
    size === "default" && typeof header === "object" && header !== null
      ? entityRow(header, {
          row: "opui-entity-list__row opui-entity-list__row--header",
          right: "opui-entity-list__cell-right",
        })
      : "";
  const footerHtml =
    size === "default" && typeof footer === "object" && footer !== null
      ? entityRow(footer, {
          row: "opui-entity-list__row opui-entity-list__row--footer",
          right: "opui-entity-list__cell-right",
        })
      : "";
  const rowsHtml = rows
    .map((row) =>
      entityRow(row, {
        row: "opui-entity-list__row",
        right: "opui-entity-list__cell-right",
      }),
    )
    .join("");
  return `<div class="opui-entity-list opui-entity-list--${size}">${headerHtml}${rowsHtml}${footerHtml}</div>`;
}

function renderCell(value: unknown): string {
  if (isElementNode(value)) return renderNode(value);
  return escapeHtml(String(value ?? ""));
}

function renderTable(node: ElementNode): string {
  const columns = Array.isArray(node.props.columns)
    ? node.props.columns.filter(isElementNode)
    : [];
  const colDefs = columns.map((column) => ({
    label: propString(column, "label") ?? "",
    data: Array.isArray(column.props.data) ? column.props.data : [],
  }));
  if (colDefs.length === 0) return "";
  const rowCount = Math.min(
    TABLE_PAGE_SIZE,
    Math.max(...colDefs.map((column) => column.data.length)),
  );
  const head = colDefs
    .map((column) => `<th class="opui-table-head">${escapeHtml(column.label)}</th>`)
    .join("");
  const body = Array.from({ length: rowCount }, (_, rowIndex) => {
    const cells = colDefs
      .map((column) => `<td class="opui-table-cell">${renderCell(column.data[rowIndex])}</td>`)
      .join("");
    return `<tr class="opui-table-row">${cells}</tr>`;
  }).join("");
  return `<div class="opui-table-container"><table class="opui-table"><thead><tr class="opui-table-row">${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const TAG_SIZES = new Set(["sm", "md", "lg"]);
const TAG_VARIANTS = new Set(["neutral", "info", "success", "warning", "danger"]);

function tagHtml(text: string, size: string | undefined, variant: string | undefined): string {
  const sizeClass = size && TAG_SIZES.has(size) ? size : "md";
  const variantClass = variant && TAG_VARIANTS.has(variant) ? variant : "neutral";
  return `<span class="opui-tag opui-tag--${sizeClass} opui-tag--${variantClass}"><span class="opui-tag-text">${escapeHtml(text)}</span></span>`;
}

function renderTagBlock(node: ElementNode): string {
  const tags = Array.isArray(node.props.tags)
    ? node.props.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const size = propString(node, "size");
  return `<div class="opui-tag-block">${tags.map((tag) => tagHtml(tag, size, undefined)).join("")}</div>`;
}

function renderTag(node: ElementNode): string {
  return tagHtml(
    propString(node, "text") ?? "",
    propString(node, "size"),
    propString(node, "variant"),
  );
}

class UnsupportedError extends Error {}

const RENDERERS: Record<string, (node: ElementNode) => string> = {
  Stack: renderStack,
  Card: renderCard,
  CardHeader: renderCardHeader,
  Separator: renderSeparator,
  InlineHeader: renderInlineHeader,
  TextContent: renderTextContent,
  Text: renderText,
  BoldText: renderBoldText,
  CodeBlock: renderCodeBlock,
  Callout: renderCallout,
  TextCallout: renderTextCallout,
  ListBlock: renderListBlock,
  ListItem: () => "",
  EntityList: renderEntityList,
  Table: renderTable,
  Col: () => "",
  TagBlock: renderTagBlock,
  Tag: renderTag,
};

function renderNode(node: ElementNode): string {
  const renderer = RENDERERS[node.typeName];
  if (renderer === undefined) {
    throw new UnsupportedError(node.typeName);
  }
  return renderer(node);
}

function buildDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${OPUI_STYLES}</style></head><body><div class="opui-root">${body}</div></body></html>`;
}

/**
 * Renders one complete openui-lang program to a self-contained HTML document.
 * Programs using unsupported components, reactive expressions, or queries are
 * rejected with a human-readable error for the guidance card.
 */
export function renderOpuiLang(source: string, dir: string = import.meta.dir): OpuiRenderResult {
  const parsed = getParser(dir).parse(source);

  if (parsed.root === null) {
    return { ok: false, error: "no renderable root statement found" };
  }
  if (parsed.meta.incomplete) {
    return { ok: false, error: "program is truncated (unclosed syntax)" };
  }
  const unknown = parsed.meta.errors.find((error) => error.code === "unknown-component");
  if (unknown) {
    return { ok: false, error: `component "${unknown.component}" is not in the display-only library` };
  }
  const validation = parsed.meta.errors[0];
  if (validation) {
    return { ok: false, error: validation.message };
  }
  if (parsed.queryStatements.length > 0 || parsed.mutationStatements.length > 0) {
    return { ok: false, error: "Query()/Mutation() have no data source in this preview" };
  }
  if (containsDynamicProps(parsed.root)) {
    return { ok: false, error: "reactive expressions ($variables, bindings) are not supported in this preview" };
  }

  const unsupported = new Set<string>();
  eachElementProp(parsed.root, (element) => {
    if (!SUPPORTED.has(element.typeName)) {
      unsupported.add(element.typeName);
    }
  });
  if (unsupported.size > 0) {
    return { ok: false, error: `preview does not support: ${[...unsupported].sort().join(", ")}` };
  }

  try {
    return { ok: true, html: buildDocument(renderNode(parsed.root)) };
  } catch (error) {
    if (error instanceof UnsupportedError) {
      return { ok: false, error: `preview does not support: ${error.message}` };
    }
    throw error;
  }
}
