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

    expect(html).toContain('.mode-toggle button[aria-pressed="true"]');
    expect(html).toContain(".archive {");
    expect(html).toContain('.lock[aria-pressed="true"]');
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
    expect(html).toContain(
      ".archive:disabled, .archive:disabled:hover { color: var(--vscode-disabledForeground);",
    );
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
    expect(html).toContain('data-action="addWorkspace"');
    expect(html).toContain('data-action="cancelWorkspaceForm"');
    expect(html).toContain('data-action="toggleWorkspaceForm"');
    expect(html).toContain("New workspace");
  });

  it("keeps the unregister confirmation dialog markup hidden by default", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain('<div id="unregister-dialog" hidden>');
    expect(html).toContain('id="unregister-dialog-cwd"');
    expect(html).toContain('data-action="cancelUnregister"');
    expect(html).toContain('data-action="confirmUnregister"');
    expect(html).toContain("Sessions stay on disk.");
  });

  it("drops the header New session action in favor of the per-group plus button", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).not.toContain('data-action="newSession"');
  });

  it("keeps the shared mode toggle in the fixed header markup", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).toContain('class="mode-toggle"');
    expect(html).toContain('data-mode="unarchived"');
    expect(html).toContain('data-mode="all"');
    expect(html).toContain('aria-label="Display mode"');
    expect(html).not.toContain("group-modes");
  });
});
