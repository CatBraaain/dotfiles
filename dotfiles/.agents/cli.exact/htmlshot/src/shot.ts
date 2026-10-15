import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildEnvelope, insertMetadata, type RenderSettings } from "./format";
import { scanViolations, type Violation } from "./scan";

export class ConstraintError extends Error {
  constructor(readonly violations: Violation[]) {
    super(`constraint violations: ${violations.length}`);
  }
}

export type ShotSettings = {
  output?: string;
  width: number;
  height: number;
  scale: number;
  unsafe: boolean;
};

const PATH_BROWSERS = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
const VIRTUAL_TIME_BUDGET_MILLISECONDS = 5000;
const RENDER_TIMEOUT_MILLISECONDS = 30000;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function resolveBrowser(): string | null {
  const envBrowser = process.env.HTMLSHOT_BROWSER;
  if (envBrowser !== undefined) {
    if (!existsSync(envBrowser)) throw new Error(`HTMLSHOT_BROWSER points to a missing file: ${envBrowser}`);
    return envBrowser;
  }
  const playwrightDir = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(playwrightDir)) {
    const versions = readdirSync(playwrightDir)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)));
    for (const version of versions) {
      const browserPath = ["chrome-linux64", "chrome-linux"]
        .map((layout) => join(playwrightDir, version, layout, "chrome"))
        .find((path) => existsSync(path));
      if (browserPath !== undefined) return browserPath;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const name of PATH_BROWSERS) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function shotFile(inputPath: string, settings: ShotSettings): Promise<string> {
  const html = utf8Decoder.decode(readFileSync(inputPath));
  const violations = scanViolations(html);
  if (violations.length > 0 && !settings.unsafe) throw new ConstraintError(violations);
  for (const { line, kind, snippet } of violations) {
    console.error(`${inputPath}:${line}: ${kind}: ${snippet}`);
  }
  const browserPath = resolveBrowser();
  if (browserPath === null) throw new Error("no chromium browser found (set HTMLSHOT_BROWSER)");
  const render: RenderSettings = { width: settings.width, height: settings.height, scale: settings.scale };
  const bound = insertMetadata(renderPng(browserPath, inputPath, render), buildEnvelope(html, render));
  const outputPath = settings.output ?? defaultBindOutput(inputPath);
  writeFileSync(outputPath, bound);
  return `shot: ${outputPath} (${render.width}x${render.height}@${render.scale}x, html ${Buffer.byteLength(html, "utf8")} bytes)`;
}

function renderPng(browserPath: string, htmlPath: string, render: RenderSettings): Buffer {
  const tempDir = mkdtempSync(join(tmpdir(), "htmlshot-"));
  const screenshotPath = join(tempDir, "shot.png");
  try {
    const result = spawnSync(
      browserPath,
      [
        "--headless",
        `--screenshot=${screenshotPath}`,
        `--window-size=${render.width},${render.height}`,
        `--force-device-scale-factor=${render.scale}`,
        "--hide-scrollbars",
        `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MILLISECONDS}`,
        pathToFileURL(htmlPath).href,
      ],
      { timeout: RENDER_TIMEOUT_MILLISECONDS },
    );
    if (result.error !== undefined || result.status !== 0 || !existsSync(screenshotPath)) {
      const cause = result.error?.message ?? `exit ${result.status}`;
      const lastErrorLine = result.stderr?.toString().trim().split("\n").pop() ?? "";
      throw new Error(`render failed (${cause}): ${lastErrorLine}`);
    }
    return readFileSync(screenshotPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function defaultBindOutput(inputPath: string): string {
  return `${inputPath.replace(/\.html$/i, "")}.htmlshot.png`;
}
