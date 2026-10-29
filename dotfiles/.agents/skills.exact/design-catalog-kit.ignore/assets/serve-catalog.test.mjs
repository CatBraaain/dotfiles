import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateViewer } from "./build-viewer.mjs";
import { serveCatalog } from "./serve-catalog.mjs";

const script = fileURLToPath(new URL("./serve-catalog.mjs", import.meta.url));

async function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), "design-catalog-http-"));
  const root = join(workspace, "catalog");
  mkdirSync(join(root, "designs", "option"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><p>Viewer</p>");
  writeFileSync(
    join(root, "designs", "option", "index.html"),
    "<!doctype html><button>Option</button>",
  );
  writeFileSync(join(workspace, "outside.html"), "private external file");
  const running = await serveCatalog(root, { port: 0 });
  t.after(async () => {
    const closed = new Promise((resolveClosed, reject) =>
      running.server.close((error) => (error ? reject(error) : resolveClosed())),
    );
    running.server.closeAllConnections();
    await closed;
    rmSync(workspace, { recursive: true, force: true });
  });
  return { ...running, workspace };
}

function get(url, path, { method = "GET", host } = {}) {
  const address = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const req = request(
      {
        hostname: address.hostname,
        port: address.port,
        path,
        method,
        headers: host ? { Host: host } : {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("binds only IPv4 loopback and serves the selected root viewer and option HTML", async (t) => {
  const f = await fixture(t);
  assert.equal(f.server.address().address, "127.0.0.1");
  assert.equal(f.server.address().family, "IPv4");
  assert.equal(f.root, join(f.workspace, "catalog"));
  const viewer = await get(f.url, "/");
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.toString(), "<!doctype html><p>Viewer</p>");
  assert.equal(viewer.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(viewer.headers["cache-control"], "no-store");
  assert.equal(viewer.headers["x-content-type-options"], "nosniff");
  const option = await get(f.url, "/designs/option/");
  assert.equal(option.status, 200);
  assert.equal(option.body.toString(), "<!doctype html><button>Option</button>");
});

test("serves local CSS, JavaScript, JSON, images, fonts, and binary bytes with content types", async (t) => {
  const f = await fixture(t);
  const assets = [
    ["style.css", "text/css; charset=utf-8"],
    ["app.js", "text/javascript; charset=utf-8"],
    ["app.mjs", "text/javascript; charset=utf-8"],
    ["catalog.json", "application/json; charset=utf-8"],
    ["image.svg", "image/svg+xml"],
    ["image.png", "image/png"],
    ["font.woff2", "font/woff2"],
    ["unknown.bin", "application/octet-stream"],
  ];
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  for (const [name, mime] of assets) {
    writeFileSync(join(f.root, name), bytes);
    const served = await get(f.url, `/${name}`);
    assert.equal(served.status, 200, name);
    assert.equal(served.headers["content-type"], mime, name);
    assert.equal(Number(served.headers["content-length"]), bytes.length, name);
    assert.deepEqual(served.body, bytes, name);
  }
});

test("HEAD returns matching metadata with no response body", async (t) => {
  const f = await fixture(t);
  const head = await get(f.url, "/", { method: "HEAD" });
  const normal = await get(f.url, "/");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-type"], normal.headers["content-type"]);
  assert.equal(head.headers["content-length"], normal.headers["content-length"]);
});

test("serves encoded filename characters and ignores query strings", async (t) => {
  const f = await fixture(t);
  const name = "日本語 space#?%.html";
  writeFileSync(join(f.root, name), "special filename");
  const served = await get(f.url, `/${encodeURIComponent(name)}?replay=2`);
  assert.equal(served.status, 200);
  assert.equal(served.body.toString(), "special filename");
});

test("does not list directories or serve missing files", async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.root, "empty"));
  for (const path of ["/missing.html", "/empty/", "/designs", "/designs/", "/designs/option"]) {
    const served = await get(f.url, path);
    assert.notEqual(served.status, 200, path);
    assert.equal(served.body.toString().includes("<button>"), false, path);
  }
});

for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
  test(`rejects ${method} without changing files`, async (t) => {
    const f = await fixture(t);
    const rejected = await get(f.url, "/", { method });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.allow, "GET, HEAD");
    const viewer = await get(f.url, "/");
    assert.equal(viewer.body.toString(), "<!doctype html><p>Viewer</p>");
  });
}

const traversalPaths = [
  "/../outside.html",
  "/designs/../../outside.html",
  "/%2e%2e/outside.html",
  "/%2e%2e%2foutside.html",
  "/designs/%2e%2e/%2e%2e/outside.html",
];
for (const path of traversalPaths) {
  test(`rejects raw/encoded traversal ${path}`, async (t) => {
    const f = await fixture(t);
    const served = await get(f.url, path);
    assert.equal(served.status, 403);
    assert.equal(served.body.toString().includes("private external file"), false);
    assert.equal(served.body.toString().includes(f.workspace), false);
  });
}

for (const path of [
  "/%",
  "/%GG",
  "/%00",
  "/%0a",
  "/%5c..%5coutside.html",
  "//outside.html",
  "/%2foutside.html",
  "http://example.com/outside.html",
]) {
  test(`rejects malformed or non-local request target ${path}`, async (t) => {
    const f = await fixture(t);
    const served = await get(f.url, path);
    assert.equal(served.status, 400);
    assert.equal(served.body.toString().includes("private external file"), false);
  });
}

for (const linkType of ["file", "directory"]) {
  test(`rejects external ${linkType} symlinks`, async (t) => {
    const f = await fixture(t);
    if (linkType === "file")
      symlinkSync(join(f.workspace, "outside.html"), join(f.root, "external.html"));
    else symlinkSync(f.workspace, join(f.root, "external"));
    const served = await get(
      f.url,
      linkType === "file" ? "/external.html" : "/external/outside.html",
    );
    assert.equal(served.status, 403);
    assert.equal(served.body.toString().includes("private external file"), false);
  });
}

test("rejects symlinks to a sibling root with the same path prefix", async (t) => {
  const f = await fixture(t);
  const sibling = `${f.root}-other`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, "index.html"), "private sibling");
  symlinkSync(sibling, join(f.root, "sibling"));
  const served = await get(f.url, "/sibling/");
  assert.equal(served.status, 403);
  assert.equal(served.body.toString().includes("private sibling"), false);
});

test("permits contained symlinks and rejects dangling symlinks", async (t) => {
  const f = await fixture(t);
  symlinkSync(join(f.root, "designs", "option"), join(f.root, "internal"));
  symlinkSync(join(f.workspace, "absent.html"), join(f.root, "dangling.html"));
  const internal = await get(f.url, "/internal/");
  assert.equal(internal.status, 200);
  assert.equal(internal.body.toString(), "<!doctype html><button>Option</button>");
  assert.equal((await get(f.url, "/dangling.html")).status, 404);
});

test("rejects non-loopback Host values to avoid publishing through rebinding", async (t) => {
  const f = await fixture(t);
  const port = new URL(f.url).port;
  for (const host of [
    "example.com",
    `example.com:${port}`,
    `127.0.0.1:${Number(port) + 1}`,
    "[::1]:4173",
  ]) {
    const served = await get(f.url, "/", { host });
    assert.equal(served.status, 403, host);
    assert.equal(served.body.toString().includes("<p>Viewer</p>"), false, host);
  }
  assert.equal((await get(f.url, "/", { host: `localhost:${port}` })).status, 200);
});

test("generator iframe paths resolve over the actual HTTP serving path", async (t) => {
  const f = await fixture(t);
  const name = "space#?%.html";
  writeFileSync(join(f.root, name), "<!doctype html><button>Generated option</button>");
  const template = join(f.workspace, "template.html");
  writeFileSync(
    template,
    '<script id="catalog-data" type="application/json">__DESIGN_CATALOG_DATA__</script>',
  );
  writeFileSync(
    join(f.root, "catalog.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test",
      title: "Test",
      axes: [
        {
          id: "axis",
          label: "Axis",
          description: "Compare",
          options: [{ id: "option", label: "Option", description: "Difference", path: name }],
        },
      ],
    }),
  );
  generateViewer(f.root, template);
  const servedViewer = await get(f.url, "/");
  assert.equal(servedViewer.status, 200);
  const json = servedViewer.body.toString().split(">")[1].split("</script")[0];
  const optionPath = JSON.parse(json).axes[0].options[0].path;
  const servedOption = await get(f.url, new URL(optionPath, f.url).pathname);
  assert.equal(servedOption.status, 200);
  assert.equal(servedOption.body.toString(), "<!doctype html><button>Generated option</button>");
});

for (const port of [-1, 65536, 1.5, "4173", NaN]) {
  test(`rejects invalid API port ${String(port)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(() => serveCatalog(f.root, { port }), /Port must be an integer/);
  });
}

test("rejects missing/non-directory roots and occupied ports", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => serveCatalog(join(f.workspace, "absent"), { port: 0 }), /ENOENT/);
  await assert.rejects(
    () => serveCatalog(join(f.root, "index.html"), { port: 0 }),
    /root must be a directory/,
  );
  await assert.rejects(() => serveCatalog(f.root, { port: f.server.address().port }), /EADDRINUSE/);
});

for (const args of [
  [],
  ["root", "extra"],
  ["root", "--host", "0.0.0.0"],
  ["root", "--port"],
  ["root", "--port", "abc"],
  ["root", "--port", "0", "extra"],
  ["root", "--port", "65536"],
]) {
  test(`CLI rejects invalid arguments ${JSON.stringify(args)}`, () => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|Port must be an integer/);
  });
}

test("CLI publishes its URL and exits cleanly on SIGTERM", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [script, f.root, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = await new Promise((resolveUrl, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) resolveUrl(stdout.trim());
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited early (${code}): ${stderr}`)));
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const served = await get(url, "/");
  assert.equal(served.status, 200);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
});
