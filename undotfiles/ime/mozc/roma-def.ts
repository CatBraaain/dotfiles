// Loads the shared declarative romaji table (../roma-table.yaml), compiles it
// into the Mozc custom roman table TSV, and applies it together with
// keymap.tsv and config.textproto as `%USERPROFILE%\AppData\LocalLow\Mozc\config1.db`.
//
// Requires `protoc` on the PATH. `protocol/config.proto` in this directory is
// the `mozc.config.Config` definition vendored from google/mozc.
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

// ---------- text proto fields ----------

const KEYMAP_PLACEHOLDER = "__KEYMAP_TABLE__";
const ROMAN_PLACEHOLDER = "__ROMAN_TABLE__";
const CONFIG_FIELDS = ["session_keymap", "custom_keymap_table", "custom_roman_table"] as const;

// Escapes a UTF-8 string as the quoted value of a bytes field in the text
// proto format: printable ASCII stays, everything else becomes `\xNN`.
export function escapeTextprotoString(value: string): string {
	let escaped = "";
	for (const byte of new TextEncoder().encode(value)) {
		const ch = String.fromCharCode(byte);
		if (ch === '"' || ch === "\\") escaped += `\\${ch}`;
		else if (ch === "\n") escaped += "\\n";
		else if (ch === "\t") escaped += "\\t";
		else if (ch === "\r") escaped += "\\r";
		else if (byte < 0x20 || byte >= 0x7f) escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
		else escaped += ch;
	}
	return escaped;
}

// Reverses escapeTextprotoString and the escapes `protoc --decode` emits
// (`\xNN`, `\NNN` octal, and the C-style shorthand).
export function unescapeTextprotoString(value: string): string {
	const bytes: number[] = [];
	const pushUtf8 = (text: string): void => {
		bytes.push(...new TextEncoder().encode(text));
	};
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (ch !== "\\") {
			pushUtf8(ch);
			continue;
		}
		const next = value[i + 1];
		if (next === "x" || next === "X") {
			bytes.push(Number.parseInt(value.slice(i + 2, i + 4), 16));
			i += 3;
		} else if (next >= "0" && next <= "7") {
			let octal = "";
			while (octal.length < 3 && value[i + 1 + octal.length] >= "0" && value[i + 1 + octal.length] <= "7") {
				octal += value[i + 1 + octal.length];
			}
			bytes.push(Number.parseInt(octal, 8));
			i += octal.length;
		} else {
			pushUtf8(SHORT_ESCAPES[next] ?? next);
			i += 1;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

const SHORT_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	a: "\x07",
	b: "\b",
	f: "\f",
	v: "\v",
};

// Returns the value of a top-level `field: value` line, unescaped for bytes
// fields, or null when the field is absent. `protoc --decode` prints each
// bytes value on a single line.
export function extractConfigField(textproto: string, field: string): string | null {
	for (const line of textproto.split("\n")) {
		if (!line.startsWith(`${field}:`)) continue;
		const value = line.slice(field.length + 1).trim();
		return value.startsWith('"') ? unescapeTextprotoString(value.slice(1, -1)) : value;
	}
	return null;
}

// Drops every top-level line of the managed config fields.
export function removeConfigFields(textproto: string): string {
	return textproto
		.split("\n")
		.filter((line) => !CONFIG_FIELDS.some((field) => line.startsWith(`${field}:`)))
		.join("\n");
}

export function injectConfigFields(textproto: string, keymapRecords: readonly string[], romanRecords: readonly string[]): string {
	const managed = [
		"session_keymap: CUSTOM",
		`custom_keymap_table: "${escapeTextprotoString(keymapRecords.join("\n"))}"`,
		`custom_roman_table: "${escapeTextprotoString(romanRecords.join("\n"))}"`,
	];
	const base = textproto.endsWith("\n") ? textproto : `${textproto}\n`;
	return `${base}${managed.join("\n")}\n`;
}

// Fills the placeholders of config.textproto, used when no config1.db exists
// yet.
export function replacePlaceholders(template: string, keymapRecords: readonly string[], romanRecords: readonly string[]): string {
	return template
		.replaceAll(KEYMAP_PLACEHOLDER, escapeTextprotoString(keymapRecords.join("\n")))
		.replaceAll(ROMAN_PLACEHOLDER, escapeTextprotoString(romanRecords.join("\n")));
}

// ---------- diff ----------

// Difference view of the managed config fields: the current session_keymap
// and per-field `+`/`-` record lines, or a notice plus every mapping when no
// config1.db is installed. Pure.
export function buildConfigDiffView(current: string | null, keymapRecords: readonly string[], romanRecords: readonly string[]): string {
	if (current === null) {
		return ["no config1.db is installed; the keymap and every romaji mapping would be added", ...romanRecords.map((record) => `+ ${record.replace("\t", "=")}`)].join("\n");
	}
	const lines: string[] = [];
	const currentKeymap = currentKeymapRecords(current);
	const currentRoman = currentRomanRecords(current);
	const keymapDiff = diffRecordSets(currentKeymap ?? [], keymapRecords);
	const romanDiff = diffRecordSets(currentRoman ?? [], romanRecords);
	lines.push(`session_keymap: ${extractConfigField(current, "session_keymap") ?? "(unset)"} -> CUSTOM`);
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

function currentKeymapRecords(current: string): string[] | null {
	const value = extractConfigField(current, "custom_keymap_table");
	if (value === null) return null;
	return value.split("\n").filter((line) => line !== "");
}

function currentRomanRecords(current: string): string[] | null {
	const value = extractConfigField(current, "custom_roman_table");
	if (value === null) return null;
	return value.split("\n").filter((line) => line !== "");
}

// ---------- OS access ----------

type SpawnSync = (
	command: string,
	args: readonly string[],
	options?: { input?: Uint8Array },
) => { status: number | null; stdout: Uint8Array; stderr: Uint8Array; error?: unknown };

async function loadSpawnSync(): Promise<SpawnSync> {
	return (await loadModule<{ spawnSync: SpawnSync }>("node:child_process")).spawnSync;
}

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
const configTextprotoPath = `${(import.meta as { dir?: string }).dir}/config.textproto`;
// protoc resolves file arguments against --proto_path, so the vendored
// protocol/config.proto is addressed as `protocol/config.proto` under the
// script directory.
const protoDir = (import.meta as { dir?: string }).dir;
const protoFile = "protocol/config.proto";

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

// Decodes the installed config1.db into its text proto form, or null when it
// does not exist. Anything other than a missing file (unreadable file,
// protoc failure, corrupted db) throws so nothing gets overwritten.
async function readCurrentConfigTextproto(fs: FsModule, path: PathModule): Promise<string | null> {
	const dbPath = configDbPath(path);
	let bytes: Uint8Array;
	try {
		const data = (await loadModule<{ readFile: (path: string) => Promise<Uint8Array> }>("node:fs/promises")).readFile;
		bytes = new Uint8Array(await data(dbPath));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw new Error(`cannot read ${dbPath}: ${String(error)}`);
	}
	return new TextDecoder().decode(await runProtoc("decode", bytes));
}

// `protoc --decode` turns config1.db bytes into a text proto; `--encode`
// turns a text proto back into config1.db bytes.
async function runProtoc(mode: "decode" | "encode", input: Uint8Array): Promise<Uint8Array> {
	const spawnSync = await loadSpawnSync();
	const proc = spawnSync("protoc", [`--${mode}=mozc.config.Config`, `--proto_path=${protoDir}`, protoFile], { input });
	if (proc.error !== undefined) throw new Error(`cannot run protoc: ${String(proc.error)}`);
	if (proc.status !== 0) {
		const stderr = new TextDecoder().decode(proc.stderr).trim();
		throw new Error(`protoc --${mode} failed with status ${proc.status}${stderr === "" ? "" : `: ${stderr}`}`);
	}
	return proc.stdout;
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

async function loadInputs(fs: FsModule): Promise<{ keymap: readonly string[]; roman: readonly string[]; template: string }> {
	const keymap = await readKeymapRecords((path) => fs.readFile(path, "utf8"));
	const roman = buildRomanRecords(await loadDeclaration());
	const template = await fs.readFile(configTextprotoPath, "utf8");
	return { keymap, roman, template };
}

async function printDiff(): Promise<void> {
	const fs = await loadModule<FsModule>("node:fs/promises");
	const path = await loadModule<PathModule>("node:path");
	const { keymap, roman } = await loadInputs(fs);
	const current = await readCurrentConfigTextproto(fs, path);
	console.log(buildConfigDiffView(current, keymap, roman));
}

async function apply(): Promise<void> {
	const fs = await loadModule<FsModule>("node:fs/promises");
	const path = await loadModule<PathModule>("node:path");
	const { keymap, roman, template } = await loadInputs(fs);
	const current = await readCurrentConfigTextproto(fs, path);
	console.log(buildConfigDiffView(current, keymap, roman));

	const textproto =
		current === null ? replacePlaceholders(template, keymap, roman) : injectConfigFields(removeConfigFields(current), keymap, roman);
	const bytes = await runProtoc("encode", new TextEncoder().encode(textproto));

	const dbPath = configDbPath(path);
	if (current !== null) console.log(`backed up the current config1.db to ${await backupCurrentDb(fs, path)}`);
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	await fs.writeFile(dbPath, bytes);
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
