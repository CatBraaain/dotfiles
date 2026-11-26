import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
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
  scale?: number;
  unsafe: boolean;
};

const AUTO_SCALE_TARGET_WIDTH_PX = 1920;
const AUTO_SCALE_TARGET_HEIGHT_PX = 1080;
const AUTO_SCALE_MIN = 1;
const AUTO_SCALE_MAX = 3;

const PLAYWRIGHT_CHROMIUM_FILES = {
  other: [
    { directory: "chrome-linux64", executable: "chrome" },
    { directory: "chrome-linux", executable: "chrome" },
  ],
  win32: [
    { directory: "chrome-win64", executable: "chrome.exe" },
    { directory: "chrome-win", executable: "chrome.exe" },
  ],
} as const;
const VIRTUAL_TIME_BUDGET_MILLISECONDS = 5000;
const RENDER_TIMEOUT_MILLISECONDS = 30000;
const TRANSPARENT_BACKGROUND_COLOR = "00000000";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function browserCandidates(
  cacheDir: string,
  entries: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const isWindows = platform === "win32";
  const pathApi = isWindows ? win32 : posix;
  const layouts = isWindows ? PLAYWRIGHT_CHROMIUM_FILES.win32 : PLAYWRIGHT_CHROMIUM_FILES.other;
  const versions = entries
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)));
  return versions.flatMap((version) =>
    layouts.map(({ directory, executable }) =>
      pathApi.join(cacheDir, version, directory, executable),
    ),
  );
}

export function resolveBrowser(): string | null {
  const cacheHome =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const cacheDir = join(cacheHome, "ms-playwright");
  if (!existsSync(cacheDir)) return null;
  const candidates = browserCandidates(cacheDir, readdirSync(cacheDir), process.platform);
  return candidates.find((path) => statSync(path, { throwIfNoEntry: false })?.isFile()) ?? null;
}

export function resolveScale(width: number, height: number, requested?: number): number {
  if (requested !== undefined) return requested;
  const targetEdgePx = width >= height ? AUTO_SCALE_TARGET_WIDTH_PX : AUTO_SCALE_TARGET_HEIGHT_PX;
  const autoScale = Math.round(targetEdgePx / Math.max(width, height));
  return Math.min(AUTO_SCALE_MAX, Math.max(AUTO_SCALE_MIN, autoScale));
}

export async function shotFile(inputPath: string, settings: ShotSettings): Promise<string> {
  const html = utf8Decoder.decode(readFileSync(inputPath));
  const violations = scanViolations(html);
  if (violations.length > 0 && !settings.unsafe) throw new ConstraintError(violations);
  for (const { line, kind, snippet } of violations) {
    console.error(`${inputPath}:${line}: ${kind}: ${snippet}`);
  }
  const browserPath = resolveBrowser();
  if (browserPath === null)
    throw new Error(
      "Playwright Chromium not found. Run: playwright-cli install-browser chrome-for-testing --no-shell",
    );
  const scale = resolveScale(settings.width, settings.height, settings.scale);
  const render: RenderSettings = { width: settings.width, height: settings.height, scale };
  const bound = insertMetadata(
    renderPng(browserPath, inputPath, render),
    buildEnvelope(html, render),
  );
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
        `--default-background-color=${TRANSPARENT_BACKGROUND_COLOR}`,
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
  return `${inputPath.replace(/\.html$/i, "")}.html.png`;
}
