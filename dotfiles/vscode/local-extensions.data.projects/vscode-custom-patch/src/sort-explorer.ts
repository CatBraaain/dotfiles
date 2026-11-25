const PRIORITY_NAMES = ["index.ts", "index.md", "index.mdx"];
const SORTER_DECLARATION =
  /\b(?:var|let|const)\s+([$A-Za-z_][$\w]*)\s*=\s*class\s*\{\s*constructor\([^{}]*\)\s*\{\s*this\.explorerService\s*=[^{}]*?\bthis\.contextService\s*=[^{}]*\}\s*compare\(\s*([$A-Za-z_][$\w]*)\s*,\s*[$A-Za-z_][$\w]*\s*\)\s*\{\s*if\s*\(\s*\2\.isRoot\s*\)/g;

export function prepareExplorerSort(bundle: string): string | undefined {
  const matches = [...bundle.matchAll(SORTER_DECLARATION)];
  const sorter = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (!sorter) return;

  return `;(() => {
  if (typeof ${sorter} !== "function") return;
  const prototype = ${sorter}.prototype;
  const original = prototype.compare;
  if (typeof original !== "function") return;
  const priorityNames = new Set(${JSON.stringify(PRIORITY_NAMES)});
  prototype.compare = function (left, right) {
    if (!left.isRoot && !right.isRoot &&
        left.isDirectory === false && right.isDirectory === false &&
        this.explorerService.sortOrderConfiguration.sortOrder !== "mixed") {
      const leftPriority = priorityNames.has(left.name);
      const rightPriority = priorityNames.has(right.name);
      if (leftPriority !== rightPriority) return leftPriority ? -1 : 1;
    }
    return original.call(this, left, right);
  };
})();`;
}
