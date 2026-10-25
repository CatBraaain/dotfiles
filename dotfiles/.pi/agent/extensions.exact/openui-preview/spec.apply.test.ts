import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureRoots: string[] = [];
const CLI_SOURCE = `
import { writeFileSync } from "node:fs";
import { version } from "@fixture/shared-library";
const output = process.argv[process.argv.indexOf("--out") + 1];
writeFileSync(output, JSON.stringify({ root: "Stack", version }));
`;
const LIBRARY_SOURCE =
  'import { version } from "@fixture/shared-library";\n' +
  "export const promptOptions = { examples: [version], additionalRules: [] };\n";

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "openui-spec-apply-"));
  fixtureRoots.push(root);
  const distHookDir = join(root, "dist", ".pi", "agent", "extensions.exact", "openui-preview");
  const homeHookDir = join(root, "home", ".pi", "agent", "extensions.exact", "openui-preview");
  const agentDir = join(root, "home", ".pi", "agent");
  const nodeModules = join(agentDir, "node_modules");
  mkdirSync(distHookDir, { recursive: true });
  mkdirSync(homeHookDir, { recursive: true });
  writeFileSync(join(root, "dist", ".pi", "agent", "bun.lock"), "");
  writeFileSync(join(distHookDir, "library.data.ts"), LIBRARY_SOURCE);
  writeFileSync(join(distHookDir, "display-only.ts"), "export {};\n");
  copyFileSync(join(import.meta.dir, "spec.apply.ts"), join(distHookDir, "spec.apply.ts"));
  return { root, distHookDir, homeHookDir, nodeModules };
}

function prepareNodeModules(fixture: ReturnType<typeof createFixture>, cliSource = CLI_SOURCE) {
  const cliDir = join(fixture.nodeModules, "@openuidev", "cli", "dist");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, "index.js"), cliSource);
  const libraryDir = join(fixture.nodeModules, "@fixture", "shared-library");
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(
    join(libraryDir, "package.json"),
    JSON.stringify({ name: "@fixture/shared-library", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(join(libraryDir, "index.js"), 'export const version = "shared-1.0.0";\n');
}

function runHook(fixture: ReturnType<typeof createFixture>) {
  return Bun.spawnSync([process.execPath, join(fixture.distHookDir, "spec.apply.ts")], {
    cwd: fixture.homeHookDir,
  });
}

function removeCli(fixture: ReturnType<typeof createFixture>) {
  rmSync(join(fixture.nodeModules, "@openuidev"), { recursive: true, force: true });
}

describe("OpenUI spec apply hook", () => {
  it("generates spec and prompt options from the dist-side library", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.homeHookDir, "spec.json"), "utf8")), {
      root: "Stack",
      version: "shared-1.0.0",
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.homeHookDir, "prompt-options.json"), "utf8")),
      { examples: ["shared-1.0.0"], additionalRules: [] },
    );
    assert.equal(existsSync(join(fixture.homeHookDir, "spec-gen-stamp")), true);
    assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
  });

  it("skips generation when the fingerprint stamp and outputs exist", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    removeCli(fixture);
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.homeHookDir, "spec.json"), "utf8")), {
      root: "Stack",
      version: "shared-1.0.0",
    });
  });

  it("regenerates when the library definition changes", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    removeCli(fixture);
    writeFileSync(join(fixture.distHookDir, "library.data.ts"), `${LIBRARY_SOURCE}\n`);
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("OpenUI CLI is missing"));
  });

  it("regenerates when the lockfile changes", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    removeCli(fixture);
    writeFileSync(join(fixture.root, "dist", ".pi", "agent", "bun.lock"), "changed\n");
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("OpenUI CLI is missing"));
  });

  it("fails without writing outputs when the parent dependencies are missing", () => {
    const fixture = createFixture();
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("OpenUI CLI is missing"));
    assert.equal(existsSync(join(fixture.homeHookDir, "spec.json")), false);
    assert.equal(existsSync(join(fixture.homeHookDir, "prompt-options.json")), false);
  });

  it("stops without writing prompt options when generation fails", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture, "process.exit(7);\n");
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("openui generate failed with exit code 7"));
    assert.equal(existsSync(join(fixture.homeHookDir, "prompt-options.json")), false);
    assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
  });

  it("does nothing when no library definition is present", () => {
    const fixture = createFixture();
    rmSync(join(fixture.distHookDir, "library.data.ts"));
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(existsSync(join(fixture.homeHookDir, "spec.json")), false);
  });
});
