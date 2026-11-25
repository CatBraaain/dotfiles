import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { it } from "bun:test";
import { prepareExplorerSort } from "./sort-explorer.ts";

const source = `
var $sorter = class {
  constructor(explorerService, contextService) {
    this.explorerService = explorerService;
    this.contextService = contextService;
  }
  compare(left, right) {
    if (left.isRoot) {
      if (right.isRoot) return this.contextService.index(left) - this.contextService.index(right);
      return -1;
    }
    if (right.isRoot) return 1;
    const { sortOrder, reverse } = this.explorerService.sortOrderConfiguration;
    if (reverse) [left, right] = [right, left];
    if (sortOrder !== "mixed" && left.isDirectory !== right.isDirectory) {
      const folderFirst = left.isDirectory ? -1 : 1;
      return sortOrder === "filesFirst" ? -folderFirst : folderFirst;
    }
    return left.name.localeCompare(right.name);
  }
};
globalThis.Sorter = $sorter;
`;

const file = (name: string) => ({ name, isDirectory: false, isRoot: false });
const directory = (name: string) => ({ name, isDirectory: true, isRoot: false });
const root = (name: string, index: number) => ({ ...directory(name), isRoot: true, index });

const items = [
  file("a.ts"),
  file("index.ts"),
  directory("z-dir"),
  file("Index.ts"),
  file("index.mdx"),
  directory("b-dir"),
  file("index.md"),
  file("index.js"),
  root("zz-workspace", 0),
  root("aa-workspace", 1),
];

it("prioritizes the three exact files while preserving folders, roots, and other file order", () => {
  assert.deepEqual(namesAfterSort("default"), [
    "zz-workspace",
    "aa-workspace",
    "b-dir",
    "z-dir",
    "index.md",
    "index.mdx",
    "index.ts",
    "a.ts",
    "index.js",
    "Index.ts",
  ]);
});

it("preserves the standard files-first and reverse orders within each group", () => {
  assert.deepEqual(namesAfterSort("filesFirst"), [
    "zz-workspace",
    "aa-workspace",
    "index.md",
    "index.mdx",
    "index.ts",
    "a.ts",
    "index.js",
    "Index.ts",
    "b-dir",
    "z-dir",
  ]);
  assert.deepEqual(namesAfterSort("default", true), [
    "zz-workspace",
    "aa-workspace",
    "index.ts",
    "index.mdx",
    "index.md",
    "Index.ts",
    "index.js",
    "a.ts",
    "z-dir",
    "b-dir",
  ]);
});

it("keeps the original mixed ordering", () => {
  assert.deepEqual(namesAfterSort("mixed"), namesAfterSort("mixed", false, false));
});

it("skips missing and ambiguous sorters", () => {
  assert.equal(
    prepareExplorerSort(source.replace("this.contextService =", "this.otherService =")),
    undefined,
  );
  assert.equal(
    prepareExplorerSort(source + source.replaceAll("$sorter", "otherSorter")),
    undefined,
  );
});

function namesAfterSort(sortOrder: string, reverse = false, patched = true): string[] {
  const patch = prepareExplorerSort(source);
  assert.ok(patch);
  const { Sorter } = runInNewContext(`${source}\n${patched ? patch : ""}\n({ Sorter });`);
  const sorter = new Sorter(
    { sortOrderConfiguration: { sortOrder, reverse } },
    { index: (node: ReturnType<typeof root>) => node.index },
  );
  return items.toSorted((left, right) => sorter.compare(left, right)).map(({ name }) => name);
}
