import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WebviewSession, WebviewState } from "../src/webview/protocol";
import { webviewAppMarkup } from "../src/webview/webview-html";
import { webviewStyles } from "../src/webview/webview-styles";

type ChangedField = "displayName" | "updatedAtMs" | "state" | "hasUnread";
type RowLocation = "onscreen" | "offscreen" | "excluded" | "collapsed";
interface UpdateCase {
  field: ChangedField;
  workspaceCount: number;
  mode: "all" | "unarchived";
  location: RowLocation;
}

const changedFields: ChangedField[] = ["displayName", "updatedAtMs", "state", "hasUnread"];
const updateCases: UpdateCase[] = [
  ...[1, 10].flatMap((workspaceCount) =>
    changedFields.flatMap((field): UpdateCase[] => [
      { field, workspaceCount, mode: "all", location: "offscreen" },
      { field, workspaceCount, mode: "unarchived", location: "offscreen" },
      { field, workspaceCount, mode: "all", location: "collapsed" },
    ]),
  ),
  ...[1, 10].flatMap((workspaceCount) =>
    (["displayName", "updatedAtMs"] as const).map((field): UpdateCase => ({
      field,
      workspaceCount,
      mode: "unarchived",
      location: "excluded",
    })),
  ),
  ...changedFields.map((field): UpdateCase => ({
    field,
    workspaceCount: 1,
    mode: "unarchived",
    location: "onscreen",
  })),
];

function createState(workspaceCount: number): WebviewState {
  return {
    groups: Array.from({ length: workspaceCount }, (_, workspace) => ({
      cwd: `/workspace/${workspace}`,
      label: `workspace ${workspace}`,
      sessions: Array.from({ length: 1500 / workspaceCount }, (_, index) => ({
        sessionId: `session-${workspace}-${index}`,
        displayName: `Session ${workspace}-${index}`,
        updatedAtMs: Date.UTC(2026, 0, 1, 1, 0),
        isArchived: index % 5 !== 0,
        ...(index % 5 === 0 ? { state: "waiting-user" as const, hasUnread: false } : {}),
      })),
    })),
  };
}

function changeField(session: WebviewSession, field: ChangedField): void {
  switch (field) {
    case "displayName":
      session.displayName = "Changed session name";
      return;
    case "updatedAtMs":
      session.updatedAtMs = (session.updatedAtMs ?? 0) + 60_000;
      return;
    case "state":
      session.state = "running";
      return;
    case "hasUnread":
      session.hasUnread = true;
  }
}

describe("single-row display work", () => {
  let browser: Browser;
  let page: Page;
  let clientSource: string;

  beforeAll(async () => {
    const artifactRoot = join(tmpdir(), "work", "vscode-agent-kit", "reduce-session-update-work");
    await mkdir(artifactRoot, { recursive: true });
    const outputDir = await mkdtemp(join(artifactRoot, "row-update-tests-"));
    const clientPath = resolve("src/webview/client.tsx");
    const source = await readFile(clientPath, "utf8");
    const anchor = "  const rowClass = [";
    expect(source.split(anchor)).toHaveLength(2);
    const instrumented =
      'import { flushSync as flushRowUpdate } from "react-dom";\n' +
      source
        .replace(anchor, "  globalThis.__rowBuilds.push(session.sessionId);\n" + anchor)
        .replace(
          '"./document-scrollbar"',
          JSON.stringify(resolve("src/webview/document-scrollbar")),
        ) +
      '\nglobalThis.__receiveSessions = (state) => flushRowUpdate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "sessions", state } })));';
    const entryPath = join(outputDir, "client.tsx");
    await writeFile(entryPath, instrumented);
    await symlink(resolve("node_modules"), join(outputDir, "node_modules"), "dir");
    await promisify(execFile)("bun", [
      "build",
      entryPath,
      "--target=browser",
      "--minify",
      '--define=process.env.NODE_ENV="production"',
      `--outfile=${join(outputDir, "client.js")}`,
    ]);
    clientSource = await readFile(join(outputDir, "client.js"), "utf8");
    browser = await chromium.launch({ headless: true });
  });

  beforeEach(async () => {
    page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: "reduce",
      timezoneId: "UTC",
    });
    await page.clock.setFixedTime(new Date("2026-01-01T12:00:00Z"));
    await page.route("http://localhost/row-update", (route) =>
      route.fulfill({ contentType: "text/html", body: webviewAppMarkup }),
    );
    await page.goto("http://localhost/row-update");
    await page.addStyleTag({ content: webviewStyles });
    await page.evaluate(() => {
      Object.assign(window, { __rowBuilds: [], acquireVsCodeApi: () => ({ postMessage() {} }) });
    });
    await page.addScriptTag({ type: "module", content: clientSource });
    await page.waitForFunction(
      () => typeof Reflect.get(window, "__receiveSessions") === "function",
    );
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function receive(state: WebviewState): Promise<string[]> {
    return page.evaluate((state) => {
      Reflect.set(window, "__rowBuilds", []);
      const send = Reflect.get(window, "__receiveSessions") as (state: WebviewState) => void;
      send(state);
      return Reflect.get(window, "__rowBuilds") as string[];
    }, state);
  }

  it.each(updateCases)(
    "$field / $workspaceCount workspace / $mode / $location builds only the changed display content",
    async ({ field, workspaceCount, mode, location }) => {
      const initial = createState(workspaceCount);
      const initialBuilds = await receive(initial);
      const initialSessionIds = initial.groups.flatMap((group) =>
        group.sessions.filter((session) => !session.isArchived).map((session) => session.sessionId),
      );
      expect(new Set(initialBuilds)).toEqual(new Set(initialSessionIds));
      if (mode === "all") {
        await page.evaluate(() =>
          document
            .querySelectorAll<HTMLButtonElement>("[data-mode-toggle]")
            .forEach((button) => button.click()),
        );
        await expect.poll(() => page.locator(".session-row").count()).toBe(1500);
      }
      const group = initial.groups[0];
      const targetIndex =
        location === "excluded" ? 1 : location === "onscreen" ? 0 : group.sessions.length - 5;
      const sessionId = group.sessions[targetIndex].sessionId;
      if (location === "collapsed") {
        await page.locator(`[data-toggle-group="${group.cwd}"]`).first().click();
        await expect
          .poll(() => page.locator(".session-row").count())
          .toBe(1500 - group.sessions.length);
      }
      const target = page.locator(`[data-session="${sessionId}"]`);
      const isDisplayed = location === "onscreen" || location === "offscreen";
      if (location === "offscreen") {
        await page.evaluate(() => window.scrollTo(0, 0));
        expect((await target.boundingBox())?.y).toBeGreaterThan(800);
      }
      if (!isDisplayed) expect(await target.count()).toBe(0);
      const oldTimestamp = isDisplayed
        ? await target.locator(".. >> .session-timestamp").textContent()
        : null;
      const updated = structuredClone(initial);
      const changed = updated.groups[0].sessions[targetIndex];
      changeField(changed, field);
      const builtSessionIds = await receive(updated);
      expect(builtSessionIds).toEqual(isDisplayed ? [sessionId] : []);
      if (!isDisplayed) return;
      if (field === "displayName")
        expect(await target.textContent()).toContain(changed.displayName);
      if (field === "updatedAtMs") {
        expect(await target.locator(".. >> .session-timestamp").textContent()).not.toBe(
          oldTimestamp,
        );
      }
      if (field === "state")
        expect(await target.locator(".session-status").getAttribute("data-state")).toBe("running");
      if (field === "hasUnread") expect(await target.getAttribute("title")).toContain("Unread");
    },
  );
});
