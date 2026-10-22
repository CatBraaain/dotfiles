import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-webview/**",
      "node_modules/**",
      "storybook-static/**",
    ],
  },
  {
    files: ["tests/support/*.cjs"],
    languageOptions: {
      globals: {
        require: "readonly",
        exports: "readonly",
        process: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["tests/support/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
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
