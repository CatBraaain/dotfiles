/**
 * Detection and display-only removal of ```openui-lang fenced code blocks.
 */

export interface OpuiLangBlock {
  /** Fence body without the opening and closing fence lines. */
  source: string;
  /** 1-based line number of the opening fence in the source text. */
  startLine: number;
  /** True when the fence was never closed. */
  unclosed: boolean;
}

const OPENING_FENCE = /^ {0,3}```openui-lang\b/;
const CLOSING_FENCE = /^ {0,3}```\s*$/;

interface ScanState {
  blocks: OpuiLangBlock[];
  /** Lines kept after removing openui-lang blocks; null while inside a block. */
  kept: (string | null)[];
}

function scan(text: string): ScanState {
  const lines = text.split("\n");
  const blocks: OpuiLangBlock[] = [];
  const kept: (string | null)[] = [];
  let current: { startLine: number; body: string[] } | null = null;

  for (const [index, line] of lines.entries()) {
    if (current === null) {
      if (OPENING_FENCE.test(line)) {
        current = { startLine: index + 1, body: [] };
        kept.push(null);
        continue;
      }
      kept.push(line);
      continue;
    }
    if (CLOSING_FENCE.test(line)) {
      blocks.push({
        source: current.body.join("\n"),
        startLine: current.startLine,
        unclosed: false,
      });
      current = null;
      kept.push(null);
      continue;
    }
    current.body.push(line);
    kept.push(null);
  }

  if (current !== null) {
    blocks.push({
      source: current.body.join("\n"),
      startLine: current.startLine,
      unclosed: true,
    });
  }

  return { blocks, kept };
}

/**
 * Extracts all ```openui-lang blocks from a text in document order.
 * Other language tags are ignored. An unterminated block is returned
 * with unclosed: true and the content collected so far.
 */
export function extractOpuiLangBlocks(text: string): OpuiLangBlock[] {
  return scan(text).blocks;
}

/**
 * Removes ```openui-lang blocks (closed or still streaming) from a text and
 * returns the remaining lines joined again. Only used for display; the
 * assistant message itself keeps the blocks for the LLM context.
 */
export function stripOpuiLangBlocks(text: string): string {
  return scan(text)
    .kept.filter((line): line is string => line !== null)
    .join("\n");
}
