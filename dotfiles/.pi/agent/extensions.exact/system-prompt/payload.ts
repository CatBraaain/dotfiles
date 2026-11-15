import { getCurrentSystemPrompt, type SystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

const RecordSchema = Type.Record(Type.String(), Type.Unknown());
const TextBlockSchema = Type.Object({
  text: Type.String(),
  type: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("input_text")])),
});
const ContentSchema = Type.Union([
  Type.String(),
  Type.Array(
    Type.Union([
      TextBlockSchema,
      Type.Object({ cachePoint: Type.Unknown() }, { additionalProperties: false }),
      Type.Object({
        type: Type.Union([Type.Literal("tool_addition"), Type.Literal("tool_removal")]),
        tool: Type.Unknown(),
      }),
    ]),
  ),
]);
const SystemMessageSchema = Type.Object({
  role: Type.Literal("system"),
  content: Type.Union([
    Type.String(),
    Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
  ]),
  sections: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
});

export function promptFromPayload(payload: unknown): string | undefined {
  if (!Value.Check(RecordSchema, payload)) return undefined;
  if ("context" in payload) return promptFromContext(payload.context);

  if ("config" in payload || "contents" in payload) {
    if (!Array.isArray(payload.contents)) return undefined;
    if (payload.config === undefined) return "";
    if (!Value.Check(RecordSchema, payload.config)) return undefined;
    const instruction = payload.config.systemInstruction;
    const parts =
      Value.Check(RecordSchema, instruction) && "parts" in instruction
        ? instruction.parts
        : instruction;
    return joinText(readContent(parts));
  }

  if ("instructions" in payload || "input" in payload) {
    const instructions = readContent(payload.instructions);
    const messages = typeof payload.input === "string" ? [] : readMessages(payload.input);
    return combineText(instructions, messages);
  }

  if ("system" in payload || "messages" in payload) {
    return combineText(readContent(payload.system), readMessages(payload.messages));
  }
  return undefined;
}

function readContent(content: unknown): string[] | undefined {
  if (content === undefined) return [];
  if (!Value.Check(ContentSchema, content)) return undefined;
  if (typeof content === "string") return [content];
  return content.flatMap((block) => (Value.Check(TextBlockSchema, block) ? [block.text] : []));
}

function readMessages(messages: unknown): string[] | undefined {
  if (messages === undefined) return [];
  if (!Array.isArray(messages)) return undefined;
  const parts: string[] = [];
  for (const message of messages) {
    if (!Value.Check(RecordSchema, message)) return undefined;
    if (message.role !== "system" && message.role !== "developer") continue;
    const content = readContent(message.content);
    if (content === undefined) return undefined;
    parts.push(...content);
  }
  return parts;
}

function promptFromContext(context: unknown): string | undefined {
  if (!Value.Check(RecordSchema, context) || !Array.isArray(context.messages)) return undefined;
  const messages: SystemMessage[] = [];
  for (const message of context.messages) {
    if (!Value.Check(RecordSchema, message)) return undefined;
    if (message.role !== "system") continue;
    if (!Value.Check(SystemMessageSchema, message)) return undefined;
    messages.push({
      role: "system",
      content: message.content,
      sections: message.sections,
      timestamp: 0,
    });
  }
  return getCurrentSystemPrompt(messages);
}

function combineText(
  first: string[] | undefined,
  second: string[] | undefined,
): string | undefined {
  if (first === undefined || second === undefined) return undefined;
  return joinText([...first, ...second]);
}

function joinText(parts: string[] | undefined): string | undefined {
  return parts?.filter((part) => part.length > 0).join("\n\n");
}
