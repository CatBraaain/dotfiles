import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  extractNpmPackageNames,
  resolvePackageManager,
  staleDependencies,
  uninstallArguments,
} from "./npm_packages.apply.ts";

describe("extractNpmPackageNames", () => {
  it("extracts plain package names", () => {
    assert.deepEqual(extractNpmPackageNames(["npm:pi-gpt", "npm:pi-web-access"]), [
      "pi-gpt",
      "pi-web-access",
    ]);
  });

  it("strips version suffixes", () => {
    assert.deepEqual(extractNpmPackageNames(["npm:pi-gpt@0.4.2", "npm:pi-gpt@^1.0.0"]), ["pi-gpt"]);
  });

  it("keeps scoped names and strips their version suffixes", () => {
    assert.deepEqual(extractNpmPackageNames(["npm:@narumitw/pi-stamp", "npm:@scope/name@2.1.3"]), [
      "@narumitw/pi-stamp",
      "@scope/name",
    ]);
  });

  it("ignores non-npm sources and non-string entries", () => {
    assert.deepEqual(
      extractNpmPackageNames(["git:https://example.com/repo", 42, null, { source: "npm:pi-gpt" }]),
      [],
    );
  });

  it("drops empty npm specs", () => {
    assert.deepEqual(extractNpmPackageNames(["npm:", "npm"]), []);
  });

  it("returns empty for missing or non-array packages", () => {
    assert.deepEqual(extractNpmPackageNames(undefined), []);
    assert.deepEqual(extractNpmPackageNames("npm:pi-gpt"), []);
    assert.deepEqual(extractNpmPackageNames({ 0: "npm:pi-gpt", length: 1 }), []);
  });

  it("deduplicates names", () => {
    assert.deepEqual(extractNpmPackageNames(["npm:pi-gpt", "npm:pi-gpt@1.0.0", "npm:pi-gpt"]), [
      "pi-gpt",
    ]);
  });
});

describe("staleDependencies", () => {
  it("lists dependencies missing from wanted in sorted order", () => {
    assert.deepEqual(
      staleDependencies(["pi-stamp", "commandcode-provider"], {
        "commandcode-provider": "^0.8.0",
        "pi-cursor-sdk": "^0.3.10",
        "pi-stamp": "^0.54.1",
        "pi-web-access": "^0.14.0",
      }),
      ["pi-cursor-sdk", "pi-web-access"],
    );
  });

  it("returns nothing when every dependency is wanted", () => {
    assert.deepEqual(staleDependencies(["pi-stamp"], { "pi-stamp": "^0.54.1" }), []);
  });

  it("returns everything for empty wanted", () => {
    assert.deepEqual(staleDependencies([], { "pi-gpt": "^0.4.2" }), ["pi-gpt"]);
  });
});

describe("resolvePackageManager", () => {
  it("defaults to npm when npmCommand is missing or empty", () => {
    assert.equal(resolvePackageManager(undefined), "npm");
    assert.equal(resolvePackageManager([]), "npm");
    assert.equal(resolvePackageManager(["npm"]), "npm");
    assert.equal(resolvePackageManager(["npm", "--silent"]), "npm");
  });

  it("detects bun as the direct command", () => {
    assert.equal(resolvePackageManager(["bun"]), "bun");
    assert.equal(resolvePackageManager(["bun", "--silent"]), "bun");
  });

  it("detects bun as the wrapped command after --", () => {
    assert.equal(resolvePackageManager(["npx", "--", "bun"]), "bun");
  });

  it("normalizes command paths and windows extensions", () => {
    assert.equal(resolvePackageManager(["C:\\tools\\bun.EXE"]), "bun");
    assert.equal(resolvePackageManager(["/usr/local/bin/bun"]), "bun");
  });

  it("falls back to npm for other package managers", () => {
    assert.equal(resolvePackageManager(["pnpm"]), "npm");
  });
});

describe("uninstallArguments", () => {
  it("builds an npm uninstall with prefix and pi flags", () => {
    assert.deepEqual(
      uninstallArguments(["pi-gpt", "pi-web-access"], "/home/u/.pi/agent/npm", "npm"),
      {
        command: "npm",
        args: [
          "uninstall",
          "pi-gpt",
          "pi-web-access",
          "--prefix",
          "/home/u/.pi/agent/npm",
          "--legacy-peer-deps",
          "--no-audit",
          "--no-fund",
        ],
      },
    );
  });

  it("builds a bun uninstall with cwd", () => {
    assert.deepEqual(uninstallArguments(["pi-gpt"], "/home/u/.pi/agent/npm", "bun"), {
      command: "bun",
      args: ["uninstall", "pi-gpt", "--cwd", "/home/u/.pi/agent/npm"],
    });
  });
});
