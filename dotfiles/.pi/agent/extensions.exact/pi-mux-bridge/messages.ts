export const MESSAGE_OPTION_PREFIX = "@pi-mux-msg-";
export const MESSAGE_TEXT_MAX_CODE_POINTS = 2800;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type AgentMessage = { v: 1; id: string; from: string; at: string; text: string };
export type DecodedMessageOption = { name: string; message: AgentMessage };

export function messageOptions(output: string): { name: string; value: string }[] {
  return output
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf(" ");
      if (separator <= 0) return [];
      return [{ name: line.slice(0, separator), value: line.slice(separator + 1) }];
    })
    .filter((option) => option.name.startsWith(MESSAGE_OPTION_PREFIX));
}

export function decodeAgentMessage(value: string): AgentMessage | undefined {
  if (!BASE64_PATTERN.test(value)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v !== 1) return undefined;
  if (typeof envelope.id !== "string" || !UUID_PATTERN.test(envelope.id)) return undefined;
  if (typeof envelope.from !== "string" || envelope.from.trim() === "") return undefined;
  if (typeof envelope.at !== "string" || envelope.at.trim() === "") return undefined;
  if (typeof envelope.text !== "string" || envelope.text.trim() === "") return undefined;
  if ([...envelope.text].length > MESSAGE_TEXT_MAX_CODE_POINTS) return undefined;
  return { v: 1, id: envelope.id, from: envelope.from, at: envelope.at, text: envelope.text };
}

export function partitionMessageOptions(
  options: {
    name: string;
    value: string;
  }[],
): { valid: DecodedMessageOption[]; invalid: string[] } {
  const valid: DecodedMessageOption[] = [];
  const invalid: string[] = [];
  for (const option of options) {
    const message = decodeAgentMessage(option.value);
    if (message === undefined) invalid.push(option.name);
    else valid.push({ name: option.name, message });
  }
  return { valid: sortBySentAt(valid), invalid };
}

function sortBySentAt(entries: DecodedMessageOption[]): DecodedMessageOption[] {
  return [...entries].sort((a, b) =>
    a.message.at < b.message.at ? -1 : a.message.at > b.message.at ? 1 : 0,
  );
}
