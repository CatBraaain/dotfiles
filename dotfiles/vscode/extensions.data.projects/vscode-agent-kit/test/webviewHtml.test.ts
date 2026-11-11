import { describe, expect, it } from "vitest";
import { webviewHtml } from "../src/webview/webviewHtml";

describe("webviewHtml", () => {
  it("binds the given nonce to the CSP, style, and module script", () => {
    const html = webviewHtml({
      scriptUri: "https://vscode-host/webview/client.js",
      nonce: "Ab12+/zZ==",
    });

    expect(html).toContain("script-src 'nonce-Ab12+/zZ=='");
    expect(html).toContain("style-src 'nonce-Ab12+/zZ=='");
    expect(html).toContain('<style nonce="Ab12+/zZ==">');
    expect(html).toContain(
      '<script type="module" nonce="Ab12+/zZ==" src="https://vscode-host/webview/client.js"></script>',
    );
  });

  it("includes the CSS from webviewStyles", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain(".group-mode-toggle svg { width: 16px; height: 16px; }");
    expect(html).toContain(".archive, .unarchive {");
    expect(html).not.toContain(".copy");
    expect(html).not.toContain(".lock");
    expect(html).not.toContain("data-locked");
    expect(html).toContain(".session-row.selected .session-button");
    expect(html).toContain("#status.error");
  });

  it("styles the workspace context menu without permanent Unregister controls", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain(".workspace-menu { position: fixed; z-index: 2;");
    expect(html).toContain("var(--vscode-menu-background, var(--vscode-sideBar-background))");
    expect(html).toContain(".workspace-menu button:hover");
    expect(html).not.toContain(".workspace-menu button:focus");
    expect(html).toContain(".group-workspace-menu { opacity: 0; }");
    expect(html).toContain(".group-workspace-menu:hover { opacity: 1; }");
    expect(html).not.toContain(".group-unregister");
  });

  it("uses readable row colors without intercepting timestamp clicks", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain(
      ".session-row.selected .session-name, .session-row.selected .session-timestamp { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }",
    );
    expect(html).toContain(
      ".session-row.archived .session-name, .session-row.archived .session-timestamp { color: var(--vscode-descriptionForeground); }",
    );
    expect(html).toContain(".session-timestamp { pointer-events: none;");
    expect(html).not.toContain(".archive:disabled");
    expect(html).toContain("padding: 0 calc(36px + 5ch + 8px) 0 4px;");
    expect(html).toContain("right: 36px;");
  });

  it("aligns session rows with group headers and paints the full hit target", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain(
      ".session-row { position: relative; min-width: 0; height: 32px; margin-left: -8px;",
    );
    expect(html).toContain(".session-button { position: relative; isolation: isolate;");
    expect(html).toContain('content: ""; position: absolute; inset: -1px;');
    expect(html).toContain("pointer-events: none; z-index: -1;");
    expect(html).toContain(".session-button:hover { background: transparent; }");
    expect(html).toContain(".session-button:focus-visible { outline: none; }");
    expect(html).toContain(".session-button:focus-visible::before { outline: 2px solid");
    expect(html).toContain(".session-row.selected .session-button::before");
    expect(html).toContain("padding: 0 calc(36px + 5ch + 8px) 0 4px;");
  });

  it("keeps the fixed controls markup the client script wires up", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain("<title>Sessions</title>");
    expect(html).toContain('<section id="sessions"');
    expect(html).toContain('<p id="status"');
  });

  it("leaves the Sessions title and refresh action to the native view header", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).not.toContain("<header>");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain('data-action="refresh"');
    expect(html).not.toContain(".header-actions");
    expect(html).not.toContain(".icon-button");
  });

  it("keeps the New workspace form and footer markup for the client script", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain('<div id="workspace-form" hidden>');
    expect(html).toContain('<input id="workspace-path" type="text" placeholder="/absolute/path"');
    expect(html).toContain('data-action="toggleWorkspaceForm"');
    expect(html).toContain("New workspace");
    expect(html).toContain(
      '<footer class="footer">\n      <p id="status" role="status" aria-live="polite"></p>',
    );
    expect(html).toContain(".new-workspace[hidden] { display: none; }");
    expect(html).toContain("#workspace-path { box-sizing: border-box; width: 100%; height: 32px;");
    expect(html).toContain('<div class="workspace-control">');
    expect(html.match(/class="workspace-folder-icon"/g)).toHaveLength(1);
    expect(html).toContain('<svg class="workspace-folder-icon" width="16" height="16"');
    expect(html).toContain('aria-hidden="true" focusable="false"');
  });

  it("omits the confirmation dialog markup and styles", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).not.toContain("confirmation-dialog");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-action="cancelConfirmation"');
    expect(html).not.toContain('data-action="confirmConfirmation"');
    expect(html).not.toContain(".dialog");
  });

  it("drops the header New session action in favor of the per-group plus button", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).not.toContain('data-action="newSession"');
  });

  it("keeps mode toggles out of the fixed header markup", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).not.toContain('class="mode-toggle"');
    expect(html).not.toContain("data-mode-toggle");
    expect(html).not.toContain("data-mode-icon");
  });
});
