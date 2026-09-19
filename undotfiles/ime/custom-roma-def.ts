// Compiles a declarative romaji table (rows + derivation families + singles)
// into the sorted `roman=kana` record list for the MS-IME custom roma-def
// registry value.
//
// CLI: no arguments compiles and applies the table. `--preview` prints a
// human-readable view and `--diff` prints the set difference against the
// currently applied registry table; neither writes the OS.

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
	// skip when the suffix spelling starts with the row key itself
	// (keeps h+ha/h+hu/h+ho and y+ya/y+yu/y+yo out of the table)
	skipSuffixStartingWithRow?: boolean;
	// row key -> suffix prefix to exclude (keeps n+ha/n+hu/n+ho out)
	skipSuffixPrefixByRow?: Record<string, string>;
};

export type Declaration = {
	// row key -> the 5 kana for the a/i/u/e/o columns. "" keeps an empty slot
	// so column positions stay aligned; empty slots are never emitted.
	rows: Record<string, string[]>;
	// individual mappings; they win over anything the rows/families generate
	singles: Record<string, string>;
	families: Family[];
};

// ---------- declaration data (the current table) ----------

const kRow = ["か", "き", "く", "け", "こ"];

// Rows that can take contracted-sound (yoon) suffixes.
const consonantRows = ["k", "c", "g", "s", "z", "t", "d", "n", "h", "b", "p", "m", "r"];

export const currentDeclaration: Declaration = {
	rows: {
		"": ["あ", "い", "う", "え", "お"],
		l: ["ぁ", "ぃ", "ぅ", "ぇ", "ぉ"],
		k: kRow,
		c: kRow,
		g: ["が", "ぎ", "ぐ", "げ", "ご"],
		s: ["さ", "し", "す", "せ", "そ"],
		z: ["ざ", "じ", "ず", "ぜ", "ぞ"],
		t: ["た", "ち", "つ", "て", "と"],
		d: ["だ", "ぢ", "づ", "で", "ど"],
		n: ["な", "に", "ぬ", "ね", "の"],
		h: ["は", "ひ", "ふ", "へ", "ほ"],
		b: ["ば", "び", "ぶ", "べ", "ぼ"],
		p: ["ぱ", "ぴ", "ぷ", "ぺ", "ぽ"],
		m: ["ま", "み", "む", "め", "も"],
		y: ["や", "", "ゆ", "いぇ", "よ"],
		ly: ["ゃ", "", "ゅ", "", "ょ"],
		r: ["ら", "り", "る", "れ", "ろ"],
		w: ["わ", "うぃ", "", "うぇ", "を"],
		q: ["くぁ", "くぃ", "", "くぇ", "くぉ"],
		j: ["じゃ", "じ", "じゅ", "じぇ", "じょ"],
		f: ["ふぁ", "ふぃ", "ふ", "ふぇ", "ふぉ"],
		v: ["ヴぁ", "ヴぃ", "ヴ", "ヴぇ", "ヴぉ"],
	},
	singles: {
		// dhu beats the standard yoon "ぢゅ" that the d row would generate
		dhu: "でゅ",
		who: "うぉ",
		nn: "ん",
		wyi: "ゐ",
		wye: "ゑ",
		ltu: "っ",
		lwa: "ゎ",
		lka: "ヵ",
		lke: "ヶ",
	},
	families: [
		// きゃ/きゅ/きょ, spelled also with h (kha = きゃ): i-column + small ya/yu/yo
		{
			suffixes: { ya: "ゃ", yu: "ゅ", yo: "ょ", ha: "ゃ", hu: "ゅ", ho: "ょ" },
			column: "i",
			rows: consonantRows,
			skipSuffixStartingWithRow: true,
			skipSuffixPrefixByRow: { n: "h" },
		},
		// thi=てぃ, dhi=でぃ: e-column + small i
		{ suffixes: { hi: "ぃ" }, column: "e", rows: ["t", "d"] },
		// khe=きぇ, she=しぇ, che=ちぇ...: i-column + small e
		{ suffixes: { he: "ぇ" }, column: "i", rows: ["k", "c", "g", "s", "t"] },
		// kwa=くぁ, swi=すぃ...: u-column + small a/i/e/o
		{ suffixes: { wa: "ぁ", wi: "ぃ", we: "ぇ", wo: "ぉ" }, column: "u", rows: consonantRows },
		// twu=とぅ, dwu=どぅ: o-column + small u
		{ suffixes: { wu: "ぅ" }, column: "o", rows: consonantRows },
	],
};

// ---------- compiler ----------

// MS-IME rejects a custom roma-def table with more than this many mappings.
const MAX_MAPPINGS = 320;

// Characters that would break the "roman=kana" NUL-terminated record format.
const FORBIDDEN: ReadonlyArray<{ ch: string; name: string }> = [
	{ ch: "=", name: '"="' },
	{ ch: "\r", name: "CR" },
	{ ch: "\n", name: "LF" },
	{ ch: "\0", name: "NUL" },
];

const COLUMN_INDEX: Record<Column, number> = { a: 0, i: 1, u: 2, e: 3, o: 4 };
const VOWELS = ["a", "i", "u", "e", "o"] as const;

export type CompileResult = {
	// "roman=kana" records sorted in UTF-16 code unit order
	records: string[];
};

// Pure function: the result depends only on the declaration. Validation
// failures throw; no output is produced and nothing outside is touched.
export function compileRomaTable(decl: Declaration): CompileResult {
	const table = buildTable(decl);

	for (const [roma, kana] of table) {
		checkForbidden(roma, `roman key "${roma}"`);
		checkForbidden(kana, `kana value of "${roma}"`);
	}
	if (table.size > MAX_MAPPINGS) {
		throw new Error(`too many mappings: ${table.size} exceeds the limit of ${MAX_MAPPINGS}`);
	}

	const records = [...table].map(([roma, kana]) => `${roma}=${kana}`).sort();
	return { records };
}

// ---------- generic engine ----------
//
// Aggregation rule: singles are registered first and nothing overwrites an
// existing key, so an individual mapping always wins over a generated one.
// Generation never merges conflicting values: an equal value collapses into
// one entry, but a different value on the same key is a declaration error.
function buildTable(decl: Declaration): Map<string, string> {
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
		// mechanical consonant-only entry: "b\=b" from the row key itself
		if (rowKey !== "") addGenerated(`${rowKey}\\`, rowKey);
		for (const [i, vowel] of VOWELS.entries()) {
			if (row[i] !== "") addGenerated(`${rowKey}${vowel}`, row[i]);
		}
	}

	for (const family of decl.families) {
		for (const rowKey of family.rows) {
			const row = decl.rows[rowKey];
			// Families may retain references to rows no longer declared.
			if (row === undefined) continue;
			// a small-kana-only entry would leak out on an empty slot
			const base = row[COLUMN_INDEX[family.column]];
			for (const [suffix, small] of Object.entries(family.suffixes)) {
				if (family.skipSuffixStartingWithRow && suffix.startsWith(rowKey)) continue;
				const excludedPrefix = family.skipSuffixPrefixByRow?.[rowKey];
				if (excludedPrefix !== undefined && suffix.startsWith(excludedPrefix)) continue;
				if (base === "" || base === undefined) continue;
				addGenerated(`${rowKey}${suffix}`, base + small);
			}
		}
	}

	return table;
}

// ---------- validation helpers ----------

function checkForbidden(value: string, where: string): void {
	for (const { ch, name } of FORBIDDEN) {
		if (value.includes(ch)) {
			throw new Error(`forbidden character ${name} in ${where}`);
		}
	}
}

// ---------- CP932 encoding ----------

const CP932_DECODER = new TextDecoder("shift_jis");
const CP932_BYTES_BY_CHARACTER = buildCp932ByteMap();

// TextDecoder exposes CP932 decoding but not encoding. Enumerate its valid
// single- and double-byte sequences once, retaining the first encoding when
// multiple byte sequences decode to the same character.
function buildCp932ByteMap(): Map<string, Uint8Array> {
	const bytesByCharacter = new Map<string, Uint8Array>();
	const add = (bytes: Uint8Array): void => {
		const character = CP932_DECODER.decode(bytes);
		if (character !== "\uFFFD" && !bytesByCharacter.has(character)) {
			bytesByCharacter.set(character, bytes);
		}
	};

	for (let byte = 0x20; byte <= 0x7e; byte += 1) add(Uint8Array.of(byte));
	for (let byte = 0xa1; byte <= 0xdf; byte += 1) add(Uint8Array.of(byte));
	for (let lead = 0x81; lead <= 0x9f; lead += 1) {
		for (let trail = 0x40; trail <= 0xfc; trail += 1) {
			if (trail !== 0x7f) add(Uint8Array.of(lead, trail));
		}
	}
	for (let lead = 0xe0; lead <= 0xef; lead += 1) {
		for (let trail = 0x40; trail <= 0xfc; trail += 1) {
			if (trail !== 0x7f) add(Uint8Array.of(lead, trail));
		}
	}
	return bytesByCharacter;
}

export function encodeCp932(value: string): Uint8Array {
	const encoded: number[] = [];
	for (const character of value) {
		const bytes = CP932_BYTES_BY_CHARACTER.get(character);
		if (bytes === undefined) throw new Error(`not representable in CP932: "${character}" in "${value}"`);
		encoded.push(...bytes);
	}
	return Uint8Array.from(encoded);
}

// Each registry record has its own NUL terminator, followed by one final NUL.
export function buildRegistryTable(records: readonly string[]): Uint8Array {
	const encodedRecords = records.map(encodeCp932);
	const bytes = new Uint8Array(encodedRecords.reduce((length, record) => length + record.length + 1, 1));
	let offset = 0;
	for (const record of encodedRecords) {
		bytes.set(record, offset);
		offset += record.length + 1;
	}
	return bytes;
}

// ---------- preview ----------

// Human-readable view of the compiled table: per regular row, one line with
// the vowel-slot mappings (`a=かな i=かな ...`, empty slots omitted) followed
// by one line with the remaining suffix mappings (`ya=きゃ ...`), then the
// singles on a single line and the mapping count against the limit. Pure: the
// output depends only on the declaration.
export function buildPreview(decl: Declaration): string {
	const { records } = compileRomaTable(decl);
	const singleKeys = new Set(Object.keys(decl.singles));
	const rowKeys = Object.keys(decl.rows);

	// Claim each mapping by the longest row key that prefixes it; singles are
	// listed on their own line and never claimed by a row.
	const groups = new Map<string, Map<string, string>>();
	for (const record of records) {
		const sep = record.indexOf("=");
		const roma = record.slice(0, sep);
		if (singleKeys.has(roma)) continue;
		const rowKey = rowKeys
			.filter((k) => roma.startsWith(k))
			.reduce((longest, k) => (k.length > longest.length ? k : longest), "");
		const group = groups.get(rowKey) ?? new Map<string, string>();
		group.set(roma, record.slice(sep + 1));
		groups.set(rowKey, group);
	}

	const labelOf = (rowKey: string): string => (rowKey === "" ? `""` : rowKey);
	const labelWidth = Math.max(...rowKeys.map((k) => labelOf(k).length));
	const pad = " ".repeat(labelWidth + 2);

	const lines: string[] = [];
	for (const rowKey of rowKeys) {
		const label = labelOf(rowKey).padEnd(labelWidth + 2);
		const group = groups.get(rowKey) ?? new Map<string, string>();
		const vowelLine = VOWELS.filter((v) => group.has(`${rowKey}${v}`))
			.map((v) => `${v}=${group.get(`${rowKey}${v}`)}`)
			.join(" ");
		// everything whose suffix is not a lone vowel: `k\=k`, yoon, w-family...
		const suffixOf = (roma: string): string => roma.slice(rowKey.length);
		const isVowelSlot = (roma: string): boolean =>
			roma.length - rowKey.length === 1 && (VOWELS as readonly string[]).includes(suffixOf(roma));
		const suffixLine = [...group]
			.filter(([roma]) => !isVowelSlot(roma))
			.map(([roma, kana]) => `${suffixOf(roma)}=${kana}`)
			.join(" ");
		if (vowelLine !== "") lines.push(label + vowelLine);
		if (suffixLine !== "") lines.push((vowelLine !== "" ? pad : label) + suffixLine);
	}

	const singlesLine = Object.entries(decl.singles)
		.map(([roma, kana]) => `${roma}=${kana}`)
		.join(" ");
	if (singlesLine !== "") lines.push(singlesLine);

	lines.push("", `${records.length}/${MAX_MAPPINGS} mappings`);
	return lines.join("\n");
}

// ---------- diff against the applied table ----------

// Extracts the REG_BINARY bytes from `reg.exe query` output. The hex digits
// follow the `REG_BINARY` type marker and may wrap onto continuation lines.
export function parseRegBinaryHex(output: string): Uint8Array | null {
	const lines = output.split(/\r?\n/);
	const marker = lines.findIndex((line) => line.includes("REG_BINARY"));
	if (marker === -1) return null;
	let hex = lines[marker].slice(lines[marker].indexOf("REG_BINARY") + "REG_BINARY".length);
	for (const continuation of lines.slice(marker + 1)) {
		if (continuation.trim() !== "" && /^[0-9a-fA-F\s]*$/.test(continuation)) hex += continuation;
	}
	const digits = hex.replace(/\s+/g, "");
	if (digits === "" || !/^[0-9a-fA-F]+$/.test(digits) || digits.length % 2 !== 0) return null;
	return Uint8Array.from({ length: digits.length / 2 }, (_, i) => Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16));
}

// The applied table stores each `roman=kana` record as CP932 bytes followed by
// a NUL terminator (plus one final NUL).
export function decodeTableRecords(bytes: Uint8Array): string[] {
	return new TextDecoder("shift_jis").decode(bytes).split("\0").filter((record) => record !== "");
}

// Set difference between two record lists, each side sorted. Pure.
export function diffRecordSets(current: readonly string[], next: readonly string[]): { added: string[]; removed: string[] } {
	const currentSet = new Set(current);
	const nextSet = new Set(next);
	const added = [...new Set(next.filter((record) => !currentSet.has(record)))].sort();
	const removed = [...new Set(current.filter((record) => !nextSet.has(record)))].sort();
	return { added, removed };
}

// Renders the `--diff` view of the compiled `next` records against the
// currently applied ones (`null` when no table can be read): a notice plus a
// `+` line for every mapping when no table is applied, an up-to-date notice
// when both sides match, otherwise `+` lines for added and `-` lines for
// removed records, each side sorted. Pure; the CLI just prints it.
export function buildDiffView(applied: readonly string[] | null, next: readonly string[]): string {
	if (applied === null) {
		const added = diffRecordSets([], next).added.map((record) => `+ ${record}`);
		return ["no table is currently applied; every mapping would be added", ...added].join("\n");
	}
	const { added, removed } = diffRecordSets(applied, next);
	if (added.length === 0 && removed.length === 0) {
		return `up to date: ${next.length} mappings, no changes`;
	}
	return [...added.map((record) => `+ ${record}`), ...removed.map((record) => `- ${record}`)].join("\n");
}

// ---------- CLI entry ----------

const REGISTRY_KEY = "HKCU\\SOFTWARE\\Microsoft\\IME\\15.0\\IMEJP\\RomaDef\\CustomRoma";
const REGISTRY_VALUE = "table";

// `reg.exe query` (read-only) fetches the currently applied table; this never
// writes the registry. Returns null when no table can be read (non-Windows,
// reg failure, missing value).
const REG_QUERY = ["query", REGISTRY_KEY, "/v", REGISTRY_VALUE];

type SpawnSync = (command: string, args: readonly string[], options?: { windowsHide?: boolean }) => {
	status: number | null;
	stdout: string | Uint8Array;
	error?: unknown;
};

async function loadSpawnSync(): Promise<SpawnSync> {
	const moduleSpec = "node:child_process" as string;
	return ((await import(moduleSpec)) as { spawnSync: SpawnSync }).spawnSync;
}

async function readAppliedTable(): Promise<string[] | null> {
	const proc = (await loadSpawnSync())("reg.exe", REG_QUERY, { windowsHide: true });
	if (proc.error !== undefined || proc.status !== 0) return null;
	const stdout = typeof proc.stdout === "string" ? proc.stdout : new TextDecoder().decode(proc.stdout);
	const bytes = parseRegBinaryHex(stdout);
	return bytes === null ? null : decodeTableRecords(bytes);
}

async function printDiff(): Promise<void> {
	const next = compileRomaTable(currentDeclaration).records;
	console.log(buildDiffView(await readAppliedTable(), next));
}

async function applyTable(): Promise<void> {
	const records = compileRomaTable(currentDeclaration).records;
	const bytes = buildRegistryTable(records);
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(",");
	const proc = (await loadSpawnSync())(
		"reg",
		["add", REGISTRY_KEY, "/v", REGISTRY_VALUE, "/t", "REG_BINARY", "/d", hex, "/f"],
		{ windowsHide: true },
	);
	if (proc.error !== undefined) throw new Error(`cannot run reg: ${String(proc.error)}`);
	if (proc.status !== 0) throw new Error(`reg add failed with status ${proc.status}`);
	console.log(`registered ${records.length} mappings`);
}

// `main` and the Node/Bun globals are not covered by the base lib types; read
// them dynamically so plain tsc type-checks this file without Bun's or Node's
// type packages.
const isMain = (import.meta as { main?: boolean }).main;
if (isMain) {
	const node = (globalThis as { process?: { argv: string[]; exit: (code: number) => never } }).process;
	const args = node?.argv.slice(2) ?? [];
	if (args.length === 0) {
		await applyTable();
	} else if (args.length === 1 && args[0] === "--preview") {
		console.log(buildPreview(currentDeclaration));
	} else if (args.length === 1 && args[0] === "--diff") {
		await printDiff();
	} else {
		console.error(`unknown arguments: ${args.join(" ")}`);
		console.error("usage: bun custom-roma-def.ts [--preview | --diff]");
		node?.exit(1);
	}
}
