// Task Scheduler XML rendering and comparison.

import { formatDateTime, type DateTime } from "./datetime.ts";
import { effectiveSetting, logonXmlName, resolveWorkingDirectory, type TaskDef } from "./def.ts";
import {
  buildTriggers,
  monthElement,
  weekdayElement,
  type CalendarTrigger,
  type ScheduleKind,
  type TriggerXml,
} from "./trigger.ts";

export const TASK_XML_NS = "http://schemas.microsoft.com/windows/2004/02/mit/task";

export class XmlError extends Error {
  constructor(task: string, message: string) {
    super(`task \`${task}\`: ${message}`);
  }
}

export function renderTaskXml(definition: TaskDef, now: DateTime): string {
  const triggers: TriggerXml[] = [];
  try {
    const today: DateTime = { ...now, h: 0, mi: 0, s: 0 };
    for (const trigger of definition.trigger) {
      triggers.push(...buildTriggers(trigger, today, now));
    }
  } catch (error) {
    throw new XmlError(definition.name, (error as Error).message);
  }
  let setting: ReturnType<typeof effectiveSetting>;
  try {
    setting = effectiveSetting(definition);
  } catch (error) {
    throw new XmlError(definition.name, (error as Error).message);
  }
  return writeTaskXml(
    definition,
    triggers,
    setting.runLevelHighest,
    logonXmlName(setting.logonType),
  );
}

function writeTaskXml(
  definition: TaskDef,
  triggers: TriggerXml[],
  runLevelHighest: boolean,
  logonType: ReturnType<typeof logonXmlName>,
): string {
  const writer = new IndentWriter();
  writer.decl();
  writer.open("Task", [
    ["version", "1.2"],
    ["xmlns", TASK_XML_NS],
  ]);
  writer.empty("RegistrationInfo");
  writeTriggers(writer, triggers);
  writePrincipal(writer, runLevelHighest, logonType);
  writeSettings(writer);
  writeActions(writer, definition);
  writer.close("Task");
  return writer.finish();
}

function writeTriggers(writer: IndentWriter, triggers: TriggerXml[]): void {
  writer.open("Triggers");
  for (const trigger of triggers) {
    switch (trigger.kind) {
      case "calendar":
        writeCalendarTrigger(writer, trigger);
        break;
      case "logon":
        writer.open("LogonTrigger");
        writer.textElement("Delay", trigger.delay);
        writer.close("LogonTrigger");
        break;
      case "boot":
        writer.open("BootTrigger");
        writer.textElement("Delay", trigger.delay);
        writer.close("BootTrigger");
        break;
      case "time":
        writer.open("TimeTrigger");
        writer.textElement("StartBoundary", formatDateTime(trigger.startBoundary));
        writer.close("TimeTrigger");
        break;
      case "registration":
        writer.empty("RegistrationTrigger");
        break;
    }
  }
  writer.close("Triggers");
}

function writeCalendarTrigger(writer: IndentWriter, trigger: CalendarTrigger): void {
  writer.open("CalendarTrigger");
  writer.textElement("StartBoundary", formatDateTime(trigger.startBoundary));
  if (trigger.repetition !== null) {
    const [interval, duration] = trigger.repetition;
    writer.open("Repetition");
    writer.textElement("Interval", interval);
    writer.textElement("Duration", duration);
    writer.close("Repetition");
  }
  writeSchedule(writer, trigger.schedule);
  writer.close("CalendarTrigger");
}

function writeSchedule(writer: IndentWriter, schedule: ScheduleKind): void {
  switch (schedule.kind) {
    case "daily":
      writer.open("ScheduleByDay");
      writer.textElement("DaysInterval", String(schedule.daysInterval));
      writer.close("ScheduleByDay");
      break;
    case "weekly":
      writer.open("ScheduleByWeek");
      writeDaysOfWeek(writer, schedule.days);
      writer.close("ScheduleByWeek");
      break;
    case "monthly":
      writer.open("ScheduleByMonth");
      writer.open("DaysOfMonth");
      for (const day of schedule.days) writer.textElement("Day", String(day));
      writer.close("DaysOfMonth");
      writeMonths(writer, schedule.months);
      writer.close("ScheduleByMonth");
      break;
    case "monthlyDow":
      writer.open("ScheduleByMonthDayOfWeek");
      writeDaysOfWeek(writer, schedule.days);
      writeMonths(writer, schedule.months);
      writer.close("ScheduleByMonthDayOfWeek");
      break;
  }
}

function writeDaysOfWeek(writer: IndentWriter, days: number[]): void {
  writer.open("DaysOfWeek");
  for (const day of days) writer.empty(weekdayElement(day));
  writer.close("DaysOfWeek");
}

function writeMonths(writer: IndentWriter, months: number[]): void {
  writer.open("Months");
  for (const month of months) writer.empty(monthElement(month));
  writer.close("Months");
}

function writePrincipal(
  writer: IndentWriter,
  runLevelHighest: boolean,
  logonType: ReturnType<typeof logonXmlName>,
): void {
  writer.open("Principals");
  writer.open("Principal");
  writer.textElement("RunLevel", runLevelHighest ? "HighestAvailable" : "LeastPrivilege");
  writer.textElement("LogonType", logonType);
  writer.close("Principal");
  writer.close("Principals");
}

function writeSettings(writer: IndentWriter): void {
  writer.open("Settings");
  writer.textElement("StartWhenAvailable", "true");
  writer.textElement("DisallowStartIfOnBatteries", "false");
  writer.textElement("StopIfGoingOnBatteries", "false");
  writer.close("Settings");
}

function writeActions(writer: IndentWriter, definition: TaskDef): void {
  writer.open("Actions");
  for (const action of definition.action) {
    writer.open("Exec");
    writer.textElement("Command", action.command);
    if (action.args !== undefined) writer.textElement("Arguments", action.args);
    const directory = resolveWorkingDirectory(action);
    if (directory !== null) writer.textElement("WorkingDirectory", directory);
    writer.close("Exec");
  }
  writer.close("Actions");
}

// Mirrors quick-xml 0.42's indented writer: a wrapped element is preceded by
// a newline + indent only when the previous event was not inline text.
class IndentWriter {
  private out = "";
  private depth = 0;
  private shouldLineBreak = false;

  private wrapped(before: string, value: string, after: string): void {
    if (this.shouldLineBreak) {
      this.out += "\n" + "  ".repeat(this.depth);
    }
    this.out += before + value + after;
  }

  decl(): void {
    this.wrapped("<?", 'xml version="1.0" encoding="UTF-8"', "?>");
    this.shouldLineBreak = true;
  }

  open(name: string, attributes: Array<[string, string]> = []): void {
    this.wrapped("<", `${name}${attrString(attributes)}`, ">");
    this.depth++;
    this.shouldLineBreak = true;
  }

  empty(name: string, attributes: Array<[string, string]> = []): void {
    this.wrapped("<", `${name}${attrString(attributes)}`, "/>");
    this.shouldLineBreak = true;
  }

  text(raw: string): void {
    this.out += raw;
    this.shouldLineBreak = false;
  }

  reference(raw: string): void {
    this.wrapped("&", raw.slice(1, -1), ";");
    this.shouldLineBreak = true;
  }

  textElement(name: string, text: string): void {
    this.open(name);
    this.text(text);
    this.close(name);
  }

  close(name: string): void {
    this.depth--;
    this.wrapped("</", name, ">");
    this.shouldLineBreak = true;
  }

  finish(): string {
    return this.out;
  }
}

function attrString(attributes: Array<[string, string]>): string {
  let out = "";
  for (const [name, value] of attributes) out += ` ${name}="${value}"`;
  return out;
}

// Normalized comparison.

interface XNode {
  name: string;
  attributes: Array<[string, string]>;
  content: XContent[];
}

type XContent =
  | { kind: "element"; node: XNode }
  | { kind: "text"; raw: string }
  | { kind: "cdata"; text: string }
  | { kind: "reference"; raw: string };

export function normalizedTaskXml(xml: string): string {
  if (xml.length === 0) return "";
  const root = normalizeNode(parseXml(xml));
  const writer = new IndentWriter();
  writer.decl();
  writeNormalizedNode(writer, root);
  return writer.finish();
}

function writeNormalizedNode(writer: IndentWriter, node: XNode): void {
  if (node.content.length === 0) {
    writer.empty(node.name, node.attributes);
    return;
  }
  writer.open(node.name, node.attributes);
  for (const item of node.content) {
    switch (item.kind) {
      case "element":
        writeNormalizedNode(writer, item.node);
        break;
      case "text":
        writer.text(item.raw);
        break;
      case "cdata":
        writer.text(item.text);
        break;
      case "reference":
        writer.text(item.raw);
        break;
    }
  }
  writer.close(node.name);
}

function localName(name: string): string {
  const index = name.lastIndexOf(":");
  return index === -1 ? name : name.slice(index + 1);
}

function normalizeNode(node: XNode): XNode {
  const name = localName(node.name);
  const attributes = node.attributes.filter(
    ([attribute]) =>
      !(name === "Principal" && localName(attribute) === "id") &&
      !(name === "Actions" && localName(attribute) === "Context"),
  );
  attributes.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

  const content: XContent[] = [];
  for (const item of node.content) {
    if (item.kind === "element") {
      if (keepChild(name, item.node))
        content.push({ kind: "element", node: normalizeNode(item.node) });
      continue;
    }
    content.push(item);
  }
  if (name === "RegistrationInfo") content.length = 0;
  sortOwnedChildren(name, content);
  if (name === "Task") sortTaskChildren(content);
  return { name: node.name, attributes, content };
}

function keepChild(parent: string, child: XNode): boolean {
  const childName = localName(child.name);
  switch (parent) {
    case "RegistrationInfo":
      return false;
    case "CalendarTrigger":
      return (
        childName !== "StartBoundary" && childName !== "Enabled" && childName !== "EndBoundary"
      );
    case "LogonTrigger":
    case "BootTrigger":
    case "TimeTrigger":
      return (
        childName !== "Enabled" && !(childName === "Delay" && textContent(child).trim() === "PT0S")
      );
    case "Principal":
      return childName === "RunLevel" || childName === "LogonType";
    case "Settings":
      return (
        childName === "StartWhenAvailable" ||
        childName === "DisallowStartIfOnBatteries" ||
        childName === "StopIfGoingOnBatteries"
      );
    default:
      return true;
  }
}

function textContent(node: XNode): string {
  let out = "";
  for (const item of node.content) {
    if (item.kind === "text") out += item.raw;
    if (item.kind === "cdata") out += item.text;
  }
  return out;
}

function sortOwnedChildren(parent: string, content: XContent[]): void {
  if (parent !== "Principal" && parent !== "Settings") return;
  const order = (child: string): number => {
    switch (`${parent}:${child}`) {
      case "Principal:RunLevel":
        return 0;
      case "Principal:LogonType":
        return 1;
      case "Settings:StartWhenAvailable":
        return 0;
      case "Settings:DisallowStartIfOnBatteries":
        return 1;
      case "Settings:StopIfGoingOnBatteries":
        return 2;
      default:
        return 3;
    }
  };
  stableSortBy(content, (item) => (item.kind === "element" ? order(localName(item.node.name)) : 3));
}

function sortTaskChildren(content: XContent[]): void {
  const order = (child: string): number => {
    switch (child) {
      case "RegistrationInfo":
        return 0;
      case "Triggers":
        return 1;
      case "Principals":
        return 2;
      case "Settings":
        return 3;
      case "Actions":
        return 4;
      default:
        return 5;
    }
  };
  stableSortBy(content, (item) => (item.kind === "element" ? order(localName(item.node.name)) : 5));
}

function stableSortBy(content: XContent[], key: (item: XContent) => number): void {
  content.sort((left, right) => key(left) - key(right));
}

// Tokenizer shared by the parser and extractTasks. Mirrors quick-xml's event
// stream: raw text is preserved (entity references split into their own
// tokens), so escaping is not resolved or re-applied.

type Token =
  | {
      kind: "start" | "empty" | "end";
      name: string;
      attributes: Array<[string, string]>;
      raw: string;
    }
  | { kind: "cdata"; text: string; raw: string }
  | { kind: "text"; raw: string }
  | { kind: "reference"; raw: string }
  | { kind: "skip"; raw: string };

export function tokenize(xml: string): { tokens: Token[]; error: string | null } {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    if (lt === -1) {
      tokens.push(...textTokens(xml.slice(pos)));
      return { tokens, error: null };
    }
    if (lt > pos) tokens.push(...textTokens(xml.slice(pos, lt)));
    const parsed = parseTagToken(xml, lt);
    if ("error" in parsed) return { tokens, error: parsed.error };
    tokens.push(parsed.token);
    pos = parsed.pos;
  }
  return { tokens, error: null };
}

function textTokens(raw: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const amp = raw.indexOf("&", pos);
    if (amp === -1) {
      tokens.push({ kind: "text", raw: raw.slice(pos) });
      break;
    }
    if (amp > pos) tokens.push({ kind: "text", raw: raw.slice(pos, amp) });
    const semi = raw.indexOf(";", amp + 1);
    if (semi === -1) {
      tokens.push({ kind: "text", raw: raw.slice(amp) });
      break;
    }
    tokens.push({ kind: "reference", raw: raw.slice(amp, semi + 1) });
    pos = semi + 1;
  }
  return tokens;
}

function parseTagToken(
  xml: string,
  pos: number,
): { token: Token; pos: number } | { error: string } {
  if (xml.startsWith("<?", pos)) {
    const end = xml.indexOf("?>", pos + 2);
    if (end === -1) return { error: "unterminated XML declaration" };
    return { token: { kind: "skip", raw: xml.slice(pos, end + 2) }, pos: end + 2 };
  }
  if (xml.startsWith("<!--", pos)) {
    const end = xml.indexOf("-->", pos + 4);
    if (end === -1) return { error: "unterminated comment" };
    return { token: { kind: "skip", raw: xml.slice(pos, end + 3) }, pos: end + 3 };
  }
  if (xml.startsWith("<![CDATA[", pos)) {
    const end = xml.indexOf("]]>", pos + 9);
    if (end === -1) return { error: "unterminated CDATA section" };
    return {
      token: { kind: "cdata", text: xml.slice(pos + 9, end), raw: xml.slice(pos, end + 3) },
      pos: end + 3,
    };
  }
  if (xml.startsWith("<!", pos)) {
    if (/^<!DOCTYPE/i.test(xml.slice(pos, pos + 9))) {
      const end = xml.indexOf(">", pos);
      if (end === -1) return { error: "unterminated doctype declaration" };
      return { token: { kind: "skip", raw: xml.slice(pos, end + 1) }, pos: end + 1 };
    }
    return { error: "unrecognized markup declaration" };
  }
  if (xml.startsWith("</", pos)) {
    const gt = xml.indexOf(">", pos);
    if (gt === -1) return { error: "unterminated closing tag" };
    const name = xml.slice(pos + 2, gt).trim();
    if (!/^[^\s>]+$/.test(name)) return { error: "invalid closing tag" };
    return {
      token: { kind: "end", name, attributes: [], raw: xml.slice(pos, gt + 1) },
      pos: gt + 1,
    };
  }
  const gt = findTagEnd(xml, pos + 1);
  if (gt === -1) return { error: "unterminated tag" };
  const tag = xml.slice(pos + 1, gt);
  const selfClosing = tag.endsWith("/");
  const parsed = parseTagAttributes(selfClosing ? tag.slice(0, -1) : tag);
  if (parsed === null) return { error: "invalid tag" };
  return {
    token: {
      kind: selfClosing ? "empty" : "start",
      name: parsed.name,
      attributes: parsed.attributes,
      raw: xml.slice(pos, gt + 1),
    },
    pos: gt + 1,
  };
}

function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function parseTagAttributes(
  body: string,
): { name: string; attributes: Array<[string, string]> } | null {
  const nameMatch = /^[^\s/>]+/.exec(body);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  const attributes: Array<[string, string]> = [];
  let pos = name.length;
  while (pos < body.length) {
    while (pos < body.length && /\s/.test(body[pos]!)) pos++;
    if (pos >= body.length) break;
    if (body[pos] === "/") break;
    const attrMatch = /^[^\s=/]+/.exec(body.slice(pos));
    if (!attrMatch) return null;
    const attrName = attrMatch[0];
    pos += attrName.length;
    while (pos < body.length && /\s/.test(body[pos]!)) pos++;
    let value = "";
    if (body[pos] === "=") {
      pos++;
      while (pos < body.length && /\s/.test(body[pos]!)) pos++;
      const quote = body[pos];
      if (quote === '"' || quote === "'") {
        const endQuote = body.indexOf(quote, pos + 1);
        if (endQuote === -1) return null;
        value = body.slice(pos + 1, endQuote);
        pos = endQuote + 1;
      } else {
        const end = /[\s/>]/.exec(body.slice(pos))?.index ?? body.length - pos;
        value = body.slice(pos, pos + end);
        pos += end;
      }
    }
    attributes.push([attrName, value]);
  }
  return { name, attributes };
}

function unescapeXml(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    if (entity.startsWith("#x")) {
      const code = parseInt(entity.slice(2), 16);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
    }
    return full;
  });
}

export function parseXml(xml: string): XNode {
  const { tokens, error } = tokenize(xml);
  if (error !== null) throw new Error(error);
  const stack: XNode[] = [];
  let root: XNode | null = null;
  const appendNode = (node: XNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.content.push({ kind: "element", node });
    else if (!root) root = node;
    else throw new Error("XML document has multiple root elements");
  };
  for (const token of tokens) {
    switch (token.kind) {
      case "start":
        stack.push({ name: token.name, attributes: token.attributes, content: [] });
        break;
      case "empty":
        appendNode({ name: token.name, attributes: token.attributes, content: [] });
        break;
      case "end": {
        const node = stack.pop();
        if (!node) throw new Error("unexpected XML closing tag");
        if (localName(token.name) !== localName(node.name)) {
          throw new Error(`expecting </${node.name}> found </${token.name}>`);
        }
        appendNode(node);
        break;
      }
      case "text": {
        if (unescapeXml(token.raw).trim().length === 0) break;
        const parent = stack[stack.length - 1];
        if (!parent) throw new Error("text outside XML root");
        parent.content.push({ kind: "text", raw: token.raw });
        break;
      }
      case "cdata": {
        if (token.text.trim().length === 0) break;
        const parent = stack[stack.length - 1];
        if (!parent) throw new Error("CDATA outside XML root");
        parent.content.push({ kind: "cdata", text: token.text });
        break;
      }
      case "reference": {
        const parent = stack[stack.length - 1];
        if (!parent) throw new Error("entity reference outside XML root");
        parent.content.push({ kind: "reference", raw: token.raw });
        break;
      }
      case "skip":
        break;
    }
  }
  if (stack.length > 0) throw new Error("unexpected end of XML document");
  if (!root) throw new Error("XML document has no root element");
  return root;
}

function lines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

export function taskXmlDiff(current: string, desired: string): string | null {
  const currentNormalized = normalizedTaskXml(current);
  const desiredNormalized = normalizedTaskXml(desired);
  if (currentNormalized === desiredNormalized) return null;

  const currentLines = lines(currentNormalized);
  const desiredLines = lines(desiredNormalized);
  const suffixes: number[][] = Array.from({ length: currentLines.length + 1 }, () =>
    new Array<number>(desiredLines.length + 1).fill(0),
  );
  for (let currentIndex = currentLines.length - 1; currentIndex >= 0; currentIndex--) {
    for (let desiredIndex = desiredLines.length - 1; desiredIndex >= 0; desiredIndex--) {
      suffixes[currentIndex]![desiredIndex] =
        currentLines[currentIndex] === desiredLines[desiredIndex]
          ? suffixes[currentIndex + 1]![desiredIndex + 1]! + 1
          : Math.max(
              suffixes[currentIndex + 1]![desiredIndex]!,
              suffixes[currentIndex]![desiredIndex + 1]!,
            );
    }
  }

  let diff = "--- current\n+++ desired\n@@\n";
  let [currentIndex, desiredIndex] = [0, 0];
  while (currentIndex < currentLines.length || desiredIndex < desiredLines.length) {
    if (
      currentIndex < currentLines.length &&
      desiredIndex < desiredLines.length &&
      currentLines[currentIndex] === desiredLines[desiredIndex]
    ) {
      currentIndex++;
      desiredIndex++;
    } else if (
      desiredIndex === desiredLines.length ||
      (currentIndex < currentLines.length &&
        suffixes[currentIndex + 1]![desiredIndex]! >= suffixes[currentIndex]![desiredIndex + 1]!)
    ) {
      diff += `-${currentLines[currentIndex]}\n`;
      currentIndex++;
    } else {
      diff += `+${desiredLines[desiredIndex]}\n`;
      desiredIndex++;
    }
  }
  return diff;
}
