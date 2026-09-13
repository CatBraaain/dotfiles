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

/** The installed `dsh-client-ui-primitives` package (source of the real `Button.module.css`). */
const primitivesDir = join(
    import.meta.resolveSync("@deepseek-ai/dsh-client-ui-primitives/package.json"),
    "..",
);

/**
 * The `@deepseek-ai/dsh-client-ui-primitives` faces the footer bundle consumes.
 * The raw npm package is not loadable by bun (its runtime deps are bundled into
 * the dsh web shell, and bun imports `.module.css` as an empty object), so the
 * fixture serves a stub with the same DOM shape as the real `Button` plus the
 * real icon paths, styled by the real `Button.module.css` read below.
 */
const primitivesStub = {
    /** Same element shape as the shell-resident primitive (class names unhashed). */
    Button: ({ variant = "ghost", size = "md", icon, children, ...rest }: React.ComponentProps<"button"> & { variant?: string; size?: string; icon?: React.ReactNode }) =>
        React.createElement(
            "button",
            { type: "button", className: ["button", variant, size].join(" "), ...rest },
            icon != null ? React.createElement("span", { className: "icon" }, icon) : null,
            children,
        ),
    IconCopyOutline16: icon16(
        "M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z",
    ),
    IconCheckOutline16: icon16(
        "M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z",
    ),
    // The clipboard is never exercised by a static render.
    writeClipboard: async () => true,
};

/** One of the ic_ds_* 16px outline icons, faithful to the real glyph. */
function icon16(d: string): () => unknown {
    return () =>
        React.createElement(
            "svg",
            { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
            React.createElement("path", { d, fill: "currentColor" }),
        );
}

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
        if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
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
    const buttonCss = await readFile(join(primitivesDir, "lib/Button.module.css"), "utf-8");

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
${buttonCss}
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
