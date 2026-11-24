// Task Scheduler XML rendering and comparison.

import { XMLParser, XMLValidator } from "fast-xml-parser";
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

export interface XNode {
  name: string;
  attributes: Array<[string, string]>;
  content: XContent[];
}

export type XContent = { kind: "element"; node: XNode } | { kind: "text" | "cdata"; text: string };

export function normalizedTaskXml(xml: string): string {
  if (xml.length === 0) return "";
  const root = normalizeNode(parseXml(xml));
  const writer = new IndentWriter();
  writer.decl();
  writeNormalizedNode(writer, root);
  return writer.finish();
}

function writeNormalizedNode(writer: IndentWriter, node: XNode): void {
  const attributes = node.attributes.map(([name, value]): [string, string] => [
    name,
    escapeXmlText(value).replaceAll('"', "&quot;"),
  ]);
  if (node.content.length === 0) {
    writer.empty(node.name, attributes);
    return;
  }
  writer.open(node.name, attributes);
  for (const item of node.content) {
    if (item.kind === "element") writeNormalizedNode(writer, item.node);
    else writer.text(escapeXmlText(item.text));
  }
  writer.close(node.name);
}

function escapeXmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

export function textContent(node: XNode): string {
  let out = "";
  for (const item of node.content) {
    if (item.kind !== "element") out += item.text;
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

const xmlParser = new XMLParser({
  ignoreDeclaration: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  attributesGroupName: ":@",
  preserveOrder: true,
  cdataPropName: "__cdata",
  trimValues: false,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: true,
});

export function parseXml(xml: string): XNode {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(
      `${validation.err.msg} (line ${validation.err.line}, col ${validation.err.col})`,
    );
  }
  const roots = xmlNodes(xmlParser.parse(xml) as XmlEntry[]);
  if (roots.length === 0) throw new Error("XML document has no root element");
  if (roots.length > 1) throw new Error("XML document has multiple root elements");
  return roots[0]!;
}

type XmlEntry = Record<string, unknown>;

const structureKeys = [":@", "#text", "__cdata"];

function xmlNodes(entries: XmlEntry[]): XNode[] {
  const nodes: XNode[] = [];
  for (const entry of entries) {
    const node = xmlNode(entry);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

function xmlNode(entry: XmlEntry): XNode | null {
  const name = Object.keys(entry).find((key) => !structureKeys.includes(key));
  if (name === undefined) return null;
  const children = entry[name];
  const attributesObject = entry[":@"];
  const attributes: Array<[string, string]> = attributesObject
    ? (Object.entries(attributesObject as XmlEntry) as Array<[string, string]>)
    : [];
  return {
    name,
    attributes,
    content: xmlContents(Array.isArray(children) ? (children as XmlEntry[]) : []),
  };
}

function xmlContents(entries: XmlEntry[]): XContent[] {
  const content: XContent[] = [];
  for (const entry of entries) {
    const text = entry["#text"];
    if (typeof text === "string") {
      if (text.trim().length > 0) content.push({ kind: "text", text });
      continue;
    }
    const cdata = entry["__cdata"];
    if (cdata !== undefined) {
      const value = cdataText(cdata);
      if (value.trim().length > 0) content.push({ kind: "cdata", text: value });
      continue;
    }
    const node = xmlNode(entry);
    if (node !== null) content.push({ kind: "element", node });
  }
  return content;
}

function cdataText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  let out = "";
  for (const item of value as XmlEntry[]) {
    const text = item["#text"];
    if (typeof text === "string") out += text;
  }
  return out;
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
