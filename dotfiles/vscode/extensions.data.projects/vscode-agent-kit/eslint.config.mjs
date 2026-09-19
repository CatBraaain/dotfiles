import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-webview/**", "node_modules/**", "preview/lib/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // Browser globals for the hand-written preview scripts; Node's process/console
    // for the generator CLI (TS sources resolve globals via tseslint).
    files: ["preview/*.mjs"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        Element: "readonly",
        HTMLElement: "readonly",
        HTMLButtonElement: "readonly",
        acquireVsCodeApi: "readonly",
        crypto: "readonly",
        process: "readonly",
        console: "readonly",
      },
    },
  },
);
