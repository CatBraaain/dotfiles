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

/** Story parameters beyond the demo state, mapped 1:1 into mount options. */
interface StoryOptions {
  /** Toggle the first workspace's mode to All after mounting. */
  toggleAllWorkspace?: boolean;
}

function mountSessionView(demoState: DemoState, options: StoryOptions = {}): HTMLElement {
  teardown?.();
  const host = document.createElement("div");
  host.innerHTML = webviewAppMarkup;
  // Attach before initClient: it queries the document for the fixed markup ids.
  document.body.append(host);
  const { bridge, reset } = createDemoBridge();
  teardown = initClient(bridge);
  reset(demoState);
  if (options.toggleAllWorkspace === true) {
    host.querySelector<HTMLElement>(".group [data-mode=\"all\"]")?.click();
  }
  return host;
}

/** Story that mounts the session view from the demo state in its parameters,
 * so the story-to-state mapping is verifiable without a DOM. */
function storyFromDemoState(name: string, demoState: DemoState, options: StoryOptions = {}): SessionsStory {
  return {
    name,
    parameters: { demoState, ...options },
    render: (_args, context) =>
      mountSessionView(context.parameters.demoState as DemoState, {
        toggleAllWorkspace: context.parameters.toggleAllWorkspace as boolean | undefined,
      }),
  };
}

export const SampleSessions: SessionsStory = storyFromDemoState("Sample — active workspaces", "sample");

export const WorkspaceAllMode: SessionsStory = storyFromDemoState(
  "Sample — one workspace in All mode",
  "sample",
  { toggleAllWorkspace: true },
);

export const EmptySessions: SessionsStory = storyFromDemoState("Sample — no active sessions", "empty");
