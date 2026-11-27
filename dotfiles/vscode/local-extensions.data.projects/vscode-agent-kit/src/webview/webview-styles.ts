/** Styles for the sessions webview; shared as-is by the stories catalog. */
export const webviewStyles = `
    :root { --session-radius: 9.6px; --group-header-height: 24px; scroll-padding-top: var(--group-header-height); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    html.session-overlay-scrollbars { scrollbar-width: none; }
    html.session-overlay-scrollbars::-webkit-scrollbar { display: none; }
    .session-scrollbar { position: fixed; top: 0; right: 0; bottom: 0; z-index: 1; width: 12px; opacity: 0; touch-action: none; user-select: none; }
    .session-scrollbar[hidden] { display: none; }
    body:hover .session-scrollbar, .session-scrollbar[data-scrolling], .session-scrollbar[data-dragging], .session-scrollbar:focus-visible { opacity: 1; }
    .session-scrollbar:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    .session-scrollbar-thumb { position: absolute; top: 0; right: 2px; width: 8px; border-radius: 4px; background: var(--vscode-scrollbarSlider-background, var(--vscode-descriptionForeground)); }
    .session-scrollbar:hover .session-scrollbar-thumb { background: var(--vscode-scrollbarSlider-hoverBackground, var(--vscode-descriptionForeground)); }
    .session-scrollbar[data-dragging] .session-scrollbar-thumb { background: var(--vscode-scrollbarSlider-activeBackground, var(--vscode-descriptionForeground)); }
    button { box-sizing: border-box; border: 1px solid transparent; border-radius: var(--session-radius); color: var(--vscode-foreground); background: transparent; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    button:hover { background: var(--vscode-list-hoverBackground); }
    svg { flex: none; pointer-events: none; }
    #app { box-sizing: border-box; display: flex; flex-direction: column; min-height: 100dvh; padding: 12px 12px 0; }
    #sessions { margin-bottom: 12px; }
    .footer { position: sticky; bottom: 0; z-index: 1; display: flex; flex-direction: column; gap: 8px; margin-top: auto; padding: 12px; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent); background: var(--vscode-sideBar-background); }
    .workspace-control { position: relative; display: grid; }
    .new-workspace { display: inline-flex; align-items: center; width: 100%; height: 32px; padding: 0 10px 0 32px; border-radius: var(--session-radius); color: var(--vscode-foreground); font-size: 13px; font-weight: 500; text-align: left; }
    .new-workspace[hidden] { display: none; }
    .workspace-folder-icon { position: absolute; top: 8px; left: 11px; width: 16px; height: 16px; }
    #workspace-form { display: flex; flex-direction: column; gap: 8px; }
    #workspace-form[hidden] { display: none; }
    #workspace-path { box-sizing: border-box; width: 100%; height: 32px; padding: 0 8px 0 32px; border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-widget-border) 50%, transparent)); border-radius: var(--session-radius); background: var(--vscode-input-background); color: var(--vscode-input-foreground, var(--vscode-foreground)); font: inherit; font-size: 13px; }
    #workspace-path:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    #workspace-path::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
    .group { min-width: 0; }
    .group + .group { margin-top: 12px; }
    .group-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 4px; min-width: 0; min-height: var(--group-header-height); margin-left: -8px; background: var(--vscode-sideBar-background); }
    .group-toggle { display: flex; align-items: center; min-width: 0; padding: 0; border: 0; }
    .group-chevron, .group-new-session, .group-mode-toggle { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-foreground); }
    .group-title { flex: 1; overflow: hidden; min-width: 0; padding: 2px 6px 2px 0; border-inline: 1px solid transparent; font-size: 14px; font-weight: 600; line-height: 20px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    .group-mode-toggle { margin-left: auto; color: var(--vscode-descriptionForeground); }
    .group-mode-toggle:hover { color: var(--vscode-foreground); }
    .group-mode-toggle svg { width: 16px; height: 16px; }
    .workspace-menu { position: fixed; z-index: 2; box-sizing: border-box; width: max-content; min-width: min(160px, calc(100vw - 8px)); max-width: calc(100vw - 8px); padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius: var(--session-radius); color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-sideBar-background)); }
    .workspace-menu button { display: block; width: 100%; min-height: 32px; padding: 0 8px; color: inherit; font-size: 13px; text-align: left; overflow-wrap: anywhere; }
    .workspace-menu button:hover { color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
    .session-context-menu { max-height: calc(100vh - 8px); overflow-y: auto; }
    .session-context-menu button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .session-row { position: relative; min-width: 0; height: 32px; margin-left: -8px; border-radius: var(--session-radius); }
    .group-header + .session-row { margin-top: 4px; }
    .session-button { position: relative; isolation: isolate; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 32px; padding: 0 calc(36px + 5ch + 8px) 0 4px; border-radius: var(--session-radius); color: var(--vscode-foreground); background: transparent; text-align: left; }
    .session-button::before { content: ""; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none; z-index: -1; }
    .session-button:hover { background: transparent; }
    .session-button:hover::before { background: var(--vscode-list-hoverBackground); }
    .session-button:focus-visible { outline: none; }
    .session-button:focus-visible::before { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    .session-row.selected .session-button::before, .session-row.selected .session-button:hover::before { background: var(--vscode-list-inactiveSelectionBackground); }
    .session-row.selected:focus-within .session-button::before { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-inactiveSelectionBackground)); }
    .session-status { position: relative; display: inline-flex; flex: none; align-items: center; justify-content: center; width: 12px; height: 12px; color: var(--vscode-descriptionForeground); }
    .session-status[data-state="running"] { color: var(--vscode-testing-iconPassed, var(--vscode-descriptionForeground)); }
    .session-status[data-state="waiting-approval"], .session-status[data-unread="true"], .session-status[data-fading="true"] { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
    .session-status[data-state="running"] > svg, .group-new-session[aria-busy="true"] svg, .archive[aria-busy="true"] svg, .unarchive[aria-busy="true"] svg { animation: session-spin 1s linear infinite; }
    .session-status[data-fading="true"] > svg { animation: session-unread-fade 200ms ease-out forwards; }
    .session-delay-dot { position: absolute; right: 0; bottom: 0; width: 6px; height: 6px; border-radius: 3px; background: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
    .session-reload-mark { position: absolute; top: 0; left: 100%; width: 8px; height: 8px; color: var(--vscode-foreground); pointer-events: none; }
    .session-reload-mark > svg { display: block; width: 100%; height: 100%; }
    @keyframes session-unread-fade { from { opacity: 1; } to { opacity: 0; } }
    @keyframes session-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .session-status[data-state="running"] > svg, .group-new-session[aria-busy="true"] svg, .archive[aria-busy="true"] svg, .unarchive[aria-busy="true"] svg { animation: none; } .session-status[data-fading="true"] > svg { display: none; } }
    .session-name { display: block; flex: 1; overflow: hidden; min-width: 0; font-size: 13px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
    .session-timestamp { pointer-events: none; position: absolute; top: 50%; right: 36px; overflow: hidden; transform: translateY(-50%); color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 20px; text-align: right; white-space: nowrap; }
    .archive, .unarchive { position: absolute; top: 50%; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; transform: translateY(-50%); color: var(--vscode-descriptionForeground); background: transparent; }
    .archive svg, .unarchive svg, .group-chevron svg, .group-new-session svg { width: 12px; height: 12px; }
    .archive, .unarchive { right: 4px; }
    .archive:hover, .unarchive:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .session-row.archived .session-name, .session-row.archived .session-timestamp { color: var(--vscode-descriptionForeground); }
    .session-row.selected .session-name, .session-row.selected .session-timestamp { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }
    .session-row.selected:focus-within .session-name, .session-row.selected:focus-within .session-timestamp { color: var(--vscode-list-activeSelectionForeground, var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground))); }
    .empty, #status, #connection-status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .empty { padding: 24px 8px; text-align: center; }
    #status, #connection-status { min-height: 16px; margin: 0; overflow-wrap: anywhere; }
    #connection-status { margin-bottom: 8px; }
    #status:empty, #connection-status:empty { display: none; }
    #status.error, #connection-status.error { color: var(--vscode-errorForeground); }
`;
