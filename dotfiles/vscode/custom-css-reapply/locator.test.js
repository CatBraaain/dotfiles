import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "bun:test";
import {
  expectedPatchSegment,
  findWorkbenchHtml,
  hasPatchMarker,
  isPatchFresh,
  patchSegment,
  workbenchSearchDirs,
} from "./locator.js";

const tempRoots = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeTempRoot(name) {
  const dir = mkdtempSync(join(tmpdir(), `custom-css-reapply-${name}-`));
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

const SESSION_ID = "12345678-abcd-1234-abcd-1234567890ab";

function patchedHtml(segment) {
  return [
    "<html><head>",
    `<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ${SESSION_ID} !! -->`,
    "<!-- !! VSCODE-CUSTOM-CSS-START !! -->",
    `${segment}<!-- !! VSCODE-CUSTOM-CSS-END !! -->`,
    "</head></html>",
  ].join("\n");
}

const variables = { userHome: () => "/home/tester" };

function reader(files) {
  return (filePath) => {
    if (!(filePath in files)) throw new Error(`missing file: ${filePath}`);
    return files[filePath];
  };
}

describe("patchSegment", () => {
  it("extracts the embedded content between the markers", () => {
    const html = patchedHtml("<script>inject()</script>");
    assert.equal(patchSegment(html), "<script>inject()</script>");
  });

  it("returns null without markers", () => {
    assert.equal(patchSegment("<html><head></head></html>"), null);
  });
});

describe("expectedPatchSegment", () => {
  it("wraps a js import in a script tag", () => {
    const imports = ["file://${userHome}/custom-css-js/scm-collapse.js"];
    const read = reader({ "/home/tester/custom-css-js/scm-collapse.js": "start();\n" });
    assert.equal(expectedPatchSegment(imports, variables, read), "<script>start();\n</script>");
  });

  it("wraps a css import in a style tag", () => {
    const imports = ["file://${userHome}/theme.css"];
    const read = reader({ "/home/tester/theme.css": "body{}" });
    assert.equal(expectedPatchSegment(imports, variables, read), "<style>body{}</style>");
  });

  it("concatenates imports in order", () => {
    const imports = ["file://${userHome}/a.js", "file://${userHome}/b.css"];
    const read = reader({
      "/home/tester/a.js": "a();",
      "/home/tester/b.css": "b{}",
    });
    assert.equal(
      expectedPatchSegment(imports, variables, read),
      "<script>a();</script><style>b{}</style>",
    );
  });

  it("returns null for an unreadable file", () => {
    const imports = ["file://${userHome}/missing.js"];
    assert.equal(expectedPatchSegment(imports, variables, reader({})), null);
  });

  it("returns null for a non-file URL", () => {
    assert.equal(expectedPatchSegment(["https://example.com/x.js"], variables, reader({})), null);
  });

  it("returns null for an empty or non-string item", () => {
    assert.equal(expectedPatchSegment([""], variables, reader({})), null);
    assert.equal(expectedPatchSegment([42], variables, reader({})), null);
  });
});

describe("isPatchFresh", () => {
  const imports = ["file://${userHome}/custom-css-js/scm-collapse.js"];
  const read = reader({ "/home/tester/custom-css-js/scm-collapse.js": "start();\n" });
  const freshHtml = patchedHtml("<script>start();\n</script>");

  it("is true when the embedded content matches the imports", () => {
    assert.equal(isPatchFresh(freshHtml, imports, variables, read), true);
  });

  it("is false when the embedded content is stale", () => {
    assert.equal(
      isPatchFresh(patchedHtml("<script>old();\n</script>"), imports, variables, read),
      false,
    );
  });

  it("is false when the patch is missing", () => {
    assert.equal(isPatchFresh("<html><head></head></html>", imports, variables, read), false);
  });

  it("is null when imports cannot be resolved", () => {
    assert.equal(isPatchFresh(freshHtml, ["file://${userHome}/missing.js"], variables, read), null);
  });
});
