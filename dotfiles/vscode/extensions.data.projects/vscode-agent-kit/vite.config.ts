import { defineConfig } from "vite";

// Webview client bundle: a single self-contained ES module with React inlined,
// loaded by the webview HTML as <script type="module" src=".../webview/client.js">.
// The output path matches the URI the session webview provider references.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
});
