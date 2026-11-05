/** Stories catalog for the sessions sidebar: the real webview markup and
 * client render against the demo bridge; no VS Code API is involved. */

import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef } from "react";
import { initClient } from "../src/webview/client";
import { webviewAppMarkup } from "../src/webview/webviewHtml";
import { createDemoBridge, type DemoState } from "./demoBridge";

const meta: Meta = {
  title: "Sessions/Sidebar",
  parameters: { layout: "fullscreen" },
};

export default meta;

type SessionsStory = StoryObj;

/** Story parameters beyond the demo state, mapped 1:1 into mount options. */
interface StoryOptions {
  /** Switch the shared header toggle to All after mounting. */
  toggleAll?: boolean;
}

interface SessionStoryViewProps {
  demoState: DemoState;
  toggleAll?: boolean;
}

/** Mount the fixed webview markup and run the real client against the demo
 * bridge. The effect cleanup disposes the client on story change: initClient
 * adds a document-level click listener and stories share one canvas iframe
 * across navigation. */
function SessionStoryView({ demoState, toggleAll }: SessionStoryViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = document.createElement("div");
    mount.innerHTML = webviewAppMarkup;
    // Attach before initClient: it queries the document for the fixed markup ids.
    hostRef.current?.append(mount);
    const { bridge, reset } = createDemoBridge();
    const dispose = initClient(bridge);
    // Safe to call synchronously: initClient subscribes to the bridge before
    // React commits, so the sessions message is never lost.
    reset(demoState);

    // React renders #sessions asynchronously; wait for the mode button to
    // exist before clicking it, and stop retrying once the story unmounts.
    let frame = 0;
    if (toggleAll === true) {
      const clickModeToggle = (): void => {
        const toggle = mount.querySelector<HTMLElement>('#app header [data-mode="all"]');
        if (toggle !== null) toggle.click();
        else frame = requestAnimationFrame(clickModeToggle);
      };
      frame = requestAnimationFrame(clickModeToggle);
    }

    return () => {
      cancelAnimationFrame(frame);
      dispose();
      mount.remove();
    };
  }, [demoState, toggleAll]);

  return <div ref={hostRef} />;
}

/** Story that mounts the session view from the demo state in its parameters,
 * so the story-to-state mapping is verifiable without a DOM. */
function storyFromDemoState(
  name: string,
  demoState: DemoState,
  options: StoryOptions = {},
): SessionsStory {
  return {
    name,
    parameters: { demoState, ...options },
    render: () => <SessionStoryView demoState={demoState} toggleAll={options.toggleAll} />,
  };
}

export const SampleSessions: SessionsStory = storyFromDemoState(
  "Sample — active workspaces",
  "sample",
);

export const AllMode: SessionsStory = storyFromDemoState("Sample — shared All mode", "sample", {
  toggleAll: true,
});

export const EmptySessions: SessionsStory = storyFromDemoState(
  "Sample — no unarchived sessions",
  "empty",
);
