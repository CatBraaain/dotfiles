// tool-allowlist — translate pi-style tool lists (`"*"`, names, `"!name"`
// negations) into dsh `tools.restrict` filters, dropping names unknown to the
// current global tool registry (dsh restrict() throws on unknown names, and
// pi-specific tool names such as `handoff_session` have no dsh counterpart).
// Semantics match pi's default-deny allowlist: without `*` exactly the listed
// tools stay visible (`[]` allows nothing); denies only matter beside `*`.
// Pure logic: the known-name set is injected.

/** Structural subset of dsh-tools `ToolRestriction`. */
export interface ToolFilter {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface TranslateResult {
  /** Restriction to pass to `tools.restrict`, or undefined for unrestricted. */
  readonly filter: ToolFilter | undefined;
  /** Entry names dropped because they are not registered global tools. */
  readonly skipped: readonly string[];
}

// Split entries into allow/deny name sets. `"*"` marks allow-everything.
// Unknown names (not in `known`) are collected into `skipped` and excluded
// from both sets.
export function translateTools(entries: readonly string[], known: ReadonlySet<string>): TranslateResult {
  const allow = new Set<string>();
  const deny = new Set<string>();
  const skipped: string[] = [];
  let allowAll = false;

  for (const entry of entries) {
    if (entry === "*") {
      allowAll = true;
      continue;
    }
    const name = entry.startsWith("!") ? entry.slice(1) : entry;
    if (name === "") continue; // bare "!" — config validation rejects it earlier
    if (!known.has(name)) {
      skipped.push(name);
      continue;
    }
    (entry.startsWith("!") ? deny : allow).add(name);
  }

  if (allowAll) {
    // ["*"] — everything stays visible; denies punch holes in it.
    return deny.size === 0
      ? { filter: undefined, skipped }
      : { filter: { deny: [...deny] }, skipped };
  }
  // Default deny (pi parity): exactly the listed known tools stay visible,
  // so `[]` and all-unknown lists restrict to nothing. Denials without `*`
  // are subsumed — the allow mask already excludes everything else.
  return { filter: { allow: [...allow] }, skipped };
}
