import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { decode, decodeWithCodePage, encodeTaskXml, extractTasks } from "./schtasks.ts";

const TASK_NS = "http://schemas.microsoft.com/windows/2004/02/mit/task";

function taskDocument(uri: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-16"?>\n' +
    `<Task xmlns="${TASK_NS}"><RegistrationInfo><URI>${uri}</URI></RegistrationInfo>${body}</Task>`
  );
}

describe("schtasks encoding", () => {
  it("writes schtasks xml as utf16 le with matching declaration", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Task><Command>日本語</Command></Task>';
    const encoded = encodeTaskXml(xml);
    assert.deepEqual([encoded[0], encoded[1]], [0xff, 0xfe]);
    assert.equal(decode(encoded), xml.replace("UTF-8", "UTF-16"));
  });
});

describe("query decoding", () => {
  it.skipIf(process.platform !== "win32")(
    "decodes non utf8 bytes with the selected windows code page",
    () => {
      assert.equal(decodeWithCodePage(new Uint8Array([0xe9]), 1252), "é");
    },
  );

  it("decodes utf16 and utf8 query output", () => {
    const text = "task";
    const littleEndian = new Uint8Array(2 + text.length * 2);
    littleEndian[0] = 0xff;
    littleEndian[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      littleEndian[2 + i * 2] = unit & 0xff;
      littleEndian[3 + i * 2] = unit >> 8;
    }
    const bigEndian = new Uint8Array(2 + text.length * 2);
    bigEndian[0] = 0xfe;
    bigEndian[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      bigEndian[2 + i * 2] = unit >> 8;
      bigEndian[3 + i * 2] = unit & 0xff;
    }
    const utf8 = new TextEncoder().encode(text);
    assert.equal(decode(littleEndian), text);
    assert.equal(decode(bigEndian), text);
    assert.equal(decode(utf8), text);
  });
});

describe("extractTasks", () => {
  it("extracts each task document with its declaration from the query output", () => {
    const first = taskDocument("\\a", "");
    const second = taskDocument("\\b", "");
    const tasks = extractTasks([first, second].join("\r\n"));
    assert.deepEqual(
      tasks.map((task) => task.path),
      ["\\a", "\\b"],
    );
    assert.deepEqual(
      tasks.map((task) => task.xml),
      [first, second],
    );
  });

  it("does not split a task document at XML declaration text in CDATA or a comment", () => {
    const declaration = '<?xml version="1.0"?>';
    const first = taskDocument(
      "\\a",
      `<Data><![CDATA[${declaration}]]></Data><!-- ${declaration} -->`,
    );
    const second = taskDocument("\\b", "");
    assert.deepEqual(extractTasks([first, second].join("\r\n")), [
      { path: "\\a", xml: first },
      { path: "\\b", xml: second },
    ]);
  });

  it("decodes entities and cdata in the task uri", () => {
    const cdata =
      '<?xml version="1.0" encoding="UTF-16"?>\n<Task xmlns="' +
      TASK_NS +
      '"><RegistrationInfo><URI><![CDATA[\\d]]></URI></RegistrationInfo></Task>';
    const tasks = extractTasks([taskDocument("\\a&amp;b", ""), cdata].join("\r\n"));
    assert.deepEqual(
      tasks.map((task) => task.path),
      ["\\a&b", "\\d"],
    );
  });

  it("parses a single document without a declaration", () => {
    const document = `<Task xmlns="${TASK_NS}"><RegistrationInfo><URI>\\a</URI></RegistrationInfo></Task>`;
    const tasks = extractTasks(document);
    assert.deepEqual(
      tasks.map((task) => task.path),
      ["\\a"],
    );
    assert.deepEqual(
      tasks.map((task) => task.xml),
      [document],
    );
  });

  it("skips documents whose root is not a task", () => {
    const other = '<?xml version="1.0" encoding="UTF-16"?>\n<NotTask><URI>\\x</URI></NotTask>';
    const tasks = extractTasks([other, taskDocument("\\a", "")].join("\r\n"));
    assert.deepEqual(
      tasks.map((task) => task.path),
      ["\\a"],
    );
  });

  it("fails on a malformed task document", () => {
    const broken = '<?xml version="1.0" encoding="UTF-16"?>\n<Task><Triggers></Trigger></Task>';
    assert.throws(() => extractTasks(broken), /failed to parse schtasks query output/);
  });
});
