/**
 * Definition of the display-only openui-lang library, kept out of the home
 * tree by its `.data.` name.
 *
 * This file is the canonical source of `spec.json`: the apply hook
 * (spec.apply.ts) feeds it to the `openui` CLI, which serializes the library
 * (signatures, groups, JSON schema) next to the extension. Runtime code only
 * reads the generated files, so neither the extension nor the apply hook
 * depends on any project outside this repository.
 *
 * Structure mirrors @openuidev/react-ui's genui-lib: filter out the
 * interactive (input / submit) components and every prompt material that
 * demonstrates them, so the model is offered display-only parts only.
 */

import { createLibrary, type Library } from "@openuidev/react-lang";
import {
  openuiComponentGroups,
  openuiLibrary,
} from "@openuidev/react-ui/genui-lib";
import { openuiPromptOptions } from "@openuidev/react-ui/genui-lib/prompt-options";
import { INTERACTIVE_COMPONENTS, mentionsInteractive } from "./display-only";

const interactive = new Set<string>(INTERACTIVE_COMPONENTS);

export const displayLibrary: Library = createLibrary({
  components: Object.entries(openuiLibrary.components)
    .filter(([name]) => !interactive.has(name))
    .map(([, component]) => component),
  componentGroups: openuiComponentGroups
    .map((group) => ({
      ...group,
      components: group.components.filter((name) => !interactive.has(name)),
      notes: (group.notes ?? []).filter((note) => !mentionsInteractive(note)),
    }))
    .filter((group) => group.components.length > 0),
  root: openuiLibrary.root,
});

export const displayPromptOptions = {
  examples: (openuiPromptOptions.examples ?? []).filter(
    (example) => !mentionsInteractive(example),
  ),
  additionalRules: [
    ...(openuiPromptOptions.additionalRules ?? []).filter(
      (rule) => !mentionsInteractive(rule),
    ),
    "Use existing components (Tabs, Accordion) before inventing ternary show/hide patterns",
  ],
};

export { displayLibrary as library };
export { displayPromptOptions as promptOptions };
