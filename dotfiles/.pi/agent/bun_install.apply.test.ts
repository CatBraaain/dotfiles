import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import { needsInstall } from "./bun_install.apply.ts";

let directory: string;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function createDirectory(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "bun-install-hook-test-"));
  return directory;
}

async function putFile(path: string, modifiedAt: Date): Promise<void> {
  await writeFile(path, "");
  await utimes(path, modifiedAt, modifiedAt);
}

describe("bun install apply hook", () => {
  it("installs when the stamp is missing", async () => {
    const root = await createDirectory();
    await mkdir(join(root, "node_modules"));

    assert.equal(needsInstall(root), true);
  });

  it("installs when a manifest or lockfile is newer than the stamp", async () => {
    const root = await createDirectory();
    const older = new Date("2020-01-01T00:00:00Z");
    const newer = new Date("2021-01-01T00:00:00Z");
    await mkdir(join(root, "node_modules"));
    await putFile(join(root, "node_modules/.bun-install-stamp"), older);
    await putFile(join(root, "package.json"), newer);

    assert.equal(needsInstall(root), true);

    await putFile(join(root, "package.json"), older);
    await putFile(join(root, "bun.lock"), newer);
    assert.equal(needsInstall(root), true);
  });

  it("skips install when watched files are not newer than the stamp", async () => {
    const root = await createDirectory();
    const timestamp = new Date("2021-01-01T00:00:00Z");
    await mkdir(join(root, "node_modules"));
    await putFile(join(root, "node_modules/.bun-install-stamp"), timestamp);
    await putFile(join(root, "package.json"), timestamp);
    await putFile(join(root, "bun.lockb"), timestamp);

    assert.equal(needsInstall(root), false);
  });
});
