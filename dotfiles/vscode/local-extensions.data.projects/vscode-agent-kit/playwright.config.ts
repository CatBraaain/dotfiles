import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  outputDir: "dist/test-results",
  reporter: [
    ["list"],
    ["./tests/support/e2eGalleryReporter.ts"],
    ["html", { outputFolder: "dist/playwright-report", open: "never" }],
    ["json", { outputFile: "dist/playwright-results.json" }],
  ],
});
