import type { Preview } from "@storybook/react";
import { createElement } from "react";
import "./theme.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      defaultValue: "dark",
      description: "dsh color theme",
      toolbar: { items: ["light", "dark"] },
    },
  },
  decorators: [
    (Story, context) =>
      createElement(
        "div",
        { className: "dsh-storybook", "data-theme": context.globals.theme },
        createElement(Story),
      ),
  ],
};

export default preview;
