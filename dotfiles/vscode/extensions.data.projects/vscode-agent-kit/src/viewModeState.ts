import type { ViewMode } from "./viewMode";

/** Minimal globalState surface so persistence logic is testable without VS Code. */
export interface GlobalStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
}

/** View mode persisted in globalState so it survives VS Code restarts. */
export class ViewModeState {
  private static readonly storageKey = "piSessions.viewMode";
  private modeValue: ViewMode;

  private constructor(
    private readonly globalState: GlobalStateLike,
    initialMode: string | undefined,
  ) {
    this.modeValue = initialMode === "all" ? "all" : "active";
  }

  static restore(globalState: GlobalStateLike): ViewModeState {
    return new ViewModeState(globalState, globalState.get<string>(ViewModeState.storageKey));
  }

  get mode(): ViewMode {
    return this.modeValue;
  }

  set(mode: ViewMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    void this.globalState.update(ViewModeState.storageKey, mode);
  }
}
