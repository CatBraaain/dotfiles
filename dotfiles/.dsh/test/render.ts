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
const pluginsDir = join(import.meta.dir, "../plugins.exact");
const outputDir = join(import.meta.dir, "dist");

/** The installed `dsh-client-ui-primitives` package (source of the real `Button.module.css`). */
const primitivesDir = join(
    import.meta.resolveSync("@deepseek-ai/dsh-client-ui-primitives/package.json"),
    "..",
);

/**
 * The `@deepseek-ai/dsh-client-ui-primitives` faces the session-list and agents
 * bundles consume. The raw npm package is not loadable by bun (its
 * runtime deps are bundled into the dsh web shell, and bun imports
 * `.module.css` as an empty object), so the fixture serves a stub with the
 * same DOM shape as the real primitives plus the real icon paths, styled by
 * the real `Button.module.css` / `StateDot.module.css` read below.
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
    relativeTime,
    IconArchiveOutline20: icon20([
        "M15.8659 2.05975C17.2603 2.05995 18.3913 3.19096 18.3914 4.58527V5.4874C18.3914 6.02747 18.2192 6.52672 17.9303 6.93735C17.9336 6.96524 17.9388 6.99318 17.9388 7.02195V12.8884C17.9388 13.6345 17.9395 14.2379 17.8996 14.7254C17.8642 15.1593 17.7936 15.5499 17.6373 15.9141L17.5654 16.0685C17.278 16.6328 16.8405 17.1046 16.3038 17.434L16.0679 17.5661C15.66 17.7739 15.2196 17.8598 14.7237 17.9003C14.2362 17.9401 13.6327 17.9405 12.8867 17.9405H7.11122C6.36511 17.9405 5.76171 17.9401 5.27418 17.9003C4.84051 17.8649 4.44949 17.7952 4.08545 17.6391L3.93104 17.5661C3.36673 17.2785 2.89392 16.8414 2.56465 16.3044L2.43245 16.0685C2.22473 15.6608 2.13878 15.2211 2.09825 14.7254C2.05841 14.2379 2.05912 13.6345 2.05912 12.8884V7.02195C2.05912 6.99284 2.06422 6.96449 2.06758 6.93629C1.77931 6.52592 1.60858 6.02687 1.60858 5.4874V4.58527C1.60876 3.19084 2.73962 2.05975 4.1341 2.05975H15.8659ZM16.4984 7.92936C16.296 7.98169 16.0847 8.01288 15.8659 8.01291H4.1341C3.91478 8.01291 3.70246 7.98194 3.49955 7.92936V12.8884C3.49955 13.6582 3.50053 14.1927 3.53445 14.608C3.56769 15.0146 3.62923 15.244 3.71635 15.415L3.7925 15.5514C3.98339 15.8627 4.25749 16.1165 4.58464 16.2833L4.72529 16.3435C4.88095 16.3993 5.08638 16.4402 5.39158 16.4651C5.80685 16.4991 6.34138 16.5001 7.11122 16.5001H12.8867C13.6564 16.5001 14.1911 16.499 14.6063 16.4651C15.0128 16.432 15.2423 16.3703 15.4133 16.2833L15.5508 16.2061C15.8618 16.0152 16.116 15.7419 16.2827 15.415L16.3429 15.2732C16.3985 15.1177 16.4396 14.9128 16.4645 14.608C16.4985 14.1927 16.4984 13.6583 16.4984 12.8884V7.92936ZM4.1341 3.50019C3.53511 3.50019 3.0492 3.98631 3.04902 4.58527V5.4874C3.04902 6.08649 3.535 6.57248 4.1341 6.57248H15.8659C16.4648 6.57228 16.951 6.08638 16.951 5.4874V4.58527C16.9509 3.98644 16.4647 3.50038 15.8659 3.50019H4.1341Z",
        "M12.7962 12.5661V11.0832H7.20548V12.5661L12.7962 12.5661Z",
    ]),
    StateDot: stateDot,
    /** Closed-menu shape only: the anchor wrapped in the Menu root span. The
     * open popover (portal, outside-click dismiss) is interaction territory —
     * out of scope for a static render. */
    Menu: ({ anchor }: { anchor: React.ReactNode }) =>
        React.createElement("span", { className: "menu-root" }, anchor),
    // Multi-path glyphs below the fold in the real package, copied verbatim.
    IconTriangleRightFill14: pathsIcon(14, "0 0 14 14", [
        { d: "M4.25 2.82782L4.25 11.1722C4.25 11.6622 4.84243 11.9076 5.18891 11.5611L9.36109 7.38891C9.57588 7.17412 9.57588 6.82588 9.36109 6.61109L5.18891 2.43891C4.84243 2.09243 4.25 2.33782 4.25 2.82782Z" },
    ]),
    IconCloseFill14: pathsIcon(14, "0 0 14 14", [
        { d: "M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z" },
    ]),
    IconProjectAddOutline16: pathsIcon(16, "0 0 16 16", [
        { transform: "translate(9.52 2.52)", d: "M3.55246 0L3.55246 2.44252L6 2.44252L6 3.55748L3.55246 3.55748L3.55246 6L2.43834 6L2.43834 3.55748L0 3.55748L0 2.44252L2.43834 2.44252L2.43834 0L3.55246 0Z" },
        { transform: "translate(0.3496 2.35)", d: "M4.76367 0C5.36861 1.80598e-05 5.93113 0.310294 6.25488 0.821289L6.78027 1.64941C6.79685 1.67558 6.81791 1.69775 6.83887 1.71973C6.72186 2.15521 6.65702 2.61192 6.65137 3.08301C6.25601 2.96045 5.90909 2.70478 5.68164 2.3457L5.15723 1.5166C5.07183 1.38189 4.92318 1.3008 4.76367 1.30078L2.32422 1.30078C1.7589 1.30078 1.30078 1.7589 1.30078 2.32422L1.30078 10.1338C1.30078 10.6991 1.7589 11.1572 2.32422 11.1572L11.9766 11.1572C12.5419 11.1572 13 10.6991 13 10.1338L13 8.58398C13.4545 8.5135 13.8903 8.38748 14.3008 8.21289L14.3008 10.1338C14.3008 11.4171 13.2598 12.458 11.9766 12.458L2.32422 12.458C1.04093 12.458 0 11.4171 0 10.1338L0 2.32422C0 1.04093 1.04093 0 2.32422 0L4.76367 0Z" },
    ]),
    IconFolderOpen16: pathsIcon(16, "0 0 16 16", [
        { d: "M5.19629 1.57104C5.81144 1.5711 6.38623 1.8786 6.72754 2.39038L7.19922 3.09839C7.28454 3.22635 7.42824 3.30344 7.58203 3.30347H12.1699C13.5039 3.30348 14.5859 4.38548 14.5859 5.71948V6.62671C15.2694 7.02689 15.6605 7.85012 15.4385 8.68726L14.3848 12.658C14.1037 13.7164 13.1449 14.4527 12.0498 14.4529H2.91699C1.51651 14.4529 0.451662 13.2814 0.501954 11.9519V3.98706C0.501954 2.65305 1.58396 1.57104 2.91797 1.57104H5.19629ZM3.7793 7.75562C3.30994 7.75562 2.89883 8.07153 2.77832 8.52515L1.91602 11.7722C1.74167 12.4291 2.23734 13.073 2.91699 13.073H12.0498C12.5191 13.0728 12.9304 12.757 13.0508 12.3035L14.1045 8.33374C14.1819 8.04202 13.9619 7.756 13.6602 7.75562H3.7793ZM2.91797 2.9519C2.34625 2.9519 1.88281 3.41534 1.88281 3.98706V7.2937C2.33068 6.7269 3.02249 6.37476 3.7793 6.37476H13.2051V5.71948C13.2051 5.14777 12.7416 4.68434 12.1699 4.68433H7.58203C6.96675 4.6843 6.39209 4.37595 6.05078 3.86401L5.5791 3.15601C5.49379 3.02821 5.34995 2.95196 5.19629 2.9519H2.91797Z" },
        { opacity: "0.2", d: "M13.6602 7.75525C13.9618 7.7556 14.1815 8.04179 14.1045 8.33337L13.0508 12.3031C12.9304 12.7567 12.5191 13.0725 12.0498 13.0726H2.91701C2.23744 13.0725 1.7417 12.4287 1.91603 11.7719L2.77834 8.52478C2.89898 8.07146 3.31018 7.75532 3.77931 7.75525H13.6602ZM5.1963 2.95154C5.34985 2.95159 5.49377 3.02803 5.57912 3.15564L6.0508 3.86365C6.39205 4.37553 6.96685 4.68385 7.58205 4.68396H12.1699C12.7416 4.68396 13.2049 5.14754 13.2051 5.71912V6.37439H3.77931C3.02267 6.37444 2.33067 6.72671 1.88283 7.29333V3.98669C1.88299 3.4152 2.34649 2.95168 2.91798 2.95154H5.1963Z" },
    ]),
    IconFolderClose16: pathsIcon(16, "0 0 16 16", [
        { transform: "translate(1.5 2.429)", d: "M5.05582 0.518756L4.50669 0.86654L5.05582 0.518756ZM13 9.4837L13.65 9.4837L13.65 3.53962L13 3.53962L12.35 3.53962L12.35 9.4837L13 9.4837ZM11.3264 1.86603L11.3264 1.21603L6.52313 1.21603L6.52313 1.86603L6.52313 2.51603L11.3264 2.51603L11.3264 1.86603ZM5.58054 1.34727L6.12968 0.999489L5.60495 0.170972L5.05582 0.518756L4.50669 0.86654L5.03141 1.69506L5.58054 1.34727ZM4.11323 1.23058e-13L4.11323 -0.65L1.67359 -0.65L1.67359 5.00699e-14L1.67359 0.65L4.11323 0.65L4.11323 1.23058e-13ZM0 1.67359L-0.65 1.67359L-0.65 9.4837L0 9.4837L0.65 9.4837L0.65 1.67359L0 1.67359ZM11.3264 11.1573L11.3264 10.5073L1.67359 10.5073L1.67359 11.1573L1.67359 11.8073L11.3264 11.8073L11.3264 11.1573ZM0 9.4837L-0.65 9.4837C-0.65 10.767 0.390308 11.8073 1.67359 11.8073L1.67359 11.1573L1.67359 10.5073C1.10828 10.5073 0.65 10.049 0.65 9.4837L0 9.4837ZM1.67359 5.00699e-14L1.67359 -0.65C0.390307 -0.65 -0.65 0.390309 -0.65 1.67359L0 1.67359L0.65 1.67359C0.65 1.10828 1.10828 0.65 1.67359 0.65L1.67359 5.00699e-14ZM5.05582 0.518756L5.60495 0.170972C5.28121 -0.340193 4.71829 -0.65 4.11323 -0.65L4.11323 1.23058e-13L4.11323 0.65C4.27282 0.65 4.4213 0.731715 4.50669 0.86654L5.05582 0.518756ZM6.52313 1.86603L6.52313 1.21603C6.36354 1.21603 6.21507 1.13431 6.12968 0.999489L5.58054 1.34727L5.03141 1.69506C5.35515 2.20622 5.91808 2.51603 6.52313 2.51603L6.52313 1.86603ZM13 3.53962L13.65 3.53962C13.65 2.25634 12.6097 1.21603 11.3264 1.21603L11.3264 1.86603L11.3264 2.51603C11.8917 2.51603 12.35 2.97431 12.35 3.53962L13 3.53962ZM13 9.4837L12.35 9.4837C12.35 10.049 11.8917 10.5073 11.3264 10.5073L11.3264 11.1573L11.3264 11.8073C12.6097 11.8073 13.65 10.767 13.65 9.4837L13 9.4837Z" },
    ]),
};

/** The real StateDot's 3x3 chase matrix cells (viewBox 0 0 10 10, 2px cells). */
const MATRIX_CELLS: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [4, 0],
    [8, 0],
    [8, 4],
    [8, 8],
    [4, 8],
    [0, 8],
    [0, 4],
];

/** Same element shape as the shell-resident `StateDot` (class names unhashed). */
function stateDot({ state, size = 10, className }: { state: string; size?: number; className?: string }): unknown {
    if (state === "ongoing") {
        return React.createElement(
            "svg",
            {
                className: ["matrix", className].filter(Boolean).join(" "),
                "data-state": "ongoing",
                width: size,
                height: size,
                viewBox: "0 0 10 10",
                shapeRendering: "crispEdges",
                "aria-hidden": "true",
            },
            MATRIX_CELLS.map(([x, y], index) =>
                React.createElement("rect", {
                    key: `${x}-${y}`,
                    className: "cell",
                    x,
                    y,
                    width: "2",
                    height: "2",
                    style: { animationDelay: `${(index - MATRIX_CELLS.length) * 125}ms` },
                }),
            ),
        );
    }
    return React.createElement("span", {
        className: ["dot", className].filter(Boolean).join(" "),
        "data-state": state,
        style: { width: size, height: size },
        "aria-hidden": "true",
    });
}

/** One of the ic_ds_* 20px outline icons, faithful to the real glyph paths. */
function icon20(paths: readonly string[]): () => unknown {
    return () =>
        React.createElement(
            "svg",
            {
                width: 20,
                height: 20,
                viewBox: "0 0 20 20",
                fill: "none",
                xmlns: "http://www.w3.org/2000/svg",
            },
            paths.map((d, index) => React.createElement("path", { key: index, d, fill: "currentColor" })),
        );
}

/** Compact relative-time bucketing, mirroring the real `relativeTime`. */
function relativeTime(at: number, now: number): { unit: string; n: number } {
    const MIN = 6e4;
    const HOUR = 36e5;
    const DAY = 864e5;
    const diff = Math.max(0, now - at);
    if (diff < MIN) return { unit: "now", n: 0 };
    if (diff < HOUR) return { unit: "minutes", n: Math.floor(diff / MIN) };
    if (diff < DAY) return { unit: "hours", n: Math.floor(diff / HOUR) };
    if (diff < 30 * DAY) return { unit: "days", n: Math.floor(diff / DAY) };
    if (diff < 365 * DAY) return { unit: "months", n: Math.floor(diff / (30 * DAY)) };
    return { unit: "years", n: Math.floor(diff / (365 * DAY)) };
}

/** One of the ic_ds_* 16px outline icons, faithful to the real glyph. */
function icon16(d: string): () => unknown {
    return () =>
        React.createElement(
            "svg",
            { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
            React.createElement("path", { d, fill: "currentColor" }),
        );
}

/** One path of a multi-path glyph; `transform` / `opacity` mirror the real one. */
interface GlyphPath {
    readonly d: string;
    readonly transform?: string;
    readonly opacity?: string;
}

/** A multi-path icon component shaped like the real one (size / className props). */
function pathsIcon(edge: number, viewBox: string, paths: readonly GlyphPath[]): (props: { size?: number; className?: string }) => unknown {
    return ({ size, className } = {}) =>
        React.createElement(
            "svg",
            {
                width: size ?? edge,
                height: size ?? edge,
                className,
                viewBox,
                fill: "none",
                xmlns: "http://www.w3.org/2000/svg",
            },
            paths.map(({ d, transform, opacity }, index) =>
                React.createElement("path", { key: index, d, transform, opacity, fill: "currentColor" }),
            ),
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
    // The primitives Menu places its portal in a layout effect; a static
    // render never opens it, so silence the server-render warning.
    useLayoutEffect: () => {},
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
 * `dir` is the plugin directory under `plugins.exact/`, `id` the bundle id used in
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

/**
 * Execute the agents apply against a fake slot context, capturing the
 * injected trigger stylesheet (kept as `agentsCss`) alongside the dock entry.
 */
let agentsCss = "";
function captureAgentsRegistration(apply: (ctx: unknown) => void): RegisteredEntry[] {
    const registered: RegisteredEntry[] = [];
    const styleEl = {
        set textContent(value: string) {
            agentsCss = value;
        },
    };
    const loaderHost = globalThis as { document?: unknown };
    loaderHost.document = {
        createElement: () => styleEl,
        head: { appendChild: () => {} },
    };
    try {
        apply({
            slots: {
                inject: (_slot: string, callback: () => void) => callback(),
                register: (spec: SlotSpec, component: unknown) => registered.push({ spec, component }),
            },
            effect: (_setup: () => unknown, _label: string) => {},
        });
    } finally {
        delete loaderHost.document;
    }
    return registered;
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
.list-host { box-sizing: border-box; flex-direction: column; max-width: 300px; display: flex; }
.list-host-tall { height: 420px; }
`;

/**
 * Execute the session-list apply against a fake context and return the
 * registered list component. The apply appends its stylesheet through the
 * captured style element (kept as `sessionListCss`) and registers its
 * dictionaries into a no-op locale stub.
 */
let sessionListCss = "";
function captureSessionListRegistration(apply: (ctx: unknown) => void): unknown {
    const registered: unknown[] = [];
    const styleEl = {
        set textContent(value: string) {
            sessionListCss = value;
        },
    };
    const loaderHost = globalThis as { document?: unknown };
    loaderHost.document = {
        createElement: () => styleEl,
        head: { appendChild: () => {} },
    };
    try {
        apply({
            slots: {
                inject: (_slot: string, callback: () => void) => callback(),
                register: (_spec: unknown, component: unknown) => registered.push(component),
                entries: (_key: string) => [],
                subscribe: (_key: string) => () => {},
            },
            sessions: {},
            workspaces: {},
            layout: {},
            locale: { register: () => () => {} },
            effect: (_setup: () => unknown, _label: string) => {},
        });
    } finally {
        delete loaderHost.document;
    }
    const component = registered[0];
    if (component === undefined) throw new Error("session-list component not registered");
    return component;
}

/** Minimal en dictionary for the session-list namespace (mirrors the plugin's locales.ts). */
const sessionListEn: Record<string, string> = {
    "session.new": "New Session",
    "time.now": "now",
    "time.minutes": "{n}min",
    "time.hours": "{n}h",
    "time.days": "{n}d",
    "time.months": "{n}mo",
    "time.years": "{n}y",
    "actions.archive": "Archive session",
    "actions.copyId": "Copy session ID",
    "section.workspaces": "Workspaces",
    "group.ungrouped": "Ungrouped",
    "workspace.add": "Add workspace",
    "sessions.expand": "Show {n} more sessions",
    "sessions.collapse": "Show less",
    "close": "Close",
    "cancel": "Cancel",
    "folderError.title": "Couldn’t open folder",
    "folderError.retry": "Choose again",
};
const translateEn = (key: string, params?: Record<string, unknown>): string =>
    (sessionListEn[key] ?? key).replace("{n}", String(params?.n ?? ""));

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
    const stateDotCss = await readFile(join(primitivesDir, "lib/StateDot.module.css"), "utf-8");

    // session-list: workspace-grouped sidebar (uses the injected-hooks component face,
    // so the fake context must survive its apply and the props carry fake selector hooks).
    const listExports = await loadPluginBundle("session-list", "dotfiles-dsh-session-list");
    const listEntry = captureSessionListRegistration(listExports.apply as (ctx: unknown) => void);
    const now = Date.now();
    /** Fake host workspaces: { id, title, sessionIds } per group. */
    type FakeWorkspace = { id: string; title: string; sessionIds: readonly string[] };
    const makeListProps = (
        rows: readonly { id: string; summary: Record<string, unknown> }[],
        current: string | undefined,
        pendingIds: readonly string[],
        workspaces: readonly FakeWorkspace[] = [],
    ) => ({
        wide: true,
        expandSidebar: () => {},
        useSessions: (selector: (snapshot: unknown) => unknown) =>
            selector({
                ids: rows.map((row) => row.id),
                byId: Object.fromEntries(rows.map((row) => [row.id, row.summary])),
                current,
            }),
        useSessionPendingInteraction: (selector: (snapshot: unknown) => unknown) =>
            selector(new Map(pendingIds.map((id) => [id, { key: `k-${id}`, kind: "question", sessionId: id }]))),
        useWorkspaces: (selector: (snapshot: unknown) => unknown) =>
            selector({
                archivedSessionIds: [],
                items: workspaces.map((workspace) => ({
                    workspaceId: workspace.id,
                    title: workspace.title,
                    path: `/home/user/${workspace.title}`,
                    sessionIds: workspace.sessionIds,
                    createdAt: new Date(now - 30 * 86_400_000).toISOString(),
                    updatedAt: new Date(now).toISOString(),
                })),
            }),
        useDirectoryFlow: (selector: (snapshot: unknown) => unknown) => selector(true),
        t: translateEn,
    });
    const session = (id: string, title: string, overrides: Record<string, unknown> = {}) => ({
        id,
        summary: {
            id,
            title,
            displayTitle: title,
            blank: false,
            running: false,
            completed: false,
            updatedAt: now - 86_400_000,
            ...overrides,
        },
    });
    const listMarkup = renderComponent(
        listEntry,
        makeListProps(
            [
                session("s1", "refit the dock alignment", { running: true, updatedAt: now - 90_000 }),
                session("s2", "review session-list", { completed: true, updatedAt: now - 3 * 3_600_000 }),
                session("s3", "refactor quota-line", { updatedAt: now - 2 * 86_400_000 }),
                session("s4", "pin the theme tokens", { updatedAt: now - 5 * 86_400_000 }),
                session("s5", "rename worktree tasks", { updatedAt: now - 9 * 86_400_000 }),
                session("s6", "trim sidebar paddings", { updatedAt: now - 12 * 86_400_000 }),
                session("s7", "split fixture cases", { updatedAt: now - 20 * 86_400_000 }),
                session("stray", "loose session from before grouping", { updatedAt: now - 40 * 86_400_000 }),
            ],
            "s1",
            ["s3"],
            [
                { id: "w1", title: "dotfiles", sessionIds: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"] },
                { id: "w2", title: "api-server", sessionIds: [] },
            ],
        ),
    );
    const blankListMarkup = renderComponent(
        listEntry,
        makeListProps(
            [
                session("b1", "review session-list", { updatedAt: now - 5 * 60_000 }),
                {
                    id: "blank-current",
                    summary: {
                        id: "blank-current",
                        title: undefined,
                        displayTitle: "New Session",
                        blank: true,
                        running: false,
                        completed: false,
                        updatedAt: now,
                    },
                },
            ],
            "blank-current",
            [],
            [{ id: "w1", title: "dotfiles", sessionIds: ["b1", "blank-current"] }],
        ),
    );
    const emptyListMarkup = renderComponent(listEntry, makeListProps([], undefined, []));

    const skillExports = await loadPluginBundle("skill-status", "dotfiles-dsh-skill-status");
    const skillEntry = findEntry(captureSlotRegistrations(skillExports.apply as (ctx: unknown) => void), "skill-status");
    /** The component reads its names through the session `useProjection` seat. */
    const renderSkill = (names: readonly string[]): string =>
        renderComponent(skillEntry, {
            useProjection: (key: string) => (key === "skillStatus" ? names : undefined),
        });
    const skillPopulated = renderSkill(["commit", "review", "write-docs"]);
    const skillEmpty = renderSkill([]);
    const skillOverflow = renderSkill([
        "commit", "review", "write-docs", "refactor-large-module", "migration-script",
        "benchmark-suite", "diagnose-flaky-test", "update-dependencies", "triage-bug-reports",
        "release-checklist", "security-audit", "performance-tuning", "api-contract-review",
        "data-migration", "docs-refresh", "ci-hardening",
    ]);

    // agents: the agent/class selector rows. Static render covers the closed
    // menus only (the popover itself is interaction territory); the row labels
    // — including the resolved-model suffix — are what the fixture seeds via
    // `initialState` (effects never run server-side, so the poller stays idle).
    const agentsExports = await loadPluginBundle("agents", "dotfiles-dsh-agents");
    const agentsEntry = findEntry(
        captureAgentsRegistration(agentsExports.apply as (ctx: unknown) => void),
        "agent-class",
    );
    const agentsVocabulary = {
        agents: ["main", "senior", "junior", "vision"],
        classes: ["high", "middle", "low", "vision"],
    };
    const renderAgents = (initialState: Record<string, unknown>): string =>
        renderComponent(agentsEntry, { sessionId: "s-fixture", initialState });
    const agentsAuto = renderAgents({
        managed: true,
        agent: "main",
        className: "middle",
        manual: false,
        model: "glm-5.3-flash",
        ...agentsVocabulary,
    });
    const agentsManual = renderAgents({
        managed: true,
        agent: "senior",
        className: "high",
        manual: true,
        model: "glm-5.3",
        ...agentsVocabulary,
    });
    const agentsIdle = renderAgents({
        managed: true,
        agent: "main",
        className: "high",
        manual: false,
        ...agentsVocabulary,
    });

    const listCase = `<div class="case">
    <div class="case-label">4. session-list — workspace groups (header row, Add workspace, current tint, Ungrouped, Show more) with status dots, relative time, and hover actions</div>
    <div class="list-host list-host-tall">${listMarkup}</div>
</div>
<div class="case">
    <div class="case-label">5. session-list — the selected blank row inside its group has no time and no actions</div>
    <div class="list-host">${blankListMarkup}</div>
</div>
<div class="case">
    <div class="case-label">6. session-list — no sessions renders an empty region</div>
    <div class="list-host">${emptyListMarkup}</div>
</div>`;

    const cases = [
        caseSection("1. skill-status — populated (input.dock, above the composer card)", skillPopulated, ""),
        caseSection("2. skill-status — empty snapshot (the row renders the bare 🎯 skills: label)", skillEmpty, ""),
        caseSection("3. skill-status — many skills (clipped with an ellipsis, must not overflow)", skillOverflow, ""),
        listCase,
        caseSection("7. agents — auto class with the resolved model (selector rows, menus closed)", agentsAuto, ""),
        caseSection("8. agents — manual pick shows (manual:model) on the class row", agentsManual, ""),
        caseSection("9. agents — idle session before the first turn (no resolved model yet)", agentsIdle, ""),
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
${stateDotCss}
</style>
<style>${dockCss}${sessionListCss}${agentsCss}</style>
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
