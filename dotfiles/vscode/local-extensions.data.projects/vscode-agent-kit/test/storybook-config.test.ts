import { describe, expect, it } from "vitest";
import { defaultViewport, sidebarViewports } from "../.storybook/preview";

describe("storybook catalog configuration", () => {
  it("exposes the narrow and wide sidebar viewports from the spec", () => {
    expect(Object.keys(sidebarViewports).sort()).toEqual(["narrow", "wide"]);
    expect(sidebarViewports.narrow.styles.width).toBe("320px");
    expect(sidebarViewports.wide.styles.width).toBe("720px");
  });

  it("opens the catalog at the narrow sidebar width", () => {
    expect(defaultViewport).toBe("narrow");
  });
});
