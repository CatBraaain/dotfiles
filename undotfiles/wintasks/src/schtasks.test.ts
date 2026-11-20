import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { decode, decodeWithCodePage, encodeTaskXml } from "./schtasks.ts";

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
