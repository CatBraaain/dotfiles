import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "bun:test";
import { join } from "node:path";

// The build keeps bare specifiers external (run_after_build.sh passes
// `--external '@deepseek-ai/*'` etc.), so runtime imports must be resolvable
// where the deployed plugin lands: libraries from dependencies install into
// the profile tree, while dsh framework packages resolve as peerDependencies
// through the shared installation fallback. A runtime import missing from
// both therefore stays invisible to type checks and tests until dsh fails to
// boot with ERR_MODULE_NOT_FOUND on the built dist/index.js. Type-only
// imports are erased at build time, so they are exempt.

const declared = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
const declaredNames = [
  ...Object.keys(declared.dependencies ?? {}),
  ...Object.keys(declared.peerDependencies ?? {}),
];

function runtimeBareImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const line of source.split("\n")) {
    if (/^\s*(?:import|export)\s+type\b/.test(line)) continue;
    for (const m of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      specifiers.add(m[1]);
    }
  }
  return [...specifiers].filter((s) => !s.startsWith(".") && !s.startsWith("node:"));
}

describe("§ dependencies 宣言", () => {
  it("src の runtime import はすべて package.json の dependencies または peerDependencies に宣言する", () => {
    const allowed = new Set([...declaredNames, "bun", "bun:test"]);
    const missing = Object.fromEntries(
      readdirSync(import.meta.dir)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => [
          file,
          runtimeBareImports(readFileSync(join(import.meta.dir, file), "utf8")).filter(
            (s) => !allowed.has(s),
          ),
        ])
        .filter(([, list]) => (list as string[]).length > 0),
    );
    assert.deepEqual(missing, {}, "runtime imports missing from package.json dependencies/peerDependencies");
  });
});
