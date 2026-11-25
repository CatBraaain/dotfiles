import { createLibrary, type Library } from "@openuidev/react-lang";
import { openuiComponentGroups, openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { openuiPromptOptions } from "@openuidev/react-ui/genui-lib/prompt-options";
import { mentionsInteractive } from "./display-only";
import { SUPPORTED_COMPONENTS } from "./supported-components";

const supported = new Set<string>(SUPPORTED_COMPONENTS);
const componentNames = new Set(Object.keys(openuiLibrary.components));

function mentionsUnselectedComponent(text: string): boolean {
  const references = text.replace(
    /^(- )?(?:Image (?:with|block)|Text (?:block|callout)|Card blocks)\b/,
    (phrase) => phrase.toLowerCase(),
  );
  return [...references.matchAll(/\b([A-Z]\w*)(\*)?/g)].some((match) => {
    const name = match[1]!;
    if (match[2]) {
      return [...componentNames].some(
        (candidate) => candidate.startsWith(name) && !supported.has(candidate),
      );
    }
    const singular = componentNames.has(name) ? name : name.replace(/s$/, "");
    return componentNames.has(singular) && !supported.has(singular);
  });
}

export const displayLibrary: Library = createLibrary({
  components: Object.entries(openuiLibrary.components)
    .filter(([name]) => supported.has(name))
    .map(([, component]) => ({
      ...component,
      description: mentionsUnselectedComponent(component.description) ? "" : component.description,
    })),
  componentGroups: openuiComponentGroups
    .map((group) => ({
      ...group,
      components: group.components.filter((name) => supported.has(name)),
      notes: (group.notes ?? []).filter(
        (note) => !mentionsInteractive(note) && !mentionsUnselectedComponent(note),
      ),
    }))
    .filter((group) => group.components.length > 0),
  root: openuiLibrary.root && supported.has(openuiLibrary.root) ? openuiLibrary.root : undefined,
});

export const displayPromptOptions = {
  examples: (openuiPromptOptions.examples ?? []).filter((example) => !mentionsInteractive(example)),
  additionalRules: [
    ...(openuiPromptOptions.additionalRules ?? []).filter(
      (rule) => !mentionsInteractive(rule) && !mentionsUnselectedComponent(rule),
    ),
    "Use existing components (Tabs, Accordion) before inventing ternary show/hide patterns",
  ],
};

export { displayLibrary as library };
export { displayPromptOptions as promptOptions };
