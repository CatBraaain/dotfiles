import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import { needsBuild, needsInstall } from "./build.apply.ts";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "dsh-build-hook-test-"));
  return root;
}

async function putFile(path: string, modifiedAt: Date): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
  await utimes(path, modifiedAt, modifiedAt);
}

const older = new Date("2020-01-01T00:00:00Z");
const newer = new Date("2021-01-01T00:00:00Z");

describe("dsh build apply hook", () => {
  it("installs when the stamp is missing or a watched file is newer", async () => {
    const plugin = await createRoot();
    const stamp = join(plugin, "node_modules/.bun-install-stamp");
    assert.equal(await needsInstall(plugin, stamp), true);

    await putFile(stamp, older);
    await putFile(join(plugin, "package.json"), older);
    assert.equal(await needsInstall(plugin, stamp), false);

    await putFile(join(plugin, "bun.lock"), newer);
    assert.equal(await needsInstall(plugin, stamp), true);
  });

  it("ignores newer test files but rebuilds for newer source files", async () => {
    const plugin = await createRoot();
    const output = join(plugin, "dist/index.js");
    await putFile(output, older);
    await putFile(join(plugin, "src/index.ts"), older);
    await putFile(join(plugin, "src/index.test.ts"), newer);

    assert.equal(await needsBuild(plugin, output), false);

    await putFile(join(plugin, "src/runner.ts"), newer);
    assert.equal(await needsBuild(plugin, output), true);
  });

  it("rebuilds when a shared library source behind the dependency symlink is newer", async () => {
    const plugin = await createRoot();
    const output = join(plugin, "dist/index.js");
    const sharedLibrary = join(root, "shared-lib");
    await putFile(output, older);
    await putFile(join(plugin, "src/index.ts"), older);
    await putFile(join(sharedLibrary, "src/helper.ts"), newer);
    await mkdir(join(plugin, "node_modules/@dotfiles"), { recursive: true });
    await symlink(sharedLibrary, join(plugin, "node_modules/@dotfiles/agent-lib"));

    assert.equal(await needsBuild(plugin, output), true);
  });
});
