import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

let generatePreviewFiles: (distWebviewDir: string) => Promise<Record<string, string>>;

beforeEach(async () => {
  ({ generatePreviewFiles } = await import("../scripts/generate-preview.mjs"));
});

const repoRoot = process.cwd();

describe("generatePreviewFiles", () => {
  it("committed preview files are in sync with the generator output", async () => {
    const files = await generatePreviewFiles(join(repoRoot, "dist-webview"));
    const paths = Object.keys(files);

    expect(paths).toEqual(
      expect.arrayContaining([
        "preview/index.html",
        "preview/app.css",
        "preview/lib/client.js",
        "preview/lib/grouping.js",
        "preview/lib/viewMode.js",
      ]),
    );

    for (const [relativePath, content] of Object.entries(files)) {
      const committed = await readFile(join(repoRoot, relativePath), "utf8");
      expect(committed, `${relativePath} is stale; run "npm run build" and commit the result`).toBe(content);
    }
  });
});
