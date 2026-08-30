import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { parse as parseYaml } from "yaml";

export const RULES_STATUS_KEY = "rules";
export const RULES_MESSAGE_TYPE = "rules";

export interface Rule {
  readonly id: string;
  readonly filePath: string;
  readonly displayPath: string;
  readonly relativePath: string;
  readonly name: string;
  readonly paths: readonly string[] | undefined;
  readonly body: string;
}

export interface RuleState {
  readonly rules: readonly Rule[];
  readonly activeRuleIds: Set<string>;
  readonly injectedRuleIds: Set<string>;
}

type RuleSource = {
  readonly directory: string;
  readonly displayDirectory: string;
  readonly extension: ".md" | ".mdc";
};

const PROJECT_RULE_SOURCES: readonly (Omit<RuleSource, "directory" | "displayDirectory"> & {
  readonly relativeDirectory: string;
})[] = [
  { relativeDirectory: ".pi/agent/rules", extension: ".md" },
  { relativeDirectory: ".claude/rules", extension: ".md" },
  { relativeDirectory: ".cursor/rules", extension: ".mdc" },
  { relativeDirectory: ".devin/rules", extension: ".md" },
  { relativeDirectory: ".windsurf/rules", extension: ".md" },
];

const GLOBAL_RULE_SOURCES: readonly RuleSource[] = [
  { directory: "", displayDirectory: "~/.pi/agent/rules", extension: ".md" },
  { directory: "", displayDirectory: "~/.claude/rules", extension: ".md" },
];

function normalizeSlashes(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function ruleName(filePath: string): string {
  return basename(filePath, extname(filePath));
}

async function collectRuleFiles(
  directory: string,
  extension: RuleSource["extension"],
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const filePaths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...(await collectRuleFiles(entryPath, extension)));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === extension) filePaths.push(entryPath);
  }
  return filePaths.sort((left, right) =>
    normalizeSlashes(left).localeCompare(normalizeSlashes(right)),
  );
}

function parseRuleContent(
  content: string,
): { paths: readonly string[] | undefined; body: string } | undefined {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { paths: undefined, body: content };
  }

  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/);
  if (!frontmatter) return undefined;

  try {
    const parsed = parseYaml(frontmatter[1] ?? "") as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const paths = (parsed as { paths?: unknown }).paths;
    if (paths === undefined)
      return { paths: undefined, body: content.slice(frontmatter[0].length) };
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) return undefined;
    return { paths, body: content.slice(frontmatter[0].length) };
  } catch {
    return undefined;
  }
}

async function readRule(
  filePath: string,
  displayPath: string,
  relativePath: string,
  sourceId: string,
  onWarning?: (message: string) => void,
): Promise<Rule | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = parseRuleContent(content);
    if (!parsed) {
      onWarning?.(`Skipped rule ${displayPath}: malformed frontmatter`);
      return undefined;
    }
    return {
      id: `${sourceId}:${relativePath}`,
      filePath,
      displayPath,
      relativePath,
      name: ruleName(filePath),
      paths: parsed.paths,
      body: parsed.body,
    };
  } catch {
    onWarning?.(`Skipped rule ${displayPath}: failed to read rule file`);
    return undefined;
  }
}

function homeDisplayPath(homeDirectory: string, filePath: string): string {
  return `~/${normalizeSlashes(relative(homeDirectory, filePath))}`;
}

export function deduplicateRules(rules: readonly Rule[]): Rule[] {
  const seenRelativePaths = new Set<string>();
  return rules.filter((rule) => {
    if (seenRelativePaths.has(rule.relativePath)) return false;
    seenRelativePaths.add(rule.relativePath);
    return true;
  });
}

export async function discoverRules(
  projectRoot: string,
  homeDirectory = homedir(),
  onWarning?: (message: string) => void,
): Promise<Rule[]> {
  const discoveredRules: Rule[] = [];

  for (const source of PROJECT_RULE_SOURCES) {
    const directory = join(projectRoot, source.relativeDirectory);
    const filePaths = await collectRuleFiles(directory, source.extension);
    for (const filePath of filePaths) {
      const relativePath = normalizeSlashes(relative(directory, filePath));
      const rule = await readRule(
        filePath,
        `${source.relativeDirectory}/${relativePath}`,
        relativePath,
        source.relativeDirectory,
        onWarning,
      );
      if (rule) discoveredRules.push(rule);
    }
  }

  for (const source of GLOBAL_RULE_SOURCES) {
    const directory = join(homeDirectory, source.displayDirectory.slice(2));
    const filePaths = await collectRuleFiles(directory, source.extension);
    for (const filePath of filePaths) {
      const relativePath = normalizeSlashes(relative(directory, filePath));
      const rule = await readRule(
        filePath,
        homeDisplayPath(homeDirectory, filePath),
        relativePath,
        source.displayDirectory,
        onWarning,
      );
      if (rule) discoveredRules.push(rule);
    }
  }

  const globalWindsurfPath = join(homeDirectory, ".codeium/windsurf/memories/global_rules.md");
  if (existsSync(globalWindsurfPath)) {
    const rule = await readRule(
      globalWindsurfPath,
      homeDisplayPath(homeDirectory, globalWindsurfPath),
      "global_rules.md",
      "~/.codeium/windsurf/memories",
      onWarning,
    );
    if (rule) discoveredRules.push(rule);
  }

  return deduplicateRules(discoveredRules);
}

function projectRelativePath(filePath: string, projectRoot: string): string | undefined {
  const normalizedInput = normalizeSlashes(filePath);
  if (/^[A-Za-z]:\//.test(normalizedInput)) return undefined;

  const absoluteProjectRoot = resolve(projectRoot);
  const absoluteFilePath = isAbsolute(normalizedInput)
    ? resolve(normalizedInput)
    : resolve(projectRoot, normalizedInput);
  const relativeFilePath = normalizeSlashes(relative(absoluteProjectRoot, absoluteFilePath));
  if (
    relativeFilePath === "" ||
    relativeFilePath === ".." ||
    relativeFilePath.startsWith("../") ||
    isAbsolute(relativeFilePath)
  ) {
    return undefined;
  }
  return relativeFilePath;
}

export function globToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeSlashes(pattern).replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern.charAt(index);
    if (character === "*") {
      if (normalizedPattern[index + 1] === "*") {
        index += 1;
        if (normalizedPattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`);
}

export function matchesPathGlob(filePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizeSlashes(filePath));
}

export function createRuleState(rules: readonly Rule[]): RuleState {
  return {
    rules,
    activeRuleIds: new Set(
      rules.filter((rule) => !rule.paths || rule.paths.length === 0).map((rule) => rule.id),
    ),
    injectedRuleIds: new Set(),
  };
}

export function activateRulesForFile(
  state: RuleState,
  filePath: string,
  projectRoot: string,
): void {
  const relativeFilePath = projectRelativePath(filePath, projectRoot);
  if (!relativeFilePath) return;

  for (const rule of state.rules) {
    if (state.activeRuleIds.has(rule.id) || !rule.paths || rule.paths.length === 0) continue;
    if (rule.paths.some((pattern) => matchesPathGlob(relativeFilePath, pattern)))
      state.activeRuleIds.add(rule.id);
  }
}

export function activeRules(state: RuleState): Rule[] {
  return state.rules.filter((rule) => state.activeRuleIds.has(rule.id));
}

export function buildRulesMessage(rules: readonly Rule[]): string | undefined {
  if (rules.length === 0) return undefined;
  const sections = rules.map((rule) => `### ${rule.displayPath}\n${rule.body}`);
  return `## Rules\n\n${sections.join("\n\n")}`;
}

export function newlyActivatedRules(state: RuleState): Rule[] {
  return state.rules.filter(
    (rule) => state.activeRuleIds.has(rule.id) && !state.injectedRuleIds.has(rule.id),
  );
}

export function markRulesInjected(state: RuleState, rules: readonly Rule[]): void {
  for (const rule of rules) state.injectedRuleIds.add(rule.id);
}

export function buildRulesWidgetLines(rules: readonly Rule[]): string[] | undefined {
  if (rules.length === 0) return undefined;
  const names = rules.map((rule, _, allRules) => {
    const duplicateName = allRules.some(
      (candidate) => candidate !== rule && candidate.name === rule.name,
    );
    return duplicateName ? `${rule.name} (${rule.displayPath})` : rule.name;
  });
  return [`📜 rules: ${names.join(", ")}`];
}

export function updateRulesWidget(ui: ExtensionUIContext, rules: readonly Rule[]): void {
  const lines = buildRulesWidgetLines(rules);
  if (!lines) {
    ui.setWidget(RULES_STATUS_KEY, undefined);
    return;
  }
  ui.setWidget(
    RULES_STATUS_KEY,
    (_tui, theme) => ({
      render: (width) => lines.map((line) => truncateToWidth(theme.fg("muted", line), width)),
      invalidate: () => {},
    }),
    { placement: "aboveEditor" },
  );
}

function isFileOperationTool(toolName: string): boolean {
  return toolName === "read" || toolName === "write" || toolName === "edit";
}

function inputFilePath(input: Record<string, unknown>): string | undefined {
  return typeof input.path === "string" ? input.path : undefined;
}

export default function rulesExtension(pi: ExtensionAPI): void {
  let state: RuleState = createRuleState([]);
  let projectRoot = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = ctx.cwd;
    const notifyWarning = ctx.hasUI
      ? (message: string) => ctx.ui.notify(message, "warning")
      : undefined;
    state = createRuleState(await discoverRules(projectRoot, homedir(), notifyWarning));
    if (ctx.hasUI) updateRulesWidget(ctx.ui, activeRules(state));
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.isError || !isFileOperationTool(event.toolName)) return;
    const filePath = inputFilePath(event.input);
    if (filePath) activateRulesForFile(state, filePath, projectRoot);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.hasUI) updateRulesWidget(ctx.ui, activeRules(state));
    const pending = newlyActivatedRules(state);
    if (pending.length === 0) return;
    const content = buildRulesMessage(pending);
    if (!content) return;
    markRulesInjected(state, pending);
    return {
      message: {
        customType: RULES_MESSAGE_TYPE,
        content,
        display: false,
      },
    };
  });
}
