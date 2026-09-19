import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-webview/**", "node_modules/**", "storybook-static/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node's process/console for the screenshot CLI (TS sources resolve
    // globals via tseslint).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
      },
    },
  },
);
