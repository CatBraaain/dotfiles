// Dist-to-home path mapping shared by diff detection, apply, and home-path
// resolution (spec: SPEC.md §差分検知 の対応関係).

export type EntryKind = "file" | "directory" | "symlink";

const excludedEntryPrefixes = [".build"];

// Build and apply hooks stay in dist and are not copied to home.
const buildHookNamePattern = /\.build(?:-machine)?\.[^.]+$/;
const applyScriptNamePattern = /\.apply(?:-machine)?\.[^.]+$/;

export function isApplyScriptName(name: string): boolean {
  return applyScriptNamePattern.test(name);
}

export type SegmentMapping = {
  homeName: string;
  kind: EntryKind;
  isExactManaged: boolean;
  isExecutable: boolean;
  isExcluded: boolean;
};

export function mapSegment(name: string, isDirectory: boolean): SegmentMapping {
  // .data. marks build-time data files (path map, external config, machine
  // layer), excluded like the .build prefix (spec §差分検知).
  const isExcluded =
    excludedEntryPrefixes.some((prefix) => name.startsWith(prefix)) ||
    name.includes(".data.") ||
    name === "external.data-machine.yaml" ||
    (!isDirectory && (isApplyScriptName(name) || buildHookNamePattern.test(name)));
  if (isExcluded)
    return {
      homeName: name,
      kind: isDirectory ? "directory" : "file",
      isExactManaged: false,
      isExecutable: false,
      isExcluded: true,
    };

  if (isDirectory && name.endsWith(".exact"))
    return {
      homeName: name.slice(0, -".exact".length),
      kind: "directory",
      isExactManaged: true,
      isExecutable: false,
      isExcluded: false,
    };
  if (!isDirectory && name.endsWith(".executable"))
    return {
      homeName: name.slice(0, -".executable".length),
      kind: "file",
      isExactManaged: false,
      isExecutable: true,
      isExcluded: false,
    };
  if (!isDirectory && name.endsWith(".symlink"))
    return {
      homeName: name.slice(0, -".symlink".length),
      kind: "symlink",
      isExactManaged: false,
      isExecutable: false,
      isExcluded: false,
    };

  return {
    homeName: name,
    kind: isDirectory ? "directory" : "file",
    isExactManaged: false,
    isExecutable: false,
    isExcluded: false,
  };
}
