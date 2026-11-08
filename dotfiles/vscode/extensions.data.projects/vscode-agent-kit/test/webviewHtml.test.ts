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

    expect(html).toContain(".mode-toggle svg[hidden] { display: none; }");
    expect(html).toContain(".archive, .unarchive {");
    expect(html).not.toContain(".copy");
    expect(html).not.toContain(".lock");
    expect(html).not.toContain("data-locked");
    expect(html).toContain(".session-row.selected .session-button");
    expect(html).toContain("#status.error");
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
    expect(html).toContain("padding: 0 calc(36px + 5ch + 8px) 0 8px;");
    expect(html).toContain("right: 36px;");
  });

  it("keeps the fixed controls markup the client script wires up", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain("<h1>Sessions</h1>");
    expect(html).toContain('data-action="refresh"');
    expect(html).toContain('<section id="sessions"');
    expect(html).toContain('<p id="status"');
  });

  it("keeps the New workspace form and footer markup for the client script", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain('<div id="workspace-form" hidden>');
    expect(html).toContain('<input id="workspace-path" type="text" placeholder="/absolute/path"');
    expect(html).toContain('data-action="toggleWorkspaceForm"');
    expect(html).toContain("New workspace");
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

  it("keeps the shared mode toggle in the fixed header markup", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain('class="mode-toggle"');
    expect(html).toContain('data-mode-toggle data-mode="unarchived"');
    expect(html).toContain('data-mode-icon="unarchived"');
    expect(html).toContain('data-mode-icon="all"');
    expect(html).toContain('aria-label="Show all sessions"');
    expect(html).not.toContain("group-modes");
  });
});
