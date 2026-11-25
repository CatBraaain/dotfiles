import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser, isASTNode, type LibrarySpec, type Parser } from "@openuidev/lang-core";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const parserCache = new Map<string, Parser>();

export type OpenuiValidationResult = { ok: true } | { ok: false; error: string };

export function validateOpenuiLang(source: string, dir = EXTENSION_DIR): OpenuiValidationResult {
  if (!source.trim()) return { ok: false, error: "no renderable root statement found" };
  const parsed = getParser(dir).parse(source);
  if (parsed.meta.incomplete) {
    return { ok: false, error: "program is truncated (unclosed syntax)" };
  }
  const unknown = parsed.meta.errors.find((error) => error.code === "unknown-component");
  if (unknown) {
    return {
      ok: false,
      error: `component "${unknown.component}" is not in the display-only library`,
    };
  }
  const validation = parsed.meta.errors[0];
  if (validation) return { ok: false, error: validation.message };
  if (parsed.queryStatements.length > 0 || parsed.mutationStatements.length > 0) {
    return { ok: false, error: "Query()/Mutation() have no data source in this preview" };
  }
  if (Object.keys(parsed.stateDeclarations).length > 0 || containsDynamicValue(parsed.root)) {
    return {
      ok: false,
      error: "reactive expressions ($variables, bindings) are not supported in this preview",
    };
  }
  if (parsed.meta.unresolved.length > 0) {
    return { ok: false, error: `unresolved references: ${parsed.meta.unresolved.join(", ")}` };
  }
  if (parsed.root === null) return { ok: false, error: "no renderable root statement found" };
  return { ok: true };
}

function getParser(dir: string): Parser {
  const cached = parserCache.get(dir);
  if (cached) return cached;
  const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as LibrarySpec;
  if (!spec.schema) throw new Error("spec.json has no library schema");
  const parser = createParser(spec.schema, spec.root);
  parserCache.set(dir, parser);
  return parser;
}

function containsDynamicValue(value: unknown): boolean {
  if (isASTNode(value)) return true;
  if (Array.isArray(value)) return value.some(containsDynamicValue);
  if (typeof value !== "object" || value === null) return false;
  if ((value as { hasDynamicProps?: boolean }).hasDynamicProps) return true;
  return Object.values(value).some(containsDynamicValue);
}
