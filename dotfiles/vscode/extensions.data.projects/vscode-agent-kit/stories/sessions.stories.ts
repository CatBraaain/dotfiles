/** Stories catalog for the sessions sidebar: the real webview markup and
 * client render against the demo bridge; no VS Code API is involved. */

import type { Meta, StoryObj } from "@storybook/html";
import { initClient } from "../src/webview/client";
import { webviewAppMarkup } from "../src/webview/webviewHtml";
import { createDemoBridge, type DemoState } from "./demoBridge";

const meta: Meta = {
  title: "Sessions/Sidebar",
  parameters: { layout: "fullscreen" },
};

export default meta;

type SessionsStory = StoryObj;

/** Dispose of the previous story's client: initClient adds a document-level
 * click listener and stories share one canvas iframe across navigation. */
let teardown: (() => void) | undefined;

function mountSessionView(demoState: DemoState): HTMLElement {
  teardown?.();
  const host = document.createElement("div");
  host.innerHTML = webviewAppMarkup;
  // Attach before initClient: it queries the document for the fixed markup ids.
  document.body.append(host);
  const { bridge, reset } = createDemoBridge();
  teardown = initClient(bridge);
  reset(demoState);
  return host;
}

/** Story that mounts the session view from the demo state in its parameters,
 * so the story-to-state mapping is verifiable without a DOM. */
function storyFromDemoState(name: string, demoState: DemoState): SessionsStory {
  return {
    name,
    parameters: { demoState },
    render: (_args, context) => mountSessionView(context.parameters.demoState),
  };
}

export const ActiveSessions: SessionsStory = storyFromDemoState("Active — sample data", "sample");

export const AllSessions: SessionsStory = storyFromDemoState("All — sample data", "all");

export const ActiveEmpty: SessionsStory = storyFromDemoState("Active — empty", "active-empty");

export const AllEmpty: SessionsStory = storyFromDemoState("All — empty", "all-empty");
