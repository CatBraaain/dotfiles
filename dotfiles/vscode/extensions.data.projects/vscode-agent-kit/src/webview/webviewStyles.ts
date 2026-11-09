/** Styles for the sessions webview; shared as-is by the stories catalog. */
export const webviewStyles = `
    :root { --session-radius: 9.6px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
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
    .group-header { display: flex; align-items: center; }
    #sessions { margin-bottom: 12px; }
    .footer { position: sticky; bottom: 0; display: flex; flex-direction: column; gap: 8px; margin-top: auto; padding: 12px; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent); background: var(--vscode-sideBar-background); }
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
    .group-header { gap: 4px; min-width: 0; min-height: 24px; }
    .group-toggle { display: flex; flex: 1; align-items: center; gap: 4px; min-width: 0; border-radius: var(--session-radius); }
    .group-toggle:hover { background: var(--vscode-list-hoverBackground); }
    .group-toggle > button:hover { background: transparent; }
    .group-chevron, .group-new-session, .group-mode-toggle { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-foreground); }
    .group-title { flex: 1; overflow: hidden; min-width: 0; height: 24px; padding: 0 6px 0 0; font-size: 14px; font-weight: 600; line-height: 20px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    .group-mode-toggle { color: var(--vscode-descriptionForeground); }
    .group-mode-toggle:hover { color: var(--vscode-foreground); }
    .group-mode-toggle svg { width: 16px; height: 16px; }
    .workspace-menu { position: fixed; z-index: 2; box-sizing: border-box; width: max-content; min-width: min(160px, calc(100vw - 8px)); max-width: calc(100vw - 8px); padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius: var(--session-radius); color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-sideBar-background)); }
    .workspace-menu button { display: block; width: 100%; min-height: 32px; padding: 0 8px; color: inherit; font-size: 13px; text-align: left; overflow-wrap: anywhere; }
    .workspace-menu button:hover, .workspace-menu button:focus { color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
    .session-row { position: relative; min-width: 0; height: 32px; margin-left: 4px; border-radius: var(--session-radius); }
    .group-header + .session-row { margin-top: 4px; }
    .session-button { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 32px; padding: 0 calc(36px + 5ch + 8px) 0 8px; border-radius: var(--session-radius); color: var(--vscode-foreground); background: transparent; text-align: left; }
    .session-button:hover { background: var(--vscode-list-hoverBackground); }
    .session-row.selected .session-button, .session-row.selected .session-button:hover { background: var(--vscode-list-inactiveSelectionBackground); }
    .session-row.selected:focus-within .session-button { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-inactiveSelectionBackground)); }
    .session-status { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 12px; height: 12px; color: var(--vscode-descriptionForeground); }
    .session-status[data-state="running"] { color: var(--vscode-testing-iconPassed, var(--vscode-descriptionForeground)); }
    .session-status[data-state="waiting-approval"], .session-status[data-unread="true"] { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
    .session-status[data-state="running"] svg { animation: session-spin 1s linear infinite; }
    @keyframes session-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .session-status[data-state="running"] svg { animation: none; } }
    .session-name { display: block; flex: 1; overflow: hidden; min-width: 0; font-size: 13px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
    .session-timestamp { pointer-events: none; position: absolute; top: 50%; right: 36px; overflow: hidden; width: 5ch; transform: translateY(-50%); color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 20px; text-align: right; white-space: nowrap; }
    .archive, .unarchive { position: absolute; top: 50%; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; transform: translateY(-50%); color: var(--vscode-descriptionForeground); background: transparent; }
    .archive svg, .unarchive svg, .group-chevron svg, .group-new-session svg { width: 12px; height: 12px; }
    .archive, .unarchive { right: 4px; }
    .archive:hover, .unarchive:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .session-row.archived .session-name, .session-row.archived .session-timestamp { color: var(--vscode-descriptionForeground); }
    .session-row.selected .session-name, .session-row.selected .session-timestamp { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }
    .session-row.selected:focus-within .session-name, .session-row.selected:focus-within .session-timestamp { color: var(--vscode-list-activeSelectionForeground, var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground))); }
    .empty, #status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .empty { padding: 24px 8px; text-align: center; }
    #status { min-height: 16px; margin: 0; overflow-wrap: anywhere; }
    #status:empty { display: none; }
    #status.error { color: var(--vscode-errorForeground); }
`;
