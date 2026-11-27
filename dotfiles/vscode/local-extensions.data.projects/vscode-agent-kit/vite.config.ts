import { defineConfig } from "vite-plus";

// Single toolchain config for Vite+:
// - pack: extension host bundle (CommonJS for VS Code; the `vscode` module is
//   provided by the VS Code runtime itself)
// - build: webview client bundle, a single self-contained ES module with React
//   inlined, loaded by the webview HTML as
//   <script type="module" src=".../webview/client.js">; the output path
//   matches the URI the session webview provider references
// - test: Vitest settings (Vitest is bundled in Vite+)
// Markdown files are formatted with prettier (see the fmt:md npm script),
// so oxfmt skips them.
export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  fmt: { ignorePatterns: ["**/*.md"] },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    entry: ["src/extension.ts"],
    format: ["cjs"],
    deps: { neverBundle: ["vscode"] },
    target: "es2022",
  },
  build: {
    outDir: "dist-webview/webview",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    lib: {
      entry: "src/webview/client.tsx",
      formats: ["es"],
      fileName: () => "client.js",
    },
  },
  test: {
    environment: "node",
    include: ["tests/vitest/**/*.test.{ts,mts}"],
  },
});
