/** Styles for the sessions webview; shared as-is by the stories catalog. */
export const webviewStyles = `
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    button { font: inherit; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #app { padding: 10px; }
    header, .session-row, .group-header { display: flex; align-items: center; }
    header { justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    h1 { margin: 0; font-size: 13px; font-weight: 600; }
    .header-actions { display: flex; gap: 4px; }
    button { border: 1px solid transparent; border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .icon-button { min-width: 26px; padding: 3px 6px; }
    .group { overflow: hidden; margin-top: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
    .group-header { gap: 8px; min-width: 0; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBarSectionHeader-background); }
    .group-title { flex: 1; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .group-path { padding: 5px 8px; color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
    .group-modes { display: flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
    .mode-button { padding: 2px 6px; color: var(--vscode-foreground); background: transparent; font-size: 10px; }
    .mode-button:hover { background: var(--vscode-list-hoverBackground); }
    .mode-button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .session-row { position: relative; min-width: 0; }
    .session-row + .session-row { border-top: 1px solid var(--vscode-widget-border); }
    .session-button { display: grid; box-sizing: border-box; grid-template-columns: 8px minmax(0, 1fr); width: 100%; gap: 7px; min-width: 0; padding: 5px calc(40% + 56px) 5px 8px; border-radius: 0; color: var(--vscode-foreground); background: transparent; text-align: left; }
    .session-button:hover { background: var(--vscode-list-hoverBackground); }
    .session-name { display: block; overflow: hidden; min-width: 0; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .session-timestamp { position: absolute; top: 50%; right: 56px; overflow: hidden; max-width: 40%; transform: translateY(-50%); color: var(--vscode-descriptionForeground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .indicator { width: 6px; height: 6px; margin-top: 4px; border: 1px solid var(--vscode-descriptionForeground); border-radius: 50%; }
    .indicator.active { border-color: var(--vscode-testing-iconPassed); background: var(--vscode-testing-iconPassed); }
    .copy { position: absolute; top: 50%; right: 30px; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; transform: translateY(-50%); color: var(--vscode-descriptionForeground); background: transparent; }
    .copy:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .copy.copied { color: var(--vscode-testing-iconPassed); }
    .archive { position: absolute; top: 50%; right: 4px; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; transform: translateY(-50%); color: var(--vscode-descriptionForeground); background: transparent; }
    .archive:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .empty, #status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .empty { padding: 24px 8px; text-align: center; }
    #status { min-height: 16px; margin: 8px 0 0; }
    #status.error { color: var(--vscode-errorForeground); }
`;
