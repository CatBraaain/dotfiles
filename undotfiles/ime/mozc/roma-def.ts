// Loads the shared declarative romaji table (../roma-table.yaml), compiles it
// into the Mozc custom roman table TSV, and applies it together with
// keymap.tsv as `%USERPROFILE%\AppData\LocalLow\Mozc\config1.db`.
//
// config1.db is a proto2 wire-format `mozc.config.Config` message. The
// managed fields are written directly as wire records and every other field
// is preserved byte for byte, so no protoc binary is needed.
//
// CLI: no arguments prints the difference against the currently installed
// config1.db and applies it. `--dry-run` prints the same without writing.
// `--preview` prints the compiled romaji table records and their count.

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

// ---------- record compilation ----------

// Characters that cannot survive the tab-separated TSV record format.
const FORBIDDEN_CHARACTERS: ReadonlyArray<{ ch: string; name: string }> = [
	{ ch: "\t", name: "TAB" },
	{ ch: "\r", name: "CR" },
	{ ch: "\n", name: "LF" },
	{ ch: "\0", name: "NUL" },
];

// Pure: the result depends only on the declaration. Validation
// failures throw and nothing outside is touched.
export function buildRomanRecords(decl: Declaration): string[] {
	const table = buildTable(decl);
	for (const [roma, kana] of table) {
		checkForbidden(roma, `roman key "${roma}"`);
		checkForbidden(kana, `kana value of "${roma}"`);
	}
	// Sorted so the output only depends on the declaration, like the MS-IME
	// compiler's UTF-16 code unit order.
	return [...table].map(([roma, kana]) => `${roma}\t${kana}`).sort();
}

function checkForbidden(value: string, where: string): void {
	for (const { ch, name } of FORBIDDEN_CHARACTERS) {
		if (value.includes(ch)) {
			throw new Error(`forbidden character ${name} in ${where}`);
		}
	}
}

// keymap.tsv: `#` comments and empty lines ignored, every remaining line must
// be a `status\tkey\tcommand` record.
export async function readKeymapRecords(readText: (path: string) => Promise<string>): Promise<string[]> {
	const text = await readText(keymapTsvPath);
	const records: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line === "" || line.startsWith("#")) continue;
		if (line.split("\t").length !== 3) throw new Error(`keymap.tsv: expected 3 tab-separated columns: ${line}`);
		records.push(line);
	}
	if (records.length === 0) throw new Error("keymap.tsv: no keymap records");
	return records;
}

// ---------- record diff ----------

// Set difference between two record lists, each side sorted. Pure.
export function diffRecordSets(current: readonly string[], next: readonly string[]): { added: string[]; removed: string[] } {
	const currentSet = new Set(current);
	const nextSet = new Set(next);
	const added = [...new Set(next.filter((record) => !currentSet.has(record)))].sort();
	const removed = [...new Set(current.filter((record) => !nextSet.has(record)))].sort();
	return { added, removed };
}

// ---------- proto2 wire fields ----------

// Managed top-level field numbers in `mozc.config.Config`.
const SESSION_KEYMAP_FIELD = 41;
const KEYMAP_TABLE_FIELD = 42;
const ROMAN_TABLE_FIELD = 43;
// `SessionKeymap` enum value that selects the custom keymap table.
const SESSION_KEYMAP_CUSTOM = 0;

// Wire types of the proto2 encoding. Group types (3/4) are legacy and are
// rejected as a parse error.
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

// A parsed top-level field of config1.db: the field number and wire type
// from its tag, and the byte range of the whole record including the tag.
export type WireField = { field: number; type: number; start: number; end: number };

function encodeVarint(value: number): number[] {
	const bytes: number[] = [];
	let rest = value;
	while (rest > 0x7f) {
		bytes.push((rest & 0x7f) | 0x80);
		rest >>>= 7;
	}
	bytes.push(rest);
	return bytes;
}

// Returns the varint at `offset`. Values are decoded with Number math so
// malformed input beyond 32 bits is caught by the callers' range checks.
function decodeVarint(bytes: Uint8Array, offset: number): { value: number; end: number } {
	let value = 0;
	let shift = 1;
	for (let i = offset; i < bytes.length; i += 1) {
		const byte = bytes[i];
		value += (byte & 0x7f) * shift;
		if ((byte & 0x80) === 0) return { value, end: i + 1 };
		shift *= 128;
		if (shift > 2 ** 63) throw new Error("config1.db: varint is too long");
	}
	throw new Error("config1.db: truncated varint");
}

// Splits config1.db bytes into top-level wire records. Throws on any
// structural error so a damaged db never gets overwritten.
export function parseWireFields(bytes: Uint8Array): WireField[] {
	const fields: WireField[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const key = decodeVarint(bytes, offset);
		if (key.value > 0xffffffff) throw new Error("config1.db: field tag is out of range");
		const type = key.value % 8;
		const field = (key.value - type) / 8;
		if (field === 0) throw new Error("config1.db: field number 0 is invalid");
		if (type !== WIRE_VARINT && type !== WIRE_FIXED64 && type !== WIRE_BYTES && type !== WIRE_FIXED32) {
			throw new Error(`config1.db: unsupported wire type ${type} on field ${field}`);
		}
		let end: number;
		if (type === WIRE_VARINT) {
			end = decodeVarint(bytes, key.end).end;
		} else if (type === WIRE_FIXED64) {
			end = key.end + 8;
		} else if (type === WIRE_FIXED32) {
			end = key.end + 4;
		} else {
			const length = decodeVarint(bytes, key.end);
			end = length.end + length.value;
		}
		if (end > bytes.length) throw new Error("config1.db: truncated field");
		fields.push({ field, type, start: offset, end });
		offset = end;
	}
	return fields;
}

function bytesField(field: number, value: string): Uint8Array {
	const data = new TextEncoder().encode(value);
	return new Uint8Array([...encodeVarint(field * 8 + WIRE_BYTES), ...encodeVarint(data.length), ...data]);
}

function sessionKeymapField(): Uint8Array {
	return new Uint8Array([...encodeVarint(SESSION_KEYMAP_FIELD * 8 + WIRE_VARINT), SESSION_KEYMAP_CUSTOM]);
}

// Managed top-level fields read from config1.db, or null when the field is
// absent.
export type ManagedConfig = { sessionKeymap: number | null; keymapTable: string | null; romanTable: string | null };

function recordBytes(db: Uint8Array, record: WireField): string {
	const length = decodeVarint(db, decodeVarint(db, record.start).end);
	return new TextDecoder().decode(db.subarray(length.end, record.end));
}

export function readManagedConfig(db: Uint8Array): ManagedConfig {
	const managed: ManagedConfig = { sessionKeymap: null, keymapTable: null, romanTable: null };
	for (const record of parseWireFields(db)) {
		if (record.field === SESSION_KEYMAP_FIELD && record.type === WIRE_VARINT) {
			managed.sessionKeymap = decodeVarint(db, decodeVarint(db, record.start).end).value;
		} else if (record.field === KEYMAP_TABLE_FIELD && record.type === WIRE_BYTES) {
			managed.keymapTable = recordBytes(db, record);
		} else if (record.field === ROMAN_TABLE_FIELD && record.type === WIRE_BYTES) {
			managed.romanTable = recordBytes(db, record);
		}
	}
	return managed;
}

// Rebuilds config1.db: every non-managed top-level field is preserved byte
// for byte in its original order, and the managed fields are appended.
export function replaceManagedFields(db: Uint8Array, keymapRecords: readonly string[], romanRecords: readonly string[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const record of parseWireFields(db)) {
		if (record.field === SESSION_KEYMAP_FIELD || record.field === KEYMAP_TABLE_FIELD || record.field === ROMAN_TABLE_FIELD) continue;
		parts.push(db.subarray(record.start, record.end));
	}
	parts.push(
		sessionKeymapField(),
		bytesField(KEYMAP_TABLE_FIELD, keymapRecords.join("\n")),
		bytesField(ROMAN_TABLE_FIELD, romanRecords.join("\n")),
	);
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

// ---------- diff ----------

function splitTableRecords(table: string | null): string[] | null {
	if (table === null) return null;
	return table.split("\n").filter((line) => line !== "");
}

function sessionKeymapLabel(value: number): string {
	return value === SESSION_KEYMAP_CUSTOM ? "CUSTOM" : String(value);
}

// Difference view of the managed config fields: the current session_keymap
// and per-field `+`/`-` record lines, or a notice plus every mapping when no
// config1.db is installed. Pure.
export function buildConfigDiffView(
	current: ManagedConfig | null,
	keymapRecords: readonly string[],
	romanRecords: readonly string[],
): string {
	if (current === null) {
		return ["no config1.db is installed; the keymap and every romaji mapping would be added", ...romanRecords.map((record) => `+ ${record.replace("\t", "=")}`)].join("\n");
	}
	const lines: string[] = [];
	const currentKeymap = splitTableRecords(current.keymapTable);
	const currentRoman = splitTableRecords(current.romanTable);
	const keymapDiff = diffRecordSets(currentKeymap ?? [], keymapRecords);
	const romanDiff = diffRecordSets(currentRoman ?? [], romanRecords);
	lines.push(`session_keymap: ${current.sessionKeymap === null ? "(unset)" : sessionKeymapLabel(current.sessionKeymap)} -> CUSTOM`);
	for (const [label, diff, present] of [
		["keymap", keymapDiff, currentKeymap !== null],
		["romaji table", romanDiff, currentRoman !== null],
	] as const) {
		if (!present) {
			lines.push(`${label}: not present in the installed config1.db; it would be added`);
			continue;
		}
		if (diff.added.length === 0 && diff.removed.length === 0) {
			lines.push(`${label}: up to date`);
			continue;
		}
		lines.push(...diff.added.map((record) => `+ ${label === "keymap" ? record : record.replace("\t", "=")}`));
		lines.push(...diff.removed.map((record) => `- ${label === "keymap" ? record : record.replace("\t", "=")}`));
	}
	return lines.join("\n");
}

// ---------- OS access ----------

type PathModule = {
	join: (...segments: readonly string[]) => string;
	dirname: (path: string) => string;
};

type FsModule = {
	copyFile: (from: string, to: string) => Promise<void>;
	mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>;
	readFile: (path: string, encoding: "utf8") => Promise<string>;
	writeFile: (path: string, data: Uint8Array) => Promise<void>;
};

const keymapTsvPath = `${(import.meta as { dir?: string }).dir}/keymap.tsv`;

function userDataDir(): string {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	const profile = env?.USERPROFILE;
	if (profile === undefined) throw new Error("USERPROFILE is not set; Mozc config is applied on Windows");
	// Mozc stores its user profile in %USERPROFILE%\AppData\LocalLow\Mozc.
	return `${profile.replace(/[\\/]+$/, "")}\\AppData\\LocalLow\\Mozc`;
}

function configDbPath(path: PathModule): string {
	return path.join(userDataDir(), "config1.db");
}

// Reads the installed config1.db, or null when it does not exist. Anything
// other than a missing file (unreadable file, corrupted db) throws so nothing
// gets overwritten.
async function readInstalledDb(path: PathModule): Promise<Uint8Array | null> {
	const dbPath = configDbPath(path);
	try {
		const readFile = (await loadModule<{ readFile: (path: string) => Promise<Uint8Array> }>("node:fs/promises")).readFile;
		return new Uint8Array(await readFile(dbPath));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw new Error(`cannot read ${dbPath}: ${String(error)}`);
	}
}

// Copies the installed config1.db to a timestamped file in the OS temp
// directory and returns the backup path.
async function backupCurrentDb(fs: FsModule, path: PathModule): Promise<string> {
	const os = await loadModule<{ tmpdir: () => string }>("node:os");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = path.join(os.tmpdir(), `mozc-config1.db-${stamp}.bak`);
	await fs.copyFile(configDbPath(path), backupPath);
	return backupPath;
}

// ---------- apply ----------

async function loadInputs(fs: FsModule): Promise<{ keymap: readonly string[]; roman: readonly string[] }> {
	const keymap = await readKeymapRecords((p) => fs.readFile(p, "utf8"));
	const roman = buildRomanRecords(await loadDeclaration());
	return { keymap, roman };
}

async function printDiff(): Promise<void> {
	const fs = await loadModule<FsModule>("node:fs/promises");
	const path = await loadModule<PathModule>("node:path");
	const { keymap, roman } = await loadInputs(fs);
	const db = await readInstalledDb(path);
	console.log(buildConfigDiffView(db === null ? null : readManagedConfig(db), keymap, roman));
}

async function apply(): Promise<void> {
	const fs = await loadModule<FsModule>("node:fs/promises");
	const path = await loadModule<PathModule>("node:path");
	const { keymap, roman } = await loadInputs(fs);
	const db = await readInstalledDb(path);
	console.log(buildConfigDiffView(db === null ? null : readManagedConfig(db), keymap, roman));

	const next = replaceManagedFields(db ?? new Uint8Array(0), keymap, roman);

	const dbPath = configDbPath(path);
	if (db !== null) console.log(`backed up the current config1.db to ${await backupCurrentDb(fs, path)}`);
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	await fs.writeFile(dbPath, next);
	console.log(`applied ${roman.length} romaji mappings and ${keymap.length} keymap records to ${dbPath}`);
}

// ---------- CLI ----------

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
		await apply();
	} else if (mode === "dry-run") {
		await printDiff();
	} else if (mode === "preview") {
		const roman = buildRomanRecords(await loadDeclaration());
		console.log([...roman.map((record) => record.replace("\t", "=")), "", `${roman.length} mappings`].join("\n"));
	} else {
		console.error(`unknown arguments: ${args.join(" ")}`);
		console.error("usage: bun roma-def.ts [--preview | --dry-run]");
		node?.exit(1);
	}
}
