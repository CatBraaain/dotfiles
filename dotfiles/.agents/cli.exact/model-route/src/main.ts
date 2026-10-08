// Entry of `bun ~/.agents/cli/model-route` (bun resolves package.json "main" to this file).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WHEN_TIMEOUT_MS = 5_000;

interface Candidate {
  provider: string;
  model: string;
  when?: string;
}

interface Config {
  classByAgent: Map<string, string>;
  candidatesByClass: Map<string, Candidate[]>;
}

type RouteRequest = { kind: "agent"; name: string } | { kind: "class"; name: string };

async function selectModel(): Promise<void> {
  const request = parseRouteRequest(process.argv.slice(2));
  const config = await loadConfig(configPath());
  const className = resolveClassName(config, request);
  const candidates = config.candidatesByClass.get(className);
  if (candidates === undefined) failNoCandidate(request, className);
  for (const candidate of candidates) {
    if (!(await isSatisfied(candidate.when))) continue;
    console.log(JSON.stringify({ provider: candidate.provider, model: candidate.model }));
    return;
  }
  failNoCandidate(request, className);
}

function parseRouteRequest(argv: string[]): RouteRequest {
  let agent: string | undefined;
  let className: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag !== "--agent" && flag !== "--class") throw new Error(`unsupported argument: ${flag}`);
    const name = argv[index + 1];
    if (name === undefined || name.startsWith("-")) throw new Error(`missing value for ${flag}`);
    index++;
    if (flag === "--agent") agent = name;
    else className = name;
  }
  if (agent !== undefined && className !== undefined)
    throw new Error("--agent and --class are mutually exclusive");
  if (agent !== undefined) return { kind: "agent", name: agent };
  if (className !== undefined) return { kind: "class", name: className };
  throw new Error("specify exactly one of --agent <name> or --class <name>");
}

async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path}: cannot read config file (${errorMessage(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid YAML (${errorMessage(error)})`);
  }
  return validateConfig(path, parsed);
}

function validateConfig(path: string, parsed: unknown): Config {
  if (!isMapping(parsed)) throw new Error(`${path}: config must be a YAML mapping`);
  if (!isMapping(parsed.agents)) throw new Error(`${path}: agents must be a mapping`);
  if (!isMapping(parsed.classes)) throw new Error(`${path}: classes must be a mapping`);
  const classByAgent = parseAgents(path, parsed.agents);
  const candidatesByClass = parseClasses(path, parsed.classes);
  for (const [name, className] of classByAgent) {
    if (!candidatesByClass.has(className))
      throw new Error(`${path}: agents.${name} references undefined class "${className}"`);
  }
  return { classByAgent, candidatesByClass };
}

function parseAgents(path: string, agents: Record<string, unknown>): Map<string, string> {
  const classByAgent = new Map<string, string>();
  for (const [name, definition] of Object.entries(agents)) {
    if (!isMapping(definition)) throw new Error(`${path}: agents.${name} must be a mapping`);
    if (!isNotBlank(definition.class))
      throw new Error(`${path}: agents.${name}.class must be a non-empty string`);
    classByAgent.set(name, definition.class);
  }
  return classByAgent;
}

function parseClasses(path: string, classes: Record<string, unknown>): Map<string, Candidate[]> {
  const candidatesByClass = new Map<string, Candidate[]>();
  for (const [name, candidates] of Object.entries(classes)) {
    if (!Array.isArray(candidates)) throw new Error(`${path}: classes.${name} must be an array`);
    const parsed = candidates.map((candidate, index) =>
      parseCandidate(candidate, `${path}: classes.${name}[${index}]`),
    );
    if (parsed.every((candidate) => hasCondition(candidate.when)))
      throw new Error(`${path}: classes.${name} has no unconditional fallback candidate`);
    candidatesByClass.set(name, parsed);
  }
  return candidatesByClass;
}

function parseCandidate(value: unknown, location: string): Candidate {
  if (!isMapping(value)) throw new Error(`${location}: candidate must be a mapping`);
  const { provider, model, when } = value;
  if (!isNotBlank(provider)) throw new Error(`${location}: provider must be a non-empty string`);
  if (!isNotBlank(model)) throw new Error(`${location}: model must be a non-empty string`);
  if (when !== undefined && typeof when !== "string")
    throw new Error(`${location}: when must be a string`);
  return when === undefined ? { provider, model } : { provider, model, when };
}

function resolveClassName(config: Config, request: RouteRequest): string {
  if (request.kind === "agent") {
    const className = config.classByAgent.get(request.name);
    if (className === undefined) throw new Error(`agent not found in config: ${request.name}`);
    return className;
  }
  if (!config.candidatesByClass.has(request.name))
    throw new Error(`class not found in config: ${request.name}`);
  return request.name;
}

async function isSatisfied(when: string | undefined): Promise<boolean> {
  if (!hasCondition(when)) return true;
  try {
    const child = Bun.spawn(["bash", "-c", when], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: WHEN_TIMEOUT_MS,
    });
    const exitCode = await child.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

function hasCondition(when: string | undefined): when is string {
  return when !== undefined && when.trim() !== "";
}

function failNoCandidate(request: RouteRequest, className: string): never {
  const source = request.kind === "agent" ? `--agent ${request.name}` : `--class ${request.name}`;
  throw new Error(
    `no candidate selected for ${source} (class "${className}"): every candidate was skipped`,
  );
}

function configPath(): string {
  return join(homedir(), ".agents", "config", "agents.yaml");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

try {
  await selectModel();
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
