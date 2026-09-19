/** Styles for the sessions webview; shared as-is by the stories catalog. */
export const webviewStyles = `
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    button { font: inherit; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #app { padding: 10px; }
    header, .mode-switch, .session-row, .group-header { display: flex; align-items: center; }
    header { justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    h1 { margin: 0; font-size: 13px; font-weight: 600; }
    .header-actions, .mode-switch { display: flex; gap: 4px; }
    button { border: 1px solid transparent; border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .icon-button { min-width: 26px; padding: 3px 6px; }
    .mode-switch { margin: 0 0 10px; padding: 2px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
    .mode-button { flex: 1; padding: 4px 8px; color: var(--vscode-foreground); background: transparent; }
    .mode-button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .group { overflow: hidden; margin-top: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
    .group-header { min-width: 0; padding: 7px 8px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBarSectionHeader-background); }
    .group-title { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .group-path { overflow: hidden; margin-top: 2px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .session-row { gap: 4px; min-width: 0; padding: 3px; }
    .session-row + .session-row { border-top: 1px solid var(--vscode-widget-border); }
    .session-button { display: grid; grid-template-columns: 8px minmax(0, 1fr); flex: 1; gap: 7px; min-width: 0; padding: 5px; color: var(--vscode-foreground); background: transparent; text-align: left; }
    .session-button:hover { background: var(--vscode-list-hoverBackground); }
    .session-content, .session-name, .session-meta { min-width: 0; }
    .session-name, .session-meta { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-name { font-size: 12px; }
    .session-meta { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .indicator { width: 6px; height: 6px; margin-top: 4px; border: 1px solid var(--vscode-descriptionForeground); border-radius: 50%; }
    .indicator.active { border-color: var(--vscode-testing-iconPassed); background: var(--vscode-testing-iconPassed); }
    .deactivate { padding: 3px 5px; color: var(--vscode-foreground); background: transparent; font-size: 10px; }
    .empty, #status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .empty { padding: 24px 8px; text-align: center; }
    #status { min-height: 16px; margin: 8px 0 0; }
    #status.error { color: var(--vscode-errorForeground); }
`;
