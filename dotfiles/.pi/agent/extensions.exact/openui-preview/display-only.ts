/**
 * Components excluded from the display-only openui-lang library, plus the
 * text-marker helper used to drop prompt material that demonstrates them.
 *
 * Kept dependency-free so it can be imported both by runtime code (prompt.ts)
 * and by the build-time library definition (library.data.ts, consumed by the
 * openui CLI through the build hook).
 */

/** Components that accept user input or trigger actions. */
export const INTERACTIVE_COMPONENTS = [
  // Submit / actions
  "Button",
  "Buttons",
  "IconButton",
  // Forms (Label only exists to label a FormControl)
  "Form",
  "FormControl",
  "Label",
  "Input",
  "TextArea",
  "Select",
  "SelectItem",
  "DatePicker",
  "Slider",
  "SwitchGroup",
  "SwitchItem",
  "RadioGroup",
  "RadioItem",
  "CheckBoxGroup",
  "CheckBoxItem",
  "Chips",
  "ChipItem",
  "OptionCards",
  "OptionCard",
  // Editing / dialogs
  "EditableTable",
  "Modal",
] as const;

/** Text markers of the excluded components (group notes, examples, rules). */
export const INTERACTIVE_HINTS = [
  ...INTERACTIVE_COMPONENTS,
  "@Reset",
  "Action(",
];

export const mentionsInteractive = (text: string) =>
  INTERACTIVE_HINTS.some((hint) => text.includes(hint));
