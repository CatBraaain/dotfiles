import { webviewStyles } from "./webviewStyles";

export interface WebviewHtmlOptions {
  /** Webview URI of the client module (dist-webview/webview/client.js). */
  scriptUri: string;
  /** Cryptographic nonce shared by the CSP and the style/script elements. */
  nonce: string;
}

/** Fixed view markup inside <body>; the stories catalog renders the same tree.
 * The workspace form sits below the New workspace button and starts hidden. */
export const webviewAppMarkup = `<main id="app">
    <header>
      <h1>Sessions</h1>
      <div class="header-actions">
        <button class="icon-button" type="button" data-action="refresh" aria-label="Refresh sessions" title="Refresh session list">↻</button>
      </div>
    </header>
    <section id="sessions" aria-live="polite"></section>
    <footer class="footer">
      <button class="new-workspace" type="button" data-action="toggleWorkspaceForm" aria-expanded="false">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 10v6"></path><path d="M9 13h6"></path><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>
        New workspace
      </button>
      <div id="workspace-form" hidden>
        <input id="workspace-path" type="text" placeholder="/absolute/path" aria-label="Workspace path (Enter to add, Escape to close)" autocomplete="off" spellcheck="false">
      </div>
    </footer>
    <p id="status" role="status" aria-live="polite"></p>
  </main>`;

/** Self-contained webview document; session data arrives only through postMessage. */
export function webviewHtml(options: WebviewHtmlOptions): string {
  const { scriptUri, nonce } = options;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Sessions</title>
  <style nonce="${nonce}">${webviewStyles}</style>
</head>
<body>
  ${webviewAppMarkup}
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
