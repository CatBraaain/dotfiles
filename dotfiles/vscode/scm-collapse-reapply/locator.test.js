import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "bun:test";
import { findWorkbenchHtml, hasPatchMarker, workbenchSearchDirs } from "./locator.js";

const tempRoots = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeTempRoot(name) {
  const dir = mkdtempSync(join(tmpdir(), `scm-collapse-reapply-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function buildWorkbenchTree(base, { workbenchDir, htmlFile }) {
  const dir = join(base, ...workbenchDir.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, htmlFile), "<html></html>");
}

describe("hasPatchMarker", () => {
  it("detects the session id marker written by the Loader", () => {
    const patched =
      "<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID 12345678-abcd-1234-abcd-1234567890ab !! -->";
    assert.equal(hasPatchMarker(patched), true);
  });

  it("rejects unpatched HTML", () => {
    assert.equal(hasPatchMarker("<html><head></head></html>"), false);
  });

  it("rejects an empty file", () => {
    assert.equal(hasPatchMarker(""), false);
  });
});

describe("findWorkbenchHtml", () => {
  it("finds workbench.html in the electron layout", () => {
    const install = join(makeTempRoot("electron"), "install");
    buildWorkbenchTree(install, {
      workbenchDir: "resources/app/out/vs/code/electron-browser/workbench",
      htmlFile: "workbench.html",
    });
    const found = findWorkbenchHtml(workbenchSearchDirs({ execPath: join(install, "code") }));
    assert.equal(
      found,
      join(install, "resources/app/out/vs/code/electron-browser/workbench/workbench.html"),
    );
  });

  it("finds the active commit-hash directory under the install root", () => {
    const install = join(makeTempRoot("selfupdate"), "install");
    mkdirSync(install, { recursive: true });
    buildWorkbenchTree(join(install, "69047191fc"), {
      workbenchDir: "resources/app/out/vs/code/electron-browser/workbench",
      htmlFile: "workbench.html",
    });
    buildWorkbenchTree(join(install, "0ffee000aa"), {
      workbenchDir: "resources/app/out/vs/code/electron-browser/workbench",
      htmlFile: "workbench.html",
    });
    const dirs = workbenchSearchDirs({
      execPath: join(install, "0ffee000aa", "code"),
      extraRoots: [install],
    });
    const found = findWorkbenchHtml(dirs);
    assert.ok(found?.startsWith(join(install, "0ffee000aa")), `unexpected: ${found}`);
  });

  it("prefers workbench-dev.html over workbench.html", () => {
    const install = join(makeTempRoot("dev"), "install");
    const dir = join(install, "out", "vs", "code", "electron-browser", "workbench");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workbench-dev.html"), "<html></html>");
    writeFileSync(join(dir, "workbench.html"), "<html></html>");
    const found = findWorkbenchHtml(workbenchSearchDirs({ execPath: join(install, "code") }));
    assert.equal(found, join(dir, "workbench-dev.html"));
  });

  it("returns null when nothing matches", () => {
    const install = join(makeTempRoot("empty"), "install");
    mkdirSync(install, { recursive: true });
    assert.equal(findWorkbenchHtml(workbenchSearchDirs({ execPath: join(install, "code") })), null);
  });

  it("resolves via require.main style out dir", () => {
    const app = join(makeTempRoot("main"), "app");
    buildWorkbenchTree(app, {
      workbenchDir: "out/vs/code/electron-sandbox/workbench",
      htmlFile: "workbench.html",
    });
    const mainFilename = join(app, "out", "cli.js");
    const found = findWorkbenchHtml(workbenchSearchDirs({ mainFilename }));
    assert.equal(found, join(app, "out/vs/code/electron-sandbox/workbench/workbench.html"));
  });
});
