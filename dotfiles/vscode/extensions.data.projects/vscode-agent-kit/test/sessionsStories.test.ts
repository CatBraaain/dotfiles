import { describe, expect, it } from "vitest";
import * as stories from "../stories/sessions.stories";

/** Spec table row 1 (表示モードとデータ) mapped to the story export names. */
const storyDemoStates = {
  ActiveSessions: "sample",
  AllSessions: "all",
  ActiveEmpty: "active-empty",
  AllEmpty: "all-empty",
} as const;

describe("sessions stories", () => {
  for (const [exportName, demoState] of Object.entries(storyDemoStates)) {
    it(`renders the ${exportName} story from the "${demoState}" demo state`, () => {
      const story = stories[exportName as keyof typeof stories];
      expect(story.parameters).toMatchObject({ demoState });
      expect(typeof story.render).toBe("function");
    });
  }
});
