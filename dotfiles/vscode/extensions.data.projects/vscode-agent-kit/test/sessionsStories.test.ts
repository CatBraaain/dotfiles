import { describe, expect, it } from "vitest";
import * as stories from "../stories/sessions.stories";

/** Spec table row (静的プレビュー「データ」) mapped to the story export names. */
const storyParameters = {
  SampleSessions: { demoState: "sample" },
  WorkspaceAllMode: { demoState: "sample", toggleAllWorkspace: true },
  EmptySessions: { demoState: "empty" },
} as const;

describe("sessions stories", () => {
  for (const [exportName, parameters] of Object.entries(storyParameters)) {
    it(`renders the ${exportName} story from its demo parameters`, () => {
      const story = stories[exportName as keyof typeof stories];
      expect(story.parameters).toMatchObject(parameters);
      expect(typeof story.render).toBe("function");
    });
  }
});
