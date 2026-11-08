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
      <div class="mode-toggle">
        <button type="button" data-mode-toggle data-mode="unarchived" title="Show all sessions" aria-label="Show all sessions">
          <svg data-mode-icon="unarchived" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M10.1196 10.8267L14.1464 14.8536C14.3417 15.0488 14.6583 15.0488 14.8536 14.8536C15.0488 14.6583 15.0488 14.3417 14.8536 14.1464L1.85355 1.14645C1.65829 0.951184 1.34171 0.951184 1.14645 1.14645C0.951184 1.34171 0.951184 1.65829 1.14645 1.85355L4.37624 5.08334C3.90117 5.4183 3.5126 5.80026 3.19877 6.18295C2.75443 6.72477 2.46154 7.26493 2.27931 7.66977C2.18795 7.87274 2.12369 8.04329 2.08166 8.1653C2.06063 8.22636 2.03453 8.31047 2.03453 8.31047L2.01687 8.37186C2.01687 8.37186 1.94098 8.86907 2.37202 8.9833C2.63879 9.05404 2.91251 8.8948 2.98346 8.62815L2.98444 8.62471L2.99179 8.5997C2.9989 8.57616 3.01051 8.53927 3.02715 8.49095C3.06047 8.39421 3.11375 8.25227 3.19119 8.08023C3.34655 7.73507 3.59627 7.27523 3.97201 6.81706C4.26363 6.46146 4.63213 6.10494 5.09595 5.80306L6.67356 7.38067C5.9688 7.82277 5.50024 8.60667 5.50024 9.5C5.50024 10.8807 6.61953 12 8.00024 12C8.89358 12 9.67747 11.5314 10.1196 10.8267ZM9.3807 10.0878C9.15205 10.6241 8.62005 11 8.00024 11C7.17182 11 6.50024 10.3284 6.50024 9.5C6.50024 8.88019 6.87616 8.34819 7.41244 8.11955L9.3807 10.0878ZM6.31962 4.19853L7.174 5.05291C7.43366 5.01852 7.70875 5 8.00017 5C10.0445 5 11.2857 5.9115 12.0283 6.81706C12.4041 7.27523 12.6538 7.73507 12.8091 8.08023C12.8866 8.25227 12.9399 8.39421 12.9732 8.49095C12.9898 8.53927 13.0014 8.57616 13.0085 8.5997L13.0159 8.62471L13.0169 8.62815L13.0172 8.62937C13.0885 8.89555 13.3618 9.05397 13.6283 8.9833C13.8952 8.91253 14.0542 8.63878 13.9835 8.37186L13.9832 8.37069L13.9827 8.36916L13.9816 8.365L13.9781 8.35236C13.9752 8.34204 13.9711 8.328 13.9658 8.31047C13.9552 8.27541 13.9397 8.22636 13.9187 8.1653C13.8766 8.04329 13.8124 7.87274 13.721 7.66977C13.5388 7.26493 13.2459 6.72477 12.8016 6.18295C11.904 5.0885 10.3952 4 8.00017 4C7.38264 4 6.82403 4.07236 6.31962 4.19853Z"/></svg>
          <svg data-mode-icon="all" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" hidden><path d="M2.98444 8.62471L2.98346 8.62815C2.91251 8.8948 2.63879 9.05404 2.37202 8.9833C1.94098 8.86907 2.01687 8.37186 2.01687 8.37186L2.03453 8.31047C2.03453 8.31047 2.06063 8.22636 2.08166 8.1653C2.12369 8.04329 2.18795 7.87274 2.27931 7.66977C2.46154 7.26493 2.75443 6.72477 3.19877 6.18295C4.09629 5.08851 5.60509 4 8.00017 4C10.3952 4 11.904 5.08851 12.8016 6.18295C13.2459 6.72477 13.5388 7.26493 13.721 7.66977C13.8124 7.87274 13.8766 8.04329 13.9187 8.1653C13.9397 8.22636 13.9552 8.27541 13.9658 8.31047C13.9711 8.328 13.9752 8.34204 13.9781 8.35236L13.9816 8.365L13.9827 8.36916L13.9832 8.37069L13.9835 8.37186C14.0542 8.63878 13.8952 8.91253 13.6283 8.9833C13.3618 9.05397 13.0885 8.89556 13.0172 8.62937L13.0169 8.62815L13.0159 8.62471L13.0085 8.5997C13.0014 8.57616 12.9898 8.53927 12.9732 8.49095C12.9399 8.39422 12.8866 8.25227 12.8091 8.08023C12.6538 7.73508 12.4041 7.27523 12.0283 6.81706C11.2857 5.9115 10.0445 5 8.00017 5C5.95584 5 4.71464 5.9115 3.97201 6.81706C3.59627 7.27523 3.34655 7.73508 3.19119 8.08023C3.11375 8.25227 3.06047 8.39422 3.02715 8.49095C3.01051 8.53927 2.9989 8.57616 2.99179 8.5997L2.98444 8.62471ZM8.00024 7C6.61953 7 5.50024 8.11929 5.50024 9.5C5.50024 10.8807 6.61953 12 8.00024 12C9.38096 12 10.5002 10.8807 10.5002 9.5C10.5002 8.11929 9.38096 7 8.00024 7ZM6.50024 9.5C6.50024 8.67157 7.17182 8 8.00024 8C8.82867 8 9.50024 8.67157 9.50024 9.5C9.50024 10.3284 8.82867 11 8.00024 11C7.17182 11 6.50024 10.3284 6.50024 9.5Z"/></svg>
        </button>
      </div>
      <div class="header-actions">
        <button class="icon-button" type="button" data-action="refresh" aria-label="Refresh sessions">↻</button>
      </div>
    </header>
    <section id="sessions" aria-live="polite"></section>
    <div id="confirmation-dialog" hidden>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-dialog-title" aria-describedby="confirmation-dialog-target confirmation-dialog-description">
        <h2 id="confirmation-dialog-title"></h2>
        <p id="confirmation-dialog-target"><span></span></p>
        <p id="confirmation-dialog-description"></p>
        <div class="dialog-actions">
          <button class="dialog-button secondary" type="button" data-action="cancelConfirmation">Cancel</button>
          <button class="dialog-button primary" type="button" data-action="confirmConfirmation"></button>
        </div>
      </div>
    </div>
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
