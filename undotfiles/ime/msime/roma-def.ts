// Compiles a declarative romaji table (rows + derivation families + singles)
// into the sorted `roman=kana` record list for the MS-IME custom roma-def
// registry value. The declaration data lives in ../roma-table.yaml and the
// aggregation engine in ../roma-table.ts, shared with the Mozc compiler.
//
// CLI: no arguments prints the set difference against the currently applied
// registry table and applies the table. `--dry-run` prints the same difference
// without writing the OS. `--preview` prints a human-readable view.

import { buildTable, VOWELS, type Declaration, type Family } from "../roma-table.ts";

// ---------- declaration loading ----------

// The shared declaration data.
const DECLARATION_YAML_PATH = `${(import.meta as { dir?: string }).dir}/../roma-table.yaml`;

async function loadModule<T>(specifier: string): Promise<T> {
	return (await import(specifier)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStringMap(value: unknown, what: string): Record<string, string> {
	if (!isRecord(value)) throw new Error(`invalid declaration: "${what}" must be a mapping`);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") throw new Error(`invalid declaration: "${what}.${key}" must be a string`);
		result[key] = entry;
	}
	return result;
}

function validateRows(value: unknown): Record<string, string[]> {
	if (!isRecord(value)) throw new Error(`invalid declaration: "rows" must be a mapping`);
	const result: Record<string, string[]> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!Array.isArray(entry) || entry.length !== 5 || !entry.every((kana) => typeof kana === "string")) {
			throw new Error(`invalid declaration: "rows.${key}" must be an array of 5 strings`);
		}
		result[key] = entry as string[];
	}
	return result;
}

function validateFamilies(value: unknown): Family[] {
	if (!Array.isArray(value)) throw new Error(`invalid declaration: "families" must be an array`);
	const result: Family[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) throw new Error(`invalid declaration: family must be a mapping`);
		if (typeof entry.column !== "string" || !(VOWELS as readonly string[]).includes(entry.column)) {
			throw new Error(`invalid declaration: "family.column" must be one of a/i/u/e/o`);
		}
		if (!Array.isArray(entry.rows) || !entry.rows.every((rowKey) => typeof rowKey === "string")) {
			throw new Error(`invalid declaration: "family.rows" must be an array of strings`);
		}
		const family: Family = {
			suffixes: validateStringMap(entry.suffixes, "family.suffixes"),
			column: entry.column as Family["column"],
			rows: entry.rows as string[],
		};
		if (entry.exclude !== undefined) {
			if (!Array.isArray(entry.exclude) || !entry.exclude.every((pattern) => typeof pattern === "string")) {
				throw new Error(`invalid declaration: "family.exclude" must be an array of strings`);
			}
			family.exclude = entry.exclude as string[];
		}
		result.push(family);
	}
	return result;
}

// Loads and validates the shared declaration data. Throws on any shape error;
// the aggregation engine only sees typed data.
export async function loadDeclaration(): Promise<Declaration> {
	const fs = await loadModule<{ readFile: (path: string, encoding: "utf8") => Promise<string> }>("node:fs/promises");
	const yaml = await loadModule<{ parse: (text: string) => unknown }>("yaml");
	const data = yaml.parse(await fs.readFile(DECLARATION_YAML_PATH, "utf8"));
	if (!isRecord(data)) throw new Error(`invalid declaration: ${DECLARATION_YAML_PATH} must contain a mapping`);
	return {
		rows: validateRows(data.rows),
		singles: validateStringMap(data.singles, "singles"),
		families: validateFamilies(data.families),
	};
}

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

export type CompileResult = {
	// "roman=kana" records sorted in UTF-16 code unit order
	records: string[];
};

// Pure function: the result depends only on the declaration. Validation
// failures throw; no output is produced and nothing outside is touched.
export function compileRomaTable(decl: Declaration): CompileResult {
	const table = buildTable(decl);

	// MS-IME's custom table needs an explicit consonant-only entry
	// (`k\` = `k`) per row key, marking the consonant as typed with the rest
	// of the spelling still pending. Mozc's longest-match engine does not.
	for (const rowKey of Object.keys(decl.rows)) {
		if (rowKey !== "" && !table.has(`${rowKey}\\`)) table.set(`${rowKey}\\`, rowKey);
	}

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

// Renders the difference view of the compiled `next` records against the
// currently applied ones (`null` when no table can be read): a notice plus a
// `+` line for every mapping when no table is applied, an up-to-date notice
// when both sides match, otherwise `+` lines for added and `-` lines for
// removed records, each side sorted. Pure; the CLI prints it before applying
// or in dry-run mode.
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

async function loadDiffView(): Promise<{ records: string[]; view: string }> {
	const records = compileRomaTable(await loadDeclaration()).records;
	const view = buildDiffView(await readAppliedTable(), records);
	return { records, view };
}

async function printDryRun(): Promise<void> {
	console.log((await loadDiffView()).view);
}

async function applyTable(records: readonly string[]): Promise<void> {
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

type CliMode = "apply" | "preview" | "dry-run";

function parseCliMode(args: readonly string[]): CliMode | null {
	if (args.length === 0) return "apply";
	if (args.length === 1 && args[0] === "--preview") return "preview";
	if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
	return null;
}

// `main` and the Node/Bun globals are not covered by the base lib types; read
// them dynamically so plain tsc type-checks this file without Bun's or Node's
// type packages.
const isMain = (import.meta as { main?: boolean }).main;
if (isMain) {
	const node = (globalThis as { process?: { argv: string[]; exit: (code: number) => never } }).process;
	const args = node?.argv.slice(2) ?? [];
	const mode = parseCliMode(args);
	if (mode === "apply") {
		const { records, view } = await loadDiffView();
		console.log(view);
		await applyTable(records);
	} else if (mode === "preview") {
		console.log(buildPreview(await loadDeclaration()));
	} else if (mode === "dry-run") {
		await printDryRun();
	} else {
		console.error(`unknown arguments: ${args.join(" ")}`);
		console.error("usage: bun roma-def.ts [--preview | --dry-run]");
		node?.exit(1);
	}
}
