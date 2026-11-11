const INTERACTIVE_HINTS = [
  // Submit / actions
  "Button",
  "Buttons",
  "IconButton",
  // Forms
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
  "@Reset",
  "Action(",
];

export function mentionsInteractive(text: string): boolean {
  return INTERACTIVE_HINTS.some((hint) => text.includes(hint));
}
