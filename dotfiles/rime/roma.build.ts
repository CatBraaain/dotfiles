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

type Declaration = {
  name: string;
  rows: Record<string, string[]>;
  singles: Record<string, string>;
  families: Family[];
  prefixes: Record<string, string[]>;
  postroma: { replace: Record<string, string> }[];
  long_vowel: string;
};

const VOWELS = ["a", "i", "u", "e", "o"] as const;
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

  const prefixes: Declaration["prefixes"] = {};
  if (!isRecord(data.prefixes)) throw new Error("roma.data.yaml: prefixes must be a mapping");
  for (const [kana, pairs] of Object.entries(data.prefixes)) {
    if (
      !kana ||
      !Array.isArray(pairs) ||
      pairs.some((pair) => typeof pair !== "string" || !/^[a-z]{2}$/.test(pair))
    )
      throw new Error("roma.data.yaml: prefixes must map kana to two-letter lowercase spellings");
    prefixes[kana] = pairs as string[];
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
    prefixes,
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

  for (const [kana, pairs] of Object.entries(decl.prefixes)) {
    for (const pair of pairs) addGenerated(pair, kana + pair.slice(1));
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

function renderRuntime(decl: Declaration): string {
  const pending = Object.entries(decl.singles).filter(
    ([roma, kana]) => /^([a-z])\1$/.test(roma) && kana === "ん",
  );
  const lines = [
    "-- Generated from roma.data.yaml by roma.build.ts.",
    "return {",
    "    pending = {",
  ];
  for (const [roma, kana] of pending)
    lines.push("        [" + luaString(roma.slice(0, 1)) + "] = " + luaString(kana) + ",");
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
