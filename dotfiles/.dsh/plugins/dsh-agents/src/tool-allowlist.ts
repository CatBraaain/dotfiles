// tool-allowlist — translate pi-style tool lists (`"*"`, names, `"!name"`
// negations) into dsh `tools.restrict` filters, dropping names unknown to the
// current global tool registry (dsh restrict() throws on unknown names, and
// pi-specific tool names such as `handoff_session` have no dsh counterpart).
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
    if (entry.startsWith("!")) {
      if (name === "") continue; // bare "!" — config validation rejects it earlier
      if (!known.has(name)) skipped.push(name);
      else deny.add(name);
    } else {
      if (!known.has(name)) skipped.push(name);
      else allow.add(name);
    }
  }

  const isDenyOnly = allowAll && allow.size === 0;
  if (isDenyOnly) {
    // ["*", "!x"] — everything stays visible except the denials.
    return deny.size === 0
      ? { filter: undefined, skipped }
      : { filter: { deny: [...deny] }, skipped };
  }
  if (allow.size === 0 && deny.size === 0) {
    // Everything was unknown or the list was `[]`-with-no-known-names: either
    // way there is nothing to restrict (or nothing restrictable left).
    return { filter: undefined, skipped };
  }
  if (allow.size === 0) {
    // A pure pi allowlist whose every name is unknown cannot be expressed as
    // an allow set (restrict rejects empty allow lists); fall back to deny-only.
    return { filter: { deny: [...deny] }, skipped };
  }
  return {
    filter: {
      allow: [...allow],
      ...(!allowAll && deny.size > 0 ? { deny: [...deny] } : {}),
    },
    skipped,
  };
}
