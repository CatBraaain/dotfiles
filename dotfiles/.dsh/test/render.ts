/**
 * Render a static fixture page reproducing the dsh web composer dock visuals
 * without booting dsh.
 *
 * Sources of truth assembled here:
 * - theme stylesheets: extracted from the installed `dsh-client-ui-theme`
 *   client bundle (inline CSS string regions)
 * - plugin components: loaded from each committed plugin `lib/client.js`
 *   through a `__ModuleLoader__` shim, mounted with a fake slot context, and
 *   rendered with `react-dom/server`
 * - dock parent layout: copies of the observed composer stack / input bar
 *   class definitions from `dsh-client-ui-conversation`
 *
 * Output: `dist/fixture.html` (light) and `dist/fixture-dark.html`.
 * Each page lays out the same review cases so a reviewer (human or VLM) can
 * check every visible-behavior point from the plugin SPECs against the
 * rendered visuals; see README.md for the checklist.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const home = process.env.HOME;
if (!home) throw new Error("HOME is not set");

const globalModules = join(home, ".bun/install/global/node_modules");
const themeBundle = join(globalModules, "@deepseek-ai/dsh-client-ui-theme/lib/client.js");
const pluginsDir = join(import.meta.dir, "../plugins");
const outputDir = join(import.meta.dir, "dist");

/**
 * React shim for the server renderer: `useSyncExternalStore` without a
 * `getServerSnapshot` argument is rejected by react-dom/server, so the shim
 * reads the client snapshot directly. A static render never exercises
 * subscriptions.
 */
const reactForServer = {
    ...React,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
} as typeof React;

/** A `__ModuleLoader__` registration emitted by each plugin client bundle. */
interface BundleRegistration {
    id: string
    factory: (require: (name: string) => unknown) => unknown
}

/** The slot spec face the fixture cares about. */
interface SlotSpec {
    id?: string
    order?: number
}

/** One `ctx.slots.register` call captured by the fake context. */
interface RegisteredEntry {
    spec: SlotSpec
    component: unknown
}

/** Extract every inline stylesheet region from the theme client bundle. */
async function extractThemeCss(): Promise<string> {
    const source = await readFile(themeBundle, "utf-8");
    const chunks: string[] = [];
    for (const match of source.matchAll(/var \w+_css_default = "((?:[^"\\]|\\.)*)";/g)) {
        chunks.push(JSON.parse(`"${match[1]}"`) as string);
    }
    if (chunks.length === 0) throw new Error("no inline css regions found in theme bundle");
    return chunks.join("\n");
}

/**
 * Execute one plugin client bundle and return its `{ apply, inject }` exports.
 * `dir` is the plugin directory under `plugins/`, `id` the bundle id used in
 * the `__ModuleLoader__.load` banner (the plugin package name).
 */
async function loadPluginBundle(dir: string, id: string): Promise<Record<string, unknown>> {
    const registrations: BundleRegistration[] = [];
    const loaderHost = globalThis as { window?: unknown; __ModuleLoader__?: unknown };
    loaderHost.window = loaderHost;
    loaderHost.__ModuleLoader__ = {
        load: (registration: BundleRegistration) => registrations.push(registration),
    };
    await import(pathToFileURL(join(pluginsDir, dir, "lib/client.js")).href);

    const registration = registrations.at(-1);
    if (!registration || registration.id !== id) throw new Error(`bundle not registered: ${id}`);
    return registration.factory((name) => {
        if (name === "react") return reactForServer;
        throw new Error(`fixture provides no module: ${name}`);
    }) as Record<string, unknown>;
}

/** Run `apply` against a fake slot context and collect the registered entries. */
function captureSlotRegistrations(apply: (ctx: unknown) => void): RegisteredEntry[] {
    const registered: RegisteredEntry[] = [];
    apply({
        slots: {
            inject: (_slot: string, callback: () => void) => callback(),
            register: (spec: SlotSpec, component: unknown) => registered.push({ spec, component }),
        },
        // The conversation assembly registration is irrelevant to the fixture:
        // the dock row gets its snapshot from the fake source below instead.
        uiConversation: {
            events: { register: () => {} },
            views: { register: () => {} },
        },
    });
    return registered;
}

function findEntry(entries: RegisteredEntry[], id: string): unknown {
    const entry = entries.find((candidate) => candidate.spec.id === id);
    if (!entry) throw new Error(`slot entry not registered: ${id}`);
    return entry.component;
}

/** Stand-in for `skillStatusSource`: a snapshot the dock row renders as-is. */
function fakeSkillSource(names: readonly string[]) {
    return { subscribe: () => () => {}, getSnapshot: () => ({ names }) };
}

function renderComponent(component: unknown, props: Record<string, unknown>): string {
    const type = component as React.ComponentType<Record<string, unknown>>;
    return renderToStaticMarkup(React.createElement(type, props));
}

/** Composer dock parent layout, copied from the observed dsh classes. */
const dockCss = `
body {
    margin: 0;
    font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif);
    -webkit-font-smoothing: antialiased;
    color: var(--dsw-alias-label-primary, #0f1115);
    background: var(--dsw-alias-bg-base, #fff);
}
.conv-root {
    --dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * .64), 920px));
    --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
    --dsh-composer-side-clearance: 16px;
    --dsh-composer-dock-inset: 8px;
    --dsh-composer-stack-gap: 6px;
    padding: 24px 0 16px;
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
}
.case-label {
    font-size: 13px;
    color: var(--dsw-alias-label-tertiary);
    padding: 0 16px;
}
.composer-stack { gap: var(--dsh-composer-stack-gap); flex-direction: column; display: flex; }
.input-root { padding: 0 var(--dsh-composer-side-clearance) 8px; flex-direction: column; align-items: center; display: flex; }
.input-card {
    box-sizing: border-box;
    width: 100%;
    max-width: var(--dsh-composer-card-max-width);
    --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
    background: var(--dsw-specific-input-major);
    box-shadow: var(--dsw-elevation-soft);
    font-size: var(--dsh-content-font-size, 14px);
    line-height: calc(24px + var(--dsh-content-font-delta, 0px));
    border: 0;
    border-radius: 22px;
    flex-direction: column;
    gap: 12px;
    padding-top: 8px;
    display: flex;
    position: relative;
}
.dummy-input { min-height: 24px; padding: 4px 16px; }
.stats-root {
    max-width: var(--dsh-chat-content-width);
    box-sizing: border-box;
    width: 100%;
    padding: 4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;
    font-size: var(--dsh-content-font-size-secondary, 13px);
    line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
    justify-content: center;
    gap: 12px;
    margin: 0 auto;
    display: flex;
}
.stats-pill {
    box-sizing: border-box;
    max-width: 100%;
    color: var(--dsw-alias-label-tertiary);
    font: inherit;
    font-variant-numeric: tabular-nums;
    line-height: inherit;
    white-space: nowrap;
    background: 0 0;
    border: none;
    border-radius: 24px;
    align-items: center;
    gap: 6px;
    padding: 1px 8px;
    display: inline-flex;
}
.stats-label { text-overflow: ellipsis; min-width: 0; overflow: hidden; }
`;

const statsPillsMarkup = `
<div class="stats-root">
    <span class="stats-pill"><span class="stats-label">ctx 12k tokens</span></span>
    <span class="stats-pill"><span class="stats-label">seq 3</span></span>
</div>
`;

/** One review case: a labeled composer scene with the dock contents in place. */
function caseSection(label: string, inputDock: string, composerDock: string): string {
    return `<div class="case">
    <div class="case-label">${label}</div>
    <div class="conv-root">
        <div class="composer-stack">
            ${inputDock ? `<div data-slot="conversation.input.dock" style="display: contents">${inputDock}</div>` : ""}
            <div class="input-root">
                <div class="input-card">
                    <div class="dummy-input">Type a message…</div>
                </div>
                ${composerDock ? `<div data-slot="conversation.composer.dock" style="display: contents">${composerDock}</div>` : ""}
            </div>
        </div>
    </div>
</div>`;
}

async function main(): Promise<void> {
    await mkdir(outputDir, { recursive: true });

    const themeCss = await extractThemeCss();

    const footerExports = await loadPluginBundle("footer", "dotfiles-dsh-footer");
    const footerEntries = captureSlotRegistrations(footerExports.apply as (ctx: unknown) => void);
    const footerMarkup = renderComponent(findEntry(footerEntries, "session-id"), {
        sessionId: "session-1",
    });

    const skillExports = await loadPluginBundle("skill-status", "dotfiles-dsh-skill-status");
    const skillEntry = findEntry(captureSlotRegistrations(skillExports.apply as (ctx: unknown) => void), "skill-status");
    const skillPopulated = renderComponent(skillEntry, {
        source: fakeSkillSource(["commit", "review", "write-docs"]),
    });
    const skillEmpty = renderComponent(skillEntry, { source: fakeSkillSource([]) });
    const skillOverflow = renderComponent(skillEntry, {
        source: fakeSkillSource([
            "commit", "review", "write-docs", "refactor-large-module", "migration-script",
            "benchmark-suite", "diagnose-flaky-test", "update-dependencies", "triage-bug-reports",
            "release-checklist", "security-audit", "performance-tuning", "api-contract-review",
            "data-migration", "docs-refresh", "ci-hardening",
        ]),
    });

    const cases = [
        caseSection("1. skill-status — populated (input.dock, above the composer card)", skillPopulated, ""),
        caseSection("2. skill-status — empty snapshot (the row must not render)", skillEmpty, ""),
        caseSection("3. skill-status — many skills (clipped with an ellipsis, must not overflow)", skillOverflow, ""),
        caseSection("4. footer — composer.dock below the card, beside the stock stats pills", "", statsPillsMarkup + footerMarkup),
    ].join("\n");

    for (const dark of [false, true]) {
        const bodyAttrs = dark ? " data-ds-dark-theme" : "";
        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>dsh dock fixture${dark ? " (dark)" : ""}</title>
<style>
${themeCss}
</style>
<style>${dockCss}</style>
</head>
<body style="--dsh-content-font-size: 14px"${bodyAttrs}>
${cases}
</body>
</html>
`;
        const file = join(outputDir, dark ? "fixture-dark.html" : "fixture.html");
        await writeFile(file, html);
        console.log(`written: ${file}`);
    }
}

await main();
