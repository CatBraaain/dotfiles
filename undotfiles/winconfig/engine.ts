import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const EXIST = "<Exist>";
const NOT_EXIST = "<NotExist>";
const NOT_CHANGE = "<NotChange>";
const EXISTENCE = [EXIST, NOT_EXIST, NOT_CHANGE] as const;

const REGISTRY_VALUE_KINDS = [
  "String",
  "ExpandString",
  "Binary",
  "DWord",
  "MultiString",
  "QWord",
] as const;
const SCHTASK_STATES = ["Enabled", "Disabled"] as const;
const ACTION_MODES = ["apply", "revert", "skip"] as const;

type Existence = (typeof EXISTENCE)[number];
type RegistryValueKind = (typeof REGISTRY_VALUE_KINDS)[number];
type SchtaskState = (typeof SCHTASK_STATES)[number];
type ActionMode = (typeof ACTION_MODES)[number];
export type ExecutableMode = Exclude<ActionMode, "skip">;

export interface RegistryEntryDefinition {
  name: string;
  type: RegistryValueKind;
  old_value: string;
  new_value: string;
}

export interface RegistryPathDefinition {
  path: string;
  old_existence: Existence;
  new_existence: Existence;
  entries: RegistryEntryDefinition[];
}

export interface SchtaskDefinition {
  full_path: string;
  old_state: SchtaskState;
  new_state: SchtaskState;
}

export interface ScriptDefinition {
  apply: string;
  revert: string;
}

export interface DefinitionBody {
  description: string;
  registries: RegistryPathDefinition[];
  scheduled_tasks: SchtaskDefinition[];
  script: ScriptDefinition;
}

export type Definitions = Record<string, Record<string, DefinitionBody>>;
export type Actions = Record<string, Record<string, ActionMode>>;

export interface RunnableTask {
  groupName: string;
  name: string;
  body: DefinitionBody;
  mode: ExecutableMode;
}

export interface TaskSelection {
  runnables: RunnableTask[];
  notices: string[];
}

export interface Config {
  definitions: Definitions;
  actions: Actions;
}

const REGISTRY_PREFIX_MAPPINGS: Array<[RegExp, string]> = [
  [/^(?:Registry::)?(?:HKEY_CLASSES_ROOT|HKCR):?\\/i, "HKCR\\"],
  [/^(?:Registry::)?(?:HKEY_CURRENT_CONFIG|HKCC):?\\/i, "HKCC\\"],
  [/^(?:Registry::)?(?:HKEY_CURRENT_USER|HKCU):?\\/i, "HKCU\\"],
  [/^(?:Registry::)?(?:HKEY_LOCAL_MACHINE|HKLM):?\\/i, "HKLM\\"],
  [/^(?:Registry::)?(?:HKEY_USERS|HKU):?\\/i, "HKU\\"],
];

export function normalizeRegistryPath(path: string): string {
  let result = path;
  for (const [pattern, replacement] of REGISTRY_PREFIX_MAPPINGS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function invalid(at: string, problem: string): never {
  throw new Error(`invalid definition: ${at}: ${problem}`);
}

function asMapping(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(at, `expected a mapping, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, at: string): string {
  if (typeof value !== "string") {
    invalid(at, `expected a string, got ${typeof value}`);
  }
  return value;
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(at, `expected a list, got ${typeof value}`);
  }
  return value;
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, at: string): T[number] {
  const text = asString(value, at);
  if (!allowed.includes(text)) {
    invalid(at, `expected one of [${allowed.join(", ")}], got "${text}"`);
  }
  return text as T[number];
}

function checkKeys(mapping: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) {
      invalid(at, `unknown key "${key}" (allowed keys: ${allowed.join(", ")})`);
    }
  }
}

function requiredValue(mapping: Record<string, unknown>, key: string, at: string): unknown {
  if (!(key in mapping)) {
    invalid(at, `missing required key "${key}"`);
  }
  return mapping[key];
}

function optionalValue(mapping: Record<string, unknown>, key: string): unknown {
  return key in mapping ? mapping[key] : undefined;
}

function parseDefinitionBody(value: unknown, at: string): DefinitionBody {
  const body = asMapping(value, at);
  checkKeys(body, ["description", "registries", "scheduled_tasks", "script"], at);
  const registries = asArray(optionalValue(body, "registries") ?? [], `${at}.registries`).map(
    (item, index) => parseRegistryPath(item, `${at}.registries[${index}]`),
  );
  const scheduledTasks = asArray(
    optionalValue(body, "scheduled_tasks") ?? [],
    `${at}.scheduled_tasks`,
  ).map((item, index) => parseSchtask(item, `${at}.scheduled_tasks[${index}]`));
  return {
    description: asString(requiredValue(body, "description", at), `${at}.description`),
    registries,
    scheduled_tasks: scheduledTasks,
    script: parseScriptDefinition(optionalValue(body, "script"), `${at}.script`),
  };
}

function parseRegistryPath(value: unknown, at: string): RegistryPathDefinition {
  const item = asMapping(value, at);
  checkKeys(item, ["path", "old_existence", "new_existence", "entries"], at);
  const entries = asArray(optionalValue(item, "entries") ?? [], `${at}.entries`).map(
    (entry, index) => parseRegistryEntry(entry, `${at}.entries[${index}]`),
  );
  return {
    path: normalizeRegistryPath(asString(requiredValue(item, "path", at), `${at}.path`)),
    old_existence: oneOf(
      optionalValue(item, "old_existence") ?? EXIST,
      EXISTENCE,
      `${at}.old_existence`,
    ),
    new_existence: oneOf(
      optionalValue(item, "new_existence") ?? EXIST,
      EXISTENCE,
      `${at}.new_existence`,
    ),
    entries,
  };
}

function parseRegistryEntry(value: unknown, at: string): RegistryEntryDefinition {
  const item = asMapping(value, at);
  checkKeys(item, ["name", "type", "old_value", "new_value"], at);
  return {
    name: asString(requiredValue(item, "name", at), `${at}.name`),
    type: oneOf(requiredValue(item, "type", at), REGISTRY_VALUE_KINDS, `${at}.type`),
    old_value: asString(requiredValue(item, "old_value", at), `${at}.old_value`),
    new_value: asString(requiredValue(item, "new_value", at), `${at}.new_value`),
  };
}

function parseSchtask(value: unknown, at: string): SchtaskDefinition {
  const item = asMapping(value, at);
  checkKeys(item, ["full_path", "old_state", "new_state"], at);
  return {
    full_path: asString(requiredValue(item, "full_path", at), `${at}.full_path`),
    old_state: oneOf(requiredValue(item, "old_state", at), SCHTASK_STATES, `${at}.old_state`),
    new_state: oneOf(requiredValue(item, "new_state", at), SCHTASK_STATES, `${at}.new_state`),
  };
}

function parseScriptDefinition(value: unknown, at: string): ScriptDefinition {
  if (value === undefined) {
    return { apply: "", revert: "" };
  }
  const item = asMapping(value, at);
  checkKeys(item, ["apply", "revert"], at);
  return {
    apply: asString(optionalValue(item, "apply") ?? "", `${at}.apply`),
    revert: asString(optionalValue(item, "revert") ?? "", `${at}.revert`),
  };
}

export function parseDefinitions(value: unknown): Definitions {
  const root = asMapping(value, "definitions.yaml");
  checkKeys(root, ["Definitions"], "definitions.yaml");
  const groups = asMapping(requiredValue(root, "Definitions", "definitions.yaml"), "Definitions");

  const definitions: Definitions = {};
  for (const [groupName, groupValue] of Object.entries(groups)) {
    const groupAt = `Definitions.${groupName}`;
    definitions[groupName] = {};
    for (const [taskName, taskValue] of Object.entries(asMapping(groupValue, groupAt))) {
      definitions[groupName][taskName] = parseDefinitionBody(taskValue, `${groupAt}.${taskName}`);
    }
  }
  return definitions;
}

export function parseActions(value: unknown): Actions {
  const root = asMapping(value, "actions.yaml");
  checkKeys(root, ["Actions"], "actions.yaml");
  const groups = asMapping(requiredValue(root, "Actions", "actions.yaml"), "Actions");

  const actions: Actions = {};
  for (const [groupName, groupValue] of Object.entries(groups)) {
    const groupAt = `Actions.${groupName}`;
    actions[groupName] = {};
    for (const [taskName, mode] of Object.entries(asMapping(groupValue, groupAt))) {
      actions[groupName][taskName] = oneOf(mode, ACTION_MODES, `${groupAt}.${taskName}`);
    }
  }
  return actions;
}

export function validateActionReferences(definitions: Definitions, actions: Actions): void {
  const unknownTasks = Object.entries(actions).flatMap(([groupName, tasks]) =>
    Object.keys(tasks)
      .filter((taskName) => definitions[groupName]?.[taskName] === undefined)
      .map((taskName) => `${groupName} > ${taskName}`),
  );
  if (unknownTasks.length > 0) {
    throw new Error(
      `actions.yaml references tasks missing from definitions.yaml: ${unknownTasks.join(", ")}`,
    );
  }
}

function flipMode(mode: ActionMode): ActionMode {
  if (mode === "apply") return "revert";
  if (mode === "revert") return "apply";
  return mode;
}

export function selectRunnableTasks(
  definitions: Definitions,
  actions: Actions,
  reverse: boolean,
): TaskSelection {
  const selection: TaskSelection = { runnables: [], notices: [] };
  for (const [groupName, tasks] of Object.entries(definitions)) {
    for (const [name, body] of Object.entries(tasks)) {
      const mode = actions[groupName]?.[name] ?? "skip";
      const resolvedMode = reverse ? flipMode(mode) : mode;
      if (resolvedMode === "skip") {
        selection.notices.push(`Skipped: ${groupName} > ${name}[skip]`);
        continue;
      }
      selection.runnables.push({ groupName, name, body, mode: resolvedMode });
    }
  }
  return selection;
}

export function psSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function psDoubleQuoted(value: string): string {
  const escaped = value.replaceAll("`", "``").replaceAll('"', '`"').replaceAll("$", "`$");
  return `"${escaped}"`;
}

export function psQuotedRegistryPath(path: string): string {
  const escaped = path.replaceAll("`", "``");
  return `"Registry::${escaped}"`;
}

function registryPathOperation(registry: RegistryPathDefinition, mode: ExecutableMode): string {
  const existence = mode === "apply" ? registry.new_existence : registry.old_existence;
  const path = psQuotedRegistryPath(registry.path);
  if (existence === NOT_EXIST) {
    return `Remove-RegistryPath -Path ${path}`;
  }
  if (existence === EXIST) {
    return `New-RegistryPath -Path ${path}`;
  }
  return "";
}

function registryEntryOperation(
  entry: RegistryEntryDefinition,
  parentPath: string,
  mode: ExecutableMode,
): string {
  const value = mode === "apply" ? entry.new_value : entry.old_value;
  const path = psQuotedRegistryPath(parentPath);
  if (value === NOT_EXIST) {
    return `Remove-RegistryEntry -Path ${path} -Name ${psDoubleQuoted(entry.name)}`;
  }
  return `Set-RegistryEntry -Path ${path} -Name ${psDoubleQuoted(entry.name)} -Type ${psDoubleQuoted(entry.type)} -Value ${psDoubleQuoted(value)}`;
}

function schtaskOperation(schtask: SchtaskDefinition, mode: ExecutableMode): string {
  const state = mode === "apply" ? schtask.new_state : schtask.old_state;
  const enabled = state === "Enabled" ? "$true" : "$false";
  const taskPath = psSingleQuoted(schtask.full_path);
  return [
    "try {",
    `    $scheduleService = New-Object -ComObject "Schedule.Service"`,
    "    $scheduleService.Connect()",
    `    $scheduleService.GetFolder("\\").GetTask(${taskPath}).Enabled = ${enabled}`,
    "    Add-WinconfigSuccess 'scheduled task state set'",
    "}",
    "catch [System.IO.FileNotFoundException] {",
    `    Add-WinconfigFailure 'target not found: scheduled task ${psSingleQuoted(schtask.full_path)}'`,
    "}",
    "catch {",
    "    Add-WinconfigFailure (Get-WinconfigFailureReason $_)",
    "}",
  ].join("\n");
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

export function generateTaskScript(task: RunnableTask): string {
  const { groupName, name, body, mode } = task;
  const title = `${groupName} > ${name} - [${mode}]`;
  const fence = `# ${"-".repeat(title.length)}`;

  const operations: string[] = [];
  for (const registry of body.registries) {
    const pathOperation = registryPathOperation(registry, mode);
    if (pathOperation !== "") {
      operations.push(pathOperation);
    }
    for (const entry of registry.entries) {
      operations.push(registryEntryOperation(entry, registry.path, mode));
    }
  }
  for (const schtask of body.scheduled_tasks) {
    operations.push(schtaskOperation(schtask, mode));
  }
  const rawScript = (mode === "apply" ? body.script.apply : body.script.revert).trim();

  const call = `Invoke-WinconfigTask ${psSingleQuoted(`${groupName} > ${name}`)} '${mode}'`;
  const lines: string[] = [];
  if (operations.length > 0 && rawScript !== "") {
    lines.push(
      `${call} {`,
      indentLines(operations.join("\n"), "    "),
      "} -RawScript {",
      indentLines(rawScript, "    "),
      "}",
    );
  } else if (operations.length > 0) {
    lines.push(`${call} {`, indentLines(operations.join("\n"), "    "), "}");
  } else if (rawScript !== "") {
    lines.push(`${call} -RawScript {`, indentLines(rawScript, "    "), "}");
  } else {
    lines.push(call);
  }

  lines[0] = `$taskResult = ${lines[0]!}`;
  lines.push("Write-WinconfigTaskReport $taskResult");
  return [fence, `# ${title}`, fence, "", ...lines].join("\n") + "\n";
}

const PS_HELPERS = `
function Get-WinconfigFailureReason {
    param([System.Management.Automation.ErrorRecord] $ErrorRecord)
    if ($ErrorRecord.Exception -is [System.UnauthorizedAccessException] -or $ErrorRecord.Exception -is [System.Security.SecurityException]) {
        'permission denied (administrator privileges are required)'
    } else {
        "error: $($ErrorRecord.Exception.Message)"
    }
}

function Add-WinconfigSuccess {
    param([string] $Reason)
    if (-not $script:WinconfigTask.succeeded) {
        $script:WinconfigTask.succeeded = $true
        $script:WinconfigTask.reason = $Reason
    }
}

function Add-WinconfigFailure {
    param([string] $Reason)
    if (-not $script:WinconfigTask.failed) {
        $script:WinconfigTask.failed = $true
        $script:WinconfigTask.reason = $Reason
    }
}

function Invoke-WinconfigTask {
    param(
        [string] $FullName,
        [string] $Mode,
        [scriptblock] $Operations = {},
        [scriptblock] $RawScript
    )
    $script:WinconfigTask = @{ failed = $false; succeeded = $false; reason = 'no operations' }
    $rawOutput = [System.Collections.Generic.List[string]]::new()
    try {
        & $Operations | ForEach-Object { $rawOutput.Add([string] $_) }
    } catch {
        Add-WinconfigFailure (Get-WinconfigFailureReason $_)
    }
    $rawCompleted = $false
    if ($null -ne $RawScript -and -not $script:WinconfigTask.failed) {
        try {
            & $RawScript | ForEach-Object { $rawOutput.Add([string] $_) }
            $rawCompleted = $true
        } catch {
            Add-WinconfigFailure (Get-WinconfigFailureReason $_)
        }
    }
    if ($rawCompleted) {
        Add-WinconfigSuccess 'script completed'
    }
    $task = $script:WinconfigTask
    $script:WinconfigTask = $null
    $status = if ($task.failed) { 'failed' } elseif ($task.succeeded) { 'success' } else { 'skipped' }
    [pscustomobject]@{
        fullName = $FullName
        mode = $Mode
        status = $status
        reason = $task.reason
        rawOutput = $rawOutput.ToArray()
    }
}

function New-RegistryPath {
    param([string] $Path)
    if ($script:WinconfigTask.failed) { return }
    try {
        if (Test-Path -LiteralPath $Path) {
            Add-WinconfigSuccess 'key already present'
            return
        }
        New-Item -Path $Path -Force -ErrorAction Stop | Out-Null
        Add-WinconfigSuccess 'key created'
    } catch {
        Add-WinconfigFailure (Get-WinconfigFailureReason $_)
    }
}

function Remove-RegistryPath {
    param([string] $Path)
    if ($script:WinconfigTask.failed) { return }
    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            Add-WinconfigSuccess 'already absent'
            return
        }
        Remove-Item -LiteralPath $Path -Force -Recurse -ErrorAction Stop | Out-Null
        Add-WinconfigSuccess 'key removed'
    } catch {
        Add-WinconfigFailure (Get-WinconfigFailureReason $_)
    }
}

function Set-RegistryEntry {
    param(
        [string] $Path,
        [string] $Name,
        [string] $Type,
        $Value
    )
    if ($script:WinconfigTask.failed) { return }
    try {
        if ($Type -eq "Binary") {
            $Value = "$Value".Split(" ") | ForEach-Object { [byte]$_ }
        }
        Set-ItemProperty -LiteralPath $Path -Name $Name -Type $Type -Value $Value -Force -ErrorAction Stop | Out-Null
        Add-WinconfigSuccess 'value set'
    } catch [System.Management.Automation.ItemNotFoundException], [System.Management.Automation.PSArgumentException] {
        Add-WinconfigFailure "target not found: registry value $Path $Name"
    } catch {
        Add-WinconfigFailure (Get-WinconfigFailureReason $_)
    }
}

function Remove-RegistryEntry {
    param(
        [string] $Path,
        [string] $Name
    )
    if ($script:WinconfigTask.failed) { return }
    try {
        Remove-ItemProperty -LiteralPath $Path -Name $Name -Force -ErrorAction Stop | Out-Null
        Add-WinconfigSuccess 'value removed'
    } catch [System.Management.Automation.ItemNotFoundException], [System.Management.Automation.PSArgumentException] {
        Add-WinconfigSuccess 'already absent'
    } catch {
        Add-WinconfigFailure (Get-WinconfigFailureReason $_)
    }
}

function Write-WinconfigLog {
    param([string] $Message)
    [Console]::Error.WriteLine(('{0:HH:mm:ss.fff} | {1}' -f [DateTime]::Now, $Message))
}

function Format-WinconfigResultText {
    param([string] $Text, [int] $Color)
    if ($script:WinconfigUseColor) {
        '{0}[{1}m{2}{0}[0m' -f [char]27, $Color, $Text
    } else {
        $Text
    }
}

function Write-WinconfigTaskReport {
    param([pscustomobject] $Result)
    foreach ($line in $Result.rawOutput) {
        Write-Output $line
    }
    $labels = @{ 'success' = 'Success'; 'failed' = 'TaskError'; 'skipped' = 'Skipped' }
    $colors = @{ 'success' = 32; 'failed' = 31; 'skipped' = 33 }
    $color = $colors[$Result.status]
    $label = Format-WinconfigResultText $labels[$Result.status] $color
    if ($Result.status -eq 'success') {
        Write-WinconfigLog ('{0}: {1}[{2}]' -f $label, $Result.fullName, $Result.mode)
    } else {
        $reason = Format-WinconfigResultText $Result.reason $color
        Write-WinconfigLog ('{0}: {1}[{2}] - {3}' -f $label, $Result.fullName, $Result.mode, $reason)
    }
    $script:WinconfigCounts[$Result.status] += 1
}

function Write-WinconfigSummary {
    $counts = $script:WinconfigCounts
    [Console]::Error.WriteLine()
    [Console]::Error.WriteLine(('─' * 40))
    $failedCount = [string] $counts['failed']
    if ($script:WinconfigUseColor -and $counts['failed'] -gt 0) {
        $failedCount = Format-WinconfigResultText $failedCount 31
    }
    [Console]::Error.WriteLine(('Summary: success={0} failed={1} skipped={2}' -f $counts['success'], $failedCount, $counts['skipped']))
    if ($counts['failed'] -gt 0) {
        exit 1
    }
    exit 0
}
`;

export function generateScript(
  runnables: RunnableTask[],
  { colorEnabled = false }: { colorEnabled?: boolean } = {},
): string {
  const sections = [
    "$ErrorActionPreference = 'Stop'",
    "",
    PS_HELPERS,
    `$script:WinconfigUseColor = $${colorEnabled}`,
    "$script:WinconfigCounts = @{ success = 0; failed = 0; skipped = 0 }",
    "",
    ...runnables.map((task) => generateTaskScript(task)),
    "Write-WinconfigSummary",
    "",
  ];
  return sections.join("\n");
}

export function loadConfig(dir: string): Config {
  const definitions = parseDefinitions(
    parseYaml(readFileSync(join(dir, "definitions.yaml"), "utf8")),
  );
  const actions = parseActions(parseYaml(readFileSync(join(dir, "actions.yaml"), "utf8")));
  validateActionReferences(definitions, actions);
  return { definitions, actions };
}

export interface ExecutionRuntime {
  platform: NodeJS.Platform;
  which: (command: string) => string | null;
  execute: (command: string[]) => Promise<number>;
}

async function executeCommand(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  return child.exited;
}

const EXECUTION_RUNTIME: ExecutionRuntime = {
  platform: process.platform,
  which: Bun.which,
  execute: executeCommand,
};

async function executeScript(script: string, runtime: ExecutionRuntime): Promise<number> {
  if (runtime.platform !== "win32") {
    writeLog("winconfig: execution requires Windows");
    return 1;
  }
  const gsudoPath = runtime.which("gsudo");
  if (gsudoPath === null) {
    writeLog("winconfig: gsudo was not found in PATH");
    return 1;
  }
  const powershellPath = runtime.which("pwsh") ?? runtime.which("powershell");
  if (powershellPath === null) {
    writeLog("winconfig: neither pwsh nor powershell was found in PATH");
    return 1;
  }
  const scriptPath = join(tmpdir(), `winconfig-${process.pid}.ps1`);
  writeFileSync(scriptPath, "\uFEFF" + script, "utf8");
  try {
    return await runtime.execute([
      gsudoPath,
      powershellPath,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]);
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

interface CliOptions {
  reverse: boolean;
  printOnly: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const unknownArgs = argv.filter((arg) => arg !== "revert" && arg !== "--print");
  if (unknownArgs.length > 0) {
    throw new Error(
      `unknown arguments: ${unknownArgs.join(" ")} (usage: bun engine.ts [revert] [--print])`,
    );
  }
  return { reverse: argv.includes("revert"), printOnly: argv.includes("--print") };
}

function writeLog(message: string): void {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const milliseconds = String(now.getMilliseconds()).padStart(3, "0");
  process.stderr.write(`${time}.${milliseconds} | ${message}\n`);
}

export async function main(
  argv: string[],
  runtime: ExecutionRuntime = EXECUTION_RUNTIME,
): Promise<number> {
  const options = parseArgs(argv);
  const colorEnabled = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;
  const { definitions, actions } = loadConfig(import.meta.dir);
  const { runnables, notices } = selectRunnableTasks(definitions, actions, options.reverse);
  for (const notice of notices) {
    const message = colorEnabled ? notice.replace("Skipped", "\x1b[33mSkipped\x1b[0m") : notice;
    writeLog(message);
  }
  const script = generateScript(runnables, { colorEnabled: !options.printOnly && colorEnabled });
  if (options.printOnly) {
    process.stdout.write(script);
    return 0;
  }
  return executeScript(script, runtime);
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      writeLog(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
