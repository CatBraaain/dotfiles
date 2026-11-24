// Declarative reconciliation of a mounted Task Scheduler subtree.

import type { DateTime } from "./datetime.ts";
import { parseDefs, TRIGGER_FOLDERS, type Definitions, type TaskDef } from "./def.ts";
import { elevateIfNeeded, type ElevationRequest } from "./elevate.ts";
import { extractTasks, type ExistingTask, type Schtasks } from "./schtasks.ts";
import { normalizedTaskXml, renderTaskXml, taskXmlDiff } from "./xml.ts";

export interface SyncOptions {
  dryRun: boolean;
}

export interface ApplyRequest {
  yamlText: string;
  file: string;
  mount: string;
}

export interface Writer {
  write(text: string): void;
}

export function taskPath(definition: TaskDef, mount: string): string {
  // validate() guarantees a non-empty trigger list before task paths are built.
  const folder = TRIGGER_FOLDERS[definition.trigger[0]!.kind];
  return `\\${mount}\\${folder}\\${definition.name}`;
}

type ActionKind = "create" | "update" | "no-change";

interface PlannedTask {
  path: string;
  action: ActionKind;
  desiredXml: string;
  currentXml: string | null;
}

export function runApply(
  request: ApplyRequest,
  options: SyncOptions,
  scheduler: Schtasks,
  now: DateTime,
  out: Writer,
  err: Writer,
): number {
  let definitions: Definitions;
  try {
    definitions = parseDefs(request.yamlText, request.file, request.mount);
  } catch (parseError) {
    return fail((parseError as Error).message, err);
  }
  return runSync(definitions, request.file, options, scheduler, now, out, err);
}

export function runSync(
  definitions: Definitions,
  file: string,
  options: SyncOptions,
  scheduler: Schtasks,
  now: DateTime,
  out: Writer,
  err: Writer,
  elevation?: ElevationRequest,
): number {
  let desired: Array<[string, string]>;
  try {
    desired = desiredTasks(definitions, file, now);
  } catch (desiredError) {
    return fail((desiredError as Error).message, err);
  }
  let query: string;
  try {
    query = scheduler.query();
  } catch (queryError) {
    return fail((queryError as Error).message, err);
  }
  let existingTasks: ExistingTask[];
  try {
    existingTasks = extractTasks(query);
  } catch (parseError) {
    return fail((parseError as Error).message, err);
  }
  const current = new Map<string, ExistingTask>();
  for (const task of existingTasks) {
    if (!isInMount(task.path, definitions.mount)) continue;
    current.set(taskPathKey(task.path), task);
  }

  let plan: PlannedTask[];
  try {
    plan = classify(desired, current);
  } catch (classifyError) {
    return fail((classifyError as Error).message, err);
  }
  const desiredPaths = new Set(desired.map(([path]) => taskPathKey(path)));
  const deletions: ExistingTask[] = [...current.values()].filter(
    (task) => !desiredPaths.has(taskPathKey(task.path)),
  );

  if (options.dryRun) {
    try {
      writeDryRun(plan, deletions, out);
    } catch (reportError) {
      return fail((reportError as Error).message, err);
    }
    return 0;
  }

  if (elevation !== undefined) {
    const changesNeeded = deletions.length > 0 || plan.some((task) => task.action !== "no-change");
    const exitCode = elevateIfNeeded(changesNeeded, elevation, err);
    if (exitCode !== undefined) return exitCode;
  }

  const errors: string[] = [];
  for (const task of plan) {
    if (task.action === "no-change") {
      out.write(`no-change ${task.path}\n`);
      continue;
    }
    let created = false;
    try {
      scheduler.create(task.path, task.desiredXml);
      created = true;
    } catch (createError) {
      errors.push(
        `error: schtasks /Create /TN ${task.path} failed: ${(createError as Error).message}`,
      );
    }
    if (!created) continue;
    try {
      writeTaskReport(task, out);
    } catch (reportError) {
      return fail((reportError as Error).message, err);
    }
  }
  for (const task of deletions) {
    let deleted = false;
    try {
      scheduler.delete(task.path);
      deleted = true;
    } catch (deleteError) {
      errors.push(
        `error: schtasks /Delete /TN ${task.path} failed: ${(deleteError as Error).message}`,
      );
    }
    if (!deleted) continue;
    try {
      writeDeleteReport(task, out);
    } catch (reportError) {
      return fail((reportError as Error).message, err);
    }
  }
  return finish(errors, err);
}

function desiredTasks(
  definitions: Definitions,
  file: string,
  now: DateTime,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const definition of definitions.tasks) {
    let xml: string;
    try {
      xml = renderTaskXml(definition, now);
    } catch (error) {
      throw new Error(`${file}: XML generation failed for ${(error as Error).message}`);
    }
    out.push([taskPath(definition, definitions.mount), xml]);
  }
  return out;
}

function classify(
  desired: Array<[string, string]>,
  current: Map<string, ExistingTask>,
): PlannedTask[] {
  const plan: PlannedTask[] = [];
  for (const [path, desiredXml] of desired) {
    const existing = current.get(taskPathKey(path));
    let action: ActionKind;
    if (!existing) {
      action = "create";
    } else {
      const same = normalizedTaskXml(existing.xml) === normalizedTaskXml(desiredXml);
      action = same ? "no-change" : "update";
    }
    plan.push({ path, action, desiredXml, currentXml: existing ? existing.xml : null });
  }
  return plan;
}

function isInMount(path: string, mount: string): boolean {
  const key = taskPathKey(path);
  const folder = taskPathKey(`\\${mount}`);
  return key === folder || key.startsWith(`${folder}\\`);
}

function taskPathKey(path: string): string {
  return path.toLowerCase();
}

function writeDryRun(plan: PlannedTask[], deletions: ExistingTask[], out: Writer): void {
  for (const task of plan) writeTaskReport(task, out);
  for (const task of deletions) writeDeleteReport(task, out);
}

function writeTaskReport(task: PlannedTask, out: Writer): void {
  out.write(`${task.action} ${task.path}\n`);
  if (task.action === "update" && task.currentXml !== null) {
    writeDiff(task.currentXml, task.desiredXml, out);
  }
}

function writeDeleteReport(task: ExistingTask, out: Writer): void {
  out.write(`delete ${task.path}\n`);
  writeDiff(task.xml, "", out);
}

function writeDiff(current: string, desired: string, out: Writer): void {
  const diff = taskXmlDiff(current, desired);
  if (diff !== null) out.write(diff);
}

function finish(errors: string[], err: Writer): number {
  if (errors.length === 0) return 0;
  for (const error of errors) err.write(`${error}\n`);
  return 1;
}

function fail(message: string, err: Writer): number {
  err.write(`wintasks: ${message}\n`);
  return 1;
}
