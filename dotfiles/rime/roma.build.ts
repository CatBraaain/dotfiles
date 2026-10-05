// Compiles the managed Rime romaji dictionary (kagiroi_dotfiles_romaji.dict.yaml)
// from the declarative table in roma.data.yaml. Runs in two modes:
// - local build hook: regenerates the dictionary inside dist/ and removes the
//   declaration copy so it never reaches home
// - CLI for the test harness: `bun roma.build.ts [--output <path>]`
//
// The aggregation rules (singles win over generated mappings, conflicting
// generated mappings are an error) mirror the MS-IME engine
// (undotfiles/ime/roma-table.ts) but stay local to this file: the hook runs
// from a dist snapshot whose depth depends on the OS path map, so importing
// across trees would be fragile, and the Rime table is meant to evolve
// independently anyway.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Column = "a" | "i" | "u" | "e" | "o";

// A derivation family: for every row in `rows`, and every suffix spelling in
// `suffixes`, emit `rowKey + suffix` = `row[column] + smallKana`.
type Family = {
  rows: string[];
  column: Column;
  suffixes: Record<string, string>;
  exclude?: string[];
};

// A conditional mapping: when a letter from `from` is followed by one more
// letter matching `when_before`, only the `from` letter turns into `to` and
// the following letter stays. `$same` stands for the paired `from` letter
// itself, `$convert` marks the Space/Henkan conversion-start boundary.
type Conditional = {
  from: string[];
  when_before: string[];
  to: string;
};

type Declaration = {
  name: string;
  rows: Record<string, string[]>;
  singles: Record<string, string>;
  families: Family[];
  conditionals: Conditional[];
  postroma: { replace: Record<string, string> }[];
  long_vowel: string;
};

const VOWELS = ["a", "i", "u", "e", "o"] as const;
const SINGLE_LETTER = /^[a-z]$/;
const COLUMN_INDEX: Record<Column, number> = { a: 0, i: 1, u: 2, e: 3, o: 4 };
const hookDir = (import.meta as { dir?: string }).dir as string;
const DECLARATION_PATH = `${hookDir}/roma.data.yaml`;
const DICTIONARY_NAME = "kagiroi_dotfiles_romaji.dict.yaml";
// librime rejects a dict.yaml without a version, so the builder owns one.
const DICTIONARY_VERSION = "20261005";

// Imported through a variable so type checking does not try to resolve the
// package from this file's location (the hook runs from a dist snapshot).
async function loadModule<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

// ---------- declaration loading ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDeclaration(data: unknown): Declaration {
  if (!isRecord(data)) throw new Error("roma.data.yaml: expected a mapping");

  const requireString = (key: string): string => {
    if (typeof data[key] !== "string") throw new Error(`roma.data.yaml: ${key} must be a string`);
    return data[key] as string;
  };

  const rows: Declaration["rows"] = {};
  if (!isRecord(data.rows)) throw new Error("roma.data.yaml: rows must be a mapping");
  for (const [key, columns] of Object.entries(data.rows)) {
    if (
      !Array.isArray(columns) ||
      columns.length !== VOWELS.length ||
      columns.some((kana) => typeof kana !== "string")
    )
      throw new Error(`roma.data.yaml: rows.${key} must be ${VOWELS.length} kana strings`);
    rows[key] = columns as string[];
  }

  const singles: Declaration["singles"] = {};
  if (!isRecord(data.singles)) throw new Error("roma.data.yaml: singles must be a mapping");
  for (const [key, kana] of Object.entries(data.singles)) {
    if (typeof kana !== "string")
      throw new Error(`roma.data.yaml: singles.${key} must be a string`);
    singles[key] = kana;
  }

  if (!Array.isArray(data.families)) throw new Error("roma.data.yaml: families must be a list");

  if (data.prefixes !== undefined)
    throw new Error("roma.data.yaml: prefixes is not supported; use conditionals");
  const conditionals: Declaration["conditionals"] = [];
  if (!Array.isArray(data.conditionals))
    throw new Error("roma.data.yaml: conditionals must be a list");
  for (const item of data.conditionals) {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => key !== "from" && key !== "when_before" && key !== "to")
    )
      throw new Error(
        "roma.data.yaml: conditionals entries must be mappings of from, when_before, to",
      );
    const from = item.from;
    const when = item.when_before;
    const to = item.to;
    if (
      !Array.isArray(from) ||
      from.length === 0 ||
      from.some((letter) => typeof letter !== "string" || !SINGLE_LETTER.test(letter))
    )
      throw new Error(
        "roma.data.yaml: conditionals.from must be a nonempty list of single lowercase letters",
      );
    if (
      !Array.isArray(when) ||
      when.length === 0 ||
      when.some(
        (condition) =>
          typeof condition !== "string" ||
          !(condition === "$same" || condition === "$convert" || SINGLE_LETTER.test(condition)),
      )
    )
      throw new Error(
        "roma.data.yaml: conditionals.when_before must be a nonempty list of single lowercase letters, $same, or $convert",
      );
    if (typeof to !== "string" || !to)
      throw new Error("roma.data.yaml: conditionals.to must be a nonempty string");
    conditionals.push({ from: from as string[], when_before: when as string[], to });
  }

  const postroma: Declaration["postroma"] = [];
  if (!Array.isArray(data.postroma)) throw new Error("roma.data.yaml: postroma must be a list");
  for (const processor of data.postroma) {
    if (!isRecord(processor) || Object.keys(processor).length !== 1 || !isRecord(processor.replace))
      throw new Error("roma.data.yaml: postroma processors must contain only a replace mapping");
    const replace: Record<string, string> = {};
    for (const [from, to] of Object.entries(processor.replace)) {
      if (!from || typeof to !== "string")
        throw new Error(
          "roma.data.yaml: replacements require nonempty literals and string outputs",
        );
      replace[from] = to;
    }
    postroma.push({ replace });
  }

  return {
    name: requireString("name"),
    rows,
    singles,
    families: data.families as Family[],
    conditionals,
    postroma,
    long_vowel: requireString("long_vowel"),
  };
}

// ---------- aggregation ----------

// Same rules as the MS-IME engine: singles are registered first and nothing
// overwrites an existing key, so an individual mapping always wins over a
// generated one. Generation never merges conflicting values: an equal value
// collapses into one entry, but a different value on the same key is a
// declaration error.
function buildEntries(decl: Declaration): Map<string, string> {
  const entries = new Map<string, string>();
  const individualKeys = new Set<string>();

  const addIndividual = (roma: string, kana: string) => {
    entries.set(roma, kana);
    individualKeys.add(roma);
  };
  const addGenerated = (roma: string, kana: string) => {
    const existing = entries.get(roma);
    if (existing === kana) return;
    if (existing === undefined) {
      entries.set(roma, kana);
      return;
    }
    if (!individualKeys.has(roma)) {
      throw new Error(`conflicting mapping: "${roma}" is "${existing}" and also "${kana}"`);
    }
  };

  for (const [roma, kana] of Object.entries(decl.singles)) addIndividual(roma, kana);

  for (const [rowKey, row] of Object.entries(decl.rows)) {
    for (const [i, vowel] of VOWELS.entries()) {
      // Empty slots are never emitted.
      const kana = row[i];
      if (kana) addGenerated(`${rowKey}${vowel}`, kana);
    }
  }

  for (const family of decl.families) {
    const excludePatterns = family.exclude?.map((pattern) => new RegExp(pattern));
    for (const rowKey of family.rows) {
      const row = decl.rows[rowKey];
      // Families may retain references to rows no longer declared.
      if (row === undefined) continue;
      // A small-kana-only entry would leak out on an empty slot.
      const base = row[COLUMN_INDEX[family.column]];
      for (const [suffix, small] of Object.entries(family.suffixes)) {
        const roma = `${rowKey}${suffix}`;
        if (excludePatterns?.some((pattern) => pattern.test(roma))) continue;
        if (base === "" || base === undefined) continue;
        addGenerated(roma, base + small);
      }
    }
  }

  for (const { from, when_before, to } of decl.conditionals) {
    for (const letter of from) {
      for (const when of when_before) {
        // $convert feeds the conversion-start mapping, not the dictionary.
        if (when === "$convert") continue;
        const next = when === "$same" ? letter : when;
        addGenerated(letter + next, to + next);
      }
    }
  }

  return entries;
}

// ---------- dictionary rendering ----------

function renderDictionary(decl: Declaration): string {
  const mappings = [...buildEntries(decl)].map(([roma, kana]) => `${kana}\t${roma}\t1`);
  const longVowel = `ー\t${decl.long_vowel}\t1`;
  // Sorted so the output order is deterministic and declaration edits do not
  // shuffle line order (which would show up as block-sized diff hunks).
  const records = [...mappings, longVowel].sort();
  return [
    "# Rime dictionary",
    "# encoding: utf-8",
    "# license: public domain",
    "",
    "# Generated by dotfiles/rime/roma.build.ts from roma.data.yaml.",
    "# Edit the declaration and rebuild instead of this file.",
    "",
    "---",
    `name: ${decl.name}`,
    `version: ${JSON.stringify(DICTIONARY_VERSION)}`,
    "sort: by_weight",
    "columns:",
    "  - text",
    "  - code",
    "  - weight",
    "...",
    ...records,
    "",
  ].join("\n");
}

function luaString(value: string): string {
  const escaped = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (character === '"' || character === "\\" || code < 32 || code === 127)
        return "\\" + code.toString().padStart(3, "0");
      return character;
    })
    .join("");
  return '"' + escaped + '"';
}

// Conversion-start replacements: letters declared with $convert turn into
// their `to` when Space/Henkan starts the conversion. Kept apart from the
// dictionary: equal duplicates collapse, a different `to` on the same letter
// is a declaration error.
function buildPending(decl: Declaration): Map<string, string> {
  const pending = new Map<string, string>();
  for (const { from, when_before, to } of decl.conditionals) {
    if (!when_before.includes("$convert")) continue;
    for (const letter of from) {
      const existing = pending.get(letter);
      if (existing !== undefined && existing !== to)
        throw new Error(
          `conflicting convert mapping: "${letter}" is "${existing}" and also "${to}"`,
        );
      pending.set(letter, to);
    }
  }
  return pending;
}

function renderRuntime(decl: Declaration): string {
  const pending = buildPending(decl);
  const lines = [
    "-- Generated from roma.data.yaml by roma.build.ts.",
    "return {",
    "    pending = {",
  ];
  for (const [letter, kana] of pending)
    lines.push("        [" + luaString(letter) + "] = " + luaString(kana) + ",");
  lines.push("    },", "    postroma = {");
  for (const processor of decl.postroma) {
    lines.push("        { replace = {");
    for (const [from, to] of Object.entries(processor.replace))
      lines.push("            { " + luaString(from) + ", " + luaString(to) + " },");
    lines.push("        } },");
  }
  lines.push("    },", "}", "");
  return lines.join("\n");
}

async function compile(outputPath: string): Promise<void> {
  const yaml = await loadModule<{ parse: (text: string) => unknown }>("yaml");
  const declaration = validateDeclaration(yaml.parse(await readFile(DECLARATION_PATH, "utf8")));
  const runtimeDir = join(dirname(outputPath), "lua/kagiroi");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(outputPath, renderDictionary(declaration));
  await writeFile(join(runtimeDir, "romaji_rules.lua"), renderRuntime(declaration));
}

export default async function build(): Promise<void> {
  await compile(join(hookDir, DICTIONARY_NAME));
  // The declaration rode along into dist just for this hook; drop it so it
  // never reaches home.
  await rm(DECLARATION_PATH);
}

if (import.meta.main) {
  const [flag, value] = process.argv.slice(2) as (string | undefined)[];
  if (flag === undefined) {
    await compile(join(hookDir, DICTIONARY_NAME));
  } else if (flag === "--output" && value !== undefined) {
    await compile(value);
  } else {
    console.error("usage: bun roma.build.ts [--output <path>]");
    process.exitCode = 1;
  }
}
