import { readFileSync, writeFileSync } from "node:fs";
import {
  assertFormatAndChecksum,
  loadEnvelope,
  resolveRenderSettings,
  verifyPng,
  type Envelope,
} from "./format";

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
  const render = resolveRenderSettings(envelope, pixelWidth, pixelHeight);
  return `verify: ${inputPath} ok (${render.width}x${render.height}@${render.scale}x, ${pixelWidth}x${pixelHeight} px, format ${envelope.format}, html ${Buffer.byteLength(envelope.html, "utf8")} bytes)`;
}

function defaultExtractOutput(inputPath: string): string {
  if (inputPath.endsWith(".html.png")) {
    return `${inputPath.slice(0, -".html.png".length)}.html`;
  }
  return `${inputPath.replace(/\.[^.]+$/, "")}.html`;
}
