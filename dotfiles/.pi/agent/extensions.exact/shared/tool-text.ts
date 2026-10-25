export type ToolResultContent = { type: string; text?: string };

export type ToolResultLike = { content?: ToolResultContent[]; details?: unknown };

export const COMMAND_PREVIEW_LIMIT = 300;

export const ERROR_OUTPUT_PREVIEW_LIMIT = 2000;

const ERROR_OUTPUT_TRUNCATION_MARKER = "\n\n[Output truncated; showing the tail.]";

export function truncateText(text: string, limit = COMMAND_PREVIEW_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

export function truncateErrorOutput(text: string, limit = ERROR_OUTPUT_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text;

  const tailLength = Math.max(0, limit - ERROR_OUTPUT_TRUNCATION_MARKER.length);
  return `${text.slice(-tailLength)}${ERROR_OUTPUT_TRUNCATION_MARKER}`;
}

export function resultText(result: ToolResultLike): string {
  return result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}
