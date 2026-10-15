import { readFileSync, writeFileSync } from "node:fs";
import { assertFormatAndChecksum, loadEnvelope, verifyPng, type Envelope } from "./format";

export function extractEnvelope(png: Buffer): Envelope {
  const envelope = loadEnvelope(png);
  if (envelope === null) throw new Error("no htmlshot metadata");
  assertFormatAndChecksum(envelope);
  return envelope;
}

export function extractFile(inputPath: string, output?: string): string {
  const envelope = extractEnvelope(readFileSync(inputPath));
  const outputPath = output ?? defaultExtractOutput(inputPath);
  writeFileSync(outputPath, envelope.html, "utf8");
  return `extract: ${outputPath} (${Buffer.byteLength(envelope.html, "utf8")} bytes)`;
}

export function verifyFile(inputPath: string): string {
  const { envelope, pixelWidth, pixelHeight } = verifyPng(readFileSync(inputPath));
  return `verify: ${inputPath} ok (${pixelWidth}x${pixelHeight}, format ${envelope.format}, html ${Buffer.byteLength(envelope.html, "utf8")} bytes)`;
}

function defaultExtractOutput(inputPath: string): string {
  if (inputPath.endsWith(".htmlshot.png")) {
    return `${inputPath.slice(0, -".htmlshot.png".length)}.html`;
  }
  return `${inputPath.replace(/\.[^.]+$/, "")}.html`;
}
