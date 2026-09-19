import { webviewStyles } from "./webviewStyles";

export interface WebviewHtmlOptions {
  /** Webview URI of the client module (dist-webview/webview/client.js). */
  scriptUri: string;
  /** Cryptographic nonce shared by the CSP and the style/script elements. */
  nonce: string;
}

/** Fixed view markup inside <body>; the stories catalog renders the same tree. */
export const webviewAppMarkup = `<main id="app">
    <header>
      <h1>Sessions</h1>
      <div class="header-actions">
        <button class="icon-button" type="button" data-action="newSession">New session</button>
        <button class="icon-button" type="button" data-action="refresh" aria-label="Refresh sessions">↻</button>
      </div>
    </header>
    <div class="mode-switch" role="group" aria-label="Session display mode">
      <button class="mode-button" type="button" data-mode="active">Active</button>
      <button class="mode-button" type="button" data-mode="all">All</button>
    </div>
    <section id="sessions" aria-live="polite"></section>
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
