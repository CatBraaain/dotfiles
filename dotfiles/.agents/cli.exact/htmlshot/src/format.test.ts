import { strict as assert } from "node:assert/strict";
import { describe, it } from "bun:test";
import { extractEnvelope } from "./extract";
import {
  FORMAT,
  PNG_SIGNATURE,
  buildEnvelope,
  chunkBytes,
  insertMetadata,
  loadEnvelope,
  metadataChunkOffset,
  verifyPng,
} from "./format";

const SAMPLE_HTML = "<!doctype html>\n<h1>図版 🎨</h1>\n";
const RENDER = { width: 1200, height: 800, scale: 1 };

const syntheticPng = (): Buffer => {
  const ihdrData = Buffer.from([0, 0, 5, 0, 0, 0, 3, 0, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunkBytes("IHDR", ihdrData),
    chunkBytes("IEND", Buffer.alloc(0)),
  ]);
};

const bound = (html: string = SAMPLE_HTML): Buffer =>
  insertMetadata(syntheticPng(), buildEnvelope(html, RENDER));

describe("format", () => {
  it("stores html byte-exact through insert and load", () => {
    const html = "<p>日本語 &amp; 絵文字 🎨</p>\n<div>line2</div>\n";
    const envelope = loadEnvelope(bound(html));
    assert.equal(envelope?.html, html);
    assert.equal(envelope?.format, FORMAT);
  });

  it("returns null when metadata is absent", () => {
    assert.equal(loadEnvelope(syntheticPng()), null);
  });

  it("uses the first metadata chunk when duplicated", () => {
    const doubled = insertMetadata(bound("first"), buildEnvelope("second", RENDER));
    assert.equal(loadEnvelope(doubled)?.html, "first");
  });

  it("rejects unknown format versions", () => {
    const envelope = buildEnvelope(SAMPLE_HTML, RENDER);
    envelope.format = "htmlshot/v99";
    assert.throws(
      () => extractEnvelope(insertMetadata(syntheticPng(), envelope)),
      /unsupported format: htmlshot\/v99/,
    );
  });

  it("rejects checksum mismatch", () => {
    const envelope = buildEnvelope(SAMPLE_HTML, RENDER);
    envelope.html = `${envelope.html}tainted`;
    assert.throws(
      () => extractEnvelope(insertMetadata(syntheticPng(), envelope)),
      /checksum mismatch/,
    );
  });

  it("rejects non-png input", () => {
    assert.throws(() => loadEnvelope(Buffer.from("hello")), /not a PNG image/);
  });

  it("verifies a well-formed bound png with pixel size", () => {
    const { envelope, pixelWidth, pixelHeight } = verifyPng(bound());
    assert.equal(envelope.html, SAMPLE_HTML);
    assert.equal(pixelWidth, 1280);
    assert.equal(pixelHeight, 768);
  });

  it("fails verify when IEND is missing", () => {
    const complete = bound();
    const truncated = complete.subarray(0, complete.length - 12);
    assert.throws(() => verifyPng(truncated), /no IEND/);
  });

  it("fails verify when metadata crc is corrupted", () => {
    const complete = bound();
    const offset = metadataChunkOffset(complete);
    assert.ok(offset !== null);
    const dataLength = complete.readUInt32BE(offset);
    const crcOffset = offset + 8 + dataLength;
    complete.writeUInt32BE((complete.readUInt32BE(crcOffset) ^ 0xff) >>> 0, crcOffset);
    assert.throws(() => verifyPng(complete), /crc mismatch/);
  });
});
