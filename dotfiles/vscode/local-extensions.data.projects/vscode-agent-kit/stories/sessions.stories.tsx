/** Stories catalog for the sessions sidebar: the real webview markup and
 * client render against the demo bridge; no VS Code API is involved. */

import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef } from "react";
import { initClient } from "../src/webview/client";
import { webviewAppMarkup } from "../src/webview/webview-html";
import { createDemoBridge, type DemoState } from "./demo-bridge";

const meta: Meta = {
  title: "Sessions/Sidebar",
  parameters: { layout: "fullscreen" },
};

export default meta;

type SessionsStory = StoryObj;

/** Story parameters beyond the demo state, mapped 1:1 into mount options. */
interface StoryOptions {
  allModeCwd?: string;
}

interface SessionStoryViewProps {
  demoState: DemoState;
  allModeCwd?: string;
}

/** Mount the fixed webview markup and run the real client against the demo
 * bridge. The effect cleanup disposes the client on story change: initClient
 * adds a document-level click listener and stories share one canvas iframe
 * across navigation. */
function SessionStoryView({ demoState, allModeCwd }: SessionStoryViewProps) {
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

    let frame = 0;
    if (allModeCwd !== undefined) {
      function clickModeToggle(): void {
        const toggle = mount.querySelector<HTMLElement>(`[data-mode-toggle="${allModeCwd}"]`);
        if (toggle !== null) toggle.click();
        else frame = requestAnimationFrame(clickModeToggle);
      }
      frame = requestAnimationFrame(clickModeToggle);
    }

    return () => {
      cancelAnimationFrame(frame);
      dispose();
      mount.remove();
    };
  }, [demoState, allModeCwd]);

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
    render: () => <SessionStoryView demoState={demoState} allModeCwd={options.allModeCwd} />,
  };
}

export const SampleSessions: SessionsStory = storyFromDemoState(
  "Sample — active workspaces",
  "sample",
);

export const AllMode: SessionsStory = storyFromDemoState("Sample — workspace All mode", "sample", {
  allModeCwd: "~/projects/vscode-agent-kit",
});

export const EmptySessions: SessionsStory = storyFromDemoState(
  "Sample — no unarchived sessions",
  "empty",
);

export const PublishDelay: SessionsStory = storyFromDemoState("Sample — publish delay", "delayed");
