// Loads the shared declarative romaji table (../roma-table.yaml), compiles it
// into the Mozc custom roman table TSV, and applies it together with
// keymap.tsv and the general settings declaration (settings.yaml) as
// `%USERPROFILE%\AppData\LocalLow\Mozc\config1.db`.
//
// config1.db is a proto2 wire-format `mozc.config.Config` message. The
// managed fields and the general settings are written directly as wire
// records and every other field is preserved byte for byte, so no protoc
// binary is needed.
//
// CLI: no arguments prints the difference against the currently installed
// config1.db and applies it. `--dry-run` prints the same without writing.
// `--preview` prints the compiled romaji table records and their count.
// `--export` writes the installed general settings to settings.yaml.

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
    if (typeof entry !== "string")
      throw new Error(`invalid declaration: "${what}.${key}" must be a string`);
    result[key] = entry;
  }
  return result;
}

function validateRows(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) throw new Error(`invalid declaration: "rows" must be a mapping`);
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 5 ||
      !entry.every((kana) => typeof kana === "string")
    ) {
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
      if (
        !Array.isArray(entry.exclude) ||
        !entry.exclude.every((pattern) => typeof pattern === "string")
      ) {
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
  const fs = await loadModule<{ readFile: (path: string, encoding: "utf8") => Promise<string> }>(
    "node:fs/promises",
  );
  const yaml = await loadModule<{ parse: (text: string) => unknown }>("yaml");
  const data = yaml.parse(await fs.readFile(DECLARATION_YAML_PATH, "utf8"));
  if (!isRecord(data))
    throw new Error(`invalid declaration: ${DECLARATION_YAML_PATH} must contain a mapping`);
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
export async function readKeymapRecords(
  readText: (path: string) => Promise<string>,
): Promise<string[]> {
  const text = await readText(keymapTsvPath);
  const records: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.split("\t").length !== 3)
      throw new Error(`keymap.tsv: expected 3 tab-separated columns: ${line}`);
    records.push(line);
  }
  if (records.length === 0) throw new Error("keymap.tsv: no keymap records");
  return records;
}

// ---------- record diff ----------

// Set difference between two record lists, each side sorted. Pure.
export function diffRecordSets(
  current: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  const added = [...new Set(next.filter((record) => !currentSet.has(record)))].sort();
  const removed = [...new Set(current.filter((record) => !nextSet.has(record)))].sort();
  return { added, removed };
}

// ---------- general settings declaration ----------

// Name -> encoded value of every `mozc.config.Config` enum the general
// settings may carry.
type EnumValues = Readonly<Record<string, number>>;

type MemberKind = "string" | "bool" | "enum" | "int";
type MemberDef = { field: number; kind: MemberKind; enumValues?: EnumValues };
type GeneralSettingDef = {
  field: number;
  kind: "bool" | "enum" | "int" | "enumList" | "message" | "messageList";
  enumValues?: EnumValues;
  fields?: Readonly<Record<string, MemberDef>>;
};

const CHARACTER_FORM: EnumValues = { HALF_WIDTH: 0, FULL_WIDTH: 1, LAST_FORM: 2, NO_CONVERSION: 3 };
const SESSION_KEYMAP_VALUES: EnumValues = {
  NONE: -1,
  CUSTOM: 0,
  ATOK: 1,
  MSIME: 2,
  KOTOERI: 3,
  MOBILE: 4,
  CHROMEOS: 5,
};

// Every `general_config` (field 1, Mozc's own metadata) and managed field
// (41-43) is excluded: the declaration never carries them. Kept in field
// number order: export writes settings.yaml in this order and
// encodeGeneralSettings writes wire records in it.
const GENERAL_SETTINGS: Readonly<Record<string, GeneralSettingDef>> = {
  verbose_level: { field: 10, kind: "int" },
  incognito_mode: { field: 20, kind: "bool" },
  check_default: { field: 22, kind: "bool" },
  presentation_mode: { field: 23, kind: "bool" },
  preedit_method: { field: 40, kind: "enum", enumValues: { ROMAN: 0, KANA: 1 } },
  punctuation_method: {
    field: 45,
    kind: "enum",
    enumValues: { TOUTEN_KUTEN: 0, COMMA_PERIOD: 1, TOUTEN_PERIOD: 2, COMMA_KUTEN: 3 },
  },
  symbol_method: {
    field: 46,
    kind: "enum",
    enumValues: {
      CORNER_BRACKET_MIDDLE_DOT: 0,
      SQUARE_BRACKET_SLASH: 1,
      CORNER_BRACKET_SLASH: 2,
      SQUARE_BRACKET_MIDDLE_DOT: 3,
    },
  },
  space_character_form: {
    field: 47,
    kind: "enum",
    enumValues: { FUNDAMENTAL_INPUT_MODE: 0, FUNDAMENTAL_FULL_WIDTH: 1, FUNDAMENTAL_HALF_WIDTH: 2 },
  },
  use_keyboard_to_change_preedit_method: { field: 48, kind: "bool" },
  history_learning_level: {
    field: 50,
    kind: "enum",
    enumValues: { DEFAULT_HISTORY: 0, READ_ONLY: 1, NO_HISTORY: 2 },
  },
  selection_shortcut: {
    field: 52,
    kind: "enum",
    enumValues: { NO_SHORTCUT: 0, SHORTCUT_123456789: 1, SHORTCUT_ASDFGHJKL: 2 },
  },
  character_form_rules: {
    field: 54,
    kind: "messageList",
    fields: {
      group: { field: 1, kind: "string" },
      preedit_character_form: { field: 2, kind: "enum", enumValues: CHARACTER_FORM },
      conversion_character_form: { field: 3, kind: "enum", enumValues: CHARACTER_FORM },
    },
  },
  auto_switch_composition_mode: { field: 56, kind: "bool" },
  use_cascading_window: { field: 58, kind: "bool" },
  shift_key_mode_switch: {
    field: 59,
    kind: "enum",
    enumValues: { OFF: 0, ASCII_INPUT_MODE: 1, KATAKANA_INPUT_MODE: 2 },
  },
  numpad_character_form: {
    field: 60,
    kind: "enum",
    enumValues: {
      NUMPAD_INPUT_MODE: 0,
      NUMPAD_FULL_WIDTH: 1,
      NUMPAD_HALF_WIDTH: 2,
      NUMPAD_DIRECT_INPUT: 3,
    },
  },
  use_auto_conversion: { field: 61, kind: "bool" },
  auto_conversion_key: { field: 62, kind: "int" },
  yen_sign_character: { field: 63, kind: "enum", enumValues: { YEN_SIGN: 0, BACKSLASH: 1 } },
  use_japanese_layout: { field: 64, kind: "bool" },
  use_kana_modifier_insensitive_conversion: { field: 65, kind: "bool" },
  use_typing_correction: { field: 66, kind: "bool" },
  composing_timeout_threshold_msec: { field: 67, kind: "int" },
  overlay_keymaps: { field: 68, kind: "enumList", enumValues: SESSION_KEYMAP_VALUES },
  use_date_conversion: { field: 80, kind: "bool" },
  use_single_kanji_conversion: { field: 81, kind: "bool" },
  use_symbol_conversion: { field: 82, kind: "bool" },
  use_number_conversion: { field: 83, kind: "bool" },
  use_emoticon_conversion: { field: 84, kind: "bool" },
  use_calculator: { field: 85, kind: "bool" },
  use_t13n_conversion: { field: 86, kind: "bool" },
  use_zip_code_conversion: { field: 87, kind: "bool" },
  use_spelling_correction: { field: 88, kind: "bool" },
  use_emoji_conversion: { field: 89, kind: "bool" },
  information_list_config: {
    field: 90,
    kind: "message",
    fields: { use_local_usage_dictionary: { field: 1, kind: "bool" } },
  },
  use_history_suggest: { field: 100, kind: "bool" },
  use_dictionary_suggest: { field: 101, kind: "bool" },
  use_realtime_conversion: { field: 102, kind: "bool" },
  suggestions_size: { field: 110, kind: "int" },
  use_mode_indicator: { field: 120, kind: "bool" },
};

const GENERAL_SETTINGS_BY_FIELD = new Map<number, [string, GeneralSettingDef]>(
  Object.entries(GENERAL_SETTINGS).map(([name, def]) => [def.field, [name, def]]),
);

function membersByFieldOrder(fields: Readonly<Record<string, MemberDef>>): [string, MemberDef][] {
  return Object.entries(fields).sort(([, left], [, right]) => left.field - right.field);
}

// ---------- proto2 wire fields ----------

// Managed top-level field numbers in `mozc.config.Config`.
const SESSION_KEYMAP_FIELD = 41;
const KEYMAP_TABLE_FIELD = 42;
const ROMAN_TABLE_FIELD = 43;
// `SessionKeymap` enum value that selects the custom keymap table.
const SESSION_KEYMAP_CUSTOM = 0;
// `general_config` top-level field number, written by Mozc itself.
const GENERAL_CONFIG_FIELD = 1;

function isManagedField(field: number): boolean {
  return (
    field === SESSION_KEYMAP_FIELD || field === KEYMAP_TABLE_FIELD || field === ROMAN_TABLE_FIELD
  );
}

// Wire types of the proto2 encoding. Group types (3/4) are legacy and are
// rejected as a parse error.
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

// A parsed top-level field of config1.db: the field number and wire type
// from its tag, and the byte range of the whole record including the tag.
export type WireField = {
  field: number;
  type: number;
  start: number;
  end: number;
  valueStart: number;
};

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

// Returns the signed 64-bit varint at `offset` as a Number: protobuf encodes
// negative ints as the two's complement 10-byte form. Throws when the value
// leaves the safe integer range.
function decodeSignedVarint(bytes: Uint8Array, offset: number): { value: number; end: number } {
  let value = 0n;
  for (let i = offset; i < bytes.length; i += 1) {
    value |= BigInt(bytes[i] & 0x7f) << BigInt(7 * (i - offset));
    if ((bytes[i] & 0x80) === 0) {
      const signed = BigInt.asIntN(64, value);
      if (signed < BigInt(Number.MIN_SAFE_INTEGER) || signed > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("config1.db: varint is out of the safe integer range");
      }
      return { value: Number(signed), end: i + 1 };
    }
  }
  throw new Error("config1.db: truncated varint");
}

// Encodes a signed integer as a varint: non-negative values as-is, negative
// values as the 64-bit two's complement form protobuf uses.
function encodeSignedVarint(value: number): number[] {
  if (value >= 0) return encodeVarint(value);
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes: number[] = [];
  while (rest > 0x7fn) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
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
    if (
      type !== WIRE_VARINT &&
      type !== WIRE_FIXED64 &&
      type !== WIRE_BYTES &&
      type !== WIRE_FIXED32
    ) {
      throw new Error(`config1.db: unsupported wire type ${type} on field ${field}`);
    }
    let valueStart: number;
    let end: number;
    if (type === WIRE_VARINT) {
      valueStart = key.end;
      end = decodeVarint(bytes, key.end).end;
    } else if (type === WIRE_FIXED64) {
      valueStart = key.end;
      end = key.end + 8;
    } else if (type === WIRE_FIXED32) {
      valueStart = key.end;
      end = key.end + 4;
    } else {
      const length = decodeVarint(bytes, key.end);
      valueStart = length.end;
      end = length.end + length.value;
    }
    if (end > bytes.length) throw new Error("config1.db: truncated field");
    fields.push({ field, type, start: offset, end, valueStart });
    offset = end;
  }
  return fields;
}

function bytesRecord(field: number, data: Uint8Array): Uint8Array {
  return new Uint8Array([
    ...encodeVarint(field * 8 + WIRE_BYTES),
    ...encodeVarint(data.length),
    ...data,
  ]);
}

function varintRecord(field: number, value: number): Uint8Array {
  return new Uint8Array([...encodeVarint(field * 8 + WIRE_VARINT), ...encodeSignedVarint(value)]);
}

function bytesField(field: number, value: string): Uint8Array {
  return bytesRecord(field, new TextEncoder().encode(value));
}

function sessionKeymapField(): Uint8Array {
  return new Uint8Array([
    ...encodeVarint(SESSION_KEYMAP_FIELD * 8 + WIRE_VARINT),
    SESSION_KEYMAP_CUSTOM,
  ]);
}

// Managed top-level fields read from config1.db, or null when the field is
// absent.
export type ManagedConfig = {
  sessionKeymap: number | null;
  keymapTable: string | null;
  romanTable: string | null;
};

function recordBytes(db: Uint8Array, record: WireField): string {
  return new TextDecoder().decode(db.subarray(record.valueStart, record.end));
}

export function readManagedConfig(db: Uint8Array): ManagedConfig {
  const managed: ManagedConfig = { sessionKeymap: null, keymapTable: null, romanTable: null };
  for (const record of parseWireFields(db)) {
    if (record.field === SESSION_KEYMAP_FIELD && record.type === WIRE_VARINT) {
      managed.sessionKeymap = decodeVarint(db, record.valueStart).value;
    } else if (record.field === KEYMAP_TABLE_FIELD && record.type === WIRE_BYTES) {
      managed.keymapTable = recordBytes(db, record);
    } else if (record.field === ROMAN_TABLE_FIELD && record.type === WIRE_BYTES) {
      managed.romanTable = recordBytes(db, record);
    }
  }
  return managed;
}

// ---------- general settings wire ----------

function expectWireType(record: WireField, type: number): void {
  if (record.type !== type)
    throw new Error(`config1.db: unexpected wire type ${record.type} on field ${record.field}`);
}

function readWireBool(what: string, value: number): boolean {
  if (value !== 0 && value !== 1)
    throw new Error(`${what}: bool wire value must be 0 or 1, got ${value}`);
  return value === 1;
}

function readWireEnum(what: string, enumValues: EnumValues, value: number): string {
  const name = Object.keys(enumValues).find((key) => enumValues[key] === value);
  if (name === undefined) throw new Error(`${what}: unknown enum value ${value}`);
  return name;
}

// Decodes a packed enum list: one bytes record holding varints.
function decodePackedEnums(
  what: string,
  enumValues: EnumValues,
  bytes: Uint8Array,
  start: number,
  end: number,
): string[] {
  const names: string[] = [];
  let offset = start;
  while (offset < end) {
    const { value, end: next } = decodeSignedVarint(bytes, offset);
    names.push(readWireEnum(what, enumValues, value));
    offset = next;
  }
  return names;
}

// Decodes a sub-message byte range into a normalized member object (members
// in field order). Throws on any field outside the member table.
function decodeMembers(
  what: string,
  fields: Readonly<Record<string, MemberDef>>,
  bytes: Uint8Array,
): Record<string, unknown> {
  const byField = new Map(
    Object.entries(fields).map(([name, def]) => [def.field, [name, def] as const]),
  );
  const read: Record<string, unknown> = {};
  for (const record of parseWireFields(bytes)) {
    const entry = byField.get(record.field);
    if (entry === undefined)
      throw new Error(`${what}: general settings do not cover field ${record.field}`);
    const [memberName, memberDef] = entry;
    if (memberDef.kind === "string") {
      expectWireType(record, WIRE_BYTES);
      read[memberName] = new TextDecoder().decode(bytes.subarray(record.valueStart, record.end));
    } else {
      expectWireType(record, WIRE_VARINT);
      const value = decodeSignedVarint(bytes, record.valueStart).value;
      read[memberName] =
        memberDef.kind === "bool"
          ? readWireBool(what, value)
          : memberDef.kind === "enum"
            ? readWireEnum(what, memberDef.enumValues!, value)
            : value;
    }
  }
  const ordered: Record<string, unknown> = {};
  for (const [memberName] of membersByFieldOrder(fields)) {
    if (read[memberName] !== undefined) ordered[memberName] = read[memberName];
  }
  return ordered;
}

// Reads the general settings carried by config1.db bytes into the normalized
// declaration shape (keys in GENERAL_SETTINGS order). Throws on any
// top-level field outside the table so an export never silently drops
// settings.
export function readGeneralSettings(db: Uint8Array): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Sorted by field number so declaration keys come out in GENERAL_SETTINGS
  // order whatever order Mozc wrote the records in (stable sort keeps the
  // relative order of a repeated field's records).
  const records = parseWireFields(db)
    .slice()
    .sort((left, right) => left.field - right.field);
  for (const record of records) {
    if (record.field === GENERAL_CONFIG_FIELD || isManagedField(record.field)) continue;
    const entry = GENERAL_SETTINGS_BY_FIELD.get(record.field);
    if (entry === undefined)
      throw new Error(`config1.db: general settings do not cover top-level field ${record.field}`);
    const [name, def] = entry;
    if (def.kind === "bool") {
      expectWireType(record, WIRE_VARINT);
      result[name] = readWireBool(name, decodeSignedVarint(db, record.valueStart).value);
    } else if (def.kind === "enum") {
      expectWireType(record, WIRE_VARINT);
      result[name] = readWireEnum(
        name,
        def.enumValues!,
        decodeSignedVarint(db, record.valueStart).value,
      );
    } else if (def.kind === "int") {
      expectWireType(record, WIRE_VARINT);
      result[name] = decodeSignedVarint(db, record.valueStart).value;
    } else if (def.kind === "enumList") {
      expectWireType(record, WIRE_BYTES);
      result[name] = decodePackedEnums(name, def.enumValues!, db, record.valueStart, record.end);
    } else if (def.kind === "message") {
      // proto2 keeps the last occurrence of a singular message field.
      expectWireType(record, WIRE_BYTES);
      result[name] = decodeMembers(name, def.fields!, db.subarray(record.valueStart, record.end));
    } else {
      expectWireType(record, WIRE_BYTES);
      const list = (result[name] as unknown[] | undefined) ?? [];
      list.push(decodeMembers(name, def.fields!, db.subarray(record.valueStart, record.end)));
      result[name] = list;
    }
  }
  return result;
}

// Encodes a validated general settings object (as returned by
// validateGeneralSettings) into top-level wire records, in field number
// order.
export function encodeGeneralSettings(general: Readonly<Record<string, unknown>>): Uint8Array[] {
  const records: Uint8Array[] = [];
  for (const [name, def] of Object.entries(GENERAL_SETTINGS)) {
    const value = general[name];
    if (value === undefined) continue;
    if (def.kind === "bool") {
      records.push(varintRecord(def.field, value === true ? 1 : 0));
    } else if (def.kind === "enum") {
      records.push(varintRecord(def.field, def.enumValues![value as string]));
    } else if (def.kind === "int") {
      records.push(varintRecord(def.field, value as number));
    } else if (def.kind === "enumList") {
      const packed = (value as string[]).flatMap((element) =>
        encodeSignedVarint(def.enumValues![element]),
      );
      records.push(bytesRecord(def.field, new Uint8Array(packed)));
    } else if (def.kind === "message") {
      records.push(
        bytesRecord(def.field, encodeMembers(def.fields!, value as Record<string, unknown>)),
      );
    } else {
      for (const element of value as Record<string, unknown>[]) {
        records.push(bytesRecord(def.field, encodeMembers(def.fields!, element)));
      }
    }
  }
  return records;
}

// Encodes a member object into a sub-message, members in field number order.
function encodeMembers(
  fields: Readonly<Record<string, MemberDef>>,
  members: Readonly<Record<string, unknown>>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [memberName, memberDef] of membersByFieldOrder(fields)) {
    const value = members[memberName];
    if (value === undefined) continue;
    if (memberDef.kind === "string")
      parts.push(bytesRecord(memberDef.field, new TextEncoder().encode(value as string)));
    else if (memberDef.kind === "bool")
      parts.push(varintRecord(memberDef.field, value === true ? 1 : 0));
    else
      parts.push(
        varintRecord(
          memberDef.field,
          memberDef.kind === "enum" ? memberDef.enumValues![value as string] : (value as number),
        ),
      );
  }
  return concatBytes(parts);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ---------- general settings declaration file ----------

// Validates parsed settings.yaml against GENERAL_SETTINGS and returns a
// normalized copy: keys in declaration order, message members in field order,
// so equal settings always compare and render identically. Throws with the
// offending key on any unknown name or wrong value type.
export function validateGeneralSettings(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) throw new Error("settings.yaml: must contain a mapping");
  for (const key of Object.keys(data)) {
    if (!(key in GENERAL_SETTINGS)) throw new Error(`settings.yaml: unknown setting "${key}"`);
  }
  const result: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(GENERAL_SETTINGS)) {
    const value = data[name];
    if (value === undefined) continue;
    result[name] = validateSettingValue(name, def, value);
  }
  return result;
}

function validateSettingValue(name: string, def: GeneralSettingDef, value: unknown): unknown {
  if (def.kind === "bool") {
    if (typeof value !== "boolean")
      throw new Error(`settings.yaml: "${name}" must be true or false`);
    return value;
  }
  if (def.kind === "enum") return validateEnumName(name, def.enumValues!, value);
  if (def.kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value))
      throw new Error(`settings.yaml: "${name}" must be an integer`);
    return value;
  }
  if (def.kind === "enumList") {
    if (!Array.isArray(value)) throw new Error(`settings.yaml: "${name}" must be a list`);
    return value.map((element) => validateEnumName(name, def.enumValues!, element));
  }
  if (def.kind === "message") return validateMembers(name, def.fields!, value);
  if (!Array.isArray(value)) throw new Error(`settings.yaml: "${name}" must be a list`);
  return value.map((element) => validateMembers(name, def.fields!, element));
}

function validateEnumName(name: string, enumValues: EnumValues, value: unknown): string {
  if (typeof value !== "string" || !(value in enumValues)) {
    throw new Error(
      `settings.yaml: "${name}" must be one of ${Object.keys(enumValues).join(", ")}`,
    );
  }
  return value;
}

function validateMembers(
  name: string,
  fields: Readonly<Record<string, MemberDef>>,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`settings.yaml: "${name}" must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!(key in fields)) throw new Error(`settings.yaml: "${name}" has unknown entry "${key}"`);
  }
  const result: Record<string, unknown> = {};
  for (const [memberName, memberDef] of membersByFieldOrder(fields)) {
    const memberValue = value[memberName];
    if (memberValue === undefined) continue;
    const what = `${name}.${memberName}`;
    if (memberDef.kind === "string") {
      if (typeof memberValue !== "string")
        throw new Error(`settings.yaml: "${what}" must be a string`);
      result[memberName] = memberValue;
    } else if (memberDef.kind === "bool") {
      if (typeof memberValue !== "boolean")
        throw new Error(`settings.yaml: "${what}" must be true or false`);
      result[memberName] = memberValue;
    } else if (memberDef.kind === "enum") {
      result[memberName] = validateEnumName(what, memberDef.enumValues!, memberValue);
    } else {
      if (typeof memberValue !== "number" || !Number.isInteger(memberValue))
        throw new Error(`settings.yaml: "${what}" must be an integer`);
      result[memberName] = memberValue;
    }
  }
  return result;
}

// Renders a validated general settings object as settings.yaml text.
export async function stringifyGeneralSettings(
  general: Readonly<Record<string, unknown>>,
): Promise<string> {
  const yaml = await loadModule<{
    stringify: (value: unknown, options?: { lineWidth?: number }) => string;
  }>("yaml");
  return yaml.stringify(general, { lineWidth: 0 });
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
    return [
      "no config1.db is installed; the keymap and every romaji mapping would be added",
      ...romanRecords.map((record) => `+ ${record.replace("\t", "=")}`),
    ].join("\n");
  }
  const lines: string[] = [];
  const currentKeymap = splitTableRecords(current.keymapTable);
  const currentRoman = splitTableRecords(current.romanTable);
  const keymapDiff = diffRecordSets(currentKeymap ?? [], keymapRecords);
  const romanDiff = diffRecordSets(currentRoman ?? [], romanRecords);
  lines.push(
    `session_keymap: ${current.sessionKeymap === null ? "(unset)" : sessionKeymapLabel(current.sessionKeymap)} -> CUSTOM`,
  );
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
    lines.push(
      ...diff.added.map((record) => `+ ${label === "keymap" ? record : record.replace("\t", "=")}`),
    );
    lines.push(
      ...diff.removed.map(
        (record) => `- ${label === "keymap" ? record : record.replace("\t", "=")}`,
      ),
    );
  }
  return lines.join("\n");
}

// Normalized values make their JSON text a stable identity for comparison.
function valueJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function formatValue(value: unknown): string {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}

// Renders the difference between the installed general settings and the
// declaration: `key: current -> next` per changed field, `+`/`-` per added
// or removed field, and per changed repeated element. Pure.
export function buildGeneralDiffView(
  current: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): string[] {
  const lines: string[] = [];
  for (const [name, def] of Object.entries(GENERAL_SETTINGS)) {
    const currentValue = current[name];
    const nextValue = next[name];
    if (valueJson(currentValue) === valueJson(nextValue)) continue;
    if (def.kind === "enumList" || def.kind === "messageList") {
      const currentJson = (Array.isArray(currentValue) ? currentValue : []).map(valueJson);
      const nextJson = (Array.isArray(nextValue) ? nextValue : []).map(valueJson);
      for (const json of nextJson)
        if (!currentJson.includes(json)) lines.push(`+ ${name}: ${json}`);
      for (const json of currentJson)
        if (!nextJson.includes(json)) lines.push(`- ${name}: ${json}`);
      continue;
    }
    if (currentValue === undefined) lines.push(`+ ${name}: ${formatValue(nextValue)}`);
    else if (nextValue === undefined) lines.push(`- ${name}: ${formatValue(currentValue)}`);
    else lines.push(`${name}: ${formatValue(currentValue)} -> ${formatValue(nextValue)}`);
  }
  return lines;
}

// ---------- config1.db assembly ----------

// Rebuilds config1.db: fields neither managed nor declared in settings.yaml
// are preserved byte for byte in their original order, and the general
// settings and managed fields are appended. The general settings are taken
// from `general` when declared, or preserved from the current bytes.
export function assembleConfigDb(
  current: Uint8Array | null,
  keymapRecords: readonly string[],
  romanRecords: readonly string[],
  general: Readonly<Record<string, unknown>> | null,
): Uint8Array {
  const parts: Uint8Array[] = [];
  if (current !== null) {
    for (const record of parseWireFields(current)) {
      if (isManagedField(record.field)) continue;
      if (general !== null && GENERAL_SETTINGS_BY_FIELD.has(record.field)) continue;
      parts.push(current.subarray(record.start, record.end));
    }
  }
  if (general !== null) parts.push(...encodeGeneralSettings(general));
  parts.push(
    sessionKeymapField(),
    bytesField(KEYMAP_TABLE_FIELD, keymapRecords.join("\n")),
    bytesField(ROMAN_TABLE_FIELD, romanRecords.join("\n")),
  );
  return concatBytes(parts);
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
const settingsYamlPath = `${(import.meta as { dir?: string }).dir}/settings.yaml`;

function userDataDir(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const profile = env?.USERPROFILE;
  if (profile === undefined)
    throw new Error("USERPROFILE is not set; Mozc config is applied on Windows");
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
    const readFile = (
      await loadModule<{ readFile: (path: string) => Promise<Uint8Array> }>("node:fs/promises")
    ).readFile;
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

type Inputs = {
  keymap: readonly string[];
  roman: readonly string[];
  general: Record<string, unknown> | null;
};

async function loadInputs(fs: FsModule): Promise<Inputs> {
  const keymap = await readKeymapRecords((p) => fs.readFile(p, "utf8"));
  const roman = buildRomanRecords(await loadDeclaration());
  const general = await loadGeneralSettings(fs);
  return { keymap, roman, general };
}

// Reads settings.yaml, or null when it does not exist. Anything other than a
// missing file throws so a broken declaration is never silently ignored.
async function loadGeneralSettings(fs: FsModule): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(settingsYamlPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new Error(`cannot read ${settingsYamlPath}: ${String(error)}`);
  }
  const yaml = await loadModule<{ parse: (text: string) => unknown }>("yaml");
  return validateGeneralSettings(yaml.parse(text));
}

function printDiff(db: Uint8Array | null, inputs: Inputs): void {
  console.log(
    buildConfigDiffView(db === null ? null : readManagedConfig(db), inputs.keymap, inputs.roman),
  );
  if (db !== null && inputs.general !== null) {
    for (const line of buildGeneralDiffView(readGeneralSettings(db), inputs.general))
      console.log(line);
  }
}

async function printDiffOnly(): Promise<void> {
  const fs = await loadModule<FsModule>("node:fs/promises");
  const path = await loadModule<PathModule>("node:path");
  const inputs = await loadInputs(fs);
  printDiff(await readInstalledDb(path), inputs);
}

async function apply(): Promise<void> {
  const fs = await loadModule<FsModule>("node:fs/promises");
  const path = await loadModule<PathModule>("node:path");
  const inputs = await loadInputs(fs);
  const db = await readInstalledDb(path);
  printDiff(db, inputs);

  const next = assembleConfigDb(db, inputs.keymap, inputs.roman, inputs.general);

  const dbPath = configDbPath(path);
  if (db !== null)
    console.log(`backed up the current config1.db to ${await backupCurrentDb(fs, path)}`);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, next);
  console.log(
    `applied ${inputs.roman.length} romaji mappings and ${inputs.keymap.length} keymap records to ${dbPath}`,
  );
}

async function exportSettings(): Promise<void> {
  const fs = await loadModule<FsModule>("node:fs/promises");
  const path = await loadModule<PathModule>("node:path");
  const db = await readInstalledDb(path);
  if (db === null) throw new Error("no config1.db is installed; nothing to export");
  const general = readGeneralSettings(db);
  await fs.writeFile(
    settingsYamlPath,
    new TextEncoder().encode(await stringifyGeneralSettings(general)),
  );
  console.log(`exported ${Object.keys(general).length} general settings to ${settingsYamlPath}`);
}

// ---------- CLI ----------

type CliMode = "apply" | "preview" | "dry-run" | "export";

function parseCliMode(args: readonly string[]): CliMode | null {
  if (args.length === 0) return "apply";
  if (args.length === 1 && args[0] === "--export") return "export";
  if (args.length === 1 && args[0] === "--preview") return "preview";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  return null;
}

// `main` and the Node/Bun globals are not covered by the base lib types; read
// them dynamically so plain tsc type-checks this file without Bun's or Node's
// type packages.
const isMain = (import.meta as { main?: boolean }).main;
if (isMain) {
  const node = (globalThis as { process?: { argv: string[]; exit: (code: number) => never } })
    .process;
  const args = node?.argv.slice(2) ?? [];
  const mode = parseCliMode(args);
  if (mode === "apply") {
    await apply();
  } else if (mode === "dry-run") {
    await printDiffOnly();
  } else if (mode === "export") {
    await exportSettings();
  } else if (mode === "preview") {
    const roman = buildRomanRecords(await loadDeclaration());
    console.log(
      [...roman.map((record) => record.replace("\t", "=")), "", `${roman.length} mappings`].join(
        "\n",
      ),
    );
  } else {
    console.error(`unknown arguments: ${args.join(" ")}`);
    console.error("usage: bun roma-def.ts [--preview | --dry-run | --export]");
    node?.exit(1);
  }
}
