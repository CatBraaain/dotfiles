import type { Decorator, Preview } from "@storybook/react";
import { webviewStyles } from "../src/webview/webviewStyles";

/** Dark-theme fallbacks for the --vscode-* variables the webview styles use;
 * mirrors a VS Code dark sidebar so the catalog matches the real view. */
const vscodeThemeFallbacks = `
  :root {
    --vscode-foreground: #cccccc;
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif;
    --vscode-font-size: 13px;
    --vscode-sideBar-background: #181818;
    --vscode-focusBorder: #0078d4;
    --vscode-button-foreground: #ffffff;
    --vscode-button-background: #0078d4;
    --vscode-button-hoverBackground: #026ec1;
    --vscode-widget-border: #2b2b2b;
    --vscode-sideBarSectionHeader-background: #181818;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editor-font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-toolbar-hoverBackground: #2a2d2e;
    --vscode-list-inactiveSelectionBackground: #37373d;
    --vscode-list-inactiveSelectionForeground: #cccccc;
    --vscode-disabledForeground: rgba(204, 204, 204, 0.6);
    --vscode-testing-iconPassed: #73c991;
    --vscode-errorForeground: #f48771;
  }
`;

function injectStyle(id: string, css: string): void {
  if (document.getElementById(id) !== null) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}

const withWebviewChrome: Decorator = (Story) => {
  injectStyle("vscode-theme-fallbacks", vscodeThemeFallbacks);
  injectStyle("sessions-webview-styles", webviewStyles);
  return Story();
};

/** Sidebar width viewports from SPEC.md「静的プレビュー」: the iframe width
 * stands in for the VS Code sidebar width. Exported for the config test. */
export const sidebarViewports = {
  narrow: { name: "narrow 320px", styles: { width: "320px", height: "640px" } },
  wide: { name: "wide 720px", styles: { width: "720px", height: "900px" } },
} as const;

/** The catalog opens at the narrow sidebar width. */
export const defaultViewport = "narrow";

const preview: Preview = {
  decorators: [withWebviewChrome],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport, options: sidebarViewports },
  },
};

export default preview;
