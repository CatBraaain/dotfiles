/**
 * System prompt section for openui-lang authoring.
 *
 * Port of agent-open-ui's display-only prompt pipeline (src/lib/cloud-prompt.ts
 * and src/lib/prompt-options.ts): the full LibrarySpec signatures with every
 * interactive component name replaced by `never`, the built-in Action section
 * and ActionExpression explainer dropped, and a markdown-embedding preamble
 * instead of lang-core's whole-response default.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSystemPrompt, type LibrarySpec } from "@openuidev/lang-core";
import { INTERACTIVE_COMPONENTS } from "./display-only";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const interactiveComponents = new Set<string>(INTERACTIVE_COMPONENTS);

function displayOnlySignature(signature: string): string {
  return signature
    .replace(/\b[A-Z]\w*(?:\s*\|\s*[A-Z]\w*)+/g, (union) =>
      union
        .split(/\s*\|\s*/)
        .filter((name) => !interactiveComponents.has(name))
        .join(" | "),
    )
    .replace(/\b[A-Z]\w*\b/g, (name) => (interactiveComponents.has(name) ? "never" : name));
}

const PREAMBLE = `You are an AI assistant that answers in markdown. When a response benefits from a generated UI, embed complete openui-lang programs in fenced \`\`\`openui-lang code blocks inside your markdown answer.`;

/**
 * Drop the generated prompt's interactive-authoring parts: the built-in
 * `## Action — Button Behavior` section and the `ActionExpression` explainer
 * line, which teach Button/Action usage the display-only library excludes.
 */
function stripInteractivePromptParts(prompt: string): string {
  const start = prompt.indexOf("\n## Action");
  const withoutSection =
    start === -1
      ? prompt
      : (() => {
          const next = prompt.indexOf("\n## ", start + 1);
          return next === -1 ? prompt.slice(0, start) : prompt.slice(0, start) + prompt.slice(next);
        })();
  return withoutSection
    .split("\n")
    .filter((line) => !line.startsWith("Props typed `ActionExpression`"))
    .join("\n");
}



/** Name of the system prompt section this extension contributes. */
export const PROMPT_SECTION_NAME = "openui-lang";

interface PromptOptionsFile {
  examples: string[];
  additionalRules: string[];
}

const promptCache = new Map<string, string>();

/**
 * The display-only openui-lang instructions for the system prompt section,
 * generated from the build-time files (spec.json and prompt-options.json,
 * both produced by spec.build.ts from library.data.ts). Cached per directory.
 */
export function opuiInstructions(dir: string = EXTENSION_DIR): string {
  const cached = promptCache.get(dir);
  if (cached !== undefined) return cached;
  const library = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as LibrarySpec;
  const promptOptions = JSON.parse(
    readFileSync(join(dir, "prompt-options.json"), "utf8"),
  ) as PromptOptionsFile;
  const prompt = stripInteractivePromptParts(
    generateSystemPrompt({
      library: {
        ...library,
        components: Object.fromEntries(
          Object.entries(library.components).map(([name, component]) => [
            name,
            {
              ...component,
              signature: displayOnlySignature(component.signature),
            },
          ]),
        ),
      },
      promptOptions: {
        preamble: PREAMBLE,
        examples: promptOptions.examples,
        additionalRules: promptOptions.additionalRules,
      },
    }),
  );
  promptCache.set(dir, prompt);
  return prompt;
}
