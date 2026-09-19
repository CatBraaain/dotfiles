// Applies the checked-in MS-IME key-settings snapshot (msime-stylelist-
// custom.reg, an export of HKCU\...\IMEJP\StyleList\Custom) to the registry,
// or with --diff shows what would change, down to the individual key-
// assignment records inside REG_BINARY values. Apply always backs the current
// key up to a temp .reg first; --diff never writes the registry.

// ---------- value model ----------

type RegValue =
	| { kind: "binary"; bytes: Uint8Array }
	| { kind: "dword"; value: number }
	| { kind: "string"; value: string };

// Values by name; subkey values carry their subkey (`Color\RoamVal`).
type RegSnapshot = Map<string, RegValue>;

type ValueStatus = "unchanged" | "changed" | "snapshot-only" | "registry-only";

// ---------- .reg parsing ----------

// Parses reg.exe export text (UTF-16LE with BOM, CRLF lines). `rootPath` is
// the exported key; sections below it become `Sub\\Value` names. Unknown
// value formats throw, so a snapshot is fully validated before any write.
export function parseRegExport(text: string, rootPath: string): RegSnapshot {
	const values: RegSnapshot = new Map();
	const physical = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	let prefix: string | null = null;

	for (let i = 0; i < physical.length; i += 1) {
		let line = physical[i];
		if (line === "" || line.startsWith(";") || line === "Windows Registry Editor Version 5.00") continue;
		if (line.startsWith("[")) {
			if (!line.endsWith("]")) throw new Error(`unterminated key line: "${line}"`);
			const path = line.slice(1, -1);
			// registry paths are case-insensitive (HKCU export uses mixed case)
			const lowerPath = path.toLowerCase();
			const lowerRoot = rootPath.toLowerCase();
			if (lowerPath === lowerRoot) prefix = "";
			else if (lowerPath.startsWith(`${lowerRoot}\\`)) prefix = path.slice(rootPath.length + 1);
			else throw new Error(`unexpected key in snapshot: ${path}`);
			continue;
		}
		// hex values wrap onto continuation lines that end with a backslash
		while (line.endsWith("\\")) {
			i += 1;
			const next = physical[i];
			if (next === undefined) throw new Error("unterminated continuation line");
			line = line.slice(0, -1) + next.trimStart();
		}
		parseValueLine(line, prefix, values);
	}
	return values;
}

function parseValueLine(line: string, prefix: string | null, values: RegSnapshot): void {
	if (prefix === null) throw new Error(`value outside of any [key] section: "${line}"`);
	const eq = line.indexOf("=");
	if (eq === -1) throw new Error(`unrecognized line: "${line}"`);
	const nameToken = line.slice(0, eq);
	const name = nameToken.startsWith('"') ? unescapeReg(nameToken.slice(1, nameToken.length - 1)) : nameToken;
	const fullName = prefix === "" ? name : `${prefix}\\${name}`;
	const payload = line.slice(eq + 1);

	if (payload.startsWith("hex:")) values.set(fullName, { kind: "binary", bytes: parseHexBytes(payload.slice(4)) });
	else if (payload.startsWith("dword:")) {
		const value = Number.parseInt(payload.slice("dword:".length), 16);
		if (Number.isNaN(value)) throw new Error(`invalid dword value for "${fullName}"`);
		values.set(fullName, { kind: "dword", value });
	} else if (payload.startsWith('"')) values.set(fullName, { kind: "string", value: unescapeReg(payload.slice(1, -1)) });
	else throw new Error(`unsupported value format for "${fullName}"`);
}

// reg.exe escapes only backslash and quote inside quoted strings.
function unescapeReg(escaped: string): string {
	let out = "";
	for (let i = 0; i < escaped.length; i += 1) {
		if (escaped[i] === "\\" && escaped[i + 1] !== undefined) i += 1;
		out += escaped[i];
	}
	return out;
}

function parseHexBytes(hexList: string): Uint8Array {
	const bytes = hexList
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token !== "")
		.map((token) => {
			if (!/^[0-9a-fA-F]{1,4}$/.test(token)) throw new Error(`invalid hex byte: "${token}"`);
			return Number.parseInt(token, 16);
		});
	return Uint8Array.from(bytes);
}

// ---------- key-assignment records ----------

// A binary key-settings value stores CP932 `keyName=payload` records, each
// NUL-terminated. A record key may contain spaces and appears before the
// first `=`; the same key may carry several payloads.
type RecordMap = Map<string, Set<string>>;

function recordMapOf(bytes: Uint8Array): RecordMap {
	const records = new TextDecoder("shift_jis").decode(bytes).split("\0").filter((record) => record !== "");
	const map: RecordMap = new Map();
	for (const record of records) {
		const sep = record.indexOf("=");
		const key = sep === -1 ? record : record.slice(0, sep);
		const payload = sep === -1 ? "" : record.slice(sep + 1);
		const payloads = map.get(key) ?? new Set<string>();
		payloads.add(payload);
		map.set(key, payloads);
	}
	return map;
}

// `+` lines are records the import would add (or overwrite), `-` lines are
// records that exist only in the current registry.
function buildRecordDiffLines(currentBytes: Uint8Array, snapshotBytes: Uint8Array): string[] {
	const current = recordMapOf(currentBytes);
	const snapshot = recordMapOf(snapshotBytes);
	const lines: string[] = [];
	const emit = (key: string, sign: string, payloads: Set<string>): void => {
		lines.push(`${sign} ${key}=${[...payloads].sort().join(" | ")}`);
	};
	for (const [key, nextPayloads] of snapshot) {
		const currentPayloads = current.get(key);
		if (currentPayloads === undefined) emit(key, "+", nextPayloads);
		else if (!setsEqual(currentPayloads, nextPayloads)) {
			emit(key, "-", currentPayloads);
			emit(key, "+", nextPayloads);
		}
	}
	for (const [key, currentPayloads] of current) {
		if (!snapshot.has(key)) emit(key, "-", currentPayloads);
	}
	return lines;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	return a.size === b.size && [...a].every((item) => b.has(item));
}

// ---------- diff ----------

function valuesEqual(a: RegValue, b: RegValue): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "binary" && b.kind === "binary") return bytesEqual(a.bytes, b.bytes);
	if (a.kind === "dword" && b.kind === "dword") return a.value === b.value;
	return a.kind === "string" && b.kind === "string" && a.value === b.value;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function valueRepr(value: RegValue): string {
	if (value.kind === "dword") return String(value.value);
	if (value.kind === "string") return `"${value.value}"`;
	return "<binary>";
}

function changeDetail(current: RegValue | undefined, snapshot: RegValue): string[] {
	if (snapshot.kind === "binary") {
		const currentBytes = current?.kind === "binary" ? current.bytes : Uint8Array.of();
		return buildRecordDiffLines(currentBytes, snapshot.bytes);
	}
	const before = current === undefined ? "" : `${valueRepr(current)} -> `;
	return [`${before}${valueRepr(snapshot)}`];
}

function renderValue(name: string, current: RegValue | undefined, snapshot: RegValue | undefined): {
	status: ValueStatus;
	detail: string[];
} {
	if (current !== undefined && snapshot !== undefined) {
		if (valuesEqual(current, snapshot)) return { status: "unchanged", detail: [] };
		return { status: "changed", detail: changeDetail(current, snapshot) };
	}
	if (snapshot !== undefined) return { status: "snapshot-only", detail: changeDetail(undefined, snapshot) };
	return { status: "registry-only", detail: [] };
}

// Pure view of what the import would change. `current === null` means no
// readable StyleList\Custom key (nothing applied yet).
export function buildDiffView(current: RegSnapshot | null, snapshot: RegSnapshot): string {
	const names = [...new Set([...(current?.keys() ?? []), ...snapshot.keys()])];
	const rows = names.map((name) => ({ name, ...renderValue(name, current?.get(name), snapshot.get(name)) }));
	if (rows.every((row) => row.status === "unchanged")) return `up to date: ${names.length} values, no changes`;

	const width = Math.max(...names.map((name) => name.length));
	const header =
		current === null
			? "no custom key settings are currently applied; every snapshot value would be added"
			: "msime key settings diff:";
	const lines = rows.map((row) => {
		const label = `  ${row.name.padEnd(width)}  ${row.status}`;
		return row.detail.length === 0 ? label : [label, ...row.detail.map((line) => `    ${line}`)].join("\n");
	});
	return [header, ...lines].join("\n");
}

// ---------- registry & file helpers ----------

type SpawnSync = (command: string, args: readonly string[], options?: { windowsHide?: boolean }) => {
	status: number | null;
	stdout: string | Uint8Array;
	error?: unknown;
};

type Fs = { readFileSync: (path: string) => Uint8Array };

// `main`, `import.meta.dir` and the Node/Bun globals are not covered by the
// base lib types; read them dynamically so plain tsc type-checks this file.
async function loadSpawnSync(): Promise<SpawnSync> {
	return ((await import("node:child_process" as string)) as { spawnSync: SpawnSync }).spawnSync;
}

async function loadFs(): Promise<Fs> {
	return (await import("node:fs" as string)) as Fs;
}

async function tempDir(): Promise<string> {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
	const fromEnv = env.TEMP ?? env.TMP ?? env.TMPDIR;
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	return ((await import("node:os" as string)) as { tmpdir: () => string }).tmpdir();
}

async function tempFilePath(prefix: string): Promise<string> {
	const dir = await tempDir();
	const sep = dir.includes("\\") ? "\\" : "/";
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${dir}${sep}${prefix}-${stamp}.reg`;
}

// ---------- apply & diff entry ----------

const ROOT_KEY = "HKCU\\SOFTWARE\\Microsoft\\IME\\15.0\\IMEJP\\StyleList\\Custom";
// reg.exe export spells the hive out, while query/add accept the HKCU alias.
const EXPORT_ROOT_KEY = "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\IME\\15.0\\IMEJP\\StyleList\\Custom";
const MSIME_KEY = "HKCU\\SOFTWARE\\Microsoft\\IME\\15.0\\IMEJP\\MSIME";
const SNAPSHOT_FILE_NAME = "msime-stylelist-custom.reg";

function snapshotPath(): string {
	const dir = (import.meta as { dir?: string }).dir;
	if (dir === undefined) throw new Error("import.meta.dir is unavailable; run with bun");
	const sep = dir.includes("\\") ? "\\" : "/";
	return `${dir}${sep}${SNAPSHOT_FILE_NAME}`;
}

// reg.exe writes UTF-16LE with a BOM (FF FE); TextDecoder strips the BOM
// during decode, so it is verified on the raw bytes.
function decodeRegText(bytes: Uint8Array, source: string): string {
	if (bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new Error(`${source} must be a UTF-16LE .reg export`);
	return new TextDecoder("utf-16le").decode(bytes);
}

async function loadSnapshot(): Promise<RegSnapshot> {
	const bytes = (await loadFs()).readFileSync(snapshotPath());
	return parseRegExport(decodeRegText(bytes, SNAPSHOT_FILE_NAME), EXPORT_ROOT_KEY);
}

// Exports the live StyleList\Custom to a temp .reg and parses it. Returns
// null when the key cannot be read (not applied yet, or reg.exe unusable);
// the registry is never written.
async function readCurrentSnapshot(): Promise<RegSnapshot | null> {
	const spawn = await loadSpawnSync();
	const exportPath = await tempFilePath("msime-stylelist-custom-current");
	const proc = spawn("reg.exe", ["export", ROOT_KEY, exportPath, "/y"], { windowsHide: true });
	if (proc.error !== undefined || proc.status !== 0) return null;
	return parseRegFileBytes((await loadFs()).readFileSync(exportPath));
}

function parseRegFileBytes(bytes: Uint8Array): RegSnapshot {
	return parseRegExport(decodeRegText(bytes, "the exported .reg file"), EXPORT_ROOT_KEY);
}

// Backs the current key up before applying. Returns the backup path, or null
// when the key does not exist yet. A failed export while the key exists is an
// error: apply must not proceed without its backup.
async function backupCurrentKey(spawn: SpawnSync): Promise<string | null> {
	const exists = spawn("reg.exe", ["query", ROOT_KEY], { windowsHide: true });
	if (exists.error !== undefined) throw new Error(`cannot run reg: ${String(exists.error)}`);
	if (exists.status !== 0) return null;
	const backupPath = await tempFilePath("msime-stylelist-custom-backup");
	const proc = spawn("reg.exe", ["export", ROOT_KEY, backupPath, "/y"], { windowsHide: true });
	if (proc.error !== undefined) throw new Error(`cannot run reg: ${String(proc.error)}`);
	if (proc.status !== 0) throw new Error(`backup export failed with status ${proc.status}`);
	return backupPath;
}

async function applySnapshot(): Promise<void> {
	const snapshot = await loadSnapshot();
	const spawn = await loadSpawnSync();

	const backupPath = await backupCurrentKey(spawn);
	console.log(backupPath === null ? "no existing key settings to back up" : `backed up current settings to ${backupPath}`);

	const importProc = spawn("reg.exe", ["import", snapshotPath()], { windowsHide: true });
	if (importProc.error !== undefined) throw new Error(`cannot run reg: ${String(importProc.error)}`);
	if (importProc.status !== 0) throw new Error(`snapshot import failed with status ${importProc.status}`);

	const styleProc = spawn("reg.exe", ["add", MSIME_KEY, "/v", "keystyle", "/t", "REG_SZ", "/d", "Custom", "/f"], {
		windowsHide: true,
	});
	if (styleProc.error !== undefined) throw new Error(`cannot run reg: ${String(styleProc.error)}`);
	if (styleProc.status !== 0) throw new Error(`setting keystyle failed with status ${styleProc.status}`);

	console.log(`imported ${snapshot.size} values; keystyle=Custom`);
}

async function printDiff(): Promise<void> {
	const snapshot = await loadSnapshot();
	const current = await readCurrentSnapshot();
	console.log(buildDiffView(current, snapshot));
}

const isMain = (import.meta as { main?: boolean }).main;
if (isMain) {
	const node = (globalThis as { process?: { argv: string[]; exit: (code: number) => never } }).process;
	const args = node?.argv.slice(2) ?? [];
	if (args.length === 0) {
		await applySnapshot();
	} else if (args.length === 1 && args[0] === "--diff") {
		await printDiff();
	} else {
		console.error(`unknown arguments: ${args.join(" ")}`);
		console.error("usage: bun msime-key-settings.ts [--diff]");
		node?.exit(1);
	}
}
