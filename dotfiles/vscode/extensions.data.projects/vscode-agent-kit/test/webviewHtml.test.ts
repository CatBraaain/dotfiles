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

    expect(html).toContain('.mode-button[aria-pressed="true"]');
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
    expect(html).toContain('data-action="newSession"');
    expect(html).toContain('data-action="refresh"');
    expect(html).toContain('<section id="sessions"');
    expect(html).toContain('<p id="status"');
  });

  it("leaves the workspace mode toggles to the dynamically rendered groups", () => {
    const html = webviewHtml({ scriptUri: "https://vscode-host/webview/client.js", nonce: "n" });

    expect(html).not.toContain("data-mode=");
    expect(html).not.toContain("mode-switch");
  });
});
