/** Styles for the sessions webview; shared as-is by the stories catalog. */
export const webviewStyles = `
    :root { --session-radius: 9.6px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    button { box-sizing: border-box; border: 1px solid transparent; border-radius: var(--session-radius); color: var(--vscode-foreground); background: transparent; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    button:hover { background: var(--vscode-list-hoverBackground); }
    svg { flex: none; pointer-events: none; }
    #app { padding: 12px; }
    header, .group-header { display: flex; align-items: center; }
    header { justify-content: space-between; gap: 8px; min-height: 24px; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 13px; font-weight: 600; line-height: 24px; }
    .header-actions { display: flex; gap: 4px; }
    .icon-button { min-width: 24px; height: 24px; padding: 0 8px; color: var(--vscode-descriptionForeground); }
    .icon-button:hover { color: var(--vscode-foreground); }
    .icon-button[data-action="refresh"] { width: 24px; padding: 0; }
    .footer { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 12px; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent); }
    .new-workspace { display: inline-flex; align-items: center; gap: 6px; width: 100%; height: 32px; padding: 0 10px; border-radius: var(--session-radius); color: var(--vscode-foreground); font-size: 13px; font-weight: 500; text-align: left; }
    .new-workspace[aria-expanded="true"] { background: var(--vscode-list-hoverBackground); }
    .new-workspace svg { flex: none; width: 16px; height: 16px; }
    #workspace-form { display: flex; flex-direction: column; gap: 8px; }
    #workspace-form[hidden] { display: none; }
    #workspace-path { height: 32px; padding: 0 8px; border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-widget-border) 50%, transparent)); border-radius: var(--session-radius); background: var(--vscode-input-background); color: var(--vscode-input-foreground, var(--vscode-foreground)); font: inherit; font-size: 13px; }
    #workspace-path:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    #workspace-path::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
    .form-actions { display: flex; gap: 8px; }
    .form-button { height: 32px; padding: 0 10px; border-radius: var(--session-radius); color: var(--vscode-foreground); font-size: 13px; font-weight: 500; }
    .form-button[data-action="addWorkspace"] { border: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent); }
    .form-button[data-action="cancelWorkspaceForm"] { color: var(--vscode-descriptionForeground); }
    .form-button[data-action="cancelWorkspaceForm"]:hover { background: transparent; color: var(--vscode-foreground); }
    .group { min-width: 0; }
    .group + .group { margin-top: 12px; }
    .group-header { gap: 4px; min-width: 0; min-height: 24px; }
    .group-chevron, .group-new-session { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-foreground); }
    .group-title { flex: 1; overflow: hidden; min-width: 0; height: 24px; padding: 0; font-size: 14px; font-weight: 600; line-height: 20px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    .group-modes { display: flex; flex: none; gap: 2px; padding: 1px; border: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent); border-radius: var(--session-radius); }
    .mode-button { height: 20px; padding: 0 6px; border-radius: 8px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 18px; }
    .mode-button:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .mode-button[aria-pressed="true"] { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); background: var(--vscode-list-inactiveSelectionBackground); }
    .session-row { position: relative; min-width: 0; height: 32px; margin-left: 12px; border-radius: var(--session-radius); }
    .group-header + .session-row { margin-top: 4px; }
    .session-button { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 32px; padding: 0 calc(84px + 5ch + 8px) 0 8px; border-radius: var(--session-radius); color: var(--vscode-foreground); background: transparent; text-align: left; }
    .session-button:hover { background: var(--vscode-list-hoverBackground); }
    .session-row.selected .session-button, .session-row.selected .session-button:hover { background: var(--vscode-list-inactiveSelectionBackground); }
    .session-row.selected:focus-within .session-button { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-inactiveSelectionBackground)); }
    .session-status { box-sizing: border-box; flex: none; width: 10px; height: 10px; border: 1px solid transparent; border-radius: 50%; background: var(--vscode-testing-iconPassed, var(--vscode-descriptionForeground)); }
    .session-status[data-locked="true"] { background: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
    .session-status[data-archived="true"] { border-color: var(--vscode-descriptionForeground); background: transparent; }
    .session-name { display: block; flex: 1; overflow: hidden; min-width: 0; font-size: 13px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
    .session-timestamp { pointer-events: none; position: absolute; top: 50%; right: 84px; overflow: hidden; width: 5ch; transform: translateY(-50%); color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 20px; text-align: right; white-space: nowrap; }
    .copy, .lock, .archive { position: absolute; top: 50%; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; transform: translateY(-50%); color: var(--vscode-descriptionForeground); background: transparent; }
    .copy svg, .lock svg, .archive svg, .group-chevron svg, .group-new-session svg { width: 12px; height: 12px; }
    .copy { right: 52px; }
    .lock { right: 28px; }
    .archive { right: 4px; }
    .copy:hover, .lock:hover, .archive:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .copy.copied { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
    .lock[aria-pressed="true"] { color: var(--vscode-foreground); }
    .session-row.archived .session-name, .session-row.archived .session-timestamp { color: var(--vscode-descriptionForeground); }
    .session-row.selected .session-name, .session-row.selected .session-timestamp { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }
    .session-row.selected:focus-within .session-name, .session-row.selected:focus-within .session-timestamp { color: var(--vscode-list-activeSelectionForeground, var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground))); }
    .archive:disabled, .archive:disabled:hover { color: var(--vscode-disabledForeground); background: transparent; cursor: default; }
    .empty, #status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .empty { padding: 24px 8px; text-align: center; }
    #status { min-height: 16px; margin: 8px 0 0; }
    #status.error { color: var(--vscode-errorForeground); }
`;
