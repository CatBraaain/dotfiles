import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCamoufox } from "./windows";

function browserFixture(application: string) {
  const appData = mkdtempSync(join(tmpdir(), "camoufox-installer-test-"));
  const browser = join(appData, "Programs", "Camoufox");
  mkdirSync(browser, { recursive: true });
  const executable = join(browser, "camoufox.exe");
  const versionFile = join(browser, "version.json");
  writeFileSync(executable, "installed browser");
  writeFileSync(join(browser, "application.ini"), application);
  return {
    appData,
    browser,
    executable,
    versionFile,
    dispose: () => rmSync(appData, { recursive: true }),
  };
}

test("repairs the metadata without replacing the installed Camoufox", async () => {
  const fixture = browserFixture("[App]\r\nName=Camoufox\r\nVersion=158.0.1-beta.41\r\n");
  try {
    await installCamoufox(fixture.appData);
    assert.deepEqual(JSON.parse(readFileSync(fixture.versionFile, "utf8")), {
      version: "158.0.1",
      release: "beta.41",
    });
    assert.equal(readFileSync(fixture.executable, "utf8"), "installed browser");
  } finally {
    fixture.dispose();
  }
});

test("leaves an existing version file intact", async () => {
  const fixture = browserFixture("[App]\n");
  const existing = '{"version":"158.0.1","release":"beta.41"}';
  try {
    writeFileSync(fixture.versionFile, existing);
    await installCamoufox(fixture.appData);
    assert.equal(readFileSync(fixture.versionFile, "utf8"), existing);
  } finally {
    fixture.dispose();
  }
});

test("can retry after failing to publish the version file", async () => {
  const fixture = browserFixture("[App]\nVersion=158.0.1-beta.41\n");
  try {
    const publish = spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("Could not publish version file");
    });
    try {
      await assert.rejects(installCamoufox(fixture.appData), /Could not publish version file/);
      assert.deepEqual(readdirSync(fixture.browser).sort(), ["application.ini", "camoufox.exe"]);
    } finally {
      publish.mockRestore();
    }
    await installCamoufox(fixture.appData);
    assert.ok(existsSync(fixture.versionFile));
  } finally {
    fixture.dispose();
  }
});

test("rejects an unknown package version instead of inventing one", async () => {
  const fixture = browserFixture("[App]\nVersion=158.0.1\n");
  try {
    await assert.rejects(installCamoufox(fixture.appData), /Invalid Camoufox version/);
    assert.equal(existsSync(fixture.versionFile), false);
  } finally {
    fixture.dispose();
  }
});
