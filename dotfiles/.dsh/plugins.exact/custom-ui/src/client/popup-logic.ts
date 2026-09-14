/**
 * Pure logic shared by the Ctrl+K → Ctrl+M popup: option rows and selection
 * lookup over the per-session model directory, built to match the stock
 * /model popup's row construction (same detail composition and failure copy)
 * so both entries render the same screen. Kept structural so tests stay
 * dependency-free.
 */

export interface DirectoryModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: { readonly defaultEffort?: string };
}

export interface DirectoryGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly DirectoryModel[];
}

export interface DirectoryFailure {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface DirectoryCurrent {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface DirectoryState {
  readonly current: DirectoryCurrent | null;
  readonly groups: readonly DirectoryGroup[];
  readonly failures: readonly DirectoryFailure[];
}

export interface PopupOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly active?: true;
}

export interface ModelSelectionLike {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
export function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Flatten the directory into popup rows; failure rows list for visibility but never select. */
export function optionsOf(state: DirectoryState): PopupOption[] {
  const rows: PopupOption[] = [];
  for (const group of state.groups) {
    for (const model of group.models) {
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        detail:
          model.description !== undefined ? `${group.name} · ${model.description}` : group.name,
        ...(state.current !== null &&
        state.current.provider === group.id &&
        state.current.model === model.id
          ? { active: true as const }
          : {}),
      });
    }
  }
  for (const failure of state.failures) {
    rows.push({
      id: `failure/${failure.id}`,
      label: failure.name,
      detail: `Catalog failed to load: ${failure.message}`,
    });
  }
  return rows;
}

/**
 * Resolve a picked row id into the complete selection: keeping the current
 * effort when the same model is already selected, otherwise the model's own
 * default effort. Returns undefined for rows without a catalog entry.
 */
export function selectionOf(state: DirectoryState, id: string): ModelSelectionLike | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id) continue;
      const reasoningEffort =
        state.current?.provider === group.id && state.current.model === model.id
          ? (state.current.reasoningEffort ?? model.reasoning?.defaultEffort)
          : model.reasoning?.defaultEffort;
      return {
        provider: group.id,
        model: model.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
    }
  }
  return undefined;
}

/**
 * The session whose /model popup the chord opens: the current ordinary
 * session, else undefined. Mirrors the stock /model command's availability
 * (addressed subagent sessions expose no model-selection contract).
 */
export function chordPopupTarget<T>(
  current: T | undefined,
  subagentAddress: (id: T) => unknown,
): T | undefined {
  if (current === undefined) return undefined;
  if (subagentAddress(current) !== undefined) return undefined;
  return current;
}

/** Structural face of the per-session model directory the popup spec needs. */
export interface DirectoryLike {
  load(): Promise<DirectoryState>;
  store: { getSnapshot(): DirectoryState };
  select(selection: ModelSelectionLike): Promise<unknown> | unknown;
}

/** Open-time context handed to the popup spec (matches the stock spec's `session`). */
export interface ModelPopupContext<S extends string = string> {
  readonly sessionId: S;
}

/**
 * Build the /model popup spec the chord opens with. Directory resolution
 * stays inside options()/onSelect() — never at keydown time — mirroring the
 * stock /model contribution, so a session with degraded remote wiring fails
 * the shell's options load (its retry UI) instead of throwing out of the
 * keydown handler.
 */
export function modelPopupSpec<S extends string>(
  directoryFor: (sessionId: S) => DirectoryLike,
): {
  options(context: ModelPopupContext<S>): Promise<PopupOption[]>;
  onSelect(option: PopupOption, context: ModelPopupContext<S>): Promise<void>;
} {
  return {
    options: async (context) => optionsOf(await directoryFor(context.sessionId).load()),
    onSelect: async (option, context) => {
      const directory = directoryFor(context.sessionId);
      const selection = selectionOf(directory.store.getSnapshot(), option.id);
      if (selection === undefined)
        throw new Error(
          "this provider's catalog failed to load — pick a model from a loaded group",
        );
      await directory.select(selection);
    },
  };
}
