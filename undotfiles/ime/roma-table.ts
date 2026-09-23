// The aggregation engine shared by the MS-IME and Mozc compilers
// (undotfiles/ime/msime/roma-def.ts and undotfiles/ime/mozc/roma-def.ts).
// The declarative romaji table itself is the data file
// undotfiles/ime/roma-table.yaml; each compiler loads and reflects it into
// its own format.
//
// Aggregation rule: individual mappings (singles) always win over generated
// ones, regular rows generate their vowel slots, and derivation families
// generate suffixed mappings. Everything IME-specific (record formats,
// limits, encodings, writing to the OS) lives in the individual compilers.

// ---------- declaration types ----------

// Which row column a family bases its kana on.
export type Column = "a" | "i" | "u" | "e" | "o";

// A derivation family: for every row in `rows`, and every suffix spelling in
// `suffixes`, emit `rowKey + suffix` = `row[column] + smallKana`.
export type Family = {
	// suffix spelling -> appended small kana (may be multiple characters)
	suffixes: Record<string, string>;
	// row column the base kana comes from
	column: Column;
	// row keys the family applies to
	rows: string[];
	// regex patterns: a generated spelling matching any of them is skipped
	// (keeps non-standard spellings like nh.* = にゃ and hh.* = ひゃ out)
	exclude?: string[];
};

export type Declaration = {
	// row key -> the 5 kana for the a/i/u/e/o columns. "" keeps an empty slot
	// so column positions stay aligned; empty slots are never emitted.
	rows: Record<string, string[]>;
	// individual mappings; they win over anything the rows/families generate
	singles: Record<string, string>;
	families: Family[];
};

export const VOWELS = ["a", "i", "u", "e", "o"] as const;
const COLUMN_INDEX: Record<Column, number> = { a: 0, i: 1, u: 2, e: 3, o: 4 };

// Aggregation rule: singles are registered first and nothing overwrites an
// existing key, so an individual mapping always wins over a generated one.
// Generation never merges conflicting values: an equal value collapses into
// one entry, but a different value on the same key is a declaration error.
// Pure: the result depends only on the declaration; validation failures
// throw and nothing outside is touched.
export function buildTable(decl: Declaration): Map<string, string> {
	const table = new Map<string, string>();
	const individualKeys = new Set<string>();

	const addIndividual = (roma: string, kana: string) => {
		table.set(roma, kana);
		individualKeys.add(roma);
	};
	const addGenerated = (roma: string, kana: string) => {
		const existing = table.get(roma);
		if (existing === kana) return;
		if (existing === undefined) {
			table.set(roma, kana);
			return;
		}
		if (!individualKeys.has(roma)) {
			throw new Error(`conflicting mapping: "${roma}" is "${existing}" and also "${kana}"`);
		}
	};

	for (const [roma, kana] of Object.entries(decl.singles)) addIndividual(roma, kana);

	for (const [rowKey, row] of Object.entries(decl.rows)) {
		for (const [i, vowel] of VOWELS.entries()) {
			if (row[i] !== "") addGenerated(`${rowKey}${vowel}`, row[i]);
		}
	}

	for (const family of decl.families) {
		const excludePatterns = family.exclude?.map((pattern) => new RegExp(pattern));
		for (const rowKey of family.rows) {
			const row = decl.rows[rowKey];
			// Families may retain references to rows no longer declared.
			if (row === undefined) continue;
			// a small-kana-only entry would leak out on an empty slot
			const base = row[COLUMN_INDEX[family.column]];
			for (const [suffix, small] of Object.entries(family.suffixes)) {
				const roma = `${rowKey}${suffix}`;
				if (excludePatterns?.some((pattern) => pattern.test(roma))) continue;
				if (base === "" || base === undefined) continue;
				addGenerated(roma, base + small);
			}
		}
	}

	return table;
}
