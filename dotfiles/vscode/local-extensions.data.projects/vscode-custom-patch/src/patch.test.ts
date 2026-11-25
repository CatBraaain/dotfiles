import { strict as assert } from "node:assert";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "bun:test";
import {
  backupPath,
  clearExistingPatchMarkers,
  ensurePatched,
  extractPatchSegment,
  findWorkbenchHtml,
  hasPatchMarker,
  insertPatchSegment,
  pluginEntries,
  removeContentSecurityPolicy,
  readOriginalFromBackup,
  segmentFromPlugins,
  workbenchSearchDirs,
} from "./patch.ts";

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeTempRoot(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `vscode-custom-patch-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function buildWorkbenchTree(
  base: string,
  { workbenchDir, htmlFile }: { workbenchDir: string; htmlFile: string },
) {
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

  it("finds the commit-hash directory from install roots without an execPath", () => {
    const install = join(makeTempRoot("installroots"), "install");
    mkdirSync(install, { recursive: true });
    buildWorkbenchTree(join(install, "69047191fc"), {
      workbenchDir: "resources/app/out/vs/code/electron-browser/workbench",
      htmlFile: "workbench.html",
    });
    const found = findWorkbenchHtml(workbenchSearchDirs({ extraRoots: [install] }));
    assert.equal(
      found,
      join(
        install,
        "69047191fc/resources/app/out/vs/code/electron-browser/workbench/workbench.html",
      ),
    );
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
    const versionDir = join(makeTempRoot("empty"), "install", "version");
    mkdirSync(versionDir, { recursive: true });
    const found = findWorkbenchHtml(workbenchSearchDirs({ execPath: join(versionDir, "code") }));
    assert.equal(found, null);
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

function patchedHtml(segment: string) {
  return [
    "<html><head>",
    `<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID ${SESSION_ID} !! -->`,
    "<!-- !! VSCODE-CUSTOM-CSS-START !! -->",
    `${segment}<!-- !! VSCODE-CUSTOM-CSS-END !! -->`,
    "</head></html>",
  ].join("\n");
}

describe("pluginEntries", () => {
  it("reads js and css plugins sorted by file name", () => {
    const dir = makeTempRoot("entries");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.css"), "b{}");
    writeFileSync(join(dir, "a.js"), "a();");
    writeFileSync(join(dir, "notes.txt"), "ignored");

    const entries = pluginEntries(dir);
    assert.deepEqual(
      entries?.map((entry) => entry.name),
      ["a.js", "b.css"],
    );
    assert.deepEqual(
      entries?.map((entry) => entry.content),
      ["a();", "b{}"],
    );
  });

  it("returns an empty list for an empty folder", () => {
    const dir = makeTempRoot("empty-plugins");
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(pluginEntries(dir), []);
  });

  it("returns null for a missing folder", () => {
    assert.equal(pluginEntries(join(makeTempRoot("missing"), "nope")), null);
  });
});

describe("segmentFromPlugins", () => {
  it("wraps js entries in script tags and css entries in style tags", () => {
    const segment = segmentFromPlugins([
      { name: "a.js", content: "a();" },
      { name: "b.css", content: "b{}" },
    ]);
    assert.equal(segment, "<script>a();</script><style>b{}</style>");
  });
});

describe("extractPatchSegment", () => {
  it("extracts the embedded content between the markers", () => {
    const html = patchedHtml("<script>inject()</script>");
    assert.equal(extractPatchSegment(html), "<script>inject()</script>");
  });

  it("returns null without markers", () => {
    assert.equal(extractPatchSegment("<html><head></head></html>"), null);
  });
});

const PRISTINE_HTML = [
  "<!doctype html>",
  "<html>",
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta http-equiv="Content-Security-Policy" content="default-src \'none\';" />',
  "    <title>Workbench</title>",
  "  </head>",
  "  <body></body>",
  "</html>",
].join("\n");

function stagePatchFixture(name: string) {
  const root = makeTempRoot(name);
  const workbenchDir = join(
    root,
    "resources",
    "app",
    "out",
    "vs",
    "code",
    "electron-sandbox",
    "workbench",
  );
  mkdirSync(workbenchDir, { recursive: true });
  const htmlPath = join(workbenchDir, "workbench.html");
  writeFileSync(htmlPath, PRISTINE_HTML);
  const pluginsDir = join(root, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const searchDirs = workbenchSearchDirs({ extraRoots: [join(root, "resources", "app")] });
  return { root, workbenchDir, htmlPath, pluginsDir, searchDirs };
}

describe("ensurePatched", () => {
  it("bakes plugins into a pristine html and reports patched", () => {
    const { htmlPath, pluginsDir, searchDirs, workbenchDir } = stagePatchFixture("bake");
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v1');");

    const result = ensurePatched({ searchDirs, pluginsDir });
    const html = readHtml(htmlPath);

    assert.equal(result, "patched");
    assert.equal(html.includes("<script>console.log('scm v1');</script>"), true);
    assert.equal(html.includes("Content-Security-Policy"), false);
    assert.equal(extractPatchSegment(html), "<script>console.log('scm v1');</script>");
    const segmentIndex = html.indexOf("<script>console.log('scm v1');</script>");
    assert.ok(segmentIndex < html.indexOf("</head>"));
    assert.equal(
      readdirSync(workbenchDir).filter((file) => file.endsWith(".bak-custom-css")).length,
      1,
    );
  });

  it("reports fresh without changing anything when the patch matches", () => {
    const { htmlPath, pluginsDir, searchDirs } = stagePatchFixture("fresh");
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v1');");
    ensurePatched({ searchDirs, pluginsDir });
    const before = readHtml(htmlPath);

    const result = ensurePatched({ searchDirs, pluginsDir });

    assert.equal(result, "fresh");
    assert.equal(readHtml(htmlPath), before);
  });

  it("re-bakes when a plugin content changes", () => {
    const { htmlPath, pluginsDir, searchDirs, workbenchDir } = stagePatchFixture("rebake");
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v1');");
    ensurePatched({ searchDirs, pluginsDir });
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v2');");

    const result = ensurePatched({ searchDirs, pluginsDir });
    const html = readHtml(htmlPath);

    assert.equal(result, "patched");
    assert.equal(html.includes("console.log('scm v2');"), true);
    assert.equal(html.includes("console.log('scm v1');"), false);
    assert.equal(
      readdirSync(workbenchDir).filter((file) => file.endsWith(".bak-custom-css")).length,
      1,
    );
  });

  it("unpatches when the plugins folder becomes empty", () => {
    const { htmlPath, pluginsDir, searchDirs } = stagePatchFixture("unpatch");
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v1');");
    ensurePatched({ searchDirs, pluginsDir });
    rmSync(join(pluginsDir, "scm-collapse.js"));

    const result = ensurePatched({ searchDirs, pluginsDir });
    const html = readHtml(htmlPath);

    assert.equal(result, "unpatched");
    assert.equal(html, PRISTINE_HTML);
    assert.equal(
      readdirSync(join(htmlPath, "..")).filter((file) => file.endsWith(".bak-custom-css")).length,
      0,
    );
  });

  it("treats a missing plugins folder as no plugins", () => {
    const { htmlPath, pluginsDir, searchDirs } = stagePatchFixture("missing-plugins");
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v1');");
    ensurePatched({ searchDirs, pluginsDir });
    rmSync(pluginsDir, { recursive: true });

    const result = ensurePatched({ searchDirs, pluginsDir });

    assert.equal(result, "unpatched");
    assert.equal(readHtml(htmlPath), PRISTINE_HTML);
  });

  it("unpatches in remove mode even when plugins exist", () => {
    const { htmlPath, pluginsDir, searchDirs } = stagePatchFixture("remove");
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v1');");
    ensurePatched({ searchDirs, pluginsDir });

    const result = ensurePatched({ searchDirs, pluginsDir, mode: "remove" });

    assert.equal(result, "unpatched");
    assert.equal(readHtml(htmlPath), PRISTINE_HTML);
  });

  it("reports backup-missing and keeps the patch when it cannot be removed", () => {
    const { htmlPath, pluginsDir, searchDirs } = stagePatchFixture("no-backup");
    const html = patchedHtml("<script>old</script>");
    writeFileSync(htmlPath, html);

    const result = ensurePatched({ searchDirs, pluginsDir });

    assert.equal(result, "backup-missing");
    assert.equal(readHtml(htmlPath), html);
  });

  it("reports unwritable when the html cannot be written", () => {
    const { htmlPath, pluginsDir, searchDirs } = stagePatchFixture("unwritable");
    writeFileSync(join(pluginsDir, "scm-collapse.js"), "console.log('scm v1');");
    chmodSync(htmlPath, 0o444);

    const result = ensurePatched({ searchDirs, pluginsDir });

    assert.equal(result, "unwritable");
    chmodSync(htmlPath, 0o644);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the current HTML and its backup if migration cannot replace the HTML",
    () => {
      const { htmlPath, searchDirs } = stagePatchFixture("locked-html-target");
      const targetDir = makeTempRoot("locked-target");
      const target = join(targetDir, "workbench.html");
      const patched = patchedHtml("<script>old</script>");
      const backup = backupPath(join(htmlPath, ".."), SESSION_ID);
      writeFileSync(target, patched);
      writeFileSync(backup, PRISTINE_HTML);
      rmSync(htmlPath);
      symlinkSync(target, htmlPath);
      chmodSync(targetDir, 0o555);
      try {
        assert.equal(ensurePatched({ searchDirs, plugins: [] }), "unwritable");
        assert.equal(readHtml(htmlPath), patched);
        assert.equal(readHtml(backup), PRISTINE_HTML);
      } finally {
        chmodSync(targetDir, 0o755);
      }
    },
  );

  it("applies and removes the bundle patch without writing pristine read-only HTML", () => {
    const { htmlPath, searchDirs } = stagePatchFixture("readonly-pristine-html");
    const bundlePath = join(searchDirs[0]!, "vs", "workbench", "workbench.desktop.main.js");
    const bundleSource = `
var Sorter = class {
  constructor(explorer, context) { this.explorerService = explorer; this.contextService = context; }
  compare(left, right) { if (left.isRoot) return -1; return 0; }
};`;
    mkdirSync(join(bundlePath, ".."), { recursive: true });
    writeFileSync(bundlePath, bundleSource);
    chmodSync(htmlPath, 0o444);
    try {
      assert.equal(ensurePatched({ searchDirs, plugins: [], sortExplorer: true }), "patched");
      assert.match(readHtml(bundlePath), /sort-explorer start/);
      assert.equal(ensurePatched({ searchDirs, mode: "remove", plugins: [] }), "unpatched");
      assert.equal(readHtml(bundlePath), bundleSource);
      assert.equal(readHtml(htmlPath), PRISTINE_HTML);
    } finally {
      chmodSync(htmlPath, 0o644);
    }
  });

  it("reports no-workbench when the installation is not found", () => {
    const root = makeTempRoot("no-workbench");
    const pluginsDir = join(root, "plugins");
    mkdirSync(pluginsDir, { recursive: true });

    const result = ensurePatched({
      searchDirs: workbenchSearchDirs({ extraRoots: [root] }),
      pluginsDir,
    });

    assert.equal(result, "no-workbench");
  });
});

function readHtml(htmlPath: string) {
  return readFileSync(htmlPath, "utf-8");
}

describe("readOriginalFromBackup", () => {
  it("reads the original html without consuming the current backup", () => {
    const dir = makeTempRoot("restore");
    const patched = insertPatchSegment(
      removeContentSecurityPolicy(clearExistingPatchMarkers(PRISTINE_HTML)),
      "<script>old</script>",
      SESSION_ID,
    );
    writeFileSync(backupPath(dir, SESSION_ID), PRISTINE_HTML);

    const restored = readOriginalFromBackup(patched, dir);

    assert.equal(restored, PRISTINE_HTML);
    assert.equal(readHtml(backupPath(dir, SESSION_ID)), PRISTINE_HTML);
  });

  it("returns the html unchanged when no backup exists", () => {
    const dir = makeTempRoot("no-backup");
    const patched = patchedHtml("<script>old</script>");
    const restored = readOriginalFromBackup(patched, dir);
    assert.equal(restored, patched);
  });

  it("keeps the html unchanged when no session id is present", () => {
    const dir = makeTempRoot("no-session");
    const restored = readOriginalFromBackup(PRISTINE_HTML, dir);
    assert.equal(restored, PRISTINE_HTML);
  });
});
