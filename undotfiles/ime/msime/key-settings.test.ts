import { backupCurrentKey, buildDiffView, parseRegExport, readCurrentSnapshot } from "./key-settings";

const { describe, it } = (await import("bun:test" as string)) as {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
};

type Assert = {
  deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  match(text: string, pattern: RegExp, message?: string): void;
  notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): asserts value;
  rejects(block: () => Promise<unknown>, error?: RegExp): Promise<void>;
  strictEqual(actual: unknown, expected: unknown, message?: string): void;
  throws(block: () => unknown, error?: RegExp, message?: string): void;
};

const assert: Assert = (await import("node:assert/strict" as string)) as Assert;
const ROOT_KEY = "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\IME\\15.0\\IMEJP\\StyleList\\Custom";

function regExportText(lines: string[]): string {
  return `\uFEFFWindows Registry Editor Version 5.00\r\n${lines.join("\r\n")}\r\n`;
}

function snapshotOf(lines: string[]): ReturnType<typeof parseRegExport> {
  return parseRegExport(regExportText(lines), ROOT_KEY);
}

describe("parseRegExport", () => {
  it("parses string, dword and hex values under the root key", () => {
    const values = snapshotOf([
      `[${ROOT_KEY}]`,
      '"keystyle"="Custom"',
      '"flags"=dword:00000001',
      '"bin"=hex:01,fe',
    ]);
    assert.deepStrictEqual([...values.entries()], [
      ["keystyle", { kind: "string", value: "Custom" }],
      ["flags", { kind: "dword", value: 1 }],
      ["bin", { kind: "binary", bytes: new Uint8Array([0x01, 0xfe]) }],
    ]);
  });

  it("names subkey values with the subkey path", () => {
    const values = snapshotOf([
      `[${ROOT_KEY}]`,
      `[${ROOT_KEY}\\Color]`,
      '"RoamVal"=dword:00000001',
    ]);
    assert.deepStrictEqual([...values.keys()], ["Color\\RoamVal"]);
  });

  it("joins hex continuation lines ending with a backslash", () => {
    const values = snapshotOf([`[${ROOT_KEY}]`, '"bin"=hex:01,02,\\', "  03,04"]);
    assert.deepStrictEqual(values.get("bin"), {
      kind: "binary",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it("unescapes backslash and quote inside quoted strings", () => {
    const values = snapshotOf([
      `[${ROOT_KEY}]`,
      '"a\\\\b"="x"',
      '"c\\"d"="e\\"f"',
    ]);
    assert.deepStrictEqual(values.get("a\\b"), { kind: "string", value: "x" });
    assert.deepStrictEqual(values.get('c"d'), { kind: "string", value: 'e"f' });
  });

  it("accepts @ as the default value name", () => {
    const values = snapshotOf([`[${ROOT_KEY}]`, '@="default"']);
    assert.deepStrictEqual(values.get("@"), { kind: "string", value: "default" });
  });
});

describe("parseRegExport rejecting invalid input", () => {
  it("rejects an unquoted value name other than @", () => {
    assert.throws(
      () => snapshotOf([`[${ROOT_KEY}]`, "foo=hex:01"]),
      /unrecognized value name: "foo"/,
    );
  });

  it("rejects hex tokens larger than one byte", () => {
    for (const hexValue of ["hex:100", "hex:0,ffff"]) {
      assert.throws(
        () => snapshotOf([`[${ROOT_KEY}]`, `"v"=${hexValue}`]),
        undefined,
        `input: ${hexValue}`,
      );
    }
  });

  it("rejects a string value without a closing quote", () => {
    assert.throws(() => snapshotOf([`[${ROOT_KEY}]`, '"x"="missing']));
  });

  it("rejects a value name without a closing quote", () => {
    assert.throws(() => snapshotOf([`[${ROOT_KEY}]`, '"x="v"']));
  });

  it("rejects a string value whose closing quote is escaped", () => {
    assert.throws(() => snapshotOf([`[${ROOT_KEY}]`, '"x"="a\\"']));
  });

  it("rejects value formats other than dword, hex and string", () => {
    assert.throws(() => snapshotOf([`[${ROOT_KEY}]`, '"v"=hex(7):00,00']));
  });

  it("rejects keys outside the snapshot root", () => {
    assert.throws(() => snapshotOf(["[HKEY_CURRENT_USER\\Software\\Other]", '"v"="x"']));
  });
});

describe("buildDiffView", () => {
  it("reports unchanged, changed, snapshot-only and registry-only states", () => {
    const current = snapshotOf([
      `[${ROOT_KEY}]`,
      '"same"=dword:00000001',
      '"edited"=dword:00000001',
      '"regOnly"=dword:00000002',
    ]);
    const snapshot = snapshotOf([
      `[${ROOT_KEY}]`,
      '"same"=dword:00000001',
      '"edited"=dword:00000009',
      '"snapOnly"=dword:00000003',
    ]);
    const view = buildDiffView(current, snapshot);
    assert.match(view, /same\s+unchanged/);
    assert.match(view, /edited\s+changed/);
    assert.match(view, /snapOnly\s+snapshot-only/);
    assert.match(view, /regOnly\s+registry-only/);
  });

  it("lists record-level removals and additions for a changed binary value", () => {
    const current = snapshotOf([`[${ROOT_KEY}]`, '"bin"=hex:61,3d,78,00']);
    const snapshot = snapshotOf([`[${ROOT_KEY}]`, '"bin"=hex:61,3d,79,00']);
    const view = buildDiffView(current, snapshot);
    assert.match(view, /- a=x/);
    assert.match(view, /\+ a=y/);
  });

  it("reports every snapshot value as an addition when no settings are applied", () => {
    const snapshot = snapshotOf([`[${ROOT_KEY}]`, '"v"=dword:00000001']);
    const view = buildDiffView(null, snapshot);
    assert.match(view, /no custom key settings are currently applied/);
    assert.match(view, /v\s+snapshot-only/);
  });

  it("reports no changes when the registry matches the snapshot", () => {
    const values = [`[${ROOT_KEY}]`, '"v"=dword:00000001'];
    const view = buildDiffView(snapshotOf(values), snapshotOf(values));
    assert.match(view, /up to date/);
  });
});

type SpawnOutcome = { status: number | null; error?: unknown };

function spawnStub(outcomes: Partial<Record<string, SpawnOutcome>>) {
  return (_command: string, args: readonly string[]) => {
    const outcome = outcomes[args[0] ?? ""];
    if (outcome === undefined) throw new Error(`unexpected reg.exe command: ${args[0]}`);
    return { status: outcome.status, stdout: "", error: outcome.error };
  };
}

describe("backupCurrentKey", () => {
  it("returns null when the existence query exits non-zero", async () => {
    const spawn = spawnStub({ query: { status: 1 } });
    assert.strictEqual(await backupCurrentKey(spawn), null);
  });

  it("throws when the existence query cannot run reg.exe", async () => {
    const spawn = spawnStub({ query: { status: null, error: new Error("not found") } });
    await assert.rejects(() => backupCurrentKey(spawn));
  });

  it("throws when the backup export exits non-zero while the key exists", async () => {
    const spawn = spawnStub({ query: { status: 0 }, export: { status: 1 } });
    await assert.rejects(() => backupCurrentKey(spawn));
  });

  it("throws when the backup export cannot run reg.exe while the key exists", async () => {
    const spawn = spawnStub({
      query: { status: 0 },
      export: { status: null, error: new Error("not found") },
    });
    await assert.rejects(() => backupCurrentKey(spawn));
  });

  it("returns a backup path when both commands succeed", async () => {
    const spawn = spawnStub({ query: { status: 0 }, export: { status: 0 } });
    const backupPath = await backupCurrentKey(spawn);
    assert.ok(typeof backupPath === "string" && backupPath.length > 0);
  });
});

function utf16leBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i += 1) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
}

function unreadableExport(path: string): Uint8Array {
  throw new Error(`the export file must not be read: ${path}`);
}

describe("readCurrentSnapshot", () => {
  it("returns null when the export exits non-zero", async () => {
    const spawn = spawnStub({ export: { status: 1 } });
    assert.strictEqual(await readCurrentSnapshot(spawn, unreadableExport), null);
  });

  it("returns null when the export cannot run reg.exe", async () => {
    const spawn = spawnStub({ export: { status: null, error: new Error("not found") } });
    assert.strictEqual(await readCurrentSnapshot(spawn, unreadableExport), null);
  });

  it("parses the exported file when the export succeeds", async () => {
    const spawn = spawnStub({ export: { status: 0 } });
    const exportedText = regExportText([`[${ROOT_KEY}]`, '"v"=dword:00000001']);
    const current = await readCurrentSnapshot(spawn, (_path) => utf16leBytes(exportedText));
    assert.ok(current !== null);
    assert.deepStrictEqual([...current.keys()], ["v"]);
  });
});
