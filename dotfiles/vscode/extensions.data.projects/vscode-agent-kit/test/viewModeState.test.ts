import { describe, expect, it, vi } from "vitest";
import { ViewModeState, type GlobalStateLike } from "../src/viewModeState";

function createStateStore(initial: string | undefined) {
  const stored = { value: initial };
  const globalState: GlobalStateLike = {
    get: <T>(key: string): T | undefined => {
      expect(key).toBe("piSessions.viewMode");
      return stored.value as T | undefined;
    },
    update: vi.fn((key: string, value: unknown) => {
      stored.value = value as string;
    }),
  };
  return { globalState, stored };
}

describe("ViewModeState", () => {
  it("restores 'all' from persisted state", () => {
    const { globalState } = createStateStore("all");
    expect(ViewModeState.restore(globalState).mode).toBe("all");
  });

  it("defaults to 'active' when unset or unknown", () => {
    expect(ViewModeState.restore(createStateStore(undefined).globalState).mode).toBe("active");
    expect(ViewModeState.restore(createStateStore("bogus").globalState).mode).toBe("active");
  });

  it("persists a mode change and updates the current mode", () => {
    const { globalState } = createStateStore(undefined);
    const state = ViewModeState.restore(globalState);

    state.set("all");

    expect(state.mode).toBe("all");
    expect(globalState.update).toHaveBeenCalledWith("piSessions.viewMode", "all");
  });

  it("does not write when the mode is unchanged", () => {
    const { globalState } = createStateStore("all");
    const state = ViewModeState.restore(globalState);

    state.set("all");

    expect(globalState.update).not.toHaveBeenCalled();
    expect(state.mode).toBe("all");
  });
});
