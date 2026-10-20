import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export const KEYWORD = "HtmlshotSource";
export const FORMAT = "htmlshot/v1";
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type RenderSettings = { width: number; height: number; scale: number };
export type Envelope = {
  format: string;
  checksum: string;
  render: RenderSettings;
  html: string;
};

type WalkedChunk = {
  offset: number;
  type: string;
  data: Buffer;
  crcOk: boolean;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function buildEnvelope(html: string, render: RenderSettings): Envelope {
  return { format: FORMAT, checksum: sha256Hex(html), render, html };
}

export function insertMetadata(png: Buffer, envelope: Envelope): Buffer {
  assertPngSignature(png);
  let iendOffset: number | null = null;
  for (const chunk of walkChunks(png)) {
    if (chunk.type !== "IEND") continue;
    iendOffset = chunk.offset;
    break;
  }
  if (iendOffset === null) throw new Error("truncated png (no IEND)");
  return Buffer.concat([png.subarray(0, iendOffset), itxtChunk(envelope), png.subarray(iendOffset)]);
}

export function loadEnvelope(png: Buffer): Envelope | null {
  assertPngSignature(png);
  for (const chunk of walkChunks(png)) {
    if (chunk.type !== "iTXt") continue;
    if (readCString(chunk.data, 0).text !== KEYWORD) continue;
    return envelopeFromItxtData(chunk.data);
  }
  return null;
}

export function resolveRenderSettings(envelope: Envelope, pixelWidth: number, pixelHeight: number): RenderSettings {
  const { render } = envelope;
  const isComplete =
    typeof render?.width === "number" &&
    typeof render?.height === "number" &&
    typeof render?.scale === "number";
  return isComplete ? render : { width: pixelWidth, height: pixelHeight, scale: 1 };
}

export function verifyPng(png: Buffer): { envelope: Envelope; pixelWidth: number; pixelHeight: number } {
  assertPngSignature(png);
  let sawIend = false;
  let metadataChunk: WalkedChunk | null = null;
  let pixelWidth = 0;
  let pixelHeight = 0;
  for (const chunk of walkChunks(png)) {
    if (chunk.type === "IHDR") {
      pixelWidth = chunk.data.readUInt32BE(0);
      pixelHeight = chunk.data.readUInt32BE(4);
    }
    if (chunk.type === "iTXt" && !metadataChunk && readCString(chunk.data, 0).text === KEYWORD) metadataChunk = chunk;
    if (chunk.type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend) throw new Error("truncated png (no IEND)");
  if (!metadataChunk) throw new Error("no htmlshot metadata");
  if (!metadataChunk.crcOk) throw new Error("metadata crc mismatch");
  const envelope = envelopeFromItxtData(metadataChunk.data);
  assertFormatAndChecksum(envelope);
  return { envelope, pixelWidth, pixelHeight };
}

export function assertFormatAndChecksum(envelope: Envelope): void {
  if (envelope.format !== FORMAT) throw new Error(`unsupported format: ${envelope.format}`);
  if (sha256Hex(envelope.html) !== envelope.checksum) throw new Error("checksum mismatch");
}

export function metadataChunkOffset(png: Buffer): number | null {
  for (const chunk of walkChunks(png)) {
    if (chunk.type === "iTXt" && readCString(chunk.data, 0).text === KEYWORD) return chunk.offset;
  }
  return null;
}

export function chunkBytes(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(data.length, 0);
  const crcSuffix = Buffer.alloc(4);
  crcSuffix.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([lengthPrefix, body, crcSuffix]);
}

function itxtChunk(envelope: Envelope): Buffer {
  const compressed = deflateSync(Buffer.from(JSON.stringify(envelope), "utf8"));
  const data = Buffer.concat([Buffer.from(KEYWORD, "latin1"), Buffer.from([0, 1, 0, 0, 0]), compressed]);
  return chunkBytes("iTXt", data);
}

function envelopeFromItxtData(data: Buffer): Envelope {
  const { end: keywordEnd } = readCString(data, 0);
  const compressionFlag = data[keywordEnd + 1];
  const compressionMethod = data[keywordEnd + 2];
  if (compressionFlag !== 1 || compressionMethod !== 0) {
    throw new Error("invalid htmlshot metadata (unsupported compression)");
  }
  try {
    const json = inflateSync(data.subarray(keywordEnd + 5)).toString("utf8");
    return JSON.parse(json) as Envelope;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid htmlshot metadata (${message})`);
  }
}

function* walkChunks(png: Buffer): Generator<WalkedChunk> {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (offset + 12 + length > png.length) return;
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crcOk = png.readUInt32BE(offset + 8 + length) === crc32(png.subarray(offset + 4, offset + 8 + length));
    yield { offset, type, data, crcOk };
    if (type === "IEND") return;
    offset += 12 + length;
  }
}

function readCString(data: Buffer, start: number): { text: string; end: number } {
  const zero = data.indexOf(0, start);
  if (zero === -1) throw new Error("invalid htmlshot metadata (unterminated keyword)");
  return { text: data.toString("latin1", start, zero), end: zero };
}

function assertPngSignature(png: Buffer): void {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG image");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
