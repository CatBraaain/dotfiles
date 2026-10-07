import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildViewerHtml, generateViewer, readCatalog } from "./build-viewer.mjs";

const script = fileURLToPath(new URL("./build-viewer.mjs", import.meta.url));
const dataMarker = '<script id="catalog-data" type="application/json">';

function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), "design-catalog-build-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, "catalog");
  mkdirSync(join(root, "designs", "motion", "fade"), { recursive: true });
  const optionFile = join(root, "designs", "motion", "fade", "index.html");
  writeFileSync(optionFile, "<!doctype html><p>Option</p>");
  writeFileSync(join(root, "asset.svg"), "<svg></svg>");
  writeFileSync(join(root, "index.html"), "existing viewer");
  writeFileSync(join(workspace, "outside.html"), "private HTML");
  // Minimal internal template for test-only API injection. The public CLI
  // only generates the bundled viewer.html and has no template argument.
  const template = join(workspace, "template.html");
  writeFileSync(template, `<!doctype html>${dataMarker}__DESIGN_CATALOG_DATA__</script>`);
  const catalog = {
    schemaVersion: 1,
    id: "motion-catalog",
    title: "Motion catalog",
    axes: [
      {
        id: "motion",
        label: "Motion",
        description: "Compare entrance styles.",
        options: [
          {
            id: "fade",
            label: "Fade",
            description: "Opacity-only entrance.",
            path: "designs/motion/fade/index.html",
          },
        ],
      },
    ],
  };
  const save = () => writeFileSync(join(root, "catalog.json"), JSON.stringify(catalog));
  save();
  return { workspace, root, template, optionFile, catalog, save };
}

function embeddedCatalog(html) {
  const start = html.indexOf(dataMarker) + dataMarker.length;
  return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
}

test("generates a viewer without changing manifest, option HTML, or assets", (t) => {
  const f = fixture(t);
  const manifestBefore = readFileSync(join(f.root, "catalog.json"));
  const optionBefore = readFileSync(f.optionFile);
  const assetBefore = readFileSync(join(f.root, "asset.svg"));
  assert.equal(generateViewer(f.root, f.template), join(f.root, "index.html"));
  const generated = readFileSync(join(f.root, "index.html"), "utf8");
  assert.deepEqual(embeddedCatalog(generated), {
    ...f.catalog,
    axes: [
      {
        ...f.catalog.axes[0],
        options: [{ ...f.catalog.axes[0].options[0], path: "./designs/motion/fade/index.html" }],
      },
    ],
  });
  assert.deepEqual(readFileSync(join(f.root, "catalog.json")), manifestBefore);
  assert.deepEqual(readFileSync(f.optionFile), optionBefore);
  assert.deepEqual(readFileSync(join(f.root, "asset.svg")), assetBefore);
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith(".catalog-viewer-")),
    false,
  );
});

test("keeps array order and allows option IDs reused across different axes", (t) => {
  const f = fixture(t);
  const firstAxis = structuredClone(f.catalog.axes[0]);
  firstAxis.id = "z-last-alphabetically";
  firstAxis.options.push({ ...firstAxis.options[0], id: "another" });
  f.catalog.axes.unshift(firstAxis);
  f.save();
  const catalog = readCatalog(f.root);
  assert.deepEqual(
    catalog.axes.map((axis) => axis.id),
    ["z-last-alphabetically", "motion"],
  );
  assert.deepEqual(
    catalog.axes[0].options.map((option) => option.id),
    ["fade", "another"],
  );
});

test("normalizes relative filesystem paths and encodes URL-special characters for iframe src", (t) => {
  const f = fixture(t);
  const name = "日本語 space#?%.HTML";
  writeFileSync(join(f.root, "designs", name), "<p>Special path</p>");
  f.catalog.axes[0].options[0].path = `./designs/motion/../${name}`;
  f.save();
  const path = readCatalog(f.root).axes[0].options[0].path;
  assert.equal(path, `./designs/${encodeURIComponent(name)}`);
});

test("embeds hostile text as inert JSON without replacement-string interpretation", (t) => {
  const f = fixture(t);
  const hostileText = '</script><script>alert("x")</script><!-- $& $` $\' \u2028\u2029';
  f.catalog.title = hostileText;
  f.catalog.axes[0].label = hostileText;
  f.catalog.axes[0].description = hostileText;
  f.catalog.axes[0].options[0].label = hostileText;
  f.catalog.axes[0].options[0].description = hostileText;
  f.save();
  const html = buildViewerHtml(f.root, f.template);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.equal(html.includes("\u2028"), false);
  assert.equal(html.includes("\u2029"), false);
  assert.equal(html.includes("__DESIGN_CATALOG_DATA__"), false);
  const embedded = embeddedCatalog(html);
  assert.equal(embedded.title, hostileText);
  assert.equal(embedded.axes[0].label, hostileText);
  assert.equal(embedded.axes[0].description, hostileText);
  assert.equal(embedded.axes[0].options[0].label, hostileText);
  assert.equal(embedded.axes[0].options[0].description, hostileText);
});

const invalidCatalogs = [
  [
    "wrong schema version",
    (c) => {
      c.schemaVersion = 2;
    },
    /schemaVersion/,
  ],
  [
    "missing schema version",
    (c) => {
      delete c.schemaVersion;
    },
    /schemaVersion/,
  ],
  [
    "non-integer schema version",
    (c) => {
      c.schemaVersion = "1";
    },
    /schemaVersion/,
  ],
  [
    "invalid catalog ID",
    (c) => {
      c.id = "UpperCase";
    },
    /catalog.id/,
  ],
  [
    "missing catalog ID",
    (c) => {
      delete c.id;
    },
    /catalog.id/,
  ],
  [
    "empty title",
    (c) => {
      c.title = " \n";
    },
    /catalog.title/,
  ],
  [
    "non-string title",
    (c) => {
      c.title = 5;
    },
    /catalog.title/,
  ],
  [
    "empty axes",
    (c) => {
      c.axes = [];
    },
    /catalog.axes/,
  ],
  [
    "missing axes",
    (c) => {
      delete c.axes;
    },
    /catalog.axes/,
  ],
  [
    "non-array axes",
    (c) => {
      c.axes = {};
    },
    /catalog.axes/,
  ],
  [
    "non-object axis",
    (c) => {
      c.axes = [null];
    },
    /must be an object/,
  ],
  [
    "invalid axis ID",
    (c) => {
      c.axes[0].id = "has space";
    },
    /lowercase/,
  ],
  [
    "duplicate axis IDs",
    (c) => {
      c.axes.push(c.axes[0]);
    },
    /duplicate ID/,
  ],
  [
    "missing axis label",
    (c) => {
      delete c.axes[0].label;
    },
    /label/,
  ],
  [
    "empty axis description",
    (c) => {
      c.axes[0].description = "";
    },
    /description/,
  ],
  [
    "empty options",
    (c) => {
      c.axes[0].options = [];
    },
    /options/,
  ],
  [
    "missing options",
    (c) => {
      delete c.axes[0].options;
    },
    /options/,
  ],
  [
    "non-object option",
    (c) => {
      c.axes[0].options = [[]];
    },
    /must be an object/,
  ],
  [
    "invalid option ID",
    (c) => {
      c.axes[0].options[0].id = "a_b";
    },
    /lowercase/,
  ],
  [
    "duplicate option IDs",
    (c) => {
      c.axes[0].options.push(c.axes[0].options[0]);
    },
    /duplicate ID/,
  ],
  [
    "missing option label",
    (c) => {
      delete c.axes[0].options[0].label;
    },
    /label/,
  ],
  [
    "empty option description",
    (c) => {
      c.axes[0].options[0].description = " ";
    },
    /description/,
  ],
  [
    "missing option path",
    (c) => {
      delete c.axes[0].options[0].path;
    },
    /path/,
  ],
];

for (const [name, mutate, expected] of invalidCatalogs) {
  test(`rejects ${name} without replacing the existing viewer`, (t) => {
    const f = fixture(t);
    mutate(f.catalog);
    f.save();
    assert.throws(() => generateViewer(f.root, f.template), expected);
    assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
  });
}

for (const invalidJson of ["{", "null", "[]", '"text"', "42"]) {
  test(`rejects invalid/non-object manifest ${invalidJson}`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, "catalog.json"), invalidJson);
    assert.throws(() => generateViewer(f.root, f.template), /invalid JSON|must be an object/);
    assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
  });
}

const invalidPaths = [
  ["/tmp/outside.html", /relative HTML/],
  ["C:\\outside.html", /relative HTML/],
  ["C:/outside.html", /relative HTML/],
  ["C:outside.html", /relative HTML/],
  ["\\\\host\\share\\index.html", /relative HTML/],
  ["//example.com/index.html", /relative HTML/],
  ["https://example.com/index.html", /relative HTML/],
  ["data:text/html,hello", /relative HTML/],
  ["javascript:alert(1)", /relative HTML/],
  ["designs\\motion\\fade\\index.html", /relative HTML/],
  ["designs/\u0000index.html", /relative HTML/],
  ["../outside.html", /inside the catalog root/],
  ["designs/../../outside.html", /inside the catalog root/],
  ["asset.svg", /expected an HTML/],
  ["designs/motion/fade/index.html?x=1", /expected an HTML/],
  ["missing.html", /ENOENT/],
  ["index.html", /cannot be the generated viewer/],
];

for (const [path, expected] of invalidPaths) {
  test(`rejects unsafe or invalid HTML path ${JSON.stringify(path)} without replacing viewer`, (t) => {
    const f = fixture(t);
    f.catalog.axes[0].options[0].path = path;
    f.save();
    assert.throws(() => generateViewer(f.root, f.template), expected);
    assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
    assert.equal(readFileSync(join(f.workspace, "outside.html"), "utf8"), "private HTML");
  });
}

test("rejects a directory with an HTML extension", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "folder.html"));
  f.catalog.axes[0].options[0].path = "folder.html";
  f.save();
  assert.throws(() => generateViewer(f.root, f.template), /regular file/);
  assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
});

for (const linkType of ["file", "directory"]) {
  test(`rejects external ${linkType} symlinks even with a catalog-root prefix`, (t) => {
    const f = fixture(t);
    const sibling = `${f.root}-outside`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "index.html"), "private sibling");
    const link = join(f.root, "link.html");
    symlinkSync(linkType === "file" ? join(sibling, "index.html") : sibling, link);
    f.catalog.axes[0].options[0].path = linkType === "file" ? "link.html" : "link.html/index.html";
    f.save();
    assert.throws(() => generateViewer(f.root, f.template), /inside the catalog root/);
    assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
  });
}

test("allows contained option symlinks and a symlinked selected root", (t) => {
  const f = fixture(t);
  symlinkSync(f.optionFile, join(f.root, "internal.html"));
  symlinkSync(f.root, join(f.workspace, "selected-root"));
  f.catalog.axes[0].options[0].path = "internal.html";
  f.save();
  assert.equal(
    readCatalog(join(f.workspace, "selected-root")).axes[0].options[0].path,
    "./internal.html",
  );
  assert.equal(
    generateViewer(join(f.workspace, "selected-root"), f.template),
    join(f.root, "index.html"),
  );
});

test("rejects an external manifest symlink", (t) => {
  const f = fixture(t);
  const outsideManifest = join(f.workspace, "outside.json");
  writeFileSync(outsideManifest, JSON.stringify(f.catalog));
  rmSync(join(f.root, "catalog.json"));
  symlinkSync(outsideManifest, join(f.root, "catalog.json"));
  assert.throws(() => generateViewer(f.root, f.template), /inside the catalog root/);
  assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
});

test("rejects a symlink that aliases the generated viewer as an option", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.root, "index.html"), join(f.root, "alias.html"));
  f.catalog.axes[0].options[0].path = "alias.html";
  f.save();
  assert.throws(() => generateViewer(f.root, f.template), /cannot be the generated viewer/);
  assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
});

for (const target of ["internal", "external", "dangling"]) {
  test(`rejects ${target} output symlink without changing its target`, (t) => {
    const f = fixture(t);
    const targetFile =
      target === "internal"
        ? f.optionFile
        : join(f.workspace, target === "external" ? "outside.html" : "absent.html");
    const before = existsSync(targetFile) ? readFileSync(targetFile) : null;
    rmSync(join(f.root, "index.html"));
    symlinkSync(targetFile, join(f.root, "index.html"));
    assert.throws(() => generateViewer(f.root, f.template), /output must be a regular file/);
    if (before === null) assert.equal(existsSync(targetFile), false);
    else assert.deepEqual(readFileSync(targetFile), before);
  });
}

test("rejects missing manifest, missing root, and non-directory root", (t) => {
  const f = fixture(t);
  assert.throws(() => readCatalog(join(f.workspace, "missing")), /ENOENT/);
  assert.throws(() => readCatalog(f.optionFile), /root must be a directory/);
  rmSync(join(f.root, "catalog.json"));
  assert.throws(() => generateViewer(f.root, f.template), /ENOENT/);
  assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
});

// Internal template failure detection through the test-only injection
// argument of generateViewer. The public CLI cannot supply a template.
for (const templateText of ["no placeholder", "__DESIGN_CATALOG_DATA__ __DESIGN_CATALOG_DATA__"]) {
  test("rejects a template without exactly one data placeholder before writing", (t) => {
    const f = fixture(t);
    writeFileSync(f.template, templateText);
    assert.throws(() => generateViewer(f.root, f.template), /exactly one/);
    assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
  });
}

test("rejects a missing template before writing", (t) => {
  const f = fixture(t);
  assert.throws(() => generateViewer(f.root, join(f.workspace, "missing-template.html")), /ENOENT/);
  assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
});

test("creates a viewer when no index.html exists", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "index.html"));
  generateViewer(f.root, f.template);
  assert.equal(embeddedCatalog(readFileSync(join(f.root, "index.html"), "utf8")).id, f.catalog.id);
});

test("does not create a viewer on invalid input", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "index.html"));
  f.catalog.schemaVersion = 0;
  f.save();
  assert.throws(() => generateViewer(f.root, f.template), /schemaVersion/);
  assert.equal(existsSync(join(f.root, "index.html")), false);
});

test("rejects a dangling option symlink without replacing viewer", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.workspace, "missing.html"), join(f.root, "dangling.html"));
  f.catalog.axes[0].options[0].path = "dangling.html";
  f.save();
  assert.throws(() => generateViewer(f.root, f.template), /ENOENT/);
  assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
});

test("rejects a directory output without changing its contents", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "index.html"));
  mkdirSync(join(f.root, "index.html"));
  writeFileSync(join(f.root, "index.html", "keep.txt"), "keep");
  assert.throws(() => generateViewer(f.root, f.template), /output must be a regular file/);
  assert.equal(readFileSync(join(f.root, "index.html", "keep.txt"), "utf8"), "keep");
});

test("buildViewerHtml reads and renders without writing the viewer", (t) => {
  const f = fixture(t);
  assert.equal(embeddedCatalog(buildViewerHtml(f.root, f.template)).id, f.catalog.id);
  assert.equal(readFileSync(join(f.root, "index.html"), "utf8"), "existing viewer");
});

test("CLI generates the bundled viewer and reports rejection with non-zero exit and reason", (t) => {
  const f = fixture(t);
  const success = spawnSync(process.execPath, [script, f.root], {
    encoding: "utf8",
  });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout.trim(), join(f.root, "index.html"));
  assert.equal(embeddedCatalog(readFileSync(join(f.root, "index.html"), "utf8")).id, f.catalog.id);
  const generated = readFileSync(join(f.root, "index.html"));
  f.catalog.axes[0].options[0].path = "missing.html";
  f.save();
  const failure = spawnSync(process.execPath, [script, f.root], {
    encoding: "utf8",
  });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /missing.html/);
  assert.deepEqual(readFileSync(join(f.root, "index.html")), generated);
});

for (const args of [
  [],
  ["root", "extra"],
  ["root", "--template"],
  ["root", "--template", "template"],
  ["root", "--template", "template", "extra"],
]) {
  test(`CLI rejects malformed arguments ${JSON.stringify(args)}`, () => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  });
}
