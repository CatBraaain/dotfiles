import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureRoots: string[] = [];
const CLI_SOURCE = `
import { writeFileSync } from "node:fs";
import { version } from "@fixture/shared-library";
const output = process.argv[process.argv.indexOf("--out") + 1];
writeFileSync(output, JSON.stringify({ root: "Stack", version }));
`;

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const agentDir = mkdtempSync(join(tmpdir(), "openui-spec-build-"));
  fixtureRoots.push(agentDir);
  const hookDir = join(agentDir, "extensions.exact", "openui-preview");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(
    join(hookDir, "library.data.ts"),
    'import { version } from "@fixture/shared-library";\n' +
      "export const promptOptions = { examples: [version], additionalRules: [] };\n",
  );
  writeFileSync(join(hookDir, "display-only.ts"), "export {};\n");
  const sharedModules = join(agentDir, ".build-deps", "node_modules");
  return { agentDir, hookDir, sharedModules };
}

function prepareSharedFixture(fixture: ReturnType<typeof createFixture>, cliSource = CLI_SOURCE) {
  const cliDir = join(fixture.sharedModules, "@openuidev", "cli", "dist");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, "index.js"), cliSource);
  const libraryDir = join(fixture.sharedModules, "@fixture", "shared-library");
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(
    join(libraryDir, "package.json"),
    JSON.stringify({ name: "@fixture/shared-library", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(join(libraryDir, "index.js"), 'export const version = "shared-1.0.0";\n');
}

function runHook(fixture: ReturnType<typeof createFixture>) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "spec.build.ts")], {
    cwd: fixture.hookDir,
  });
}

describe("OpenUI spec build", () => {
  it("uses the prepared shared dependencies for both CLI and library loading", () => {
    const fixture = createFixture();
    prepareSharedFixture(fixture);
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.hookDir, "spec.json"), "utf8")), {
      root: "Stack",
      version: "shared-1.0.0",
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.hookDir, "prompt-options.json"), "utf8")),
      { examples: ["shared-1.0.0"], additionalRules: [] },
    );
    assert.equal(existsSync(join(fixture.hookDir, ".build-deps")), false);
    assert.equal(existsSync(join(fixture.hookDir, ".build", "package.json")), false);
    assert.equal(existsSync(join(fixture.hookDir, ".build", "bun.lock")), false);
  });

  it("fails without installing when the parent dependencies have not been prepared", () => {
    const fixture = createFixture();
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("bun_install.build.ts must run first"));
    assert.equal(existsSync(join(fixture.agentDir, ".build-deps")), false);
    assert.equal(existsSync(join(fixture.hookDir, "spec.json")), false);
    assert.equal(existsSync(join(fixture.hookDir, "prompt-options.json")), false);
  });

  it("stops without writing prompt options when generation fails", () => {
    const fixture = createFixture();
    prepareSharedFixture(fixture, "process.exit(7);\n");
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("openui generate failed with exit code 7"));
    assert.equal(existsSync(join(fixture.hookDir, "prompt-options.json")), false);
  });

  it("does nothing when no library definition is present", () => {
    const fixture = createFixture();
    rmSync(join(fixture.hookDir, "library.data.ts"));
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(existsSync(join(fixture.hookDir, ".build")), false);
    assert.equal(existsSync(join(fixture.agentDir, ".build-deps")), false);
  });
});
