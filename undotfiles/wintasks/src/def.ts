// YAML schema and validation for the declarative desired state.

import { parse as parseYaml, type YAMLParseError } from "yaml";

export type TriggerKind = "cron" | "startup" | "boot" | "once" | "now";
export type LogonType = "interactive_token" | "s4u";

export interface TriggerDef {
  kind: TriggerKind;
  value: string;
}

export interface ActionDef {
  command: string;
  args?: string;
  workingDirectory?: string;
}

export interface SettingDef {
  runAs?: boolean | string;
  logonType?: LogonType;
}

export interface TaskDef {
  name: string;
  trigger: TriggerDef[];
  action: ActionDef[];
  setting: SettingDef | null;
}

export interface Definitions {
  mount: string;
  tasks: TaskDef[];
}

export interface EffectiveSetting {
  runLevelHighest: boolean;
  logonType: LogonType;
}

export const TRIGGER_FOLDERS: Record<TriggerKind, string> = {
  cron: "cron",
  startup: "startup",
  boot: "boot",
  once: "once",
  now: "now",
};

export function logonXmlName(logonType: LogonType): string {
  return logonType === "interactive_token" ? "InteractiveToken" : "S4U";
}

export function effectiveSetting(task: TaskDef): EffectiveSetting {
  const setting = task.setting;
  if (!setting) {
    return { runLevelHighest: false, logonType: "interactive_token" };
  }
  let runLevelHighest = false;
  if (setting.runAs !== undefined) {
    if (typeof setting.runAs === "boolean") {
      runLevelHighest = setting.runAs;
    } else if (setting.runAs === "true") {
      runLevelHighest = true;
    } else if (setting.runAs === "false") {
      runLevelHighest = false;
    } else {
      throw new Error("setting.run_as must be true or false");
    }
  }
  return { runLevelHighest, logonType: setting.logonType ?? "interactive_token" };
}

export function resolveWorkingDirectory(action: ActionDef): string | null {
  if (action.workingDirectory !== undefined) return action.workingDirectory;
  return parentDirectory(action.command);
}

function parentDirectory(path: string): string | null {
  const normalized = path.replaceAll("/", "\\");
  const separator = normalized.lastIndexOf("\\");
  if (separator === -1) return null;
  if (separator === 0) return "\\";
  if (separator === 2 && normalized[1] === ":") return normalized.slice(0, separator + 1);
  return normalized.slice(0, separator);
}

export function parseDefs(text: string, file: string, mount: string): Definitions {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new Error(locatedYamlError(file, error as YAMLParseError));
  }
  if (doc === null || doc === undefined) {
    throw new Error(`${file}: no task definitions found (file is empty or null)`);
  }
  if (!Array.isArray(doc)) {
    throw new Error(`${file}: invalid type: expected a sequence of task definitions`);
  }
  const definitions: Definitions = { mount, tasks: doc.map(parseTaskDef) };
  validate(definitions, file);
  return definitions;
}

function locatedYamlError(file: string, error: YAMLParseError): string {
  // yaml's error.linePos is unavailable for some failures, but the message
  // always carries the failing position as "at line N, column M".
  const position = /at line (\d+), column (\d+)/.exec(error.message);
  const cause = error.message.split("\n")[0];
  if (position) return `${file}:${position[1]}:${position[2]}: ${cause}`;
  return `${file}: ${cause}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failInvalidType(what: string, value: unknown): never {
  const kind = Array.isArray(value) ? "sequence" : typeof value;
  throw new Error(`${what}: invalid type: ${kind}`);
}

function expectKeys(value: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${what}: unknown field \`${key}\`, expected one of ${allowed.map((k) => `\`${k}\``).join(", ")}`,
      );
    }
  }
}

function expectString(value: unknown, what: string): string {
  if (typeof value !== "string") failInvalidType(`${what}: expected a string`, value);
  return value;
}

function parseTaskDef(value: unknown): TaskDef {
  if (!isRecord(value)) failInvalidType("task definition: expected a mapping", value);
  expectKeys(value, ["name", "trigger", "action", "setting"], "task definition");
  const name = expectString(value.name, "task name");
  if (value.trigger === undefined) throw new Error("task definition: missing field `trigger`");
  if (value.action === undefined) throw new Error("task definition: missing field `action`");
  return {
    name,
    trigger: singleOrVec(value.trigger, parseTriggerDef),
    action: singleOrVec(value.action, parseActionDef),
    setting:
      value.setting === undefined || value.setting === null ? null : parseSettingDef(value.setting),
  };
}

function singleOrVec<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (Array.isArray(value)) return value.map(parse);
  return [parse(value)];
}

function parseTriggerDef(value: unknown): TriggerDef {
  if (!isRecord(value)) failInvalidType("trigger: expected a mapping", value);
  expectKeys(value, ["type", "value"], "trigger");
  const kind = expectString(value.type, "trigger type");
  if (!(kind in TRIGGER_FOLDERS)) {
    throw new Error(
      `trigger: unknown variant \`${kind}\`, expected one of \`cron\`, \`startup\`, \`boot\`, \`once\`, \`now\``,
    );
  }
  if (value.value === undefined) throw new Error("trigger: missing field `value`");
  const triggerValue = expectString(value.value, "trigger value");
  return { kind: kind as TriggerKind, value: triggerValue };
}

function parseActionDef(value: unknown): ActionDef {
  if (!isRecord(value)) failInvalidType("action: expected a mapping", value);
  expectKeys(value, ["command", "args", "working_directory"], "action");
  if (value.command === undefined) throw new Error("action: missing field `command`");
  const action: ActionDef = { command: expectString(value.command, "action command") };
  if (value.args !== undefined) action.args = expectString(value.args, "action args");
  if (value.working_directory !== undefined) {
    action.workingDirectory = expectString(value.working_directory, "action working_directory");
  }
  return action;
}

function parseSettingDef(value: unknown): SettingDef {
  if (!isRecord(value)) failInvalidType("setting: expected a mapping", value);
  expectKeys(value, ["run_as", "logon_type"], "setting");
  const setting: SettingDef = {};
  const runAs = value.run_as;
  if (runAs !== undefined && runAs !== null) {
    if (typeof runAs !== "boolean" && typeof runAs !== "string") {
      failInvalidType("setting.run_as: expected a boolean or a string", runAs);
    }
    setting.runAs = runAs;
  }
  const logonType = value.logon_type;
  if (logonType !== undefined && logonType !== null) {
    if (logonType !== "interactive_token" && logonType !== "s4u") {
      throw new Error(
        `setting.logon_type: unknown variant \`${String(logonType)}\`, expected one of \`interactive_token\`, \`s4u\``,
      );
    }
    setting.logonType = logonType;
  }
  return setting;
}

function validate(definitions: Definitions, file: string): void {
  if (!validMount(definitions.mount)) {
    throw new Error(`${file}: mount must be a non-root folder path`);
  }
  const names = new Set<string>();
  const taskPaths = new Set<string>();
  for (const task of definitions.tasks) {
    if (task.name.length === 0 || task.name.includes("\\") || task.name.includes("/")) {
      throw new Error(`${file}: invalid task name \`${task.name}\``);
    }
    if (names.has(task.name)) {
      throw new Error(`${file}: duplicate task name \`${task.name}\``);
    }
    names.add(task.name);
    if (task.trigger.length === 0) {
      throw new Error(`${file}: task \`${task.name}\` must define a trigger`);
    }
    if (task.action.length === 0) {
      throw new Error(`${file}: task \`${task.name}\` must define an action`);
    }
    const path = `\\${definitions.mount}\\${TRIGGER_FOLDERS[task.trigger[0]!.kind]}\\${task.name}`;
    if (taskPaths.has(path.toLowerCase())) {
      throw new Error(`${file}: duplicate task path \`${path}\``);
    }
    taskPaths.add(path.toLowerCase());
  }
}

function validMount(mount: string): boolean {
  return (
    mount.length > 0 &&
    !mount.startsWith("\\") &&
    !mount.endsWith("\\") &&
    mount.split("\\").every((part) => part.length > 0)
  );
}
